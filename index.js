require('dotenv').config();
const express = require('express');
const path    = require('path');
const { botEvents, botRegistry, HOST, MC_PORT,
        scanInventoryAndChests, fetchServerInfo, botMaps } = require('./utils');

const app        = express();
const PORT_WEB   = process.env.PORT || 3000;
const SERVER_START = Date.now();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────────────────
const MAX_LOGS = 300;
const logBuffer = [];
const BOT1 = process.env.BOT1_NAME || 'AfkBot';
const BOT2 = process.env.BOT2_NAME || 'KillBot';

const botStatus = {
  [BOT1]: { online: false, type: 'AFK Bot',  running: false },
  [BOT2]: { online: false, type: 'Kill Bot', running: false },
};
const stats = {
  [BOT1]: { ghastKills: 0, foodAte: 0, inventory: {}, chests: {} },
  [BOT2]: { ghastKills: 0, foodAte: 0, inventory: {}, chests: {} },
};
const coords    = { [BOT1]: null, [BOT2]: null };
let serverInfo  = null;
const controllers = {};

// ─── Event queue ──────────────────────────────────────────────────────────────
const eventQueue = [];
let eventSeq = 0;
const MAX_QUEUE = 500;

const sseClients = new Set();

function broadcast(event, data) {
  eventQueue.push({ id: ++eventSeq, event, data });
  if (eventQueue.length > MAX_QUEUE) eventQueue.shift();
  sseClients.forEach(res => {
    try {
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch (_) { sseClients.delete(res); }
  });
}

// ─── Bot events ───────────────────────────────────────────────────────────────
botEvents.on('log', entry => {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  broadcast('log', entry);
});
botEvents.on('status', ({ username, online }) => {
  if (botStatus[username]) botStatus[username].online = online;
  broadcast('status', { username, online });
});
botEvents.on('ghastKill', ({ username, total }) => {
  if (stats[username]) stats[username].ghastKills = total;
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('ate', ({ username }) => {
  if (stats[username]) stats[username].foodAte++;
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('inventory', ({ username, counts }) => {
  if (stats[username]) stats[username].inventory = counts;
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('chestScan', ({ username, chests, count }) => {
  if (stats[username]) stats[username].chests = chests;
  broadcast('chestScan', { username, chests, count });
  broadcast('stats',    { username, stats: stats[username] });
});
botEvents.on('mapUpdate', ({ username, png, ts }) => broadcast('mapUpdate', { username, png, ts }));
botEvents.on('coords', ({ username, coords: c, ts }) => {
  coords[username] = { ...c, ts };
  broadcast('coords', { username, coords: coords[username] });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.send('pong'));

app.get('/poll', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const events = since === 0
    ? logBuffer.slice(-80).map((e, i) => ({ id: i + 1, event: 'log', data: e }))
    : eventQueue.filter(e => e.id > since);
  res.json({
    ok: true,
    lastId: since === 0 ? (events.length ? events[events.length - 1].id : 0) : eventSeq,
    events,
    state: { status: botStatus, stats, coords, serverInfo, serverStart: SERVER_START,
             bots: { [BOT1]: 'AFK Bot', [BOT2]: 'Kill Bot' } },
  });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('event: init\ndata: ' + JSON.stringify({
    logs: logBuffer, status: botStatus, stats, coords, serverInfo,
  }) + '\n\n');
  if (typeof res.flush === 'function') res.flush();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/bot/:name/start', (req, res) => {
  const { name } = req.params;
  if (!botStatus[name])          return res.json({ ok: false, reason: 'unknown bot' });
  if (botStatus[name].running)   return res.json({ ok: false, reason: 'already running' });
  if (!controllers[name])        return res.json({ ok: false, reason: 'controller not ready' });
  botStatus[name].running = true;
  controllers[name].start();
  broadcast('control', { username: name, action: 'started' });
  res.json({ ok: true });
});

app.post('/bot/:name/stop', (req, res) => {
  const { name } = req.params;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  botStatus[name].running = false;
  botStatus[name].online  = false;
  if (controllers[name]) controllers[name].stop();
  broadcast('control', { username: name, action: 'stopped' });
  broadcast('status',  { username: name, online: false });
  res.json({ ok: true });
});

app.post('/bot/:name/cmd', (req, res) => {
  const { name } = req.params;
  const { cmd }  = req.body;
  if (!cmd) return res.json({ ok: false, reason: 'no command' });
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  try {
    bot.chat(cmd);
    require('./utils').emit(name, 'chat', '[CMD] ' + cmd);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

app.post('/bot/:name/coords', (req, res) => {
  const { name } = req.params;
  const bot = botRegistry[name];
  if (!bot || !bot.entity) return res.json({ ok: false, reason: 'bot not connected' });
  try {
    const p = bot.entity.position;
    const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), ts: Date.now() };
    coords[name] = c;
    broadcast('coords', { username: name, coords: c });
    res.json({ ok: true, coords: c });
  } catch (e) { res.json({ ok: false, reason: e.message }); }
});

app.post('/bot/:name/chestscan', (req, res) => {
  const { name } = req.params;
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  require('./utils').emit(name, 'info', 'Manual chest scan triggered...');
  scanInventoryAndChests(bot, name).catch(() => {});
  res.json({ ok: true });
});

app.get('/bot/:name/map', (req, res) => {
  const map = botMaps[req.params.name];
  if (!map) return res.json({ ok: false, reason: 'no map data yet' });
  res.json({ ok: true, ...map });
});

app.get('/serverinfo', async (req, res) => {
  try {
    serverInfo = await fetchServerInfo();
    if (serverInfo) broadcast('serverInfo', serverInfo);
    res.json(serverInfo || { error: 'ping failed' });
  } catch (_) { res.json({ error: 'ping error' }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT_WEB, () => {
  console.log('[Dashboard] http://localhost:' + PORT_WEB);

  setInterval(() => {
    sseClients.forEach(res => {
      try { res.write(': ping\n\n'); if (typeof res.flush === 'function') res.flush(); }
      catch (_) { sseClients.delete(res); }
    });
  }, 8000);

  setTimeout(() => {
    fetchServerInfo().then(info => {
      serverInfo = info;
      if (info) broadcast('serverInfo', info);
    }).catch(() => {});
  }, 3000);

  setTimeout(() => {
    botStatus[BOT1].running = true;
    console.log('[Launcher] Starting AFK bot...');
    controllers[BOT1] = require('./afk-bot');
  }, 2000);

  setTimeout(() => {
    botStatus[BOT2].running = true;
    console.log('[Launcher] Starting Kill bot...');
    controllers[BOT2] = require('./kill-bot');
  }, 22000);
});
