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

const { status, relayLaunch, allocateTrustPorts, roomUrl, trustHelperArgs } = await import(
  pathToFileURL(path.join(here, '..', 'room.mjs')).href
);

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

test('relayLaunch defaults to the Node relay and switches cleanly when RELAY_BIN is set', () => {
  const fallback = relayLaunch({
    host: '127.0.0.1',
    port: 8787,
    docsDir: '/tmp/docs',
    docsToken: 'tok',
    relayBin: '',
  });
  assert.equal(fallback.command, process.execPath);
  assert.equal(fallback.args.length, 1);
  assert.match(fallback.args[0], /spike[\\/]relay\.js$/);
  assert.equal(fallback.env.BROSR_DOCS_DIR, '/tmp/docs');
  assert.equal(fallback.env.BROSR_DOCS_TOKEN, 'tok');

  const native = relayLaunch({
    host: '0.0.0.0',
    port: 8899,
    docsDir: '/tmp/docs',
    docsToken: 'tok',
    relayBin: '/opt/brosr-relay',
  });
  assert.equal(native.command, '/opt/brosr-relay');
  assert.deepEqual(native.args, []);
  assert.equal(native.env.HOST, '0.0.0.0');
  assert.equal(native.env.PORT, '8899');
  assert.match(native.env.LANDING, /landing$/);
  assert.match(native.env.FIXTURES, /spike[\\/]fixtures$/);
  assert.match(native.env.ASSETS, /assets$/);
  assert.match(native.env.MEDIA, /spike[\\/]\.runtime$/);
});

test('relayLaunch priority: explicit RELAY_BIN > auto-discovered staged binary > spike/relay.js fallback', async () => {
  const bundleRoot = await mkdtemp(path.join(tmpdir(), 'brosr-relay-launch-'));
  const previousRelayBin = process.env.RELAY_BIN;
  try {
    // 1. Neither RELAY_BIN nor staged binary present -> spike/relay.js fallback.
    delete process.env.RELAY_BIN;
    const fallback = relayLaunch({
      host: '127.0.0.1',
      port: 8787,
      docsDir: '/tmp/docs',
      docsToken: 'tok',
      root: bundleRoot,
      platform: 'darwin',
    });
    assert.equal(fallback.command, process.execPath);
    assert.deepEqual(fallback.args, [path.join(bundleRoot, 'spike', 'relay.js')]);
    assert.equal(fallback.source, 'node');

    // 2. Staged binary next to host/ -> auto-discovered on Unix and Windows.
    const relayDir = path.join(bundleRoot, 'relay');
    fs.mkdirSync(relayDir, { recursive: true });
    const unixBin = path.join(relayDir, 'brosr-relay');
    const winBin = path.join(relayDir, 'brosr-relay.exe');
    fs.writeFileSync(unixBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(winBin, 'MZ');

    const stagedUnix = relayLaunch({
      host: '127.0.0.1',
      port: 8791,
      docsDir: '/tmp/docs',
      docsToken: 'tok',
      root: bundleRoot,
      platform: 'darwin',
    });
    assert.equal(stagedUnix.command, unixBin);
    assert.deepEqual(stagedUnix.args, []);
    assert.equal(stagedUnix.source, 'staged');
    assert.equal(stagedUnix.env.LANDING, path.join(bundleRoot, 'landing'));
    assert.equal(stagedUnix.env.FIXTURES, path.join(bundleRoot, 'spike', 'fixtures'));
    assert.equal(stagedUnix.env.ASSETS, path.join(bundleRoot, 'assets'));
    assert.equal(stagedUnix.env.MEDIA, path.join(bundleRoot, 'spike', '.runtime'));

    const stagedWin = relayLaunch({
      host: '127.0.0.1',
      port: 8792,
      docsDir: '/tmp/docs',
      docsToken: 'tok',
      root: bundleRoot,
      platform: 'win32',
    });
    assert.equal(stagedWin.command, winBin);
    assert.deepEqual(stagedWin.args, []);
    assert.equal(stagedWin.source, 'staged');

    // 3. Explicit RELAY_BIN (env or arg) beats the staged binary.
    process.env.RELAY_BIN = '/opt/override-relay';
    const fromEnv = relayLaunch({
      host: '0.0.0.0',
      port: 8899,
      docsDir: '/tmp/docs',
      docsToken: 'tok',
      root: bundleRoot,
      platform: 'darwin',
    });
    assert.equal(fromEnv.command, '/opt/override-relay');
    assert.deepEqual(fromEnv.args, []);
    assert.equal(fromEnv.source, 'env');

    const fromArg = relayLaunch({
      host: '0.0.0.0',
      port: 8899,
      docsDir: '/tmp/docs',
      docsToken: 'tok',
      relayBin: '/opt/arg-relay',
      root: bundleRoot,
      platform: 'darwin',
    });
    assert.equal(fromArg.command, '/opt/arg-relay');
    assert.deepEqual(fromArg.args, []);
    assert.equal(fromArg.source, 'env');
  } finally {
    if (previousRelayBin === undefined) delete process.env.RELAY_BIN;
    else process.env.RELAY_BIN = previousRelayBin;
    await rm(bundleRoot, { recursive: true, force: true });
  }
});

test('trust agent port wiring separates agentPort from debugPort in roomUrl and helper args', async () => {
  const { debugPort, agentPort } = await allocateTrustPorts({
    debugStart: 19330,
    agentStart: 19400,
  });
  assert.notEqual(debugPort, agentPort);
  assert.ok(debugPort >= 19330 && debugPort < 19370);
  assert.ok(agentPort >= 19400 && agentPort < 19440);

  const trust = { debugPort, agentPort, port: agentPort, token: 'tok-123' };
  const url = new URL(
    roomUrl({
      host: '127.0.0.1',
      port: 18787,
      room: 'room-trust',
      key: 'k1',
      name: 'Host',
      trust,
    })
  );
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(fragment.get('tp'), String(agentPort));
  assert.notEqual(fragment.get('tp'), String(debugPort));
  assert.equal(fragment.get('t'), 'tok-123');

  const args = trustHelperArgs('room-trust', trust, 'chromium');
  assert.ok(args.includes(`--debug-port=${debugPort}`));
  assert.ok(args.includes(`--agent-port=${agentPort}`));
  assert.ok(args.includes('--family=chromium'));

  // Backward compatibility when agentPort is omitted (defaults to 0 in host/trust.mjs).
  const legacyArgs = trustHelperArgs('room-trust', { port: debugPort, token: 'tok-123' }, 'gecko');
  assert.ok(legacyArgs.includes(`--debug-port=${debugPort}`));
  assert.equal(legacyArgs.some((a) => a.startsWith('--agent-port=')), false);
});
