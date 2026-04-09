const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 数据库初始化 ---
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS draw_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    result TEXT NOT NULL,
    created_at TEXT
  );
`);

// 如果 config 表为空，插入默认配置
const row = db.prepare('SELECT id FROM config WHERE id = 1').get();
if (!row) {
  const defaultConfig = JSON.stringify({
    event: '羽毛球赛',
    admin: { username: 'admin', password: 'admin123' },
    tiers: {
      A: ['张三','李四','王五','赵六','钱七','孙八','周九','吴十'],
      B: ['甲一','甲二','甲三','甲四','甲五','甲六','甲七','甲八'],
      C: ['乙一','乙二','乙三','乙四','乙五','乙六','乙七','乙八'],
      D: ['丙一','丙二','丙三','丙四','丙五','丙六','丙七','丙八'],
      E: ['丁一','丁二','丁三','丁四','丁五','丁六','丁七','丁八']
    },
    fixedPairs: []
  });
  db.prepare('INSERT INTO config (id, data, updated_at) VALUES (1, ?, ?)').run(defaultConfig, new Date().toISOString());
}

// --- 中间件 ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 辅助函数 ---
function getConfig() {
  const row = db.prepare('SELECT data FROM config WHERE id = 1').get();
  return row ? JSON.parse(row.data) : null;
}

function checkAdmin(req, res) {
  const { username, password } = req.body;
  const config = getConfig();
  if (!config) { res.status(500).json({ error: '配置不存在' }); return null; }
  if (username !== config.admin.username || password !== config.admin.password) {
    res.status(401).json({ error: '用户名或密码错误' });
    return null;
  }
  return config;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortTeamMembers(team, tierByName) {
  const tierOrder = { A: 0, B: 1, C: 2, D: 3, E: 4 };
  return [...team].sort((left, right) => {
    const leftRank = tierOrder[tierByName[left]] ?? Number.MAX_SAFE_INTEGER;
    const rightRank = tierOrder[tierByName[right]] ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}

function buildTeams(config) {
  const teams = Array.from({ length: 8 }, () => []);
  const used = new Set();
  const tierByName = {};
  const randomSlots = shuffle([0, 1, 2, 3, 4, 5, 6, 7]);

  Object.entries(config.tiers).forEach(([tier, members]) => {
    members.forEach(name => { if (name) tierByName[name] = tier; });
  });

  // 固定组：随机落位
  (config.fixedPairs || []).forEach((group, index) => {
    const teamIndex = randomSlots[index % randomSlots.length];
    const tierUsedInGroup = new Set();
    (group.members || []).forEach(name => {
      const tier = tierByName[name];
      if (!name || used.has(name) || !tier) return;
      if (tierUsedInGroup.has(tier)) return;
      teams[teamIndex].push(name);
      used.add(name);
      tierUsedInGroup.add(tier);
    });
  });

  // 剩余成员随机分配，保证每队每梯队 1 人
  Object.entries(config.tiers).forEach(([tier, members]) => {
    const remaining = shuffle(members.filter(name => name && !used.has(name)));
    for (const name of remaining) {
      const candidate = [];
      for (let t = 0; t < 8; t++) {
        if (!teams[t].some(m => tierByName[m] === tier)) candidate.push(t);
      }
      const teamIndex = candidate.length
        ? candidate.sort((a, b) => teams[a].length - teams[b].length)[0]
        : teams.map((team, idx) => ({ idx, len: team.length })).sort((a, b) => a.len - b.len)[0].idx;
      teams[teamIndex].push(name);
      used.add(name);
    }
  });

  return teams.map(team => sortTeamMembers(team, tierByName));
}

// --- API 路由 ---

// 获取配置（公开部分：梯队人数、赛事名称）
app.get('/api/config', (req, res) => {
  const config = getConfig();
  if (!config) return res.status(500).json({ error: '配置不存在' });
  res.json({
    event: config.event,
    tierCounts: Object.fromEntries(Object.entries(config.tiers).map(([k, v]) => [k, v.length])),
    totalPlayers: Object.values(config.tiers).reduce((a, b) => a + b.length, 0)
  });
});

// 管理员获取完整配置
app.post('/api/admin/config', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) return;
  res.json({
    event: config.event,
    tiers: config.tiers,
    fixedPairs: config.fixedPairs
  });
});

// 管理员保存配置
app.post('/api/admin/save', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) return;

  const { event, tiers, fixedPairs } = req.body;
  const updated = {
    ...config,
    event: event || config.event,
    tiers: tiers || config.tiers,
    fixedPairs: fixedPairs || config.fixedPairs
  };

  db.prepare('UPDATE config SET data = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(updated), new Date().toISOString());
  res.json({ success: true });
});

// 管理员执行抽签
app.post('/api/admin/draw', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) return;

  const teams = buildTeams(config);
  const resultJson = JSON.stringify(teams);

  db.prepare('INSERT INTO draw_result (result, created_at) VALUES (?, ?)')
    .run(resultJson, new Date().toISOString());

  res.json({ success: true, teams });
});

// 获取最新抽签结果（所有人可见）
app.get('/api/result', (req, res) => {
  const row = db.prepare('SELECT result, created_at FROM draw_result ORDER BY id DESC LIMIT 1').get();
  if (!row) return res.json({ hasResult: false });
  res.json({ hasResult: true, teams: JSON.parse(row.result), createdAt: row.created_at });
});

// --- 启动 ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
