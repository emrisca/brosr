// A remote pointer has to stay on the same paper point when either window
// changes. This check drives two canvas pages at different sizes, moves one
// pointer, then zooms and resizes each page and reads where the other page
// paints the dot. The dot is placed by sheet coordinates, so the tip of the
// arrow must land at view.x + point.x * view.z on the receiving page at every
// zoom and every window size.
//
// The app keeps its browser on port 9333, so this check uses its own port, its
// own profile and its own relay.
//
//   node scripts/check-canvas-pointer.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-canvas-pointer.mjs
//   BROSR_RELAY=http://127.0.0.1:8787 BROSR_ROOM=room-1 node scripts/check-canvas-pointer.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.BROSR_RELAY || '';
const ROOM = process.env.BROSR_ROOM || `pointer-${Date.now().toString(36)}`;
const SHEET = { x: 1200, y: 800 };
const TOLERANCE = 4;
const BROWSERS = [
  process.env.BROSR_CHECK_BROWSER,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
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
    await sleep(120);
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
      if (!message.id) return;
      const held = this.pending.get(message.id);
      if (!held) return;
      this.pending.delete(message.id);
      if (message.error) held.reject(new Error(JSON.stringify(message.error)));
      else held.resolve(message.result);
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      // A wheel dispatch can wait on the compositor. A stuck call names the
      // method instead of holding the whole check open.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
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
      throw new Error(out.exceptionDetails.text + ' ' + (out.exceptionDetails.exception?.description || ''));
    }
    return out.result.value;
  }
}

// The page paints its own sheet, so its pixels are the picture a person sees.
// The arrow tip is the top left of the coloured pixels, because the arrow path
// starts at 0,0 and the name label sits down and to the right of it.
const INSPECT = `(() => {
  const c = document.getElementById('sheet');
  if (!c) return null;
  if (typeof view === 'undefined') return { missing: 'view' };
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dot = 0, tipX = 1e9, tipY = 1e9;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) {
      dot += 1;
      const p = i / 4, x = p % c.width, y = (p - x) / c.width;
      if (x < tipX) tipX = x;
      if (y < tipY) tipY = y;
    }
  }
  const rect = c.getBoundingClientRect();
  return {
    dot,
    tip: dot ? { x: tipX, y: tipY } : null,
    dpr: c.width / Math.max(1, rect.width),
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    view: { x: view.x, y: view.y, z: view.z },
    pointer: pointer ? { x: pointer.x, y: pointer.y } : null,
    pointerAt: pointerAt ? { x: pointerAt.x, y: pointerAt.y } : null,
    zoom: document.getElementById('zoom-out-value').textContent,
  };
})()`;

const browser = BROWSERS.find((file) => fs.existsSync(file));
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}

let relay = null;
let base = LIVE.replace(/\/$/, '');
let failed = false;
const profile = await mkdtemp(path.join(tmpdir(), 'brosr-canvas-pointer-'));
let chrome = null;
const tabs = [];
let probe = null;

const pointerFrames = () =>
  probe.frames.filter(
    (frame) => frame.type === 'app' && frame.name === 'canvas' && frame.data && frame.data.op === 'pointer'
  );
const lastPoint = () => {
  const list = pointerFrames().filter((frame) => !frame.data.gone);
  return list.length ? list[list.length - 1].data : null;
};

function moved(where, a, b) {
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  console.log(`  ${where}: wire point ${round(a.x)},${round(a.y)} (moved ${round(distance)} from ${round(b.x)},${round(b.y)})`);
  return distance;
}

const round = (value) => Math.round(value * 10) / 10;

async function expectDot(where, tab, point) {
  const state = await waitFor(async () => {
    const now = await tab.eval(INSPECT);
    return now && now.dot > 0 ? now : null;
  }, `a dot on the ${where}`);
  const expectedX = (state.view.x + point.x * state.view.z) * state.dpr;
  const expectedY = (state.view.y + point.y * state.view.z) * state.dpr;
  const dx = Math.abs(state.tip.x - expectedX);
  const dy = Math.abs(state.tip.y - expectedY);
  assert.ok(
    dx <= TOLERANCE && dy <= TOLERANCE,
    `${where}: dot tip ${round(state.tip.x)},${round(state.tip.y)} at ${state.zoom}, expected ${round(expectedX)},${round(expectedY)} for sheet ${round(point.x)},${round(point.y)}`
  );
  console.log(
    `  ${where} at ${state.zoom}: dot tip ${round(state.tip.x)},${round(state.tip.y)}, expected ${round(expectedX)},${round(expectedY)}`
  );
  return state;
}

// The pointer is placed by the page's own view, so the check reads the same
// mapping the page uses instead of hard coding a client point.
async function moveToSheet(tab, point) {
  const state = await tab.eval(INSPECT);
  const x = Math.round(state.rect.left + state.view.x + point.x * state.view.z);
  const y = Math.round(state.rect.top + state.view.y + point.y * state.view.z);
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  return { x, y };
}

// A wheel at a quarter of the sheet area zooms around a fixed point that is
// not the hand, so the paper point under the hand moves and the page has to
// send the new point without a move.
async function wheel(tab, deltaY) {
  const state = await tab.eval(INSPECT);
  const x = Math.round(state.rect.left + state.rect.width * 0.25);
  const y = Math.round(state.rect.top + state.rect.height * 0.25);
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  return { x, y };
}

try {
  if (!base) {
    const port = await freePort(9640);
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RELAY_QUIET: '1' },
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`${base}/health`)).ok, 'relay');
  }
  console.log(`relay ${base}, room ${ROOM}, browser ${path.basename(browser)}`);

  const devPort = await freePort(9720);
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

  const open = async (url) => {
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
    await tab.send('Page.navigate', { url });
    await waitFor(
      () => tab.eval('document.readyState === "complete" && !!document.getElementById("sheet")'),
      url
    );
    return tab;
  };

  const page = `${base}/canvas/?room=${encodeURIComponent(ROOM)}`;
  const a = await open(page);
  const b = await open(page);
  // A second viewport size is the point, so the two pages do not share a fit.
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1200);

  const first = await a.eval(INSPECT);
  assert.ok(!first.missing, `the page hides ${first.missing} from this check`);
  assert.ok(first.view.z > 0, 'the sheet is not fitted');
  assert.equal((await b.eval(INSPECT)).dot, 0, 'page B drew a dot before any pointer arrived');

  probe = new WebSocket(`${base.replace(/^http/, 'ws')}/room?room=${encodeURIComponent(ROOM)}`);
  probe.frames = [];
  probe.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      probe.frames.push(JSON.parse(event.data));
    } catch {
      // A frame this check cannot read is not a pointer frame.
    }
  });
  await new Promise((resolve, reject) => {
    probe.addEventListener('open', resolve, { once: true });
    probe.addEventListener('error', () => reject(new Error('probe socket')), { once: true });
  });

  // 1. A point on the paper travels as sheet coordinates.
  await moveToSheet(a, SHEET);
  const held = await waitFor(() => lastPoint(), 'the first pointer frame', 4000);
  assert.ok(
    Math.abs(held.x - SHEET.x) <= 1.5 && Math.abs(held.y - SHEET.y) <= 1.5,
    `the wire point ${held.x},${held.y} is not the sheet point ${SHEET.x},${SHEET.y}`
  );
  console.log(`  page A sent sheet ${round(held.x)},${round(held.y)}`);
  await expectDot('page B before any zoom', b, held);

  // 2. B zooms out. The dot is placed on the sheet, so it follows the paper
  // point under the same place on B and not a share of B's viewport.
  const countBeforeB = pointerFrames().length;
  await wheel(b, 500);
  await sleep(350);
  const zoomedB = await expectDot('page B after its own zoom out', b, held);
  assert.ok(zoomedB.view.z < first.view.z, 'page B did not zoom out');
  assert.equal(pointerFrames().length, countBeforeB, 'page B sent a pointer frame of its own');
  console.log(`  page B zoomed from ${first.view.z.toFixed(2)} to ${zoomedB.view.z.toFixed(2)} with the dot on the same paper point`);

  // 3. B changes window size. The view stays, so the dot must stay too, and
  // the canvas has to be repainted at the new size.
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: 820,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(350);
  const resizedB = await expectDot('page B after a resize', b, held);
  assert.ok(
    Math.abs(resizedB.rect.width - zoomedB.rect.width) > 20,
    `the window on page B reads ${resizedB.rect.width} wide after reading ${zoomedB.rect.width}`
  );
  console.log(
    `  page B resized from ${Math.round(zoomedB.rect.width)}x${Math.round(zoomedB.rect.height)} to ${Math.round(resizedB.rect.width)}x${Math.round(resizedB.rect.height)} and kept the dot`
  );

  // 4. A zooms out around a corner while its hand stays still. The paper point
  // under the hand changes, so A has to send the new point without a move.
  const beforeZoomA = pointerFrames().length;
  console.log('  page A zooms out with a still hand');
  // A wheel lands on the page in front, so the wheel lane brings the page it
  // drives forward first. The dot lane stays where it is and keeps reading.
  await a.send('Page.bringToFront');
  await sleep(200);
  await wheel(a, 600);
  await sleep(350);
  const afterZoomA = await waitFor(
    () => (pointerFrames().length > beforeZoomA ? lastPoint() : null),
    'a pointer frame after the zoom out on A',
    4000
  );
  const heldA = await a.eval(INSPECT);
  const under = {
    x: (heldA.pointerAt.x - heldA.rect.left - heldA.view.x) / heldA.view.z,
    y: (heldA.pointerAt.y - heldA.rect.top - heldA.view.y) / heldA.view.z,
  };
  assert.ok(
    Math.abs(afterZoomA.x - under.x) <= 1.5 && Math.abs(afterZoomA.y - under.y) <= 1.5,
    `A sent ${afterZoomA.x},${afterZoomA.y} but its hand reads ${under.x},${under.y}`
  );
  moved('page A after its own zoom out', afterZoomA, held);
  await expectDot('page B for the zoomed point', b, afterZoomA);

  // 5. A zooms in around the same corner. The point under a still hand moves
  // again, and the dot has to land there.
  const beforeIn = pointerFrames().length;
  console.log('  page A zooms in with a still hand');
  await wheel(a, -500);
  await sleep(350);
  const afterIn = await waitFor(
    () => (pointerFrames().length > beforeIn ? lastPoint() : null),
    'a pointer frame after the zoom in on A',
    4000
  );
  const heldIn = await a.eval(INSPECT);
  const underIn = {
    x: (heldIn.pointerAt.x - heldIn.rect.left - heldIn.view.x) / heldIn.view.z,
    y: (heldIn.pointerAt.y - heldIn.rect.top - heldIn.view.y) / heldIn.view.z,
  };
  assert.ok(
    Math.abs(afterIn.x - underIn.x) <= 1.5 && Math.abs(afterIn.y - underIn.y) <= 1.5,
    `A sent ${afterIn.x},${afterIn.y} but its hand reads ${underIn.x},${underIn.y}`
  );
  moved('page A after its own zoom in', afterIn, afterZoomA);
  await expectDot('page B for the zoomed in point', b, afterIn);

  // 6. The zoom buttons change the view without a wheel, so they need the same
  // resend.
  for (const step of ['first', 'second']) {
    const before = pointerFrames().length;
    await a.eval(`document.getElementById('zoom-out').click()`);
    await sleep(300);
    const next = await waitFor(
      () => (pointerFrames().length > before ? lastPoint() : null),
      `a pointer frame after zoom out click ${step}`,
      4000
    );
    const state = await a.eval(INSPECT);
    const want = {
      x: (state.pointerAt.x - state.rect.left - state.view.x) / state.view.z,
      y: (state.pointerAt.y - state.rect.top - state.view.y) / state.view.z,
    };
    assert.ok(
      Math.abs(next.x - want.x) <= 1.5 && Math.abs(next.y - want.y) <= 1.5,
      `A sent ${next.x},${next.y} but its hand reads ${want.x},${want.y}`
    );
    console.log(`  page A sent ${round(next.x)},${round(next.y)} after zoom out click ${step} at ${await a.eval('document.getElementById("zoom-out-value").textContent')}`);
    await expectDot(`page B after zoom out click ${step}`, b, next);
  }

  // 7. A changes window size. The view does not move, so the paper point under
  // the same client place is unchanged and B keeps its dot there.
  const beforeResize = await a.eval(INSPECT);
  await a.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
  const resizedA = await a.eval(INSPECT);
  assert.ok(
    Math.abs(resizedA.rect.width - beforeResize.rect.width) > 20,
    `the window on page A reads ${resizedA.rect.width} wide after reading ${beforeResize.rect.width}`
  );
  const still = resizedA.pointer;
  assert.ok(still, 'page A lost the paper under a still hand after a resize');
  assert.ok(
    Math.abs(resizedA.view.x - beforeResize.view.x) < 0.01 && Math.abs(resizedA.view.z - beforeResize.view.z) < 0.001,
    'the resize moved the view without a fit'
  );
  console.log(
    `  page A resized from ${Math.round(beforeResize.rect.width)}x${Math.round(beforeResize.rect.height)} to ${Math.round(resizedA.rect.width)}x${Math.round(resizedA.rect.height)} and still holds ${round(still.x)},${round(still.y)}`
  );
  await expectDot('page B after the window on A resized', b, still);

  // 8. Leaving the paper has to clear the dot, so nothing draws on the desk.
  const last = await a.eval(INSPECT);
  await a.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(last.rect.left + 2),
    y: Math.round(last.rect.top + 2),
  });
  await waitFor(
    () => pointerFrames().some((frame) => frame.data.gone === true),
    'a clear frame when the pointer leaves the paper',
    4000
  );
  await waitFor(async () => (await b.eval(INSPECT)).dot === 0, 'page B to drop the dot', 4000);
  console.log('  the dot left with the pointer');

  console.log(`PASS: the remote pointer held ${SHEET.x},${SHEET.y} through zoom, resize and clear`);
} catch (error) {
  failed = true;
  console.error(`FAIL: ${error.message}`);
} finally {
  if (probe) probe.close();
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
