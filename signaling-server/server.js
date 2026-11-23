'use strict';
/**
 * server.js — Private WebSocket signaling server for «شبكة الناس».
 *
 * Owns no public broker: clients connect directly to this server (wss://
 * behind a TLS reverse proxy in production — see README.md).
 *
 * What this server DOES:
 *   - rooms of towers numbered 1–8 (join with a chosen free node, or auto)
 *   - presence: heartbeats every 5s from the client; silence > 15s removes
 *     the tower and notifies the room; a dropped socket is a last-will
 *     (peer-left broadcast) immediately
 *   - WebRTC signaling relay: offer/answer/ICE between two towers in the
 *     same room (server only forwards, never reads SDP)
 *   - sealed-sender message relay: an opaque envelope is forwarded to the
 *     recipient as-is, WITHOUT any sender identity attached, and is never
 *     logged or stored
 *   - public key-bundle store (X25519 identity + signed prekey + one-time
 *     prekeys) for the Signal Protocol — public keys only, never private
 *   - rejoin with the same (towerId, device) replaces the old connection;
 *     a DIFFERENT device with the same towerId coexists (same identity on
 *     two phones after a QR identity transfer) — presence stays one entry
 *     per towerId, and sync-* messages are relayed between the devices of
 *     one towerId only (history sync, see PROTOCOL.md)
 *
 * What this server does NOT do: encryption/decryption, message storage,
 * push notifications, authentication. See PROTOCOL.md.
 */

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { KeyStore } = require('./keystore');

// ---------------------------------------------------------------------------
// Configuration (environment)
// ---------------------------------------------------------------------------
const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0';
/** A tower silent longer than this is removed from presence (v3.3: 15 s). */
const HEARTBEAT_TIMEOUT_MS = 15_000;
/** How often the server sweeps for silent towers. */
const SWEEP_INTERVAL_MS = 5_000;
/** Max WebSocket message size (also enforced by ws maxPayload). */
const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB
/** Rate limit: max messages per connection per minute. */
const RATE_LIMIT_PER_MINUTE = 60;
/** Towers per room (nodes 1–8, as in the v3.3 web prototype). */
const MAX_TOWERS_PER_ROOM = 8;

const CLOSE_REPLACED = 4001; // same towerId rejoined from a new connection

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function randomSuffix() {
  return crypto.randomBytes(3).toString('hex');
}

function cleanString(v, maxLen) {
  if (typeof v !== 'string') return '';
  const s = v.trim().slice(0, maxLen);
  return s;
}

function validRoom(room) {
  return typeof room === 'string' && room.trim().length > 0 && room.trim().length <= 64;
}

function validNode(node) {
  return Number.isInteger(node) && node >= 1 && node <= MAX_TOWERS_PER_ROOM;
}

/** Presence entry sent to clients (mirrors the v3.3 presence payload). */
function presenceOf(peer) {
  return {
    towerId: peer.towerId,
    node: peer.node,
    name: peer.info.name,
    uname: peer.info.uname,
    ucolor: peer.info.ucolor,
    uicon: peer.info.uicon,
    super: peer.info.super,
    call: peer.info.call,
    relayLoad: peer.info.relayLoad,
    device: peer.info.device,
    tab: peer.info.tab,
  };
}

// ---------------------------------------------------------------------------
// Server factory (also usable from tests)
// ---------------------------------------------------------------------------
function createSignalingServer(options = {}) {
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
  const keystore = options.keystore ?? new KeyStore(options.keystorePath);
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  const wss = new WebSocketServer({
    port,
    host,
    maxPayload: MAX_MESSAGE_BYTES,
  });

  /** Map<room, Map<deviceKey, peer>> — one entry per CONNECTED DEVICE.
   * A towerId may have several devices at once (same identity on several
   * phones); the key is towerId + device so only the same (towerId,
   * device) pair replaces an old connection. Presence stays one entry
   * per towerId (see uniquePresenceList). */
  const rooms = new Map();

  /** Key of one device's connection inside a room's peer map. */
  function deviceKey(towerId, device) {
    return `${towerId}\n${device || ''}`;
  }

  /** All connected devices of one towerId in a room (join order). */
  function peersForTower(room, towerId) {
    const peers = rooms.get(room);
    if (!peers) return [];
    return Array.from(peers.values()).filter((p) => p.towerId === towerId);
  }

  /** First (earliest-joined) device of a towerId, or undefined. */
  function firstPeerForTower(room, towerId) {
    return peersForTower(room, towerId)[0];
  }

  /** Presence list for a room: exactly one entry per towerId (the
   * earliest-joined device represents the tower). */
  function uniquePresenceList(room) {
    const peers = rooms.get(room);
    if (!peers) return [];
    const seen = new Set();
    const list = [];
    for (const peer of peers.values()) {
      if (seen.has(peer.towerId)) continue;
      seen.add(peer.towerId);
      list.push(presenceOf(peer));
    }
    return list;
  }

  function roomPeers(room) {
    let m = rooms.get(room);
    if (!m) { m = new Map(); rooms.set(room, m); }
    return m;
  }

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (_) { /* socket going away */ }
    }
  }

  function sendError(ws, code, message) {
    send(ws, { type: 'error', code, message });
  }

  function broadcast(room, obj, exceptTowerId) {
    const peers = rooms.get(room);
    if (!peers) return;
    const raw = JSON.stringify(obj);
    for (const peer of peers.values()) {
      // exceptTowerId excludes ALL devices of that tower (map keys are
      // deviceKeys now, so compare the towerId field, not the key).
      if (peer.towerId === exceptTowerId) continue;
      if (peer.ws.readyState === peer.ws.OPEN) {
        try { peer.ws.send(raw); } catch (_) { /* ignore */ }
      }
    }
  }

  function broadcastPresence(room) {
    const list = uniquePresenceList(room);
    broadcast(room, { type: 'presence', room, peers: list });
  }

  function freeNode(room) {
    const peers = rooms.get(room);
    const taken = new Set(peers ? Array.from(peers.values(), (p) => p.node) : []);
    for (let n = 1; n <= MAX_TOWERS_PER_ROOM; n++) {
      if (!taken.has(n)) return n;
    }
    return null;
  }

  /** Remove one DEVICE's connection from its room. The tower leaves
   * presence (peer-left) only when its LAST device disconnects. */
  function removePeer(peer, reason) {
    if (!peer.room) return;
    const peers = rooms.get(peer.room);
    if (!peers || !peers.has(peer.deviceKey)) return;
    peers.delete(peer.deviceKey);
    if (peers.size === 0) rooms.delete(peer.room);
    if (peersForTower(peer.room, peer.towerId).length > 0) {
      // Another device of the same tower is still online: the tower
      // stays in presence, no peer-left.
      console.log('[mesh] device %s of tower %s left room %s (%s) — tower stays',
        peer.device || '(no device)', peer.towerId, peer.room, reason);
      peer.room = null;
      return;
    }
    broadcast(peer.room, {
      type: 'peer-left', room: peer.room, towerId: peer.towerId, node: peer.node, reason,
    });
    console.log('[mesh] tower %s left room %s (%s)', peer.towerId, peer.room, reason);
    peer.room = null;
  }

  // -- message handlers -----------------------------------------------------

  function handleJoin(ws, ctx, msg) {
    if (ctx.peer.room) {
      sendError(ws, 'already_joined', 'Already in a room — send leave first.');
      return;
    }
    const room = cleanString(msg.room, 64);
    if (!validRoom(room)) {
      sendError(ws, 'invalid_room', 'room must be a non-empty string of at most 64 chars.');
      return;
    }
    const peers = roomPeers(room);

    // Identity is (towerId, device). Rejoin with the SAME pair replaces
    // the old connection (client-side reconnect logic): the old socket is
    // closed, its last-will fires once. A DIFFERENT device with the same
    // towerId (same identity on a second phone) coexists — it inherits
    // the tower's node and does not count as a new tower.
    let towerId = cleanString(msg.towerId, 128);
    const device = cleanString(msg.device, 128);
    if (towerId && peers.has(deviceKey(towerId, device))) {
      const old = peers.get(deviceKey(towerId, device));
      peers.delete(deviceKey(towerId, device));
      try { old.ws.close(CLOSE_REPLACED, 'replaced by a new connection'); } catch (_) {}
      console.log('[mesh] tower %s device %s reconnected — old connection replaced',
        towerId, device || '(no device)');
    }

    let node = msg.node;
    const sameTower = towerId ? peersForTower(room, towerId) : [];
    if (sameTower.length > 0) {
      // Another device of this tower is already here: same node, no
      // node_taken check, no extra peer-joined broadcast (below).
      node = sameTower[0].node;
    } else if (node !== undefined && node !== null) {
      node = Number(node);
      if (!validNode(node)) {
        sendError(ws, 'invalid_node', 'node must be an integer from 1 to 8.');
        return;
      }
      const clash = Array.from(peers.values()).find((p) => p.node === node);
      if (clash) {
        sendError(ws, 'node_taken', `Tower ${node} is already taken in this room.`);
        return;
      }
    } else {
      node = freeNode(room);
      if (node === null) {
        sendError(ws, 'room_full', 'Room is full (8 towers).');
        return;
      }
    }

    if (!towerId) towerId = `tower-${node}-${randomSuffix()}`;

    const isFirstDevice = sameTower.length === 0;
    const peer = {
      ws,
      towerId,
      device,
      deviceKey: deviceKey(towerId, device),
      node,
      room,
      lastSeen: Date.now(),
      info: {
        name: cleanString(msg.name, 64) || `برج ${node}`,
        uname: cleanString(msg.uname, 64),
        ucolor: cleanString(msg.ucolor, 16),
        uicon: cleanString(msg.uicon, 8),
        super: msg.super === true,
        call: cleanString(msg.call, 16) || 'idle',
        relayLoad: Number.isFinite(msg.relayLoad) ? msg.relayLoad : 0,
        device: cleanString(msg.device, 128),
        tab: cleanString(msg.tab, 128),
      },
    };
    peers.set(peer.deviceKey, peer);
    ctx.peer = peer;

    // Presence is one entry per towerId; the joining device never sees
    // its own tower in the list.
    const others = uniquePresenceList(room)
      .filter((p) => p.towerId !== towerId);
    send(ws, { type: 'joined', room, towerId, node, peers: others });
    // peer-joined only when the FIRST device of a tower joins.
    if (isFirstDevice) {
      broadcast(room, { type: 'peer-joined', room, peer: presenceOf(peer) }, towerId);
    }
    console.log('[mesh] tower %s (device %s) joined room %s as node %d',
      towerId, device || '(no device)', room, node);
  }

  function handleLeave(ws, ctx) {
    if (!ctx.peer.room) {
      sendError(ws, 'not_joined', 'Not in a room.');
      return;
    }
    removePeer(ctx.peer, 'leave');
    ctx.peer = { room: null };
    send(ws, { type: 'left' });
  }

  function handleHeartbeat(ws, ctx) {
    if (!ctx.peer.room) {
      sendError(ws, 'not_joined', 'Join a room before sending a heartbeat.');
      return;
    }
    ctx.peer.lastSeen = Date.now();
    send(ws, { type: 'pong', ts: Date.now() });
  }

  function handlePresence(ws, ctx, msg) {
    const peer = ctx.peer;
    if (!peer.room) {
      sendError(ws, 'not_joined', 'Join a room before updating presence.');
      return;
    }
    peer.lastSeen = Date.now();
    if (typeof msg.name === 'string') peer.info.name = cleanString(msg.name, 64);
    if (typeof msg.uname === 'string') peer.info.uname = cleanString(msg.uname, 64);
    if (typeof msg.ucolor === 'string') peer.info.ucolor = cleanString(msg.ucolor, 16);
    if (typeof msg.uicon === 'string') peer.info.uicon = cleanString(msg.uicon, 8);
    if (typeof msg.super === 'boolean') peer.info.super = msg.super;
    if (typeof msg.call === 'string') peer.info.call = cleanString(msg.call, 16);
    if (Number.isFinite(msg.relayLoad)) peer.info.relayLoad = msg.relayLoad;
    if (typeof msg.device === 'string') peer.info.device = cleanString(msg.device, 128);
    if (typeof msg.tab === 'string') peer.info.tab = cleanString(msg.tab, 128);
    broadcastPresence(peer.room);
  }

  function handleSignal(ws, ctx, msg) {
    const peer = ctx.peer;
    if (!peer.room) {
      sendError(ws, 'not_joined', 'Join a room before sending signals.');
      return;
    }
    const to = cleanString(msg.to, 128);
    const signalType = cleanString(msg.signalType, 32);
    if (!to || !signalType) {
      sendError(ws, 'invalid_signal', 'signal needs "to" and "signalType".');
      return;
    }
    const peers = rooms.get(peer.room);
    const target = peers && firstPeerForTower(peer.room, to);
    if (!target) {
      sendError(ws, 'peer_not_found', `Tower ${to} is not in this room.`);
      return;
    }
    if (to === peer.towerId) {
      sendError(ws, 'invalid_signal', 'Cannot signal yourself.');
      return;
    }
    // Forward verbatim apart from stamping the sender. SDP/ICE are opaque
    // to this server — it never parses them. If the target tower has
    // several devices online, the signal goes to its earliest-joined one.
    const out = { type: 'signal', from: peer.towerId, to, signalType };
    if (msg.sdp !== undefined) out.sdp = msg.sdp;
    if (msg.candidate !== undefined) out.candidate = msg.candidate;
    if (msg.mode !== undefined) out.mode = msg.mode;
    if (msg.groupId !== undefined) out.groupId = msg.groupId;
    if (msg.renegotiate !== undefined) out.renegotiate = msg.renegotiate;
    send(target.ws, out);
  }

  function handleMessage(ws, ctx, msg) {
    const peer = ctx.peer;
    if (!peer.room) {
      sendError(ws, 'not_joined', 'Join a room before sending messages.');
      return;
    }
    const to = cleanString(msg.to, 128);
    const envelope = msg.envelope;
    if (!to || typeof envelope !== 'string' || envelope.length === 0
      || envelope.length > MAX_MESSAGE_BYTES) {
      sendError(ws, 'invalid_message', 'message needs "to" and a non-empty string "envelope".');
      return;
    }
    const peers = rooms.get(peer.room);
    const target = peers && firstPeerForTower(peer.room, to);
    if (!target) {
      sendError(ws, 'peer_not_found', `Tower ${to} is not in this room.`);
      return;
    }
    if (to === peer.towerId) {
      sendError(ws, 'invalid_message', 'Cannot message yourself.');
      return;
    }
    // SEALED SENDER: the envelope is forwarded exactly as received, with NO
    // sender identity attached and nothing logged. Only the recipient can
    // open it and learn who sent it. If the target tower has several
    // devices online, the envelope goes to its earliest-joined one.
    send(target.ws, { type: 'message', envelope });
  }

  /**
   * History sync between devices of the SAME towerId (sync-request /
   * sync-offer / sync-chunk). The sender addresses the message to its own
   * towerId; the server relays it to the OTHER devices of that towerId
   * only — never back to the sender, never to another tower. Payloads
   * (sync-chunk `data`) are opaque encrypted blobs: the server never
   * reads, logs, or stores them.
   */
  function handleSync(ws, ctx, msg) {
    const peer = ctx.peer;
    if (!peer.room) {
      sendError(ws, 'not_joined', 'Join a room before syncing history.');
      return;
    }
    const to = cleanString(msg.to, 128);
    if (to !== peer.towerId) {
      sendError(ws, 'invalid_sync', 'sync messages must be addressed to your own towerId.');
      return;
    }
    const others = peersForTower(peer.room, peer.towerId)
      .filter((p) => p.deviceKey !== peer.deviceKey);
    if (others.length === 0) {
      sendError(ws, 'sync_no_peer', 'No other device of this tower is online.');
      return;
    }
    // Relay verbatim (the client stamps its own device id in the payload).
    const raw = JSON.stringify(msg);
    for (const p of others) {
      if (p.ws.readyState === p.ws.OPEN) {
        try { p.ws.send(raw); } catch (_) { /* socket going away */ }
      }
    }
  }

  function handleKeyBundle(ws, ctx, msg) {
    const peer = ctx.peer;
    if (msg.action === 'put') {
      if (!peer.room) {
        sendError(ws, 'not_joined', 'Join a room before storing a key bundle.');
        return;
      }
      const err = keystore.put(peer.towerId, msg.bundle);
      if (err) {
        sendError(ws, 'invalid_key_bundle', err);
        return;
      }
      send(ws, { type: 'key-bundle', action: 'put', towerId: peer.towerId, ok: true });
      return;
    }
    if (msg.action === 'get') {
      const towerId = cleanString(msg.towerId, 128);
      if (!towerId) {
        sendError(ws, 'invalid_key_bundle', 'get needs a "towerId".');
        return;
      }
      const entry = keystore.get(towerId);
      if (!entry) {
        sendError(ws, 'key_bundle_not_found', `No key bundle for tower ${towerId}.`);
        return;
      }
      // X3DH: hand out exactly one one-time prekey and delete it from the
      // store so it is never reused.
      const bundle = JSON.parse(JSON.stringify(entry.bundle));
      const used = keystore.consumeOneTimePreKey(towerId);
      bundle.oneTimePreKeys = used ? [used] : [];
      send(ws, { type: 'key-bundle', action: 'get', towerId, bundle });
      return;
    }
    sendError(ws, 'invalid_key_bundle', 'action must be "put" or "get".');
  }

  // -- connection lifecycle -------------------------------------------------

  wss.on('connection', (ws) => {
    const ctx = {
      peer: { room: null },
      // Sliding-window rate limit timestamps (ms).
      msgTimes: [],
    };

    ws.on('message', (data) => {
      // Rate limit: 60 messages / minute per connection.
      const now = Date.now();
      ctx.msgTimes = ctx.msgTimes.filter((t) => now - t < 60_000);
      if (ctx.msgTimes.length >= RATE_LIMIT_PER_MINUTE) {
        sendError(ws, 'rate_limited',
          `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE} messages/minute). Slow down.`);
        return;
      }
      ctx.msgTimes.push(now);

      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch (_) {
        sendError(ws, 'invalid_json', 'Message must be valid JSON.');
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        sendError(ws, 'invalid_message', 'Message must be a JSON object.');
        return;
      }
      switch (msg.type) {
        case 'join': handleJoin(ws, ctx, msg); break;
        case 'leave': handleLeave(ws, ctx); break;
        case 'heartbeat': handleHeartbeat(ws, ctx); break;
        case 'presence': handlePresence(ws, ctx, msg); break;
        case 'signal': handleSignal(ws, ctx, msg); break;
        case 'message': handleMessage(ws, ctx, msg); break;
        case 'sync-request':
        case 'sync-offer':
        case 'sync-chunk': handleSync(ws, ctx, msg); break;
        case 'key-bundle': handleKeyBundle(ws, ctx, msg); break;
        default:
          sendError(ws, 'unknown_type', `Unknown message type: ${String(msg.type).slice(0, 32)}`);
      }
    });

    ws.on('close', () => {
      // Last-will: a dropped socket removes the tower at once.
      if (ctx.peer.room) removePeer(ctx.peer, 'disconnect');
    });

    ws.on('error', () => { /* socket errors are followed by close */ });
  });

  // -- presence sweep: silence > 15 s removes the tower --------------------
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const peers of rooms.values()) {
      for (const peer of Array.from(peers.values())) {
        if (now - peer.lastSeen > heartbeatTimeoutMs) {
          removePeer(peer, 'timeout');
        }
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // -- graceful shutdown ------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(sweepTimer);
    keystore.saveNow();
    return new Promise((resolve) => {
      for (const client of wss.clients) {
        try { client.close(1001, 'server shutting down'); } catch (_) {}
      }
      wss.close(() => resolve());
    });
  }

  function address() {
    return wss.address();
  }

  return { wss, keystore, rooms, close, address };
}

// ---------------------------------------------------------------------------
// Standalone run: `node server.js`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const server = createSignalingServer();
  server.wss.on('listening', () => {
    const addr = server.address();
    console.log('[mesh] signaling server listening on %s:%d', addr.address, addr.port);
    console.log('[mesh] limits: 1 MB max message, 60 msgs/min per connection, '
      + 'presence timeout 15 s, max 8 towers/room');
    console.log('[mesh] TLS is expected from a reverse proxy (nginx/Caddy) — see README.md');
  });
  server.wss.on('error', (err) => {
    console.error('[mesh] failed to start: %s', err.message);
    process.exit(1);
  });
  const shutdown = () => {
    console.log('[mesh] shutting down…');
    server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createSignalingServer };
