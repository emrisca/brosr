// Visual check for the two complaints that a unit test cannot see: a cursor
// that moves when the window is resized, and a granted click on the Canvas tile
// that opens the page for the other person.
//
// Two Chromium windows load the unpacked bridge, join one room, and the check
// reads the wire and the page. It writes PNGs to .runtime/visual so a person
// can look at the same frames the assertions used.
//
//   node scripts/check-resize-grant.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-resize-grant.mjs
//
// The app keeps its browser on port 9333, so this check uses its own ports and
// its own profiles and never touches that one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChrome } from '../zen/package.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.runtime', 'visual');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE_PORT = Number(process.env.BROSR_CHECK_PORT || 9484);
const CANDIDATES = [
  process.env.BROSR_CHECK_BROWSER,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const open = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (open) return port;
  }
  throw new Error(`no free port between ${start} and ${start + 39}`);
}

async function waitFor(fn, label, timeout = 20000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(120);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

class Tab {
  constructor(ws, targetId) {
    this.ws = ws;
    this.targetId = targetId;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const held = this.pending.get(message.id);
      if (!held) return;
      this.pending.delete(message.id);
      if (message.error) held.reject(new Error(JSON.stringify(message.error)));
      else held.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text +
          ' ' +
          (result.exceptionDetails.exception?.description || '')
      );
    }
    return result.result.value;
  }
}

async function startRelay(port) {
  const child = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 'relay');
  return child;
}

async function launch({ browser, port, extension }) {
  const profile = await mkdtemp(path.join(tmpdir(), 'brosr-resize-grant-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1400,900',
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    'about:blank',
  ];
  const chrome = spawn(browser, args, { stdio: 'ignore' });
  const cdp = `http://127.0.0.1:${port}`;
  const stop = async () => {
    chrome.kill('SIGTERM');
    await sleep(600);
    chrome.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true });
  };
  try {
    await waitFor(async () => (await fetch(`${cdp}/json/version`)).ok, 'devtools endpoint');
  } catch (error) {
    await stop();
    throw error;
  }
  return { chrome, profile, cdp, stop };
}

async function openTab(cdp, tabs, url, ready) {
  const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('debug socket')), { once: true });
  });
  const tab = new Tab(ws, target.id);
  tabs.push(tab);
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  await tab.send('Page.navigate', { url });
  await waitFor(() => ready(tab), url);
  return tab;
}

async function openProbe(port, room) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/room?room=${encodeURIComponent(room)}`);
  const frames = [];
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      frames.push(JSON.parse(event.data));
    } catch {
      // A frame this check cannot read is not one it needs.
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('probe socket')), { once: true });
  });
  return { socket, frames };
}

const state = (tab) =>
  tab.eval(`(() => {
    const raw = document.documentElement.dataset.brosr || '';
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  })()`);

const view = (tab) =>
  tab.eval(`({ width: innerWidth, height: innerHeight, path: location.pathname })`);

async function shot(tab, name) {
  const result = await tab.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, name);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

const near = (a, b) => Math.abs(a - b) < 0.004;

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = CANDIDATES.find((file) => fs.existsSync(file));
  if (!browser) throw new Error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');

  const relayPort = await freePort(BASE_PORT + 20);
  const relay = await startRelay(relayPort);
  const extension = await mkdtemp(path.join(tmpdir(), 'brosr-resize-grant-ext-'));
  const room = `visual-${Date.now()}`;
  const base = `http://127.0.0.1:${relayPort}`;
  const tabs = [];
  let probe = null;
  let hostBrowser = null;
  let peerBrowser = null;
  try {
    const built = buildChrome(extension);
    console.log(`relay on ${relayPort}, ${path.basename(browser)} with ${built.entries} extension files`);

    hostBrowser = await launch({ browser, port: await freePort(BASE_PORT), extension: built.dir });
    peerBrowser = await launch({
      browser,
      port: await freePort(BASE_PORT + 10),
      extension: built.dir,
    });
    probe = await openProbe(relayPort, room);

    const hostTab = await openTab(
      hostBrowser.cdp,
      tabs,
      `${base}/?role=host&room=${room}&peer=host&name=Host&relay=${relayPort}&grant=peer`,
      async (tab) => {
        const seen = await state(tab);
        return seen && seen.role === 'host';
      }
    );
    const peerTab = await openTab(
      peerBrowser.cdp,
      tabs,
      `${base}/?role=peer&room=${room}&peer=peer&name=Peer&relay=${relayPort}`,
      async (tab) => {
        const seen = await state(tab);
        return seen && seen.role === 'peer';
      }
    );

    // The grant frame has to reach the peer after the socket opens. This is the
    // first thing the user reported: a grant that never turns capture on.
    await waitFor(async () => (await state(peerTab))?.granted === true, 'the peer heard the grant');
    console.log('  the peer received the grant frame and now captures');

    await peerTab.send('Page.bringToFront');
    await waitFor(
      () => peerTab.eval(`document.hasFocus() && document.visibilityState === 'visible'`),
      'focused peer tab',
      8000
    );
    const before = await view(peerTab);

    for (const [x, y] of [
      [540, 360],
      [600, 400],
      [600, 400],
    ]) {
      await peerTab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(140);
    }
    const first = await waitFor(
      () =>
        probe.frames.find(
          (frame) =>
            frame.type === 'presence' &&
            frame.peerId === 'peer' &&
            frame.point &&
            near(frame.point.x, 600 / before.width) &&
            near(frame.point.y, 400 / before.height)
        ),
      'presence at the first window size'
    );
    console.log(
      `  peer at ${before.width}x${before.height} sent ${first.point.x} / ${first.point.y}`
    );
    assert.ok(
      await waitFor(async () => ((await state(hostTab))?.cursors || 0) >= 1, 'host drew the peer'),
      'the host did not draw the peer cursor'
    );
    const shotBefore = await shot(hostTab, 'host-before-resize.png');

    // The window changes size and the pointer does not move. The share has to
    // follow the window, or the dot sits where the old size put it.
    await peerTab.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const moved = await waitFor(
      () =>
        probe.frames.find(
          (frame) =>
            frame.type === 'presence' &&
            frame.peerId === 'peer' &&
            frame.point &&
            near(frame.point.x, 600 / 900) &&
            near(frame.point.y, 400 / 600)
        ),
      'presence after the resize'
    );
    console.log(`  same point after 900x600 sent ${moved.point.x} / ${moved.point.y}`);
    assert.notDeepEqual(moved.point, first.point, 'the share did not follow the new window');
    assert.ok(
      await waitFor(async () => ((await state(hostTab))?.cursors || 0) >= 1, 'host kept the peer'),
      'the host dropped the peer cursor after the resize'
    );
    const shotAfter = await shot(hostTab, 'host-after-resize.png');

    // The peer clicks its own Canvas tile. The bridge captures the click, and
    // the host has to open the same page. A plain dispatched click never runs a
    // link, so this also proves the receiver repeats that default.
    await peerTab.send('Page.bringToFront');
    const tile = await peerTab.eval(`(() => {
      const box = document.querySelector('a.tile-live');
      if (!box) return null;
      const rect = box.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    assert.ok(tile, 'the landing page has no live tile');
    await peerTab.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: tile.x,
      y: tile.y,
      button: 'left',
      clickCount: 1,
    });
    await peerTab.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: tile.x,
      y: tile.y,
      button: 'left',
      clickCount: 1,
    });

    const landed = await waitFor(
      async () => {
        const seen = await view(hostTab);
        return seen.path === '/canvas/' ? seen : null;
      },
      'the host opened the Canvas page',
      12000
    );
    // The new page starts the core again, so its own status arrives a moment
    // after the navigation.
    const hostState = await waitFor(async () => {
      const seen = await state(hostTab);
      return seen && seen.role === 'host' ? seen : null;
    }, 'the host joined the room on the Canvas page');
    assert.equal(hostState.role, 'host', 'the host lost the room on the Canvas page');
    const shotCanvas = await shot(hostTab, 'host-canvas.png');

    console.log(`  the peer tile click opened ${landed.path} on the host, still ${hostState.role}`);
    console.log(`  screenshots: ${shotBefore}`);
    console.log(`               ${shotAfter}`);
    console.log(`               ${shotCanvas}`);
    console.log('  PASS: the cursor keeps its share across a resize and a granted click opens the tile');
  } finally {
    if (probe) probe.socket.close();
    for (const tab of tabs) tab.ws.close();
    // Stopping a browser closes every tab it owns.
    if (hostBrowser) await hostBrowser.stop();
    if (peerBrowser) await peerBrowser.stop();
    relay.kill('SIGTERM');
    await rm(extension, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
