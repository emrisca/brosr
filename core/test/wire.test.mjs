import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decode, encode } from '../protocol.mjs';
import { newRoomKey, roomKey, sealFrame, openFrame } from '../seal.mjs';

const RELAY = new URL('../../spike/relay.js', import.meta.url).pathname;
const RELAY_BIN = process.env.RELAY_BIN || '';
const FIXTURES = new URL('../../spike/fixtures', import.meta.url).pathname;

// The same two proofs run against the Node spike relay and the axum relay. Set
// RELAY_BIN to a built binary and neither frame rule changes.
function startRelay(env) {
  const options = { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] };
  return RELAY_BIN
    ? spawn(RELAY_BIN, [], { ...options, env: { ...options.env, FIXTURES } })
    : spawn(process.execPath, [RELAY], options);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const reply = await fetch(`http://127.0.0.1:${port}/health`);
      if (reply.ok) return;
    } catch {
      // The relay is still starting.
    }
    await sleep(50);
  }
  throw new Error('the relay did not answer /health');
}

function socketFor(port, query) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/room?${query}`);
  socket.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    const fail = (event) => reject(new Error(`socket failed: ${event?.message || 'closed'}`));
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', fail, { once: true });
  });
}

function nextFrame(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame arrived')), 4000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        resolve(event.data);
      },
      { once: true }
    );
  });
}

test('a sealed frame crosses the relay as bytes with no URL and no name', { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brosr-wire-'));
  const capture = path.join(dir, 'frames.jsonl');
  const port = await freePort();
  const relay = startRelay({
    PORT: String(port),
    HOST: '127.0.0.1',
    RELAY_CAPTURE: capture,
  });
  t.after(() => {
    relay.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  await waitForHealth(port, Date.now() + 5000);
  const host = await socketFor(port, 'room=sealed&role=host&peer=host');
  const peer = await socketFor(port, 'room=sealed&role=peer&peer=bob');
  t.after(() => {
    host.close();
    peer.close();
  });

  const key = await roomKey(newRoomKey());
  const message = encode({
    type: 'presence',
    peerId: 'host',
    name: 'Peer Two',
    colour: '#e2603f',
    point: { x: 10, y: 20 },
    roomTime: 1000,
  });
  const sealed = sealFrame(key, new TextEncoder().encode(message), { room: 'sealed' });
  host.send(sealed);

  const arrived = await nextFrame(peer);
  assert.ok(arrived instanceof ArrayBuffer, 'the relay changed the frame to text');
  const opened = new TextDecoder().decode(
    openFrame(key, new Uint8Array(arrived), { room: 'sealed' })
  );
  assert.deepEqual(decode(opened), decode(message));

  // The relay wrote down every payload it forwarded. Those bytes are the only
  // witness on the machine that is not an endpoint.
  const lines = readFileSync(capture, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(lines.length >= 1, 'the relay captured nothing');
  for (const line of lines) {
    assert.equal(line.opcode, 2, 'the relay saw a text frame');
    assert.ok(line.bytes > 0);
    const bytes = Buffer.from(line.hex, 'hex');
    assert.equal(bytes.includes(Buffer.from('http')), false, 'a URL reached the relay');
    assert.equal(bytes.includes(Buffer.from('Peer Two')), false, 'a name reached the relay');
    assert.equal(bytes.includes(Buffer.from('presence')), false, 'a message type reached the relay');
  }
});

test('the relay still forwards a plain frame in a room without a key', { timeout: 20000 }, async (t) => {
  const port = await freePort();
  const relay = startRelay({ PORT: String(port), HOST: '127.0.0.1' });
  t.after(() => relay.kill('SIGKILL'));
  await waitForHealth(port, Date.now() + 5000);

  const host = await socketFor(port, 'room=open&role=host&peer=host');
  const peer = await socketFor(port, 'room=open&role=peer&peer=bob');
  t.after(() => {
    host.close();
    peer.close();
  });

  const frame = encode({ type: 'view', scroll: 0.5, fingerprint: { innerWidth: 800 } });
  host.send(frame);
  assert.equal(await nextFrame(peer), frame);
});
