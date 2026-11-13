// The Mac peer across a relay restart, and the game role on the app channel.
// Both tests spawn the real peer against a real relay on a spare port, so the
// frames travel the same path a LAN run uses.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-peer-'));
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function startRelay(port) {
  const child = spawn(process.execPath, [path.join(here, 'relay.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port) },
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error('relay printed no ready line')), 10000);
    child.stdout.on('data', (chunk) => {
      seen += chunk.toString();
      if (seen.includes('[relay] http://')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code}`));
    });
  });
}

function startPeer({ port, room, peer, seconds, game = false, out }) {
  const argv = [
    path.join(here, 'peer.mjs'),
    '--relay=127.0.0.1',
    `--port=${port}`,
    `--room=${room}`,
    `--peer=${peer}`,
    `--seconds=${seconds}`,
    `--out=${out}`,
  ];
  if (game) argv.push('--game=1');
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.log = '';
  child.stdout.on('data', (chunk) => (child.log += chunk.toString()));
  return child;
}

function connect(port, room) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/room?room=${room}`);
  socket.messages = [];
  socket.onmessage = (event) => socket.messages.push(JSON.parse(String(event.data)));
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error(`cannot open room ${room}`));
  });
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(message);
}

const exitOf = (child) => new Promise((resolve) => child.once('exit', resolve));

async function stopPeer(peer) {
  if (peer.exitCode !== null) return;
  const exited = exitOf(peer);
  peer.kill('SIGTERM');
  await exited;
}

const joinedTimes = (peer) => peer.log.split('[peer] joined').length - 1;

test('the peer rejoins on its own after a relay restart', async () => {
  const port = 8801;
  let relay = await startRelay(port);
  const out = path.join(tmp, 'reconnect.json');
  const peer = startPeer({ port, room: 'reconnect', peer: 'mac', seconds: 30, out });

  await waitFor(() => joinedTimes(peer) === 1, 'the peer did not join the first relay');

  relay.kill('SIGKILL');
  await sleep(1500);
  relay = await startRelay(port);

  // A room peer on the other side of the restart. Its presence is what the
  // peer looks for after it rejoins.
  const probe = await connect(port, 'reconnect');
  await waitFor(() => joinedTimes(peer) === 2, 'the peer did not rejoin the second relay', 12000);
  probe.send(
    JSON.stringify({
      v: 1,
      type: 'presence',
      peerId: 'probe',
      name: 'Probe',
      point: { x: 1, y: 2 },
      roomTime: Date.now(),
    })
  );
  await sleep(1500);
  await stopPeer(peer);

  const journal = JSON.parse(fs.readFileSync(out, 'utf8'));
  const last = journal.samples[journal.samples.length - 1];
  assert.ok(journal.reconnects >= 1, 'the peer counted no reconnect');
  assert.equal(last.peers, 1, 'the peer did not see the probe after the restart');
  assert.ok(last.latency, 'the restarted room carried no presence latency');
  probe.close();
});

test('the game peer sends paddles and counts host states', async () => {
  const port = 8802;
  await startRelay(port);
  const out = path.join(tmp, 'game.json');
  const peer = startPeer({ port, room: 'game', peer: 'mac', seconds: 30, game: true, out });

  await waitFor(() => joinedTimes(peer) === 1, 'the peer did not join the game room');
  const host = await connect(port, 'game');
  await sleep(2000);

  const paddles = host.messages.filter(
    (message) => message.type === 'app' && message.name === 'paddle'
  );
  assert.ok(paddles.length >= 10, `expected about 20 paddles in 2 s, got ${paddles.length}`);
  assert.equal(typeof paddles[0].data.y, 'number', 'a paddle needs a y value');

  host.send(
    JSON.stringify({
      v: 1,
      type: 'app',
      peerId: 'host',
      name: 'state',
      data: { seq: 7, scores: { host: 1, peer: 0 } },
      roomTime: Date.now(),
    })
  );
  await sleep(600);
  await stopPeer(peer);

  const journal = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(journal.statesReceived >= 1, 'the peer counted no host state');
  assert.equal(journal.last.seq, 7, 'the peer kept the wrong sequence');
  assert.deepEqual(journal.last.scores, { host: 1, peer: 0 });
  host.close();
});
