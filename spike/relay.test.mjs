// Two rooms on one relay. A frame must reach its own room and nothing else.
// This test starts a real relay on a spare port and speaks real WebSockets.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

function connect(room) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/room?room=${room}`);
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

test('closing every client of a room removes the room', async () => {
  const one = await connect('gamma');
  const two = await connect('gamma');
  one.close();
  two.close();
  await sleep(250);
  const stats = await (await fetch(`${BASE}/stats`)).json();
  assert.equal(stats.rooms.gamma, undefined);
});
