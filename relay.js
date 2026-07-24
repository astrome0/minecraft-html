// ============ relay.js — Minecraft PE multiplayer relay ============
// A dumb pipe: pairs a host + one guest by a 6-digit room code and forwards
// JSON messages between them. Knows nothing about game state. Both sides
// connect OUTBOUND to this server (ws:// or wss://) — no port forwarding,
// no inbound connection to anyone's home network.
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8127;
const MAX_ROOMS = 500;                 // hard cap on concurrent rooms
const MAX_PER_IP = 5;                  // rooms a single IP may host at once
const ROOM_TTL_MS = 1000 * 60 * 30;    // unclaimed/idle room reaped after 30 min
const MSG_RATE_LIMIT = 90;             // max messages per socket per second
// world-snapshot frames (seed + all block edits) can be large; allow up to 4MB.
// pos updates are tiny — the rate limit is the real flood guard.
const MAX_MSG_BYTES = 4 * 1024 * 1024; // reject oversized frames

// rooms: code -> { host, guest, hostIP, createdAt, lastActivity }
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

function closeRoom(code, reason) {
  const r = rooms.get(code);
  if (!r) return;
  for (const side of [r.host, r.guest]) {
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
      if (rooms.size >= MAX_ROOMS) { ws.send(JSON.stringify({ t: 'error', msg: 'server full' })); ws.close(); return; }
      if ((ipRoomCount.get(ip) || 0) >= MAX_PER_IP) { ws.send(JSON.stringify({ t: 'error', msg: 'too many rooms from this connection' })); ws.close(); return; }
      const code = genCode();
      if (!code) { ws.send(JSON.stringify({ t: 'error', msg: 'no codes available, try again' })); ws.close(); return; }
      rooms.set(code, { host: ws, guest: null, hostIP: ip, createdAt: now, lastActivity: now });
      ipRoomCount.set(ip, (ipRoomCount.get(ip) || 0) + 1);
      ws._role = 'host'; ws._code = code;
      ws.send(JSON.stringify({ t: 'hosted', code }));
      return;
    }

    if (msg.t === 'join') {
      if (ws._role) return;
      const code = String(msg.code || '').trim();
      const r = rooms.get(code);
      if (!r) { ws.send(JSON.stringify({ t: 'error', msg: 'room not found' })); return; }
      if (r.guest) { ws.send(JSON.stringify({ t: 'error', msg: 'room full' })); return; }
      r.guest = ws; r.lastActivity = now;
      ws._role = 'guest'; ws._code = code;
      ws.send(JSON.stringify({ t: 'joined', code }));
      if (r.host.readyState === r.host.OPEN) r.host.send(JSON.stringify({ t: 'guest_joined' }));
      return;
    }

    // anything else: relay to the other side of the room, untouched
    if (!ws._role || !ws._code) return;
    const r = rooms.get(ws._code);
    if (!r) return;
    r.lastActivity = now;
    const other = ws._role === 'host' ? r.guest : r.host;
    if (other && other.readyState === other.OPEN) {
      // re-stamp so the receiver knows who it's from without trusting client-supplied "from"
      msg.from = ws._role;
      other.send(JSON.stringify(msg));
    }
  });

  ws.on('close', () => {
    if (!ws._code) return;
    const r = rooms.get(ws._code);
    if (!r) return;
    if (ws._role === 'host') {
      closeRoom(ws._code, 'host left');
    } else if (ws._role === 'guest') {
      r.guest = null;
      if (r.host.readyState === r.host.OPEN) r.host.send(JSON.stringify({ t: 'guest_left' }));
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => console.log('Minecraft PE relay listening on :' + PORT));
