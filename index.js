require('dotenv').config();
const express = require('express');
const { botEvents, botRegistry, HOST, MC_PORT, scanInventoryAndChests, fetchServerInfo, botMaps } = require('./utils');

// ─── Bot lifecycle controllers (set after launch) ────────────────────────────
const controllers = {};

const app      = express();
const PORT_WEB = process.env.PORT || 3000;
app.use(express.json());

// ─── Uptime + ping endpoints ──────────────────────────────────────────────────
app.get('/uptime', (req, res) => res.json({ startedAt: SERVER_START, uptime: Date.now() - SERVER_START }));
app.get('/ping',   (req, res) => res.send('pong')); // UptimeRobot hits this

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
const coords = {
  [BOT1]: null,
  [BOT2]: null,
};

let serverInfo = null;

// ─── Event listeners ──────────────────────────────────────────────────────────
botEvents.on('log', (entry) => {
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
  broadcast('stats', { username, stats: stats[username] });
});
botEvents.on('mapUpdate', ({ username, png, ts }) => {
  broadcast('mapUpdate', { username, png, ts });
});

botEvents.on('coords', ({ username, coords: c, ts }) => {
  coords[username] = { ...c, ts };
  broadcast('coords', { username, coords: coords[username] });
});

// ─── Event queue (for polling) ───────────────────────────────────────────────
const eventQueue = [];   // { event, data, id }
let   eventSeq   = 0;
const MAX_QUEUE  = 500;

function broadcast(event, data) {
  eventQueue.push({ id: ++eventSeq, event, data });
  if (eventQueue.length > MAX_QUEUE) eventQueue.shift();
  // Also try SSE push for clients that support it
  sseClients.forEach(res => {
    try {
      res.write('event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch(_) { sseClients.delete(res); }
  });
}

// SSE endpoint (best-effort — may not work behind all proxies)
const sseClients = new Set();
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const init = { logs: logBuffer, status: botStatus, stats, coords, serverInfo, maps: botMaps };
  res.write('event: init\ndata: ' + JSON.stringify(init) + '\n\n');
  if (typeof res.flush === 'function') res.flush();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Polling endpoint — browser hits this every 2s, gets everything since last seen id
app.get('/poll', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  let events;
  if (since === 0) {
    // First load — send last 80 log events + current state only
    const logs = logBuffer.slice(-80).map((entry, i) => ({
      id: i + 1,
      event: 'log',
      data: entry,
    }));
    events = logs;
  } else {
    events = eventQueue.filter(e => e.id > since);
  }
  res.json({
    ok: true,
    lastId: since === 0 ? (events.length ? events[events.length-1].id : 0) : eventSeq,
    events,
    state: { status: botStatus, stats, coords, serverInfo, serverStart: SERVER_START },
  });
});

// ─── API: Start/Stop ──────────────────────────────────────────────────────────
app.post('/bot/:name/start', (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  if (botStatus[name].running) return res.json({ ok: false, reason: 'already running' });
  if (!controllers[name]) return res.json({ ok: false, reason: 'controller not ready' });
  botStatus[name].running = true;
  controllers[name].start();
  broadcast('control', { username: name, action: 'started' });
  res.json({ ok: true });
});

app.post('/bot/:name/stop', (req, res) => {
  const name = req.params.name;
  if (!botStatus[name]) return res.json({ ok: false, reason: 'unknown bot' });
  botStatus[name].running = false;
  botStatus[name].online  = false;
  if (controllers[name]) controllers[name].stop();
  broadcast('control', { username: name, action: 'stopped' });
  broadcast('status',  { username: name, online: false });
  res.json({ ok: true });
});

// ─── API: Send command to bot ─────────────────────────────────────────────────
app.post('/bot/:name/cmd', (req, res) => {
  const name = req.params.name;
  const { cmd } = req.body;
  if (!cmd) return res.json({ ok: false, reason: 'no command' });
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  try {
    bot.chat(cmd);
    const { emit } = require('./utils');
    emit(name, 'chat', `[CMD] ${cmd}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

// ─── API: Force coords refresh ────────────────────────────────────────────────
app.post('/bot/:name/coords', (req, res) => {
  const name = req.params.name;
  const bot = botRegistry[name];
  if (!bot || !bot.entity) return res.json({ ok: false, reason: 'bot not connected' });
  try {
    const pos = bot.entity.position;
    const c = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), ts: Date.now() };
    coords[name] = c;
    broadcast('coords', { username: name, coords: c });
    res.json({ ok: true, coords: c });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

// ─── API: Force chest scan ────────────────────────────────────────────────────
app.post('/bot/:name/chestscan', (req, res) => {
  const name = req.params.name;
  const bot = botRegistry[name];
  if (!bot) return res.json({ ok: false, reason: 'bot not connected' });
  const { emit } = require('./utils');
  emit(name, 'info', 'Manual chest scan triggered...');
  scanInventoryAndChests(bot, name).catch(() => {});
  res.json({ ok: true });
});

// ─── API: Get latest map for bot ─────────────────────────────────────────────
app.get('/bot/:name/map', (req, res) => {
  const name = req.params.name;
  const map = botMaps[name];
  if (!map) return res.json({ ok: false, reason: 'no map data yet — hold a map item in the bot\'s hand' });
  res.json({ ok: true, ...map });
});

// ─── API: Server info ─────────────────────────────────────────────────────────
app.get('/serverinfo', async (req, res) => {
  try {
    serverInfo = await fetchServerInfo();
    if (serverInfo) broadcast('serverInfo', serverInfo);
    res.json(serverInfo || { error: 'ping failed or timed out' });
  } catch(_) {
    res.json({ error: 'ping error' });
  }
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MC Bot Console</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
:root {
  --bg:#0d0f12; --panel:#131720; --border:#1e2535; --text:#c9d1d9; --dim:#4a5568;
  --green:#39ff6b; --green-dim:#1a3d2b; --red:#ff4d4d; --red-dim:#3d1a1a;
  --yellow:#ffd166; --cyan:#00d4ff; --purple:#c678dd; --orange:#ff8c42;
  --blue:#61afef; --gray:#5c6370; --teal:#2dd4bf;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}

header{background:var(--panel);border-bottom:1px solid var(--border);padding:8px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.logo{font-size:14px;font-weight:700;color:var(--cyan);letter-spacing:2px}
.logo span{color:var(--green)}
.uptime-badge{font-size:11px;color:var(--dim)}
#uptime{color:var(--cyan)}
.header-btns{margin-left:auto;display:flex;gap:6px;align-items:center}
.hdr-btn{background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:11px;padding:3px 10px;border-radius:3px;cursor:pointer;transition:all .15s}
.hdr-btn:hover{border-color:var(--cyan);color:var(--cyan)}
#conn-status{font-size:11px}
#conn-status.connected{color:var(--green)}
#conn-status.connecting{color:var(--yellow)}
#conn-status.disconnected{color:var(--red)}

/* Server card */
#server-card{background:var(--panel);border-bottom:1px solid var(--border);padding:8px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0}
#server-favicon{width:40px;height:40px;border-radius:4px;border:1px solid var(--border);image-rendering:pixelated;flex-shrink:0;background:#0a0c10}
#server-favicon.placeholder{display:flex;align-items:center;justify-content:center;font-size:18px}
.server-info{flex:1;min-width:0}
#server-motd{font-size:12px;color:var(--cyan);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.server-meta{display:flex;gap:12px;font-size:10px;color:var(--dim)}
#server-ip{color:var(--text)}
#server-players{color:var(--green)}
#server-version{color:var(--dim)}
.srv-refresh{background:none;border:1px solid var(--border);color:var(--dim);cursor:pointer;font-size:10px;padding:2px 7px;border-radius:3px;font-family:inherit;flex-shrink:0}
.srv-refresh:hover{border-color:var(--cyan);color:var(--cyan)}

/* Cards row */
.cards-row{display:flex;gap:8px;padding:10px 16px;flex-shrink:0;background:var(--panel);border-bottom:1px solid var(--border)}
.card{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 12px;transition:border-color .3s;min-width:0}
.card.online{border-color:var(--green)}
.card.offline{border-color:#2a1a1a}
.card-header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;transition:all .3s}
.card.online .status-dot{background:var(--green);box-shadow:0 0 6px var(--green)}
.card.offline .status-dot{background:var(--red)}
.card-name{font-weight:700;font-size:12px;flex:1}
.card-type{font-size:10px;color:var(--dim)}
.card-badge{font-size:10px;font-weight:700;letter-spacing:1px}
.card.online .card-badge{color:var(--green)}
.card.offline .card-badge{color:#ff4d4d99}
.card-stats{display:grid;grid-template-columns:1fr 1fr;gap:3px 6px;margin-bottom:6px}
.stat{font-size:10px}
.stat-l{color:var(--dim)}
.stat-v{color:var(--cyan);font-weight:700}
.coords-row{display:flex;align-items:center;gap:4px;font-size:10px;margin-bottom:6px;color:var(--dim)}
.coords-val{color:var(--teal);font-weight:700}
.coords-ts{color:#2a3a3a;font-size:9px;margin-left:2px}
.icon-btn{background:none;border:none;color:var(--dim);cursor:pointer;font-size:10px;padding:0 2px;font-family:inherit}
.icon-btn:hover{color:var(--teal)}
.chest-row{font-size:10px;color:var(--dim);margin-bottom:6px;display:flex;align-items:center;gap:6px}
.chest-item{color:var(--orange)}
.small-btn{background:none;border:1px solid #1e2535;color:var(--dim);font-family:inherit;font-size:9px;padding:1px 6px;border-radius:2px;cursor:pointer}
.small-btn:hover{border-color:var(--orange);color:var(--orange)}
.small-btn.captcha{border-color:#3d2a1a}
.small-btn.captcha:hover{border-color:var(--yellow);color:var(--yellow)}
.card-btns{display:flex;gap:4px;margin-bottom:0}
.btn-start,.btn-stop,.btn-console{flex:1;border:none;border-radius:3px;padding:3px 0;font-family:inherit;font-size:10px;font-weight:700;cursor:pointer;transition:opacity .15s}
.btn-start{background:var(--green-dim);color:var(--green);border:1px solid #1a5c2b}
.btn-start:hover{opacity:.8}
.btn-stop{background:var(--red-dim);color:var(--red);border:1px solid #5c1a1a}
.btn-stop:hover{opacity:.8}
.btn-console{background:#1a1e2e;color:var(--blue);border:1px solid #1e2a45;flex:0.7}
.btn-console:hover{opacity:.8}
.btn-start:disabled,.btn-stop:disabled{opacity:.25;cursor:not-allowed}

/* Console panes */
.console-area{display:flex;flex:1;overflow:hidden}
.console-pane{flex:1;display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden}
.console-pane:last-child{border-right:none}
.pane-header{background:#0e1118;border-bottom:1px solid var(--border);padding:5px 10px;display:flex;align-items:center;gap:5px;flex-shrink:0;font-size:11px;flex-wrap:wrap}
.pane-title{color:var(--cyan);font-weight:700;margin-right:2px}
.pane-count{color:var(--yellow);font-size:10px;margin-right:4px}
.pane-filter{background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:10px;padding:1px 5px;border-radius:2px;cursor:pointer}
.pane-filter.active{border-color:var(--cyan);color:var(--cyan)}
.pane-clear{background:none;border:none;color:var(--dim);cursor:pointer;font-size:10px;font-family:inherit;margin-left:auto}
.pane-clear:hover{color:var(--red)}
.log-scroll{flex:1;overflow-y:auto;padding:4px 10px}
.log-scroll::-webkit-scrollbar{width:4px}
.log-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.log-line{display:flex;gap:6px;padding:1px 0;border-bottom:1px solid rgba(30,37,53,.3);line-height:1.6;font-size:11px;animation:fi .12s ease}
@keyframes fi{from{opacity:0}to{opacity:1}}
.l-ts{color:var(--gray);flex-shrink:0;width:68px}
.l-tag{font-size:9px;font-weight:700;letter-spacing:1px;flex-shrink:0;width:52px;text-align:right;padding-right:4px}
.l-msg{flex:1;word-break:break-word}
.tag-info{color:var(--blue)} .msg-info{color:var(--text)}
.tag-error{color:var(--red)} .msg-error{color:var(--red)}
.tag-kick{color:var(--orange)} .msg-kick{color:var(--orange)}
.tag-disconnect{color:var(--orange)} .msg-disconnect{color:var(--orange);opacity:.85}
.tag-reconnect{color:var(--yellow)} .msg-reconnect{color:var(--yellow)}
.tag-kill{color:var(--purple)} .msg-kill{color:var(--purple)}
.tag-food{color:#a8d8a8} .msg-food{color:#a8d8a8}
.tag-chat{color:var(--cyan)} .msg-chat{color:var(--cyan)}
.tag-inv{color:var(--teal)} .msg-inv{color:var(--teal)}
.hl-error{background:rgba(255,77,77,.04)}
.hl-kick{background:rgba(255,140,66,.04)}
.hl-kill{background:rgba(198,120,221,.04)}
.cmd-row{display:flex;border-top:1px solid var(--border);flex-shrink:0}
.cmd-input{flex:1;background:#0a0c10;border:none;color:var(--text);font-family:inherit;font-size:11px;padding:6px 10px;outline:none}
.cmd-input::placeholder{color:var(--dim)}
.cmd-send{background:#1a2a1a;border:none;border-left:1px solid var(--border);color:var(--green);font-family:inherit;font-size:11px;padding:6px 12px;cursor:pointer}
.cmd-send:hover{background:#1f3a1f}

/* Modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--panel);border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;overflow:hidden}
.modal-head{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0}
.modal-title{font-weight:700;color:var(--cyan);flex:1;font-size:13px}
.modal-close{background:none;border:none;color:var(--dim);cursor:pointer;font-size:18px;line-height:1;padding:0 2px}
.modal-close:hover{color:var(--red)}

/* CMD modal */
#cmd-modal .modal{width:680px;max-width:95vw;height:75vh}
.modal-log{flex:1;overflow-y:auto;padding:6px 12px}
.modal-log::-webkit-scrollbar{width:4px}
.modal-log::-webkit-scrollbar-thumb{background:var(--border)}
.modal-cmd{display:flex;border-top:1px solid var(--border);flex-shrink:0}
.modal-input{flex:1;background:#0a0c10;border:none;color:var(--text);font-family:inherit;font-size:12px;padding:8px 12px;outline:none}
.modal-send{background:#1a2a1a;border:none;border-left:1px solid var(--border);color:var(--green);font-family:inherit;padding:8px 14px;cursor:pointer;font-size:12px}

/* Captcha modal */
#captcha-modal .modal{width:420px;max-width:95vw}
.captcha-body{padding:14px;display:flex;flex-direction:column;align-items:center;gap:10px}
#captcha-map-img{width:256px;height:256px;image-rendering:pixelated;border:2px solid var(--border);border-radius:4px;background:#0a0c10;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:11px}
#captcha-map-img img{width:100%;height:100%;image-rendering:pixelated}
.captcha-hint{font-size:10px;color:var(--dim);text-align:center}
.captcha-input-row{display:flex;gap:6px;width:100%}
#captcha-answer{flex:1;background:#0a0c10;border:1px solid var(--border);color:var(--text);font-family:inherit;font-size:13px;padding:7px 10px;border-radius:3px;outline:none;text-align:center;letter-spacing:2px}
#captcha-answer:focus{border-color:var(--yellow)}
#captcha-submit{background:#2a2000;border:1px solid var(--yellow);color:var(--yellow);font-family:inherit;font-size:12px;font-weight:700;padding:7px 16px;border-radius:3px;cursor:pointer}
#captcha-submit:hover{background:#3a3000}
.captcha-refresh{background:none;border:1px solid var(--border);color:var(--dim);font-family:inherit;font-size:10px;padding:4px 10px;border-radius:3px;cursor:pointer;width:100%}
.captcha-refresh:hover{border-color:var(--cyan);color:var(--cyan)}
.captcha-status{font-size:11px;min-height:16px}
.captcha-status.ok{color:var(--green)}
.captcha-status.err{color:var(--red)}
</style>
</head>
<body>

<header>
  <div class="logo">⚡ MC<span>Bot</span></div>
  <div class="uptime-badge">UP: <span id="uptime">00:00:00</span></div>
  <div class="header-btns">
    <button class="hdr-btn" onclick="reconnectSSE()">⟳ Reconnect</button>
    <span id="conn-status" class="connecting">⬤ CONNECTING</span>
  </div>
</header>

<!-- Server card -->
<div id="server-card">
  <div id="server-favicon" class="placeholder">🌐</div>
  <div class="server-info">
    <div id="server-motd">Pinging server...</div>
    <div class="server-meta">
      <span>🖥 <span id="server-ip">${HOST}:${MC_PORT}</span></span>
      <span>👥 <span id="server-players">--/--</span></span>
      <span>📦 <span id="server-version">--</span></span>
    </div>
  </div>
  <button class="srv-refresh" onclick="refreshServerInfo()">⟳ Ping</button>
</div>

<div style="display:flex;flex-direction:column;flex:1;overflow:hidden">
  <div class="cards-row" id="cards"></div>
  <div class="console-area" id="console-area"></div>
</div>

<!-- CMD Modal -->
<div class="modal-overlay" id="cmd-modal" onclick="if(event.target.id==='cmd-modal')closeModal('cmd-modal')">
  <div class="modal">
    <div class="modal-head">
      <span class="modal-title" id="cmd-modal-title"></span>
      <button class="modal-close" onclick="closeModal('cmd-modal')">✕</button>
    </div>
    <div class="modal-log" id="modal-log"></div>
    <div class="modal-cmd">
      <input class="modal-input" id="modal-input" placeholder="Type command or chat (e.g. /tp ~ ~ ~)..."
        onkeydown="if(event.key==='Enter')sendModalCmd()">
      <button class="modal-send" onclick="sendModalCmd()">SEND ▶</button>
    </div>
  </div>
</div>

<!-- Captcha Modal -->
<div class="modal-overlay" id="captcha-modal" onclick="if(event.target.id==='captcha-modal')closeModal('captcha-modal')">
  <div class="modal">
    <div class="modal-head">
      <span class="modal-title" id="captcha-modal-title">🗺 Map Captcha</span>
      <button class="modal-close" onclick="closeModal('captcha-modal')">✕</button>
    </div>
    <div class="captcha-body">
      <div id="captcha-map-img">No map data yet.<br>Bot must hold a map item.</div>
      <div class="captcha-hint">Look at the map above and type the captcha answer below.</div>
      <div class="captcha-input-row">
        <input id="captcha-answer" placeholder="Answer..." onkeydown="if(event.key==='Enter')submitCaptcha()">
        <button id="captcha-submit" onclick="submitCaptcha()">SUBMIT</button>
      </div>
      <button class="captcha-refresh" onclick="fetchMap()">⟳ Refresh Map</button>
      <div class="captcha-status" id="captcha-status"></div>
    </div>
  </div>
</div>

<script>
const BOT1 = '${BOT1}';
const BOT2 = '${BOT2}';

const logsPerBot = {};
const statusMap  = {};
const statsMap   = {};
const coordsMap  = {};
const mapsData   = {};
let startTime    = Date.now();
let activeModal  = null;
let activeCaptchaBot = null;
let autoScrollMap = {};
let filterMap     = {};

// Build panes immediately so appendToPane works before first poll returns
initConsolePanes([BOT1, BOT2]);

// ── Uptime ─────────────────────────────────────────────────────────────────
setInterval(() => {
  const s = Math.floor((Date.now()-startTime)/1000);
  document.getElementById('uptime').textContent =
    [Math.floor(s/3600),Math.floor((s%3600)/60),s%60].map(n=>String(n).padStart(2,'0')).join(':');
}, 1000);

// ── Server info ────────────────────────────────────────────────────────────
function stripMC(s) { return String(s).replace(/§[0-9a-fk-or]/gi,''); }

function updateServerCard(info) {
  if (!info) {
    document.getElementById('server-motd').textContent = 'Server ping failed';
    document.getElementById('server-motd').style.color = 'var(--red)';
    return;
  }
  document.getElementById('server-motd').textContent = stripMC(info.motd || 'Unknown');
  document.getElementById('server-motd').style.color = 'var(--cyan)';
  document.getElementById('server-players').textContent = (info.onlinePlayers||0) + '/' + (info.maxPlayers||0) + ' online';
  document.getElementById('server-version').textContent = info.version || '?';
  const fav = document.getElementById('server-favicon');
  if (info.favicon && info.favicon.startsWith('data:image')) {
    fav.className = '';
    fav.innerHTML = '<img src="'+info.favicon+'" style="width:40px;height:40px;image-rendering:pixelated;border-radius:3px">';
  } else {
    fav.className = 'placeholder';
    fav.textContent = '🌐';
  }
}

async function refreshServerInfo() {
  document.getElementById('server-motd').textContent = 'Pinging...';
  document.getElementById('server-motd').style.color = 'var(--dim)';
  try {
    const r = await fetch('/serverinfo');
    updateServerCard(await r.json());
  } catch(_) {
    document.getElementById('server-motd').textContent = 'Ping failed';
  }
}

// ── Cards ──────────────────────────────────────────────────────────────────
function renderCard(name, info, st, crds) {
  let card = document.getElementById('card-'+name);
  if (!card) {
    card = document.createElement('div');
    card.id = 'card-'+name;
    document.getElementById('cards').appendChild(card);
  }
  const online = info?.online;
  const inv    = st?.inventory || {};
  const chests = st?.chests    || {};
  // Show inv and chest counts separately to avoid double-counting
  const invTear   = inv['ghast_tear']    || 0;
  const invPowder = inv['gunpowder']     || 0;
  const chestTear   = chests['ghast_tear'] || 0;
  const chestPowder = chests['gunpowder']  || 0;
  const coordsHtml = crds
    ? '<span class="coords-val">X:'+crds.x+' Y:'+crds.y+' Z:'+crds.z+'</span>'
      +'<span class="coords-ts">'+timeAgo(crds.ts)+'</span>'
      +'<button class="icon-btn" onclick="refreshCoords(\''+name+'\')" title="Refresh">⟳</button>'
    : '<span style="color:var(--dim)">unknown</span>'
      +'<button class="icon-btn" onclick="refreshCoords(\''+name+'\')" title="Refresh">⟳</button>';

  card.className = 'card '+(online?'online':'offline');
  card.innerHTML =
    '<div class="card-header">'
    +'<div class="status-dot"></div>'
    +'<div style="flex:1"><div class="card-name">'+esc(name)+'</div>'
    +'<div class="card-type">'+esc(info?.type||'Bot')+'</div></div>'
    +'<div class="card-badge">'+(online?'● ONLINE':'○ OFFLINE')+'</div>'
    +'</div>'
    +'<div class="card-stats">'
    +'<div class="stat"><span class="stat-l">KILLS </span><span class="stat-v">'+(st?.ghastKills||0)+'</span></div>'
    +'<div class="stat"><span class="stat-l">FOOD ATE </span><span class="stat-v">'+(st?.foodAte||0)+'</span></div>'
    +'</div>'
    +'<div class="coords-row">📍 '+coordsHtml+'</div>'
    +'<div class="chest-row">'
    +'💀 Tear: <span class="chest-item">inv:'+invTear+' chest:'+chestTear+'</span>'
    +' 💥 Powder: <span class="chest-item">inv:'+invPowder+' chest:'+chestPowder+'</span>'
    +'<button class="small-btn" onclick="triggerChestScan(\''+name+'\')">SCAN</button>'
    +'<button class="small-btn captcha" onclick="openCaptcha(\''+name+'\')">🗺 CAPTCHA</button>'
    +'</div>'
    +'<div class="card-btns">'
    +'<button class="btn-start" onclick="botAction(\''+name+'\',\'start\')" '+(info?.running?'disabled':'')+'>▶ START</button>'
    +'<button class="btn-stop" onclick="botAction(\''+name+'\',\'stop\')" '+(!info?.running?'disabled':'')+'>■ STOP</button>'
    +'<button class="btn-console" onclick="openCmdModal(\''+name+'\')">⌨ CMD</button>'
    +'</div>';
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 60) return s+'s ago';
  if (s < 3600) return Math.floor(s/60)+'m ago';
  return Math.floor(s/3600)+'h ago';
}

// ── Console panes ──────────────────────────────────────────────────────────
function initConsolePanes(bots) {
  const area = document.getElementById('console-area');
  area.innerHTML = '';
  // Reset per-bot state so old logs don't carry over
  for (const name of bots) {
    logsPerBot[name]    = [];
    autoScrollMap[name] = true;
    filterMap[name]     = 'all';
  }
  for (const name of bots) {
    const pane = document.createElement('div');
    pane.className = 'console-pane';
    pane.id = 'pane-'+name;
    pane.innerHTML =
      '<div class="pane-header">'
      +'<span class="pane-title">'+esc(name)+'</span>'
      +'<span class="pane-count" id="pcount-'+name+'">0</span>'
      +'<button class="pane-filter active" onclick="setPaneFilter(\''+name+'\',\'all\',this)">ALL</button>'
      +'<button class="pane-filter" onclick="setPaneFilter(\''+name+'\',\'error\',this)">ERR</button>'
      +'<button class="pane-filter" onclick="setPaneFilter(\''+name+'\',\'kill\',this)">KILL</button>'
      +'<button class="pane-filter" onclick="setPaneFilter(\''+name+'\',\'chat\',this)">CHAT</button>'
      +'<button class="pane-filter" onclick="setPaneFilter(\''+name+'\',\'inv\',this)">INV</button>'
      +'<button class="pane-clear" onclick="clearPane(\''+name+'\')">CLR</button>'
      +'</div>'
      +'<div class="log-scroll" id="scroll-'+name+'"></div>'
      +'<div class="cmd-row">'
      +'<input class="cmd-input" id="cmdinput-'+name+'" placeholder="/cmd or chat for '+esc(name)+'..." onkeydown="if(event.key===\'Enter\')sendCmd(\''+name+'\')">'
      +'<button class="cmd-send" onclick="sendCmd(\''+name+'\')">▶</button>'
      +'</div>';
    area.appendChild(pane);
    document.getElementById('scroll-'+name).addEventListener('scroll', () => {
      const el = document.getElementById('scroll-'+name);
      autoScrollMap[name] = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    });
  }
}

function setPaneFilter(bot, filter, btn) {
  filterMap[bot] = filter;
  document.querySelectorAll('#pane-'+bot+' .pane-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  rebuildPane(bot);
}

function clearPane(bot) { logsPerBot[bot] = []; rebuildPane(bot); }

const TAG_LABELS = {info:'INFO',error:'ERR',kick:'KICK',disconnect:'DISC',reconnect:'RECONN',kill:'KILL',food:'FOOD',chat:'CHAT',inv:'INV'};

function makeLogEl(entry) {
  const type = entry.type||'info';
  const div = document.createElement('div');
  div.className = 'log-line hl-'+type;
  div.dataset.type = type;
  div.innerHTML =
    '<span class="l-ts">'+new Date(entry.ts).toTimeString().slice(0,8)+'</span>'
    +'<span class="l-tag tag-'+type+'">'+(TAG_LABELS[type]||type.toUpperCase())+'</span>'
    +'<span class="l-msg msg-'+type+'">'+esc(entry.message)+'</span>';
  return div;
}

function appendToPane(entry) {
  const bot = entry.username;
  if (!logsPerBot[bot]) return;
  logsPerBot[bot].push(entry);
  const f = filterMap[bot]||'all';
  if (f === 'all' || f === entry.type) {
    const scroll = document.getElementById('scroll-'+bot);
    if (scroll) {
      scroll.appendChild(makeLogEl(entry));
      if (autoScrollMap[bot]) scroll.scrollTop = scroll.scrollHeight;
    }
    if (activeModal === bot) {
      const ml = document.getElementById('modal-log');
      if (ml) { ml.appendChild(makeLogEl(entry)); ml.scrollTop = ml.scrollHeight; }
    }
  }
  const c = document.getElementById('pcount-'+bot);
  if (c) c.textContent = logsPerBot[bot].length;
}

function rebuildPane(bot) {
  const scroll = document.getElementById('scroll-'+bot);
  if (!scroll) return;
  scroll.innerHTML = '';
  const f = filterMap[bot]||'all';
  const visible = f==='all' ? logsPerBot[bot] : logsPerBot[bot].filter(e=>e.type===f);
  visible.forEach(e => scroll.appendChild(makeLogEl(e)));
  scroll.scrollTop = scroll.scrollHeight;
}

// ── Commands ───────────────────────────────────────────────────────────────
async function sendCmd(name) {
  const input = document.getElementById('cmdinput-'+name);
  if (!input?.value.trim()) return;
  const cmd = input.value.trim(); input.value = '';
  const r = await fetch('/bot/'+encodeURIComponent(name)+'/cmd',
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd})});
  const d = await r.json();
  if (!d.ok) appendToPane({username:name,type:'error',message:'CMD failed: '+(d.reason||'?'),ts:Date.now()});
}

async function sendModalCmd() {
  if (!activeModal) return;
  const input = document.getElementById('modal-input');
  if (!input?.value.trim()) return;
  const cmd = input.value.trim(); input.value = '';
  const r = await fetch('/bot/'+encodeURIComponent(activeModal)+'/cmd',
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd})});
  const d = await r.json();
  if (!d.ok) appendToPane({username:activeModal,type:'error',message:'CMD failed: '+(d.reason||'?'),ts:Date.now()});
}

// ── CMD Modal ──────────────────────────────────────────────────────────────
function openCmdModal(name) {
  activeModal = name;
  document.getElementById('cmd-modal-title').textContent = '⌨ '+name+' — Command Console';
  const log = document.getElementById('modal-log');
  log.innerHTML = '';
  logsPerBot[name].forEach(e => log.appendChild(makeLogEl(e)));
  log.scrollTop = log.scrollHeight;
  document.getElementById('cmd-modal').classList.add('open');
  setTimeout(() => document.getElementById('modal-input').focus(), 50);
}

// ── Captcha Modal ──────────────────────────────────────────────────────────
function openCaptcha(name) {
  activeCaptchaBot = name;
  document.getElementById('captcha-modal-title').textContent = '🗺 Map Captcha — '+name;
  document.getElementById('captcha-answer').value = '';
  document.getElementById('captcha-status').textContent = '';
  document.getElementById('captcha-modal').classList.add('open');
  fetchMap();
}

async function fetchMap() {
  if (!activeCaptchaBot) return;
  const container = document.getElementById('captcha-map-img');
  container.textContent = 'Loading...';
  try {
    const r = await fetch('/bot/'+encodeURIComponent(activeCaptchaBot)+'/map');
    const d = await r.json();
    if (!d.ok) {
      container.textContent = d.reason || 'No map data. Bot must hold a map item.';
      return;
    }
    container.innerHTML = '';
    const img = document.createElement('img');
    img.src = d.png;
    img.style.cssText = 'width:100%;height:100%;image-rendering:pixelated';
    container.appendChild(img);
    document.getElementById('captcha-answer').focus();
  } catch(e) {
    container.textContent = 'Error fetching map.';
  }
}

async function submitCaptcha() {
  const answer = document.getElementById('captcha-answer').value.trim();
  const status = document.getElementById('captcha-status');
  if (!answer || !activeCaptchaBot) return;
  const r = await fetch('/bot/'+encodeURIComponent(activeCaptchaBot)+'/cmd',
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd: answer})});
  const d = await r.json();
  if (d.ok) {
    status.textContent = '✓ Sent!';
    status.className = 'captcha-status ok';
    document.getElementById('captcha-answer').value = '';
    setTimeout(() => closeModal('captcha-modal'), 1500);
  } else {
    status.textContent = '✗ Failed: '+(d.reason||'bot not connected');
    status.className = 'captcha-status err';
  }
}

// ── Modal helpers ──────────────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'cmd-modal') activeModal = null;
  if (id === 'captcha-modal') activeCaptchaBot = null;
}

// ── Bot actions ────────────────────────────────────────────────────────────
async function botAction(name, action) {
  const r = await fetch('/bot/'+encodeURIComponent(name)+'/'+action, {method:'POST'});
  const d = await r.json();
  if (!d.ok) alert('Error: '+(d.reason||'unknown'));
}

async function refreshCoords(name) {
  await fetch('/bot/'+encodeURIComponent(name)+'/coords', {method:'POST'});
}

async function triggerChestScan(name) {
  await fetch('/bot/'+encodeURIComponent(name)+'/chestscan', {method:'POST'});
}

// ── SSE ────────────────────────────────────────────────────────────────────
let es = null;
// ── Polling-based connection (works reliably on Render/proxies) ──────────────
let pollLastId   = 0;
let pollTimer    = null;
let initialised  = false;
let es           = null;

function reconnectSSE() { startPolling(); }

function handleEvent(event, data) {
  if (event === 'log')        { appendToPane(data); return; }
  if (event === 'status')     {
    const { username, online } = data;
    if (statusMap[username]) statusMap[username].online = online;
    renderCard(username, statusMap[username]||{online,type:'Bot'}, statsMap[username]||{}, coordsMap[username]);
    return;
  }
  if (event === 'stats')      {
    statsMap[data.username] = data.stats;
    renderCard(data.username, statusMap[data.username]||{}, data.stats, coordsMap[data.username]);
    return;
  }
  if (event === 'coords')     {
    coordsMap[data.username] = data.coords;
    renderCard(data.username, statusMap[data.username]||{}, statsMap[data.username]||{}, data.coords);
    return;
  }
  if (event === 'chestScan')  {
    if (statsMap[data.username]) statsMap[data.username].chests = data.chests;
    appendToPane({username:data.username,type:'inv',message:'Chest scan ('+data.count+'): '+JSON.stringify(data.chests),ts:Date.now()});
    renderCard(data.username, statusMap[data.username]||{}, statsMap[data.username]||{}, coordsMap[data.username]);
    return;
  }
  if (event === 'mapUpdate')  {
    mapsData[data.username] = { png: data.png, ts: data.ts };
    if (activeCaptchaBot === data.username) {
      const c = document.getElementById('captcha-map-img');
      c.innerHTML = '';
      const img = document.createElement('img');
      img.src = data.png;
      img.style.cssText = 'width:100%;height:100%;image-rendering:pixelated';
      c.appendChild(img);
    }
    return;
  }
  if (event === 'control')    {
    if (statusMap[data.username]) statusMap[data.username].running = (data.action==='started');
    renderCard(data.username, statusMap[data.username]||{}, statsMap[data.username]||{}, coordsMap[data.username]);
    return;
  }
  if (event === 'serverInfo') { updateServerCard(data); return; }
}

async function doPoll() {
  const connEl = document.getElementById('conn-status');
  try {
    const r = await fetch('/poll?since=' + pollLastId);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();

    if (!initialised) {
      initialised = true;
      // Build panes FIRST before touching any logs
      const { status, stats, coords: crds, serverInfo: si, serverStart } = d.state;
      if (serverStart) startTime = serverStart; // sync uptime to server
      const bots = Object.keys(status);
      initConsolePanes(bots);
      for (const [name, info] of Object.entries(status)) {
        statusMap[name] = info;
        statsMap[name]  = stats[name] || {};
        coordsMap[name] = crds[name]  || null;
        renderCard(name, info, statsMap[name], coordsMap[name]);
      }
      if (si) updateServerCard(si);
      // Replay all historical log events from queue
      for (const ev of d.events) {
        if (ev.event === 'log') appendToPane(ev.data);
      }
      pollLastId = d.lastId;
      connEl.className = 'connected';
      connEl.textContent = '⬤ LIVE';
    } else {
      // Normal poll — process all new events
      for (const ev of d.events) handleEvent(ev.event, ev.data);
      pollLastId = d.lastId;
      connEl.className = 'connected';
      connEl.textContent = '⬤ LIVE';
    }
  } catch(err) {
    connEl.className = 'disconnected';
    connEl.textContent = '⬤ DISCONNECTED — retrying...';
    initialised = false;
    pollLastId  = 0;
  }
  pollTimer = setTimeout(doPoll, 2000);
}

function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  initialised = false;
  pollLastId  = 0;
  document.getElementById('conn-status').className   = 'connecting';
  document.getElementById('conn-status').textContent = '⬤ CONNECTING';
  doPoll();
}

function connect() { startPolling(); }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

connect();
refreshServerInfo();
setInterval(refreshServerInfo, 5 * 60 * 1000);
</script>
</body>
</html>`);
});

// ─── Start server FIRST, then bots ────────────────────────────────────────────
app.listen(PORT_WEB, () => {
  console.log('[Dashboard] http://localhost:' + PORT_WEB);

  // SSE keepalive ping
  setInterval(() => {
    sseClients.forEach(res => { res.write(': ping\n\n'); if (res.flush) res.flush(); });
  }, 8000);

  // Fetch server info in background — don't block startup
  setTimeout(() => {
    fetchServerInfo().then(info => {
      serverInfo = info;
      if (info) {
        broadcast('serverInfo', info);
        console.log('[Server] ' + info.motd + ' | ' + info.onlinePlayers + '/' + info.maxPlayers);
      } else {
        console.log('[Server] ping failed or timed out');
      }
    }).catch(() => {});
  }, 3000);

  // Start bots after port is registered — store controllers for start/stop
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
