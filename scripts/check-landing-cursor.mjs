// Cursor checks for the landing page. Lane 1 opens the page on its own and
// reads the socket the page holds. Lane 2 loads the unpacked bridge in a second
// Chromium and checks the shared tab path: a plain tab sends its pointer, the
// room tab puts it on the wire, and a frame from another person draws it on
// that plain tab.
//
// The app keeps its browser on port 9333, so this check uses its own ports and
// its own profile and never touches that one.
//
//   node scripts/check-landing-cursor.mjs
//   node scripts/check-landing-cursor.mjs --no-bridge
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-landing-cursor.mjs
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : true;
}

const BASE_PORT = Number(option('--port', process.env.BROSR_CHECK_PORT || 9444));
const WITH_BRIDGE = option('--bridge', !process.argv.includes('--no-bridge'));

// A plain lane needs any Chromium. A bridge lane needs one that still loads an
// unpacked folder, because Chrome 137 refuses --load-extension.
const CANDIDATES = [
  process.env.BROSR_CHECK_BROWSER,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);
const BRIDGE_ONLY = [
  process.env.BROSR_CHECK_BRIDGE_BROWSER,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const pick = (list) => list.find((file) => fs.existsSync(file)) || null;

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
    await sleep(120);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

// One tab on the debug port. The socket answers in order, so one counter names
// every call.
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
    const out = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (out.exceptionDetails) {
      throw new Error(
        out.exceptionDetails.text + ' ' + (out.exceptionDetails.exception?.description || '')
      );
    }
    return out.result.value;
  }
}

async function startRelay(port) {
  const child = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 'relay');
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return child;
}

async function launch({ browser, port, extension = null }) {
  const profile = await mkdtemp(path.join(tmpdir(), 'brosr-cursor-check-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1400,900',
  ];
  if (extension) {
    args.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
  } else {
    args.push('--disable-extensions');
  }
  args.push('about:blank');
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
      // A frame this check cannot read is not a cursor frame it needs.
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('probe socket')), { once: true });
  });
  return { socket, frames };
}

const landingDots = (tab) =>
  tab.eval(
    `[...document.querySelectorAll('#cursors .cursor')].map((box) => ({
      name: box.querySelector('.cursor-name').textContent,
      left: box.style.left,
      top: box.style.top,
    }))`
  );

// Lane 1. The landing page has no room, so the page holds its own socket. One
// focused tab sends its pointer as a share of the viewport, a probe frame draws
// one named dot on every page, and the dot leaves when the points stop.
async function checkLanding(browser, devPort, relayPort) {
  // A page with no room params is a plain page. Its own room name is 'default',
  // and its socket reads the address the page was opened on.
  const room = 'default';
  const page = `http://127.0.0.1:${relayPort}/`;
  const tabs = [];
  let probe = null;
  const held = await launch({ browser, port: devPort });
  try {
    probe = await openProbe(relayPort, room);
    const ready = (tab) =>
      tab.eval(`document.readyState === 'complete' && !!document.getElementById('cursors')`);

    const a = await openTab(held.cdp, tabs, page, ready);
    assert.equal(
      await a.eval(`!!document.querySelector('meta[name="brosr-cursors"]')`),
      true,
      'the landing page does not name itself as the cursor owner'
    );
    assert.equal(
      await a.eval(`!!document.getElementById('brosr-cursors')`),
      false,
      'the bridge drew on a page that owns its cursors'
    );
    await a.send('Page.bringToFront');
    await waitFor(
      () => a.eval(`document.hasFocus() && document.visibilityState === 'visible'`),
      'focused tab',
      6000
    );
    await waitFor(
      async () => (await (await fetch(`http://127.0.0.1:${relayPort}/status?room=${room}`)).json()).peers === 2,
      'page and probe in the room'
    );
    await sleep(1000);

    const sent = () =>
      probe.frames.find(
        (frame) =>
          frame.type === 'app' &&
          frame.name === 'cursor' &&
          frame.data &&
          frame.data.page === page &&
          frame.data.name === 'Guest'
      );
    for (let round = 0; round < 3 && !sent(); round += 1) {
      for (const [x, y] of [
        [320, 260],
        [430, 310],
        [540, 360],
        [650, 400],
      ]) {
        await a.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await sleep(120);
      }
      await sleep(500);
    }
    const frame = sent();
    assert.ok(
      frame,
      'the page sent no cursor frame: ' +
        JSON.stringify(await a.eval(`({ focus: document.hasFocus(), visibility: document.visibilityState })`))
    );
    assert.ok(frame.data.x > 0 && frame.data.x < 1, `x is not a viewport share: ${frame.data.x}`);
    assert.ok(frame.data.y > 0 && frame.data.y < 1, `y is not a viewport share: ${frame.data.y}`);
    assert.deepEqual(await landingDots(a), [], 'the page drew its own cursor back');
    console.log(
      `  focused page sent ${Math.round(frame.data.x * 1000) / 10}% / ${Math.round(frame.data.y * 1000) / 10}%`
    );

    const b = await openTab(held.cdp, tabs, page, ready);
    probe.socket.send(
      JSON.stringify({
        v: 1,
        type: 'app',
        peerId: 'probe-1',
        name: 'cursor',
        data: { page, x: 0.5, y: 0.4, name: 'Probe' },
      })
    );
    const shown = await waitFor(async () => {
      const list = await landingDots(b);
      return list.length === 1 && list[0].name === 'Probe' ? list : null;
    }, 'probe dot in the second page');
    assert.equal(shown[0].left, '50%');
    assert.equal(shown[0].top, '40%');
    assert.deepEqual(await landingDots(a), shown, 'the two pages put the dot in different places');
    console.log('  one probe frame drew one dot at 50% / 40% on both pages');

    await waitFor(async () => (await landingDots(b)).length === 0, 'dot expiry', 8000);
    console.log('  the dot left after three quiet seconds');
  } finally {
    if (probe) probe.socket.close();
    for (const tab of tabs) {
      await fetch(`${held.cdp}/json/close/${tab.targetId}`).catch(() => {});
      tab.ws.close();
    }
    await held.stop();
  }
}

// Lane 2. The bridge runs, the landing page is the room tab, and a Canvas tab
// is a plain page in the same browser. The Canvas tab sends its pointer through
// the room tab, and a probe frame comes back through the background to the tab
// that shows that page.
async function checkBridge(browser, devPort, relayPort, extension) {
  const room = `bridge-${Date.now()}`;
  const base = `http://127.0.0.1:${relayPort}`;
  const landing = `${base}/`;
  const canvas = `${base}/canvas/`;
  const tabs = [];
  let probe = null;
  const held = await launch({ browser, port: devPort, extension });
  try {
    probe = await openProbe(relayPort, room);
    const roomTab = await openTab(
      held.cdp,
      tabs,
      `${landing}?role=host&room=${room}&peer=host&name=Host&relay=${relayPort}`,
      async (tab) => {
        const raw = await tab.eval(`document.documentElement.dataset.brosr || ''`);
        if (!raw) return false;
        try {
          return JSON.parse(raw).role === 'host';
        } catch {
          return false;
        }
      }
    );
    assert.equal(
      await roomTab.eval(`!!document.querySelector('[data-brosr-overlay]')`),
      true,
      'the core did not attach its cursor overlay on the room tab'
    );
    assert.deepEqual(
      await landingDots(roomTab),
      [],
      'the room tab opened its own socket beside the core'
    );

    // The content script runs in an isolated world, so a page check cannot read
    // its globals. The page shows the work through the layer it draws instead.
    const shared = await openTab(
      held.cdp,
      tabs,
      canvas,
      (tab) => tab.eval(`document.readyState === 'complete'`)
    );
    await sleep(700);
    await shared.send('Page.bringToFront');
    await waitFor(
      () => shared.eval(`document.hasFocus() && document.visibilityState === 'visible'`),
      'focused canvas tab',
      6000
    );
    await waitFor(
      async () => (await (await fetch(`${base}/status?room=${room}`)).json()).peers >= 1,
      'room tab in the room'
    );
    await sleep(1000);

    // The room tab speaks for this person with presence, because that is the
    // frame every peer draws from. The old app/cursor frame belonged to the
    // landing page's own socket, which the room tab keeps shut. The URL alone
    // arrives first through the active-page report, so the frame has to carry
    // the pointer the canvas tab forwarded to count as the shared tab's cursor.
    const moves = [
      [300, 240],
      [420, 300],
      [560, 360],
    ];
    const sharedView = await shared.eval(`({ width: innerWidth, height: innerHeight })`);
    const near = (a, b) => Math.abs(a - b) < 0.004;
    // A background room tab has its presence timer throttled, so the frame may
    // carry any of the points this tab moved to and not only the newest one.
    // Each of them proves the same thing: the point came from this canvas tab.
    const isMovedPoint = (point) =>
      Boolean(point) &&
      moves.some(
        ([x, y]) =>
          near(point.x, x / sharedView.width) && near(point.y, y / sharedView.height)
      );
    const fromCanvas = () =>
      probe.frames.find(
        (frame) =>
          frame.type === 'presence' &&
          frame.peerId === 'host' &&
          typeof frame.url === 'string' &&
          frame.url.startsWith(canvas) &&
          isMovedPoint(frame.point)
      );
    for (let round = 0; round < 3 && !fromCanvas(); round += 1) {
      for (const [x, y] of [
        [300, 240],
        [420, 300],
        [560, 360],
      ]) {
        await shared.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await sleep(140);
      }
      await sleep(500);
    }
    const frame = fromCanvas();
    if (!frame) {
      const sharedState = await shared.eval(`({
        meta: !!document.querySelector('meta[name="brosr-own-room"]'),
        sites: document.documentElement.dataset.brosrCursorSites || null,
        error: document.documentElement.dataset.brosrError || null,
        ready: document.readyState,
        width: innerWidth,
        height: innerHeight,
      })`);
      const seen = probe.frames
        .filter((item) => item.type === 'presence' && item.peerId === 'host')
        .slice(-6)
        .map((item) => ({ url: item.url, point: item.point }));
      throw new Error(
        'the shared tab sent no presence frame through the room tab: ' +
          JSON.stringify({ sharedState, seen })
      );
    }
    // The room tab adds the name, because the shared tab has none. A frame that
    // carries no name would draw an unnamed dot for everyone in the room.
    assert.equal(
      frame.name,
      'Host',
      `the room tab sent ${JSON.stringify(frame.name)} as the sender name`
    );
    assert.ok(
      frame.point &&
        frame.point.x > 0 &&
        frame.point.x <= 1 &&
        frame.point.y > 0 &&
        frame.point.y <= 1,
      `the frame carried ${JSON.stringify(frame.point)} as its point`
    );
    console.log(
      `  shared tab sent ${Math.round(frame.point.x * 1000) / 10}% / ${Math.round(frame.point.y * 1000) / 10}% as ${frame.name} through the room tab`
    );

    // The canvas page holds its own room and draws its own pointers. The core
    // must not add a second layer beside them, or every peer dot shows twice.
    assert.equal(
      await shared.eval(`!!document.querySelector('[data-brosr-overlay]')`),
      false,
      'the canvas page grew a second cursor layer beside its own'
    );
    console.log('  the canvas page keeps one pointer layer, its own');

    probe.socket.send(
      JSON.stringify({
        v: 1,
        type: 'presence',
        peerId: 'probe-1',
        name: 'Probe',
        colour: '#3f86e2',
        point: { x: 0.4, y: 0.35 },
        url: landing,
      })
    );
    const seen = await waitFor(async () => {
      const raw = await roomTab.eval(`document.documentElement.dataset.brosr || ''`);
      if (!raw) return null;
      const state = JSON.parse(raw);
      return Number(state.cursors) >= 1 ? state : null;
    }, 'the room tab counted the probe cursor');
    assert.ok(seen.peerId === 'host', `the room tab reports ${seen.peerId}`);
    assert.deepEqual(
      await landingDots(roomTab),
      [],
      'the room tab drew a second dot beside the core overlay'
    );
    console.log('  the room tab draws the room cursors through the core and keeps its own socket shut');
  } finally {
    if (probe) probe.socket.close();
    for (const tab of tabs) {
      await fetch(`${held.cdp}/json/close/${tab.targetId}`).catch(() => {});
      tab.ws.close();
    }
    await held.stop();
  }
}

const browser = pick(CANDIDATES);
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}
const bridgeBrowser = pick(BRIDGE_ONLY);
const relayPort = await freePort(BASE_PORT + 20);
const relay = await startRelay(relayPort);
let failed = false;
try {
  console.log(`relay on ${relayPort}, plain browser ${browser}`);
  await checkLanding(browser, await freePort(BASE_PORT), relayPort);
  console.log('  PASS: the landing page sends its pointer and draws a named room cursor');

  if (!WITH_BRIDGE) {
    console.log('\nbridge lane skipped: --no-bridge');
  } else if (!bridgeBrowser) {
    console.log('\nbridge lane skipped: no browser here loads an unpacked extension');
  } else {
    const extension = await mkdtemp(path.join(tmpdir(), 'brosr-cursor-bridge-'));
    try {
      const built = buildChrome(extension);
      console.log(`bridge lane on ${path.basename(bridgeBrowser)} with ${built.entries} files`);
      await checkBridge(bridgeBrowser, await freePort(BASE_PORT + 10), relayPort, built.dir);
      console.log('  PASS: a shared tab reaches the room and draws the frame that comes back');
    } finally {
      await rm(extension, { recursive: true, force: true });
    }
  }
} catch (error) {
  failed = true;
  console.error(`\nFAIL: ${error.message}`);
} finally {
  relay.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
