// One stroke into a room from a Node socket, then a peer page on the same room
// paints it. The page reads its own sheet pixels, so the check covers the wire,
// the room code and the paint in one pass.
//
// The app keeps its browser on port 9333, so this check uses its own port, its
// own profile and its own relay.
//
//   node scripts/check-canvas-stroke.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-canvas-stroke.mjs
//   BROSR_RELAY=http://127.0.0.1:8787 BROSR_ROOM=room-1 node scripts/check-canvas-stroke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, '.runtime', 'visual');
const COLOUR = '#d81b60';
const ID = `probe-${Date.now().toString(36)}`;
const LIVE = process.env.BROSR_RELAY || '';
const ROOM = process.env.BROSR_ROOM || `canvas-${Date.now().toString(36)}`;
const BROWSERS = [
  process.env.BROSR_CHECK_BROWSER,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  throw new Error(`no free port from ${start}`);
}

async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

class Tab {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const held = message.id && this.pending.get(message.id);
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
    const out = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text);
    return out.result.value;
  }
}

// The sheet is the canvas the page already paints on, so its pixels are the
// picture a person sees, not a copy made for the check.
const COUNT = `(() => {
  const c = document.getElementById('sheet');
  if (!c) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a > 200 && r > 150 && g < 90 && b > 50 && b < 140) {
      n += 1;
      const p = i / 4;
      const x = p % c.width;
      const y = (p - x) / c.width;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { n, minX, minY, maxX, maxY, width: c.width, height: c.height };
})()`;

const browser = BROWSERS.find((file) => fs.existsSync(file));
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}

let relay = null;
let base = LIVE.replace(/\/$/, '');
let failed = false;
const profile = await mkdtemp(path.join(tmpdir(), 'brosr-canvas-stroke-'));
let chrome = null;
const tabs = [];

try {
  if (!base) {
    const port = await freePort(9600);
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RELAY_QUIET: '1' },
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`${base}/health`)).ok, 'relay');
  }
  console.log(`relay ${base}, room ${ROOM}, plain browser ${path.basename(browser)}`);

  const devPort = await freePort(9700);
  chrome = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${devPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const cdp = `http://127.0.0.1:${devPort}`;
  await waitFor(async () => (await fetch(`${cdp}/json/version`)).ok, 'devtools endpoint');

  const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('debug socket')), { once: true });
  });
  const tab = new Tab(ws);
  tabs.push(tab);
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  const page = `${base}/canvas/?room=${encodeURIComponent(ROOM)}`;
  await tab.send('Page.navigate', { url: page });
  await waitFor(
    () => tab.eval('document.readyState === "complete" && !!document.getElementById("sheet")'),
    page
  );
  await sleep(1200);

  const start = await tab.eval(COUNT);
  if (!start) throw new Error('the page has no sheet canvas');
  await waitFor(
    async () => (await (await fetch(`${base}/status?room=${encodeURIComponent(ROOM)}`)).json()).peers >= 1,
    'the page in the room'
  );
  console.log(`  peer page opened ${start.width}x${start.height} with ${start.n} pixels of ${COLOUR}`);

  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/room?room=${encodeURIComponent(ROOM)}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('room socket')), { once: true });
  });
  socket.send(
    JSON.stringify({
      v: 1,
      type: 'app',
      peerId: 'probe-stroke',
      name: 'canvas',
      data: {
        op: 'stroke',
        id: ID,
        layer: 0,
        tool: 'line',
        colour: COLOUR,
        size: 14,
        opacity: 1,
        symmetry: 'off',
        part: 0,
        parts: 1,
        points: [
          { x: 1150, y: 750 },
          { x: 1250, y: 850 },
        ],
      },
    })
  );
  await sleep(600);
  socket.close();

  const after = await waitFor(async () => {
    const now = await tab.eval(COUNT);
    return now && now.n > start.n ? now : null;
  }, 'the stroke on the peer page', 10000);
  console.log(`  the page now holds ${after.n} pixels, ${after.n - start.n} of them new`);
  console.log(
    `  the new pixels sit between ${Math.round(after.minX)},${Math.round(after.minY)} and ${Math.round(after.maxX)},${Math.round(after.maxY)}`
  );

  const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'canvas-peer-stroke.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  screenshot ${file}`);
  console.log(`PASS: stroke ${ID} crossed the room and a peer page painted it`);
} catch (error) {
  failed = true;
  console.error(`FAIL: ${error.message}`);
} finally {
  for (const tab of tabs) tab.ws.close();
  if (chrome) {
    chrome.kill('SIGTERM');
    await sleep(600);
    chrome.kill('SIGKILL');
  }
  if (relay) relay.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
