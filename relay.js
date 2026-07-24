// ============ relay.js — Minecraft PE multiplayer relay ============
// A dumb pipe: pairs a host + up to 9 guests by a 6-digit room code and forwards
// JSON messages between them. Knows nothing about game state. Everyone connects
// OUTBOUND to this server (ws:// or wss://) — no port forwarding, no inbound
// connection to anyone's home network.
//
// Peer ids ("pid"): the host is always 0, guests get 1..maxPlayers-1 (smallest
// free id, reused after someone leaves so the client's skin slots stay bounded).
// Routing of any non-control frame:
//   msg.to == null  -> broadcast to everyone in the room except the sender
//   msg.to === <pid> -> delivered to that peer only
// Every forwarded frame is stamped with `from` = the sender's pid.
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8127;
const MAX_ROOMS = 500;                 // hard cap on concurrent rooms
const MAX_PER_IP = 5;                  // rooms a single IP may host at once
const ROOM_TTL_MS = 1000 * 60 * 30;    // unclaimed/idle room reaped after 30 min
const MSG_RATE_LIMIT = 150;            // max messages per socket per second
const MIN_PLAYERS = 2, MAX_PLAYERS = 10; // total players in a room, host included
// world-snapshot frames (seed + all block edits) can be large; allow up to 4MB.
// pos updates are tiny — the rate limit is the real flood guard.
const MAX_MSG_BYTES = 4 * 1024 * 1024; // reject oversized frames

// rooms: code -> { host, guests: Map<pid, ws>, hostIP, maxPlayers, createdAt, lastActivity }
const rooms = new Map();
const ipRoomCount = new Map();

function genCode() {
  for (let tries = 0; tries < 20; tries++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
  return null; // absurdly unlucky / rooms full
}

function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function clampSlots(n) {
  n = Math.round(Number(n));
  if (!isFinite(n)) return 2;
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
}

function playerCount(r) { return 1 + r.guests.size; }

// smallest free guest id in 1..maxPlayers-1, or 0 if the room is full
function freePid(r) {
  for (let pid = 1; pid < r.maxPlayers; pid++) if (!r.guests.has(pid)) return pid;
  return 0;
}

function sendTo(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}

// everyone in the room except `exceptPid` (pass -1 for "really everyone")
function roomBroadcast(r, obj, exceptPid) {
  if (exceptPid !== 0) sendTo(r.host, obj);
  for (const [pid, ws] of r.guests) if (pid !== exceptPid) sendTo(ws, obj);
}

function peerOf(r, pid) { return pid === 0 ? r.host : r.guests.get(pid); }

function closeRoom(code, reason) {
  const r = rooms.get(code);
  if (!r) return;
  for (const side of [r.host, ...r.guests.values()]) {
    if (side && side.readyState === side.OPEN) {
      try { side.send(JSON.stringify({ t: 'closed', reason })); side.close(); } catch (e) {}
    }
  }
  rooms.delete(code);
  const n = ipRoomCount.get(r.hostIP) || 0;
  if (n <= 1) ipRoomCount.delete(r.hostIP); else ipRoomCount.set(r.hostIP, n - 1);
}

// periodic reap of stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.lastActivity > ROOM_TTL_MS) closeRoom(code, 'timeout');
  }
}, 60 * 1000);

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  ws._ip = ip;
  ws._rate = { count: 0, windowStart: Date.now() };
  ws._role = null;   // 'host' | 'guest'
  ws._pid = null;    // 0 for host, 1..n for guests
  ws._code = null;

  ws.on('message', (raw) => {
    // per-socket rate limit
    const now = Date.now();
    if (now - ws._rate.windowStart > 1000) { ws._rate.windowStart = now; ws._rate.count = 0; }
    if (++ws._rate.count > MSG_RATE_LIMIT) { ws.close(1008, 'rate limit'); return; }

    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'host') {
      if (ws._role) return; // already assigned a role
      if (rooms.size >= MAX_ROOMS) { sendTo(ws, { t: 'error', msg: 'server full' }); ws.close(); return; }
      if ((ipRoomCount.get(ip) || 0) >= MAX_PER_IP) { sendTo(ws, { t: 'error', msg: 'too many rooms from this connection' }); ws.close(); return; }
      const code = genCode();
      if (!code) { sendTo(ws, { t: 'error', msg: 'no codes available, try again' }); ws.close(); return; }
      const maxPlayers = clampSlots(msg.slots);
      rooms.set(code, { host: ws, guests: new Map(), hostIP: ip, maxPlayers, createdAt: now, lastActivity: now });
      ipRoomCount.set(ip, (ipRoomCount.get(ip) || 0) + 1);
      ws._role = 'host'; ws._pid = 0; ws._code = code;
      sendTo(ws, { t: 'hosted', code, pid: 0, slots: maxPlayers, count: 1 });
      return;
    }

    if (msg.t === 'join') {
      if (ws._role) return;
      const code = String(msg.code || '').trim();
      const r = rooms.get(code);
      if (!r) { sendTo(ws, { t: 'error', msg: 'room not found' }); return; }
      const pid = freePid(r);
      if (!pid) { sendTo(ws, { t: 'error', msg: 'room full' }); return; }
      r.guests.set(pid, ws); r.lastActivity = now;
      ws._role = 'guest'; ws._pid = pid; ws._code = code;
      const peers = [0, ...r.guests.keys()].filter((p) => p !== pid);
      sendTo(ws, { t: 'joined', code, pid, slots: r.maxPlayers, count: playerCount(r), peers });
      roomBroadcast(r, { t: 'peer_join', pid, count: playerCount(r), slots: r.maxPlayers }, pid);
      return;
    }

    if (!ws._role || !ws._code) return;
    const r = rooms.get(ws._code);
    if (!r) return;
    r.lastActivity = now;

    // host may resize the room while it's live (never below the players already in)
    if (msg.t === 'slots') {
      if (ws._role !== 'host') return;
      r.maxPlayers = Math.max(clampSlots(msg.n), playerCount(r));
      roomBroadcast(r, { t: 'room', slots: r.maxPlayers, count: playerCount(r) }, -1);
      return;
    }

    // anything else: relay to the room, untouched apart from the `from` stamp
    // (re-stamped so a receiver never has to trust a client-supplied "from")
    msg.from = ws._pid;
    if (msg.to != null) {
      const target = peerOf(r, msg.to | 0);
      if (target && target !== ws) sendTo(target, msg);
    } else {
      roomBroadcast(r, msg, ws._pid);
    }
  });

  ws.on('close', () => {
    if (!ws._code) return;
    const r = rooms.get(ws._code);
    if (!r) return;
    if (ws._role === 'host') {
      closeRoom(ws._code, 'host left');
    } else if (ws._role === 'guest') {
      if (r.guests.get(ws._pid) === ws) r.guests.delete(ws._pid);
      roomBroadcast(r, { t: 'peer_leave', pid: ws._pid, count: playerCount(r), slots: r.maxPlayers }, ws._pid);
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => console.log('Minecraft PE relay listening on :' + PORT));
