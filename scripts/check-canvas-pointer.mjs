// A remote pointer has to stay on the same paper point when either window
// changes. This check drives two canvas pages at different sizes, moves one
// pointer, then zooms and resizes each page and reads where the other page
// paints the dot. The dot is placed by sheet coordinates, so the tip of the
// arrow must land at view.x + point.x * view.z on the receiving page at every
// zoom and every window size. The square sheet is checked too: a stroke that
// leaves the paper has to stop at its edge, a press on the desk has to draw
// nothing, and a sheet of 2000 strokes has to keep a frame inside one refresh.
// A page in front has to glide its dot to a new point in about the 80 ms the
// landing page cursors take, and not jump there.
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
const SHEET = { x: 1200, y: 1200 };
const TOLERANCE = 4;
// One frame at 60 Hz is 16.7 ms. A crowded sheet has to stay well inside it.
const FRAME_BUDGET = 8;
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
  let dot = 0, tipX = 1e9, tipY = 1e9, box = null;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) {
      dot += 1;
      const p = i / 4, x = p % c.width, y = (p - x) / c.width;
      if (x < tipX) tipX = x;
      if (y < tipY) tipY = y;
      if (!box) box = { minX: x, minY: y, maxX: x, maxY: y };
      if (x < box.minX) box.minX = x;
      if (y < box.minY) box.minY = y;
      if (x > box.maxX) box.maxX = x;
      if (y > box.maxY) box.maxY = y;
    }
  }
  const rect = c.getBoundingClientRect();
  return {
    dot,
    tip: dot ? { x: tipX, y: tipY } : null,
    box,
    dpr: c.width / Math.max(1, rect.width),
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    view: { x: view.x, y: view.y, z: view.z },
    paper: { width: PAPER.width, height: PAPER.height },
    fitted: Boolean(fitted),
    total: state.layers.reduce((sum, layer) => sum + layer.strokes.length, 0),
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

// A dot glides to its point, so the wait holds until the tip has arrived, not
// only until some coloured pixel exists.
async function expectDot(where, tab, point) {
  const expectedOf = (now) => ({
    x: (now.view.x + point.x * now.view.z) * now.dpr,
    y: (now.view.y + point.y * now.view.z) * now.dpr,
  });
  let state;
  try {
    state = await waitFor(async () => {
      const now = await tab.eval(INSPECT);
      if (!now || !(now.dot > 0)) return null;
      const at = expectedOf(now);
      return Math.abs(now.tip.x - at.x) <= TOLERANCE && Math.abs(now.tip.y - at.y) <= TOLERANCE
        ? now
        : null;
    }, `a dot on the ${where}`);
  } catch (error) {
    const now = await tab.eval(INSPECT);
    assert.fail(
      `${where}: dot tip ${now && now.tip ? round(now.tip.x) + ',' + round(now.tip.y) : 'none'} at ${now && now.zoom}, expected ${now ? round(expectedOf(now).x) + ',' + round(expectedOf(now).y) : 'none'} for sheet ${round(point.x)},${round(point.y)}`
    );
  }
  const expectedX = expectedOf(state).x;
  const expectedY = expectedOf(state).y;
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

// A fit is the view the page gives a sheet nobody zoomed. The check compares
// against the same formula rather than trusting the displayed percentage.
const fitZoom = (rect, paper) =>
  Math.min(rect.width / paper.width, rect.height / paper.height) * 0.9;

// One mouse event on a page. A drag needs buttons set, because a move after a
// press is what a pointermove on the sheet looks like.
const mouse = (tab, type, x, y, extra = {}) =>
  tab.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });

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

  // 1. A point on the paper travels as sheet coordinates. A mouse lands on a
  // whole client pixel, so the check reads the paper point under that pixel
  // from the page and not the one it asked for.
  await moveToSheet(a, SHEET);
  const held = await waitFor(() => lastPoint(), 'the first pointer frame', 4000);
  const onSheet = await a.eval(INSPECT);
  assert.ok(onSheet.pointer, 'page A did not hold a paper point');
  assert.ok(
    Math.abs(held.x - onSheet.pointer.x) <= 1 && Math.abs(held.y - onSheet.pointer.y) <= 1,
    `the wire point ${held.x},${held.y} is not the paper point ${round(onSheet.pointer.x)},${round(onSheet.pointer.y)}`
  );
  assert.ok(
    Math.abs(onSheet.pointer.x - SHEET.x) <= 4 && Math.abs(onSheet.pointer.y - SHEET.y) <= 4,
    `the pointer landed at ${round(onSheet.pointer.x)},${round(onSheet.pointer.y)} instead of ${SHEET.x},${SHEET.y}`
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

  // 4. A dot glides to its point instead of jumping. A page in the background
  // paints no frames, so B is held in front, the hand on A moves 600 sheet px
  // and the check samples B until the tip is within 2 px of the point A sent.
  await b.send('Page.bringToFront');
  await sleep(200);
  const glideFrom = (await b.eval(INSPECT)).tip;
  const beforeGlide = pointerFrames().length;
  await moveToSheet(a, { x: 1800, y: 1800 });
  const glideWire = await waitFor(
    () => (pointerFrames().length > beforeGlide ? lastPoint() : null),
    'the pointer frame the glide reads',
    4000
  );
  const glideStart = Date.now();
  let landed = null;
  while (Date.now() - glideStart < 1500) {
    const now = await b.eval(INSPECT);
    if (now && now.dot) {
      const ex = (now.view.x + glideWire.x * now.view.z) * now.dpr;
      const ey = (now.view.y + glideWire.y * now.view.z) * now.dpr;
      if (Math.hypot(now.tip.x - ex, now.tip.y - ey) <= 2) {
        landed = { ms: Date.now() - glideStart, state: now };
        break;
      }
    }
    await sleep(16);
  }
  assert.ok(landed, 'the front page never glided its dot to the point A sent');
  const finalX = (landed.state.view.x + glideWire.x * landed.state.view.z) * landed.state.dpr;
  const finalY = (landed.state.view.y + glideWire.y * landed.state.view.z) * landed.state.dpr;
  const travel = Math.hypot(finalX - glideFrom.x, finalY - glideFrom.y);
  assert.ok(travel > 40, `the glide moved the dot only ${round(travel)} px`);
  // A jump would land on the first frame. The sample waits 16 ms between
  // reads, so a glide is the only way the dot is still moving at 40 ms.
  assert.ok(
    landed.ms >= 40 && landed.ms <= 200,
    `the dot reached its point in ${landed.ms} ms, which is not the 80 ms landing move`
  );
  console.log(`  the dot glided ${round(travel)} px and arrived within 2 px after ${landed.ms} ms`);
  // Put the hand back where the lanes before this one left it.
  await moveToSheet(a, held);
  await sleep(150);

  // 5. A zooms out around a corner while its hand stays still. The paper point
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

  // 6. A zooms in around the same corner. The point under a still hand moves
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

  // 7. The zoom buttons change the view without a wheel, so they need the same
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

  // 8. A changes window size with a zoomed view. A zoom is a choice, so the
  // resize leaves the view alone and the paper point under the same client
  // place does not move.
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
    'the resize moved a zoomed view without a fit'
  );
  console.log(
    `  page A resized from ${Math.round(beforeResize.rect.width)}x${Math.round(beforeResize.rect.height)} to ${Math.round(resizedA.rect.width)}x${Math.round(resizedA.rect.height)} and still holds ${round(still.x)},${round(still.y)}`
  );
  await expectDot('page B after the window on A resized', b, still);

  // 9. The other case is a sheet nobody zoomed: Fit, put the hand on the middle
  // of the paper, then change the window. The sheet refits to the new shape and
  // the point under the hand is read again against the new view.
  await a.eval('fit()');
  await sleep(150);
  await moveToSheet(a, { x: 1200, y: 1200 });
  await sleep(150);
  await a.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(450);
  const refit = await a.eval(INSPECT);
  const wantZoom = fitZoom(refit.rect, refit.paper);
  assert.ok(
    Math.abs(refit.view.z - wantZoom) < 0.005,
    `a fitted sheet kept ${refit.view.z.toFixed(3)} after a resize to ${Math.round(refit.rect.width)}x${Math.round(refit.rect.height)}, expected ${wantZoom.toFixed(3)}`
  );
  assert.ok(refit.fitted, 'the page dropped its fitted flag after a resize');
  assert.ok(refit.pointer, 'page A sent no pointer after a refit');
  const underRefit = {
    x: (refit.pointerAt.x - refit.rect.left - refit.view.x) / refit.view.z,
    y: (refit.pointerAt.y - refit.rect.top - refit.view.y) / refit.view.z,
  };
  assert.ok(
    Math.abs(refit.pointer.x - underRefit.x) <= 1.5 && Math.abs(refit.pointer.y - underRefit.y) <= 1.5,
    `after a refit A holds ${round(refit.pointer.x)},${round(refit.pointer.y)} but its hand reads ${round(underRefit.x)},${round(underRefit.y)}`
  );
  console.log(
    `  page A refitted to ${Math.round(refit.view.z * 100)}% after a resize to ${Math.round(refit.rect.width)}x${Math.round(refit.rect.height)} and re-read its hand`
  );
  await expectDot('page B after the refit', b, refit.pointer);

  // 10. Leaving the paper has to clear the dot, so nothing draws on the desk.
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

  // 11. Ink stops at the paper edge. The stroke starts on the sheet and the
  // hand leaves it, so every painted pixel has to sit inside the rectangle.
  const beforeInk = await a.eval(INSPECT);
  assert.equal(beforeInk.paper.width, beforeInk.paper.height, 'the sheet is not a square');
  await a.eval('setPreset("ink"); setColour("#1d4ed8")');
  await moveToSheet(a, { x: 1200, y: 1200 });
  await sleep(150);
  const start = await a.eval(INSPECT);
  const startX = Math.round(start.rect.left + start.view.x + 1200 * start.view.z);
  const startY = Math.round(start.rect.top + start.view.y + 1200 * start.view.z);
  const cornerX = Math.round(start.rect.left + 2);
  const cornerY = Math.round(start.rect.top + 2);
  await mouse(a, 'mousePressed', startX, startY, { clickCount: 1 });
  for (const t of [0.35, 0.7, 1]) {
    await mouse(
      a,
      'mouseMoved',
      Math.round(startX + (cornerX - startX) * t),
      Math.round(startY + (cornerY - startY) * t),
      { buttons: 1 }
    );
  }
  await mouse(a, 'mouseReleased', cornerX, cornerY);
  await sleep(250);
  const inkState = await a.eval(INSPECT);
  assert.equal(
    inkState.total,
    beforeInk.total + 1,
    'the stroke that left the sheet did not commit'
  );
  const points = await a.eval(`(() => {
    const layer = state.layers[state.activeLayer];
    const stroke = layer.strokes[layer.strokes.length - 1];
    return stroke ? stroke.points : [];
  })()`);
  assert.ok(points.length > 2, 'the stroke out of the sheet kept no points');
  const outside = points.filter(
    (point) =>
      point.x < 0 ||
      point.y < 0 ||
      point.x > inkState.paper.width ||
      point.y > inkState.paper.height
  );
  assert.equal(outside.length, 0, `${outside.length} stroke points sit outside the paper`);
  assert.ok(
    points.some((point) => point.x <= 0.01 || point.y <= 0.01),
    'no point was pulled back to the paper edge'
  );
  const box = inkState.box;
  assert.ok(box, 'the stroke painted nothing');
  const paperLeft = inkState.view.x * inkState.dpr;
  const paperTop = inkState.view.y * inkState.dpr;
  const paperRight = (inkState.view.x + inkState.paper.width * inkState.view.z) * inkState.dpr;
  const paperBottom = (inkState.view.y + inkState.paper.height * inkState.view.z) * inkState.dpr;
  assert.ok(
    Math.abs(paperRight - paperLeft - (paperBottom - paperTop)) < 1,
    'the paper is not square on screen'
  );
  const slack = 2;
  assert.ok(
    box.minX >= paperLeft - slack &&
      box.minY >= paperTop - slack &&
      box.maxX <= paperRight + slack &&
      box.maxY <= paperBottom + slack,
    `ink painted outside the paper: ${round(box.minX)},${round(box.minY)} to ${round(box.maxX)},${round(box.maxY)} against ${round(paperLeft)},${round(paperTop)} to ${round(paperRight)},${round(paperBottom)}`
  );
  console.log(
    `  a stroke out of the sheet stopped at its edge: ink ${round(box.maxX - box.minX)}x${round(box.maxY - box.minY)} inside a ${round(paperRight - paperLeft)}x${round(paperBottom - paperTop)} paper`
  );

  // 12. A press on the desk is not a stroke, so the model does not grow.
  const beforePress = await a.eval(INSPECT);
  await mouse(a, 'mousePressed', Math.round(beforePress.rect.left + 2), Math.round(beforePress.rect.top + 2), { clickCount: 1 });
  await mouse(a, 'mouseMoved', Math.round(beforePress.rect.left + 40), Math.round(beforePress.rect.top + 40), { buttons: 1 });
  await mouse(a, 'mouseReleased', Math.round(beforePress.rect.left + 40), Math.round(beforePress.rect.top + 40));
  await sleep(200);
  const afterPress = await a.eval(INSPECT);
  assert.equal(afterPress.total, beforePress.total, 'a press on the desk started a stroke');
  console.log('  a press on the desk drew nothing');

  // 13. A crowded sheet keeps a cheap frame. The single stroke path is what a
  // full repaint costs, and the page paints a frame from its ink bitmap.
  const perf = await a.eval(`(() => {
    const layer = state.layers[0];
    layer.strokes.length = 0;
    for (let i = 0; i < 800; i++) {
      const x = (i % 40) * 55 + 40;
      const y = Math.floor(i / 40) * 110 + 40;
      const points = [];
      for (let j = 0; j < 30; j++) {
        points.push(clampPoint({ x: x + j * 2, y: y + Math.sin(j / 3) * 14 }));
      }
      layer.strokes.push({
        id: 'perf-' + i,
        layer: 0,
        tool: 'pencil',
        colour: '#18181b',
        size: 4,
        opacity: 1,
        points,
      });
    }
    markInk();
    redraw();

    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const full = () => {
      const g = scratch.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, scratch.width, scratch.height);
      g.save();
      g.translate(view.x, view.y);
      g.scale(view.z, view.z);
      g.fillStyle = PAPER_COLOUR;
      g.fillRect(0, 0, PAPER.width, PAPER.height);
      paintCommitted(g);
      g.restore();
    };
    const median = (list) => list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)];
    // A canvas holds its work until something reads it, so a one-pixel read
    // ends the pass and the number covers the raster too.
    const flush = (target) => target.getContext('2d').getImageData(0, 0, 1, 1);
    const time = (fn, runs, target) => {
      const list = [];
      for (let i = 0; i < runs; i++) {
        const started = performance.now();
        fn();
        flush(target);
        list.push(performance.now() - started);
      }
      return Math.round(median(list) * 100) / 100;
    };

    full();
    redraw();
    const fullMs = time(full, 8, scratch);
    const frameMs = time(redraw, 30, canvas);
    const live = {
      id: 'perf-live',
      layer: 1,
      tool: 'pencil',
      colour: '#18181b',
      size: 4,
      opacity: 1,
      points: [],
    };
    for (let j = 0; j < 120; j++) {
      live.points.push(clampPoint({ x: 200 + j * 4, y: 400 + Math.sin(j / 4) * 30 }));
    }
    drawing = { stroke: live, last: live.points[live.points.length - 1] };
    const liveMs = time(redraw, 20, canvas);
    drawing = null;
    redraw();
    return { strokes: layer.strokes.length, fullMs, frameMs, liveMs };
  })()`);
  assert.ok(
    perf.frameMs < perf.fullMs / 2,
    `a frame took ${perf.frameMs} ms against ${perf.fullMs} ms for a full repaint`
  );
  assert.ok(
    perf.liveMs < perf.fullMs / 2,
    `a frame with a live line took ${perf.liveMs} ms against ${perf.fullMs} ms for a full repaint`
  );
  console.log(
    `  ${perf.strokes} strokes: full repaint ${perf.fullMs} ms, cached frame ${perf.frameMs} ms, frame with a live line ${perf.liveMs} ms`
  );

  // 14. Two thousand strokes is a sheet nobody draws by hand, and a frame still
  // has to land inside one refresh. The whole sheet is painted once for the
  // baseline, so a frame that scaled with the count would show up here.
  const stress = await a.eval(`(() => {
    const layer = state.layers[0];
    layer.strokes.length = 0;
    for (let i = 0; i < 2000; i++) {
      const x = (i % 50) * 44 + 20;
      const y = Math.floor(i / 50) * 55 + 20;
      const points = [];
      for (let j = 0; j < 24; j++) {
        points.push(clampPoint({ x: x + j * 1.6, y: y + Math.sin(j / 3) * 10 }));
      }
      layer.strokes.push({
        id: 'stress-' + i,
        layer: 0,
        tool: 'pencil',
        colour: '#18181b',
        size: 4,
        opacity: 1,
        points,
      });
    }
    markInk();
    redraw();

    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const full = () => {
      const g = scratch.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, scratch.width, scratch.height);
      g.save();
      g.translate(view.x, view.y);
      g.scale(view.z, view.z);
      g.fillStyle = PAPER_COLOUR;
      g.fillRect(0, 0, PAPER.width, PAPER.height);
      paintCommitted(g);
      g.restore();
    };
    const median = (list) => list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const flush = (target) => target.getContext('2d').getImageData(0, 0, 1, 1);
    const time = (fn, runs, target) => {
      const list = [];
      for (let i = 0; i < runs; i++) {
        const started = performance.now();
        fn();
        flush(target);
        list.push(performance.now() - started);
      }
      return Math.round(median(list) * 100) / 100;
    };

    full();
    redraw();
    const fullMs = time(full, 6, scratch);
    const frameMs = time(redraw, 40, canvas);
    const live = {
      id: 'stress-live',
      layer: 1,
      tool: 'pencil',
      colour: '#18181b',
      size: 4,
      opacity: 1,
      points: [],
    };
    for (let j = 0; j < 160; j++) {
      live.points.push(clampPoint({ x: 120 + j * 5, y: 1200 + Math.sin(j / 5) * 40 }));
    }
    drawing = { stroke: live, last: live.points[live.points.length - 1] };
    const liveMs = time(redraw, 30, canvas);
    drawing = null;
    redraw();
    return {
      strokes: layer.strokes.length,
      points: layer.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
      width: canvas.width,
      height: canvas.height,
      fullMs,
      frameMs,
      liveMs,
    };
  })()`);
  assert.equal(stress.strokes, 2000, `the stress lane committed ${stress.strokes} strokes`);
  assert.ok(
    stress.frameMs <= FRAME_BUDGET,
    `a frame on ${stress.strokes} strokes took ${stress.frameMs} ms against a budget of ${FRAME_BUDGET} ms`
  );
  assert.ok(
    stress.liveMs <= FRAME_BUDGET,
    `a frame with a live line on ${stress.strokes} strokes took ${stress.liveMs} ms against a budget of ${FRAME_BUDGET} ms`
  );
  assert.ok(
    stress.frameMs * 4 < stress.fullMs,
    `a frame on ${stress.strokes} strokes took ${stress.frameMs} ms against ${stress.fullMs} ms for a full repaint`
  );
  console.log(
    `  ${stress.strokes} strokes, ${stress.points} points at ${stress.width}x${stress.height}: full repaint ${stress.fullMs} ms, cached frame ${stress.frameMs} ms, frame with a live line ${stress.liveMs} ms`
  );

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
