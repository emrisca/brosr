// A guest runs no local relay, so it has no room.json. These tests point the
// state folder at a temporary directory and keep a small relay stub beside it,
// so no real room file is read or written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const state = await mkdtemp(path.join(tmpdir(), 'brosr-guest-status-'));
process.env.BROSR_STATE = state;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/status')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ room: 'room-1', peers: 4 }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// A port nothing listens on, for the relay-down case.
const closed = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const free = probe.address().port;
    probe.close(() => resolve(free));
  });
});

const { status } = await import(pathToFileURL(path.join(here, '..', 'room.mjs')).href);

const joinFile = path.join(state, 'join.json');

function join(extra = {}) {
  return {
    started: '2026-11-16T04:20:00.000Z',
    browser: { id: 'zen', name: 'Zen', path: '/none', family: 'gecko' },
    room: 'room-1',
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}/?role=peer&room=room-1`,
    name: 'Guest',
    peer: 'guest-1',
    profile: path.join(state, 'profile-guest'),
    browserPid: process.pid,
    bridge: { file: '/none/bridge.xpi', built: false, version: '0.4.0' },
    extensions: 0,
    ...extra,
  };
}

function write(body) {
  fs.writeFileSync(joinFile, JSON.stringify(body));
}

function clear() {
  fs.rmSync(joinFile, { force: true });
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(state, { recursive: true, force: true });
});

test('a machine with no room file and no join file is not running', async () => {
  clear();
  const state = await status();
  assert.equal(state.running, false);
  assert.equal(state.room, undefined);
});

test('a guest reads the join file, the invite relay and its peer count', async () => {
  write(join());
  const state = await status();
  assert.equal(state.role, 'peer');
  assert.equal(state.room, 'room-1');
  assert.equal(state.peer, 'guest-1');
  assert.equal(state.host, '127.0.0.1');
  assert.equal(state.port, port);
  assert.equal(state.relayReady, true);
  assert.equal(state.relayAlive, true);
  assert.equal(state.peers, 4);
  assert.equal(state.browserAlive, true);
  assert.equal(state.running, true);
  assert.equal(state.name, 'Guest');
});

test('a dead guest pid still runs while the relay holds a page', async () => {
  write(join({ browserPid: 999999 }));
  const state = await status();
  assert.equal(state.browserAlive, false);
  assert.equal(state.peers, 4);
  assert.equal(state.running, true);
  assert.equal(state.room, 'room-1');
});

test('a dead guest pid and a silent relay is not running', async () => {
  write(join({ browserPid: 999999, port: closed }));
  const state = await status();
  assert.equal(state.browserAlive, false);
  assert.equal(state.relayReady, false);
  assert.equal(state.running, false);
  assert.equal(state.room, 'room-1');
});

test('a guest whose relay cannot answer counts no peers', async () => {
  write(join({ port: closed }));
  const state = await status();
  assert.equal(state.relayReady, false);
  assert.equal(state.peers, 0);
  assert.equal(state.running, true);
});
