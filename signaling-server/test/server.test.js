'use strict';
/**
 * test/server.test.js — integration tests for the signaling server.
 * Run: npm test   (node --test test/server.test.js)
 *
 * Every test starts a real server on an ephemeral port (port 0) with a
 * throwaway keystore file, and drives it with real `ws` clients.
 */

const assert = require('node:assert');
const { describe, test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createSignalingServer } = require('../server');
const { KeyStore } = require('../keystore');

let server;
let port;
let keystoreDir;

function url() {
  return `ws://127.0.0.1:${port}`;
}

/** Connect a client and collect parsed messages in `client.messages`. */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url());
    ws.messages = [];
    ws.on('message', (data) => {
      try { ws.messages.push(JSON.parse(data.toString('utf8'))); } catch (_) {}
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

/** Wait until a message matching `pred` arrives (or the timeout fires). */
function waitFor(ws, pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const found = ws.messages.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timed out waiting for message: ${pred.toString()}`));
    }, timeoutMs);
    function onMsg(data) {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (_) { return; }
      if (pred(msg)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

async function join(ws, room, node, extra = {}) {
  send(ws, { type: 'join', room, node, ...extra });
  return waitFor(ws, (m) => m.type === 'joined');
}

function validBundle() {
  const b64 = (s) => Buffer.from(s).toString('base64');
  return {
    identityKey: b64('identity-public-key-32-bytes-long!!'),
    signedPreKey: { id: 1, key: b64('signed-prekey-public'), signature: b64('sig-bytes') },
    oneTimePreKeys: [
      { id: 101, key: b64('otp-101') },
      { id: 102, key: b64('otp-102') },
    ],
  };
}

before(() => {
  keystoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-keystore-'));
  const keystore = new KeyStore(path.join(keystoreDir, 'keybundles.json'));
  // Short presence timeout so the timeout test runs fast.
  server = createSignalingServer({ port: 0, host: '127.0.0.1', keystore, heartbeatTimeoutMs: 600 });
  return new Promise((resolve) => {
    server.wss.on('listening', () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  await server.close();
  fs.rmSync(keystoreDir, { recursive: true, force: true });
});

describe('signaling server', () => {
  test('(a) two towers join one room and exchange offer/answer', async () => {
    const a = await connect();
    const b = await connect();
    try {
      const ja = await join(a, 'room-offer', 1, { name: 'برج 1' });
      const jb = await join(b, 'room-offer', 2, { name: 'برج 2' });
      assert.strictEqual(ja.node, 1);
      assert.strictEqual(jb.node, 2);
      assert.strictEqual(ja.peers.length, 0);
      assert.strictEqual(jb.peers.length, 1); // sees tower A already there

      const offerSdp = { type: 'offer', sdp: 'v=0\r\no=- fake offer\r\n' };
      send(a, { type: 'signal', to: jb.towerId, signalType: 'call-offer', sdp: offerSdp, mode: 'av' });
      const offer = await waitFor(b, (m) => m.type === 'signal' && m.signalType === 'call-offer');
      assert.strictEqual(offer.from, ja.towerId);
      assert.deepStrictEqual(offer.sdp, offerSdp);
      assert.strictEqual(offer.mode, 'av');

      const answerSdp = { type: 'answer', sdp: 'v=0\r\no=- fake answer\r\n' };
      send(b, { type: 'signal', to: ja.towerId, signalType: 'call-answer', sdp: answerSdp });
      const answer = await waitFor(a, (m) => m.type === 'signal' && m.signalType === 'call-answer');
      assert.strictEqual(answer.from, jb.towerId);
      assert.deepStrictEqual(answer.sdp, answerSdp);

      // ICE candidate also relays.
      send(a, { type: 'signal', to: jb.towerId, signalType: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host' } });
      const ice = await waitFor(b, (m) => m.type === 'signal' && m.signalType === 'ice');
      assert.strictEqual(ice.candidate.candidate, 'candidate:1 1 udp 1 1.2.3.4 5000 typ host');
    } finally {
      a.close(); b.close();
    }
  });

  test('(b) a tower that disconnects is removed from presence and the other is told', async () => {
    const a = await connect();
    const b = await connect();
    try {
      const ja = await join(a, 'room-leave', 1);
      const jb = await join(b, 'room-leave', 3);
      assert.ok(jb.peers.some((p) => p.towerId === ja.towerId));

      a.close(); // abrupt disconnect = last-will
      const left = await waitFor(b, (m) => m.type === 'peer-left' && m.towerId === ja.towerId);
      assert.strictEqual(left.reason, 'disconnect');
      assert.strictEqual(left.node, 1);

      // Presence list afterwards no longer contains the departed tower.
      send(b, { type: 'presence', call: 'idle' });
      const presence = await waitFor(b, (m) => m.type === 'presence');
      assert.ok(!presence.peers.some((p) => p.towerId === ja.towerId));
    } finally {
      b.close();
    }
  });

  test('(b2) a tower silent for >15s (shortened in test) times out of presence', async () => {
    const a = await connect();
    const b = await connect();
    try {
      const ja = await join(a, 'room-timeout', 1);
      await join(b, 'room-timeout', 2);
      // A stays connected but never sends a heartbeat; B keeps heartbeating.
      const hb = setInterval(() => send(b, { type: 'heartbeat' }), 200);
      try {
        const left = await waitFor(b, (m) => m.type === 'peer-left' && m.towerId === ja.towerId, 5000);
        assert.strictEqual(left.reason, 'timeout');
      } finally {
        clearInterval(hb);
      }
    } finally {
      a.close(); b.close();
    }
  });

  test('(c) a sealed envelope reaches the recipient verbatim, with no sender identity', async () => {
    const a = await connect();
    const b = await connect();
    try {
      const ja = await join(a, 'room-sealed', 1);
      const jb = await join(b, 'room-sealed', 2);
      const envelope = Buffer.from(JSON.stringify({
        sealed: true, iv: 'AAECAwQFBgc=', ct: '3q2+7w==',
      })).toString('base64');
      send(a, { type: 'message', to: jb.towerId, envelope, from: ja.towerId });
      const got = await waitFor(b, (m) => m.type === 'message');
      assert.strictEqual(got.envelope, envelope); // byte-for-byte identical
      assert.strictEqual(got.from, undefined); // sealed sender: no identity
      assert.strictEqual(got.to, undefined);
      // And the sender gets no copy back.
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!a.messages.some((m) => m.type === 'message'));
    } finally {
      a.close(); b.close();
    }
  });

  test('(d) a key bundle is stored and retrieved (one-time prekey handed out once)', async () => {
    const a = await connect();
    const b = await connect();
    try {
      const ja = await join(a, 'room-keys', 1);
      await join(b, 'room-keys', 2);
      const bundle = validBundle();
      send(a, { type: 'key-bundle', action: 'put', bundle });
      const putAck = await waitFor(a, (m) => m.type === 'key-bundle' && m.action === 'put');
      assert.strictEqual(putAck.ok, true);
      assert.strictEqual(putAck.towerId, ja.towerId);

      // First fetch: exactly one one-time prekey (id 101).
      send(b, { type: 'key-bundle', action: 'get', towerId: ja.towerId });
      const get1 = await waitFor(b, (m) => m.type === 'key-bundle' && m.action === 'get');
      assert.strictEqual(get1.bundle.identityKey, bundle.identityKey);
      assert.deepStrictEqual(get1.bundle.signedPreKey, bundle.signedPreKey);
      assert.deepStrictEqual(get1.bundle.oneTimePreKeys, [{ id: 101, key: bundle.oneTimePreKeys[0].key }]);

      // Second fetch: the next one-time prekey (id 102) — 101 is never reused.
      send(b, { type: 'key-bundle', action: 'get', towerId: ja.towerId });
      const get2 = await waitFor(b, (m) => m.type === 'key-bundle' && m.action === 'get'
        && m.bundle.oneTimePreKeys.length > 0
        && m.bundle.oneTimePreKeys[0].id === 102, 3000);
      assert.strictEqual(get2.bundle.oneTimePreKeys[0].id, 102);

      // Unknown tower: clear error, no bundle.
      send(b, { type: 'key-bundle', action: 'get', towerId: 'no-such-tower' });
      const err = await waitFor(b, (m) => m.type === 'error' && m.code === 'key_bundle_not_found');
      assert.ok(err.message);

      // Private keys are refused.
      send(a, { type: 'key-bundle', action: 'put', bundle: { ...bundle, privateKey: 'xxx' } });
      const perr = await waitFor(a, (m) => m.type === 'error' && m.code === 'invalid_key_bundle');
      assert.match(perr.message, /private/i);
    } finally {
      a.close(); b.close();
    }
  });

  test('node clash is rejected; auto-assign picks a free node; rooms are isolated', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    try {
      await join(a, 'room-clash', 5);
      send(b, { type: 'join', room: 'room-clash', node: 5 });
      const clash = await waitFor(b, (m) => m.type === 'error' && m.code === 'node_taken');
      assert.ok(clash.message);

      // Auto-assign: lowest free node (1).
      const jc = await join(c, 'room-clash');
      assert.strictEqual(jc.node, 1);

      // A tower in another room cannot be signalled.
      send(c, { type: 'signal', to: 'tower-9-xxxx', signalType: 'call-offer', sdp: {} });
      const nf = await waitFor(c, (m) => m.type === 'error' && m.code === 'peer_not_found');
      assert.ok(nf.message);
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  test('rejoin with the same towerId replaces the old connection', async () => {
    const a = await connect();
    const b = await connect();
    try {
      const ja = await join(a, 'room-rejoin', 2);
      const towerId = ja.towerId;
      send(b, { type: 'join', room: 'room-rejoin', node: 2, towerId });
      const jb = await waitFor(b, (m) => m.type === 'joined');
      assert.strictEqual(jb.towerId, towerId);
      assert.strictEqual(jb.node, 2);
      // Old socket is closed by the server with 4001.
      await new Promise((resolve) => { a.on('close', resolve); setTimeout(resolve, 2000); });
      assert.strictEqual(a.readyState, WebSocket.CLOSED);
    } finally {
      b.close();
    }
  });

  test('(e) two devices with the same towerId but different device ids coexist', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    try {
      const towerId = 'tower-sync-1';
      const ja = await join(a, 'room-multi', 1, { towerId, device: 'dev-a' });
      assert.strictEqual(ja.towerId, towerId);
      assert.strictEqual(ja.node, 1);

      // Second device, same identity: joins fine, inherits the tower's node,
      // and does not see its own tower in the peers list.
      const jb = await join(b, 'room-multi', 1, { towerId, device: 'dev-b' });
      assert.strictEqual(jb.towerId, towerId);
      assert.strictEqual(jb.node, 1);
      assert.strictEqual(jb.peers.length, 0);

      // No peer-joined is broadcast for the second device of a tower
      // that is already present.
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!a.messages.some((m) => m.type === 'peer-joined'
        && m.peer && m.peer.towerId === towerId));

      // A third tower sees the multi-device tower exactly ONCE in presence.
      const jc = await join(c, 'room-multi', 2, { towerId: 'tower-other-1', device: 'dev-c' });
      assert.strictEqual(jc.peers.length, 1);
      assert.strictEqual(jc.peers[0].towerId, towerId);
      assert.strictEqual(jc.peers[0].node, 1);

      // First device leaves: the tower stays (no peer-left yet).
      a.close();
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!c.messages.some((m) => m.type === 'peer-left' && m.towerId === towerId));

      // Last device leaves: now the tower leaves presence.
      b.close();
      const left = await waitFor(c, (m) => m.type === 'peer-left' && m.towerId === towerId);
      assert.strictEqual(left.reason, 'disconnect');
      assert.strictEqual(left.node, 1);
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  test('(e2) reconnecting the SAME device replaces the old connection (4001)', async () => {
    const a = await connect();
    const b = await connect();
    try {
      const towerId = 'tower-sync-2';
      await join(a, 'room-redevice', 3, { towerId, device: 'dev-a' });
      const closeCode = new Promise((resolve) => {
        a.on('close', (code) => resolve(code));
        setTimeout(() => resolve(null), 2000);
      });
      const jb = await join(b, 'room-redevice', 3, { towerId, device: 'dev-a' });
      assert.strictEqual(jb.towerId, towerId);
      assert.strictEqual(jb.node, 3);
      assert.strictEqual(await closeCode, 4001);
      assert.strictEqual(a.readyState, WebSocket.CLOSED);
    } finally {
      b.close();
    }
  });

  test('(f) a sync message reaches the other device of the same tower only', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    try {
      const towerId = 'tower-sync-3';
      await join(a, 'room-sync-route', 1, { towerId, device: 'dev-a' });
      await join(b, 'room-sync-route', 1, { towerId, device: 'dev-b' });
      await join(c, 'room-sync-route', 2, { towerId: 'tower-other-2', device: 'dev-c' });

      send(a, { type: 'sync-request', to: towerId, syncId: 's1', fromDevice: 'dev-a' });
      const got = await waitFor(b, (m) => m.type === 'sync-request' && m.syncId === 's1');
      assert.strictEqual(got.fromDevice, 'dev-a');
      assert.strictEqual(got.to, towerId);

      // A sync-chunk is relayed the same way, verbatim.
      send(a, { type: 'sync-chunk', to: towerId, syncId: 's1', index: 0, total: 1, nonce: 'AA==', data: 'BB==' });
      const chunk = await waitFor(b, (m) => m.type === 'sync-chunk' && m.syncId === 's1');
      assert.strictEqual(chunk.index, 0);
      assert.strictEqual(chunk.data, 'BB==');

      // Neither the sender nor the other tower got any sync message.
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!a.messages.some((m) => m.type.startsWith('sync-')));
      assert.ok(!c.messages.some((m) => m.type.startsWith('sync-')));
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  test('(f2) sync to your own tower with no other device online is an error', async () => {
    const a = await connect();
    const b = await connect();
    try {
      const ja = await join(a, 'room-sync-alone', 1, { towerId: 'tower-alone-1', device: 'dev-a' });
      send(a, { type: 'sync-request', to: ja.towerId, syncId: 's9', fromDevice: 'dev-a' });
      const err = await waitFor(a, (m) => m.type === 'error' && m.code === 'sync_no_peer');
      assert.ok(err.message);

      // A sync addressed to ANOTHER tower is rejected, not relayed.
      const jb = await join(b, 'room-sync-alone', 2, { towerId: 'tower-alone-2', device: 'dev-b' });
      send(a, { type: 'sync-request', to: jb.towerId, syncId: 's10', fromDevice: 'dev-a' });
      const err2 = await waitFor(a, (m) => m.type === 'error' && m.code === 'invalid_sync');
      assert.ok(err2.message);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!b.messages.some((m) => m.type === 'sync-request'));
    } finally {
      a.close(); b.close();
    }
  });
});
