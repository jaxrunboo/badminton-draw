const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TIER_VALUES = ['A', 'B', 'C', 'D', 'E'];
const TEAM_COUNT = 8;

const DB_PATH = path.join(__dirname, 'app-data.db');
const LEGACY_DB_PATH = path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
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

  CREATE TABLE IF NOT EXISTS user_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    nickname TEXT,
    phone TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    tier TEXT,
    selected_for_draw INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS manual_player (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    nickname TEXT,
    phone TEXT UNIQUE,
    tier TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(phone) {
  return String(phone || '').trim();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeTier(value) {
  const tier = normalizeText(value).toUpperCase();
  return TIER_VALUES.includes(tier) ? tier : '';
}

function getDisplayName(person) {
  const name = normalizeText(person.name);
  const nickname = normalizeText(person.nickname);
  return nickname ? `${name}（${nickname}）` : name;
}

function ensureDefaultConfig() {
  const row = db.prepare('SELECT id FROM config WHERE id = 1').get();
  if (row) {
    return;
  }

  const defaultConfig = JSON.stringify({
    event: '羽毛球赛',
    admin: { username: 'admin', password: 'admin123' },
    tiers: {
      A: ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十'],
      B: ['甲一', '甲二', '甲三', '甲四', '甲五', '甲六', '甲七', '甲八'],
      C: ['乙一', '乙二', '乙三', '乙四', '乙五', '乙六', '乙七', '乙八'],
      D: ['丙一', '丙二', '丙三', '丙四', '丙五', '丙六', '丙七', '丙八'],
      E: ['丁一', '丁二', '丁三', '丁四', '丁五', '丁六', '丁七', '丁八']
    },
    fixedPairs: []
  });

  db.prepare('INSERT INTO config (id, data, updated_at) VALUES (1, ?, ?)')
    .run(defaultConfig, nowIso());
}

function migrateLegacyDatabase() {
  if (!fs.existsSync(LEGACY_DB_PATH) || DB_PATH === LEGACY_DB_PATH) {
    return;
  }

  const configRow = db.prepare('SELECT id FROM config WHERE id = 1').get();
  const resultCount = db.prepare('SELECT COUNT(*) AS count FROM draw_result').get().count;
  if (configRow || resultCount > 0) {
    return;
  }

  let legacyDb = null;
  try {
    legacyDb = new Database(LEGACY_DB_PATH, { readonly: true });
    const legacyConfig = legacyDb.prepare('SELECT data, updated_at FROM config WHERE id = 1').get();
    if (legacyConfig) {
      db.prepare('INSERT OR REPLACE INTO config (id, data, updated_at) VALUES (1, ?, ?)')
        .run(legacyConfig.data, legacyConfig.updated_at || nowIso());
    }

    const legacyResults = legacyDb.prepare('SELECT result, created_at FROM draw_result ORDER BY id ASC').all();
    if (legacyResults.length) {
      const insert = db.prepare('INSERT INTO draw_result (result, created_at) VALUES (?, ?)');
      const tx = db.transaction(() => {
        legacyResults.forEach((row) => {
          insert.run(row.result, row.created_at || nowIso());
        });
      });
      tx();
    }
  } catch (error) {
    console.warn(`Legacy DB migration skipped: ${error.message}`);
  } finally {
    if (legacyDb) {
      legacyDb.close();
    }
  }
}

function getConfig() {
  const row = db.prepare('SELECT data FROM config WHERE id = 1').get();
  if (!row) {
    return null;
  }

  const parsed = JSON.parse(row.data);
  return {
    event: parsed.event || '羽毛球赛',
    admin: {
      username: parsed.admin?.username || 'admin',
      password: parsed.admin?.password || 'admin123'
    },
    fixedPairs: Array.isArray(parsed.fixedPairs) ? parsed.fixedPairs : [],
    tiers: parsed.tiers || {}
  };
}

function saveConfig(config) {
  db.prepare('UPDATE config SET data = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(config), nowIso());
}

function migrateLegacyManualPlayers() {
  const config = getConfig();
  if (!config) {
    return;
  }

  const manualCount = db.prepare('SELECT COUNT(*) AS count FROM manual_player').get().count;
  if (manualCount > 0) {
    return;
  }

  const rows = [];
  TIER_VALUES.forEach((tier) => {
    (config.tiers?.[tier] || []).forEach((name) => {
      const cleanName = normalizeText(name);
      if (!cleanName) {
        return;
      }
      rows.push({
        name: cleanName,
        nickname: '',
        phone: null,
        tier
      });
    });
  });

  if (!rows.length) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO manual_player (name, nickname, phone, tier, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const timestamp = nowIso();
  const tx = db.transaction(() => {
    rows.forEach((row) => {
      insert.run(row.name, row.nickname, row.phone, row.tier, timestamp, timestamp);
    });
  });

  tx();
}

migrateLegacyDatabase();
ensureDefaultConfig();
migrateLegacyManualPlayers();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function checkAdmin(req, res) {
  const { username, password } = req.body || {};
  const config = getConfig();
  if (!config) {
    res.status(500).json({ error: '配置不存在' });
    return null;
  }
  if (username !== config.admin.username || password !== config.admin.password) {
    res.status(401).json({ error: '用户名或密码错误' });
    return null;
  }
  return config;
}

function getUserByCredentials(phone, password) {
  return db.prepare(`
    SELECT id, name, nickname, phone, password, status, tier, selected_for_draw, created_at, updated_at
    FROM user_account
    WHERE phone = ? AND password = ?
  `).get(normalizePhone(phone), String(password || ''));
}

function requireUser(req, res) {
  const { phone, password } = req.body || {};
  const user = getUserByCredentials(phone, password);
  if (!user) {
    res.status(401).json({ error: '手机号或密码错误' });
    return null;
  }
  return user;
}

function getManualPlayers() {
  const rows = db.prepare(`
    SELECT id, name, nickname, phone, tier, created_at, updated_at
    FROM manual_player
    ORDER BY tier ASC, id ASC
  `).all();

  return rows.map((row) => ({
    ...row,
    key: `manual:${row.id}`,
    source: 'manual',
    displayName: getDisplayName(row)
  }));
}

function getRegisteredUsers() {
  const rows = db.prepare(`
    SELECT id, name, nickname, phone, status, tier, selected_for_draw, created_at, updated_at
    FROM user_account
    ORDER BY created_at DESC, id DESC
  `).all();

  return rows.map((row) => ({
    ...row,
    key: `user:${row.id}`,
    source: 'registration',
    selectedForDraw: !!row.selected_for_draw,
    displayName: getDisplayName(row)
  }));
}

function getSelectedRegisteredPlayers() {
  return getRegisteredUsers()
    .filter((row) => row.status === 'approved' && row.selectedForDraw && normalizeTier(row.tier))
    .map((row) => ({
      ...row,
      tier: normalizeTier(row.tier)
    }));
}

function getDrawPoolPlayers() {
  const manual = getManualPlayers()
    .filter((row) => normalizeTier(row.tier))
    .map((row) => ({
      ...row,
      tier: normalizeTier(row.tier)
    }));

  const registered = getSelectedRegisteredPlayers();
  return [...manual, ...registered];
}

function summarizePool(players) {
  const tierCounts = Object.fromEntries(TIER_VALUES.map((tier) => [tier, 0]));
  players.forEach((player) => {
    if (tierCounts[player.tier] != null) {
      tierCounts[player.tier] += 1;
    }
  });

  return {
    tierCounts,
    totalPlayers: players.length
  };
}

function sanitizeFixedPairs(fixedPairs, validKeys) {
  if (!Array.isArray(fixedPairs)) {
    return [];
  }

  return fixedPairs
    .map((group) => {
      const memberKeys = Array.isArray(group?.memberKeys) ? group.memberKeys : [];
      const uniqueKeys = [...new Set(memberKeys.map((key) => String(key || '').trim()).filter((key) => validKeys.has(key)))];
      return { memberKeys: uniqueKeys };
    })
    .filter((group) => group.memberKeys.length >= 2);
}

function shuffle(arr) {
  const items = [...arr];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function sortTeamMembers(team) {
  const tierOrder = { A: 0, B: 1, C: 2, D: 3, E: 4 };
  return [...team].sort((left, right) => {
    const leftRank = tierOrder[left.tier] ?? Number.MAX_SAFE_INTEGER;
    const rightRank = tierOrder[right.tier] ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}

function buildTeams(players, fixedPairs) {
  const teams = Array.from({ length: TEAM_COUNT }, () => []);
  const playerByKey = new Map(players.map((player) => [player.key, player]));
  const used = new Set();
  const randomSlots = shuffle(Array.from({ length: TEAM_COUNT }, (_, index) => index));

  fixedPairs.forEach((group, index) => {
    const teamIndex = randomSlots[index % randomSlots.length];
    const tierUsedInGroup = new Set();

    group.memberKeys.forEach((memberKey) => {
      const player = playerByKey.get(memberKey);
      if (!player || used.has(player.key) || !player.tier) {
        return;
      }
      if (tierUsedInGroup.has(player.tier)) {
        return;
      }
      teams[teamIndex].push(player);
      used.add(player.key);
      tierUsedInGroup.add(player.tier);
    });
  });

  TIER_VALUES.forEach((tier) => {
    const remaining = shuffle(players.filter((player) => player.tier === tier && !used.has(player.key)));
    remaining.forEach((player) => {
      const candidates = [];
      teams.forEach((team, teamIndex) => {
        if (!team.some((member) => member.tier === tier)) {
          candidates.push(teamIndex);
        }
      });

      const teamIndex = candidates.length
        ? candidates.sort((left, right) => teams[left].length - teams[right].length)[0]
        : teams
          .map((team, index) => ({ index, size: team.length }))
          .sort((left, right) => left.size - right.size)[0].index;

      teams[teamIndex].push(player);
      used.add(player.key);
    });
  });

  return teams.map((team) => sortTeamMembers(team).map((member) => ({
    key: member.key,
    name: member.name,
    nickname: member.nickname,
    phone: member.phone || '',
    tier: member.tier,
    source: member.source,
    displayName: member.displayName
  })));
}

function resolveLatestMember(member) {
  if (!member || typeof member !== 'object' || !member.key) {
    return member;
  }

  const key = String(member.key);
  if (key.startsWith('user:')) {
    const id = Number(key.slice(5));
    if (Number.isInteger(id) && id > 0) {
      const row = db.prepare(`
        SELECT id, name, nickname, phone, tier
        FROM user_account
        WHERE id = ?
      `).get(id);
      if (row) {
        return {
          ...member,
          name: row.name,
          nickname: row.nickname || '',
          phone: row.phone || '',
          tier: row.tier || member.tier,
          displayName: getDisplayName(row)
        };
      }
    }
  }

  if (key.startsWith('manual:')) {
    const id = Number(key.slice(7));
    if (Number.isInteger(id) && id > 0) {
      const row = db.prepare(`
        SELECT id, name, nickname, phone, tier
        FROM manual_player
        WHERE id = ?
      `).get(id);
      if (row) {
        return {
          ...member,
          name: row.name,
          nickname: row.nickname || '',
          phone: row.phone || '',
          tier: row.tier || member.tier,
          displayName: getDisplayName(row)
        };
      }
    }
  }

  return member;
}

function resolveLatestTeams(teams) {
  if (!Array.isArray(teams)) {
    return [];
  }
  return teams.map((team) => Array.isArray(team) ? team.map((member) => resolveLatestMember(member)) : []);
}

app.get('/api/config', (req, res) => {
  const config = getConfig();
  const pool = getDrawPoolPlayers();
  const summary = summarizePool(pool);

  res.json({
    event: config?.event || '羽毛球赛',
    tierCounts: summary.tierCounts,
    totalPlayers: summary.totalPlayers
  });
});

app.post('/api/user/register', (req, res) => {
  const name = normalizeText(req.body?.name);
  const nickname = normalizeText(req.body?.nickname);
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  const tier = normalizeTier(req.body?.tier) || null;

  if (!name || !nickname || !phone || !password) {
    return res.status(400).json({ error: '姓名、昵称、手机号、密码不能为空' });
  }

  const existingManual = db.prepare('SELECT id FROM manual_player WHERE phone = ?').get(phone);
  if (existingManual) {
    return res.status(400).json({ error: '该手机号已存在于手工名单中' });
  }

  const existingUser = db.prepare('SELECT id FROM user_account WHERE phone = ?').get(phone);
  if (existingUser) {
    return res.status(400).json({ error: '该手机号已注册' });
  }

  const timestamp = nowIso();
  const info = db.prepare(`
    INSERT INTO user_account (name, nickname, phone, password, status, tier, selected_for_draw, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?)
  `).run(name, nickname, phone, password, tier, timestamp, timestamp);

  const user = db.prepare(`
    SELECT id, name, nickname, phone, status, tier, selected_for_draw, created_at, updated_at
    FROM user_account
    WHERE id = ?
  `).get(info.lastInsertRowid);

  return res.json({
    success: true,
    user: {
      ...user,
      selectedForDraw: !!user.selected_for_draw
    }
  });
});

app.post('/api/user/login', (req, res) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      name: user.name,
      nickname: user.nickname,
      phone: user.phone,
      status: user.status,
      tier: user.tier,
      selectedForDraw: !!user.selected_for_draw,
      createdAt: user.created_at,
      updatedAt: user.updated_at
    }
  });
});

app.post('/api/user/me', (req, res) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  res.json({
    id: user.id,
    name: user.name,
    nickname: user.nickname,
    phone: user.phone,
    status: user.status,
    tier: user.tier,
    selectedForDraw: !!user.selected_for_draw,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  });
});

app.post('/api/user/profile/update', (req, res) => {
  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  const name = normalizeText(req.body?.name);
  const nickname = normalizeText(req.body?.nickname);
  if (!name || !nickname) {
    return res.status(400).json({ error: '姓名和昵称不能为空' });
  }

  db.prepare(`
    UPDATE user_account
    SET name = ?, nickname = ?, updated_at = ?
    WHERE id = ?
  `).run(name, nickname, nowIso(), user.id);

  const updated = db.prepare(`
    SELECT id, name, nickname, phone, status, tier, selected_for_draw, created_at, updated_at
    FROM user_account
    WHERE id = ?
  `).get(user.id);

  res.json({
    success: true,
    user: {
      id: updated.id,
      name: updated.name,
      nickname: updated.nickname,
      phone: updated.phone,
      status: updated.status,
      tier: updated.tier,
      selectedForDraw: !!updated.selected_for_draw,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at
    }
  });
});

app.post('/api/admin/config', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) {
    return;
  }

  const manualPlayers = getManualPlayers();
  const registrations = getRegisteredUsers();
  const poolCandidates = getDrawPoolPlayers();
  const summary = summarizePool(poolCandidates);
  const validKeys = new Set(poolCandidates.map((player) => player.key));
  const fixedPairs = sanitizeFixedPairs(config.fixedPairs, validKeys);

  res.json({
    event: config.event,
    manualPlayers: manualPlayers.map((row) => ({
      id: row.id,
      name: row.name,
      nickname: row.nickname || '',
      phone: row.phone || '',
      tier: row.tier
    })),
    registrations: registrations.map((row) => ({
      id: row.id,
      name: row.name,
      nickname: row.nickname || '',
      phone: row.phone,
      status: row.status,
      tier: row.tier || '',
      selectedForDraw: row.selectedForDraw,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    poolCandidates: poolCandidates.map((row) => ({
      key: row.key,
      name: row.name,
      nickname: row.nickname || '',
      phone: row.phone || '',
      tier: row.tier,
      source: row.source,
      displayName: row.displayName
    })),
    fixedPairs,
    drawSummary: summary
  });
});

app.post('/api/admin/save', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) {
    return;
  }

  const event = normalizeText(req.body?.event) || config.event;
  const inputManualPlayers = Array.isArray(req.body?.manualPlayers) ? req.body.manualPlayers : [];
  const sanitizedManualPlayers = [];
  const phoneSet = new Set();
  const registeredPhones = new Set(
    db.prepare('SELECT phone FROM user_account').all().map((row) => normalizePhone(row.phone))
  );

  for (const row of inputManualPlayers) {
    const name = normalizeText(row?.name);
    const nickname = normalizeText(row?.nickname);
    const phone = normalizePhone(row?.phone);
    const tier = normalizeTier(row?.tier);

    if (!name && !nickname && !phone && !tier) {
      continue;
    }

    if (!name || !nickname || !phone || !tier) {
      return res.status(400).json({ error: '手工名单中的姓名、昵称、手机号、梯队不能为空' });
    }

    if (phoneSet.has(phone)) {
      return res.status(400).json({ error: `手工名单手机号重复：${phone}` });
    }

    if (registeredPhones.has(phone)) {
      return res.status(400).json({ error: `手机号 ${phone} 已存在于报名数据源中` });
    }

    phoneSet.add(phone);
    sanitizedManualPlayers.push({ name, nickname, phone, tier });
  }

  const timestamp = nowIso();
  const replaceManualPlayers = db.transaction(() => {
    db.prepare('DELETE FROM manual_player').run();
    const insert = db.prepare(`
      INSERT INTO manual_player (name, nickname, phone, tier, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    sanitizedManualPlayers.forEach((row) => {
      insert.run(row.name, row.nickname, row.phone, row.tier, timestamp, timestamp);
    });

    saveConfig({
      ...config,
      event
    });
  });

  replaceManualPlayers();
  res.json({ success: true });
});

app.post('/api/admin/fixed-pairs/save', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) {
    return;
  }

  const players = getDrawPoolPlayers();
  const validKeys = new Set(players.map((player) => player.key));
  const fixedPairs = sanitizeFixedPairs(req.body?.fixedPairs, validKeys);

  saveConfig({
    ...config,
    fixedPairs
  });

  res.json({ success: true });
});

app.post('/api/admin/registration/save', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) {
    return;
  }

  const id = Number(req.body?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '报名记录无效' });
  }

  const status = ['pending', 'approved', 'rejected'].includes(req.body?.status) ? req.body.status : 'pending';
  const tier = normalizeTier(req.body?.tier) || null;
  let selectedForDraw = !!req.body?.selectedForDraw;

  if (status !== 'approved') {
    selectedForDraw = false;
  }

  if (selectedForDraw && !tier) {
    return res.status(400).json({ error: '加入抽签池前请先分配梯队' });
  }

  const info = db.prepare(`
    UPDATE user_account
    SET status = ?, tier = ?, selected_for_draw = ?, updated_at = ?
    WHERE id = ?
  `).run(status, tier, selectedForDraw ? 1 : 0, nowIso(), id);

  if (!info.changes) {
    return res.status(404).json({ error: '报名记录不存在' });
  }

  const poolCandidates = getDrawPoolPlayers();
  const validKeys = new Set(poolCandidates.map((player) => player.key));
  const currentConfig = getConfig();
  const fixedPairs = sanitizeFixedPairs(currentConfig.fixedPairs, validKeys);
  saveConfig({
    ...currentConfig,
    fixedPairs
  });

  res.json({ success: true });
});

app.post('/api/admin/registrations/save', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) {
    return;
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) {
    return res.status(400).json({ error: '没有可保存的报名记录' });
  }

  const parsedItems = [];
  for (const item of items) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: '存在无效的报名记录' });
    }

    const status = ['pending', 'approved', 'rejected'].includes(item?.status) ? item.status : 'pending';
    const tier = normalizeTier(item?.tier) || null;
    let selectedForDraw = !!item?.selectedForDraw;

    if (selectedForDraw && status !== 'approved') {
      return res.status(400).json({ error: '加入抽签池前请先将报名状态改为已通过' });
    }
    if (selectedForDraw && !tier) {
      return res.status(400).json({ error: '加入抽签池前请先分配梯队' });
    }
    if (status !== 'approved') {
      selectedForDraw = false;
    }

    parsedItems.push({ id, status, tier, selectedForDraw });
  }

  const update = db.prepare(`
    UPDATE user_account
    SET status = ?, tier = ?, selected_for_draw = ?, updated_at = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    parsedItems.forEach((item) => {
      const info = update.run(item.status, item.tier, item.selectedForDraw ? 1 : 0, nowIso(), item.id);
      if (!info.changes) {
        throw new Error('报名记录不存在');
      }
    });
  });

  try {
    tx();
  } catch (error) {
    return res.status(400).json({ error: error.message || '批量保存失败' });
  }

  const poolCandidates = getDrawPoolPlayers();
  const validKeys = new Set(poolCandidates.map((player) => player.key));
  const currentConfig = getConfig();
  const fixedPairs = sanitizeFixedPairs(currentConfig.fixedPairs, validKeys);
  saveConfig({
    ...currentConfig,
    fixedPairs
  });

  res.json({ success: true });
});

app.post('/api/admin/draw', (req, res) => {
  const config = checkAdmin(req, res);
  if (!config) {
    return;
  }

  const players = getDrawPoolPlayers();
  if (!players.length) {
    return res.status(400).json({ error: '当前抽签池为空，请先配置手工名单或加入报名人员' });
  }

  const validKeys = new Set(players.map((player) => player.key));
  const fixedPairs = sanitizeFixedPairs(config.fixedPairs, validKeys);
  const teams = buildTeams(players, fixedPairs);

  db.prepare('INSERT INTO draw_result (result, created_at) VALUES (?, ?)')
    .run(JSON.stringify(teams), nowIso());

  res.json({ success: true, teams });
});

app.get('/api/result', (req, res) => {
  const row = db.prepare('SELECT result, created_at FROM draw_result ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    return res.json({ hasResult: false });
  }

  const teams = resolveLatestTeams(JSON.parse(row.result));

  res.json({
    hasResult: true,
    teams,
    createdAt: row.created_at
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
