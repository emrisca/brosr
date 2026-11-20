// Two rooms on one relay. A frame must reach its own room and nothing else.
// This test starts a real relay on a spare port and speaks real WebSockets.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const relay = spawn(process.execPath, [path.join(here, 'relay.js')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT) },
});
relay.stdout.on('data', () => {});
relay.stderr.on('data', (chunk) => process.stderr.write(chunk));

after(() => {
  relay.kill('SIGKILL');
});

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }
  throw new Error('relay did not start');
}

function connect(room, role = 'peer', peer = '') {
  const named = peer ? `&peer=${encodeURIComponent(peer)}` : '';
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/room?room=${room}&role=${role}${named}`);
  socket.messages = [];
  socket.onmessage = (event) => socket.messages.push(String(event.data));
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error(`cannot open room ${room}`));
  });
}

test('a relay keeps two rooms apart', async () => {
  await waitHealth();
  const [alphaOne, alphaTwo, betaOne, betaTwo] = await Promise.all([
    connect('alpha'),
    connect('alpha'),
    connect('beta'),
    connect('beta'),
  ]);

  alphaOne.send(JSON.stringify({ type: 'presence', peerId: 'a1', point: { x: 1, y: 2 } }));
  await sleep(250);
  assert.equal(alphaTwo.messages.length, 1, 'the other alpha client got the frame');
  assert.equal(betaOne.messages.length, 0, 'beta never sees an alpha frame');
  assert.equal(betaTwo.messages.length, 0);

  betaOne.send(JSON.stringify({ type: 'presence', peerId: 'b1', point: { x: 3, y: 4 } }));
  await sleep(250);
  assert.equal(betaTwo.messages.length, 1);
  assert.equal(alphaTwo.messages.length, 1, 'alpha did not grow');

  const stats = await (await fetch(`${BASE}/stats`)).json();
  assert.equal(stats.rooms.alpha, 2);
  assert.equal(stats.rooms.beta, 2);
  assert.equal(stats.forwarded, 2, 'two sends, one delivery each');

  for (const socket of [alphaOne, alphaTwo, betaOne, betaTwo]) socket.close();
});

test('a room says whether the host is one of its members', async () => {
  await waitHealth();
  const host = await connect('hosted', 'host');
  const peer = await connect('hosted');

  const full = await (await fetch(`${BASE}/status?room=hosted`)).json();
  assert.equal(full.peers, 2);
  assert.equal(full.hosts, 1, 'the host socket is counted');

  host.close();
  await sleep(250);
  const alone = await (await fetch(`${BASE}/status?room=hosted`)).json();
  assert.equal(alone.peers, 1, 'the guest is still in the room');
  assert.equal(alone.hosts, 0, 'the host left and the room says so');

  // A socket with no role is a guest, so an older page cannot count as a host.
  const legacy = await connect('unlabelled');
  const plain = await (await fetch(`${BASE}/status?room=unlabelled`)).json();
  assert.equal(plain.peers, 1);
  assert.equal(plain.hosts, 0);

  peer.close();
  legacy.close();
});

test('a replacement host takes the room without leaving a stale host count', async () => {
  await waitHealth();
  const oldHost = await connect('swap', 'host', 'host-old');
  const guest = await connect('swap', 'peer', 'guest-1');

  const before = await (await fetch(`${BASE}/status?room=swap`)).json();
  assert.equal(before.peers, 2);
  assert.equal(before.hosts, 1);

  // The replacement joins while the old host is still listed, which is the
  // moment a swap can count one person twice.
  const newHost = await connect('swap', 'host', 'host-new');
  const overlap = await (await fetch(`${BASE}/status?room=swap`)).json();
  assert.equal(overlap.peers, 3, 'both live sockets are counted during the overlap');
  assert.equal(overlap.hosts, 2);

  oldHost.close();
  let after = null;
  for (let i = 0; i < 40; i++) {
    after = await (await fetch(`${BASE}/status?room=swap`)).json();
    if (after.peers === 2 && after.hosts === 1) break;
    await sleep(50);
  }
  assert.equal(after.peers, 2, 'the retired host socket is gone');
  assert.equal(after.hosts, 1, 'only the replacement counts as host');
  assert.equal(after.people, 2, 'the retired host identity is not kept');

  newHost.close();
  guest.close();
});

test('a cursor socket is not an app, and a closed host page is named', async () => {
  await waitHealth();
  const host = await connect('pointing', 'host', 'host-1');
  const guest = await connect('pointing', 'peer', 'guest-1');
  // A plain landing page draws pointers for the room from its own socket.
  const cursors = await connect('pointing', 'cursor');

  const busy = await (await fetch(`${BASE}/status?room=pointing`)).json();
  assert.equal(busy.peers, 2, 'two room pages, not three');
  assert.equal(busy.hosts, 1);
  assert.equal(busy.people, 2, 'the pointer surface is not a person');

  // The host page closes while the guest stays. The room says no host, which is
  // the honest answer, and a replacement that joins as host clears it.
  host.close();
  let alone = null;
  for (let i = 0; i < 40; i++) {
    alone = await (await fetch(`${BASE}/status?room=pointing`)).json();
    if (alone.hosts === 0) break;
    await sleep(50);
  }
  assert.equal(alone.peers, 1, 'only the guest app is left');
  assert.equal(alone.hosts, 0, 'the room has no host');
  assert.equal(alone.people, 1);

  const replacement = await connect('pointing', 'host', 'host-2');
  const back = await (await fetch(`${BASE}/status?room=pointing`)).json();
  assert.equal(back.peers, 2, 'the replacement is a room page');
  assert.equal(back.hosts, 1, 'the host notice clears');

  replacement.close();
  guest.close();
  cursors.close();
});

test('people counts each peer once across tabs, and ignores the panel socket', async () => {
  await waitHealth();
  const host = await connect('counted', 'host', 'host-1');
  const guestTabOne = await connect('counted', 'peer', 'guest-1');
  const guestTabTwo = await connect('counted', 'peer', 'guest-1');
  const panel = await connect('counted', 'panel', 'host-1');
  const legacy = await connect('counted');

  const status = await (await fetch(`${BASE}/status?room=counted`)).json();
  assert.equal(status.peers, 4, 'the socket count still reports every non-panel socket');
  assert.equal(status.hosts, 1);
  assert.equal(status.people, 3, 'two tabs of one guest count once, and an unnamed socket counts once');

  guestTabTwo.close();
  await sleep(250);
  const oneTab = await (await fetch(`${BASE}/status?room=counted`)).json();
  assert.equal(oneTab.peers, 3, 'the panel socket never enters the socket count');
  assert.equal(oneTab.people, 3, 'closing one tab of a guest leaves the people count alone');

  for (const socket of [host, guestTabOne, panel, legacy]) socket.close();
});

test('closing every client of a room removes the room', async () => {
  const one = await connect('gamma');
  const two = await connect('gamma');
  one.close();
  two.close();
  await sleep(250);
  const stats = await (await fetch(`${BASE}/stats`)).json();
  assert.equal(stats.rooms.gamma, undefined);
});

test('a named clip serves range requests, and a missing one gives 404', async () => {
  await waitHealth();
  const dir = path.join(here, '.runtime');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'range-test.webm');
  fs.writeFileSync(file, Buffer.alloc(1024, 7));

  const ranged = await fetch(`${BASE}/media/range-test.webm`, { headers: { range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206, 'a range request answers 206');
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-99/1024');
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  const whole = await fetch(`${BASE}/media/range-test.webm`);
  assert.equal(whole.status, 200, 'a plain request answers 200');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');

  const missing = await fetch(`${BASE}/media/absent.webm`);
  assert.equal(missing.status, 404);
  fs.rmSync(file, { force: true });
});

test('a relay on a busy port exits instead of serving', async () => {
  const second = spawn(process.execPath, [path.join(here, 'relay.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT) },
  });
  let text = '';
  second.stdout.on('data', (chunk) => (text += chunk.toString()));
  second.stderr.on('data', (chunk) => (text += chunk.toString()));
  const code = await new Promise((resolve) => second.once('exit', resolve));
  assert.notEqual(code, 0, 'the second relay did not exit cleanly');
  assert.match(text, /cannot listen on/, 'the second relay named the busy port');
});
