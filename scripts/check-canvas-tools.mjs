// The canvas tools that the sheet needs to be usable by hand: a brush wide
// enough to be an eraser, an eraser that cuts only its own layer, layer
// controls with a floor of one, a hex field and recent colours, image import,
// and the GIF dialog. Every lane drives the real page, so the DOM, the model
// and the painted sheet are the same ones a person uses.
//
// The app keeps its browser on port 9333, so this check uses its own port, its
// own profile and its own relay.
//
//   node scripts/check-canvas-tools.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-canvas-tools.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.BROSR_RELAY || '';
const ROOM = process.env.BROSR_ROOM || `tools-${Date.now().toString(36)}`;
const BLUE = '#1d4ed8';
const RED = '#dc2626';
const PAPER = '#f7f7f8';
// A red PNG, built here so the check owns no binary asset. It is large enough
// to land at the box the page gives an imported picture, so its pixels are easy
// to count without depending on the file picker.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function redPng(side) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((side * 3 + 1) * side);
  for (let y = 0; y < side; y += 1) {
    const row = y * (side * 3 + 1);
    for (let x = 0; x < side; x += 1) raw[row + 1 + x * 3] = 220;
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

const PNG = redPng(1400);
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

const browser = BROWSERS.find((file) => fs.existsSync(file));
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}

// A tiny probe on the page: reset the stack, paint a line through the model,
// and count the finished pixels. paintComposite is the same pass a PNG export
// uses, so a count here is what a saved file would hold.
const PROBE = `(() => {
  window.probe = {
    reset() {
      state.layers.length = 0;
      state.layers.push(blankLayer('A'), blankLayer('B'));
      state.activeLayer = 1;
      markInk();
      redraw();
      renderLayers();
      return state.layers.length;
    },
    line(layer, tool, colour, size, y) {
      const points = [];
      for (let i = 0; i <= 20; i += 1) points.push({ x: 200 + i * 100, y: y });
      const stroke = {
        id: 'probe-' + Math.random().toString(36).slice(2, 10),
        layer: layer,
        tool: tool,
        colour: colour,
        size: size,
        opacity: 1,
        points: points,
      };
      addStroke(stroke);
      markInk();
      redraw();
      return stroke.id;
    },
    count(hex) {
      const out = document.createElement('canvas');
      out.width = PAPER.width;
      out.height = PAPER.height;
      paintComposite(out.getContext('2d'));
      const data = out.getContext('2d').getImageData(0, 0, PAPER.width, PAPER.height).data;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - r) <= 6 &&
          Math.abs(data[i + 1] - g) <= 6 &&
          Math.abs(data[i + 2] - b) <= 6
        ) {
          n += 1;
        }
      }
      return n;
    },
  };
  return true;
})()`;

let relay = null;
let base = LIVE.replace(/\/$/, '');
let failed = false;
const profile = await mkdtemp(path.join(tmpdir(), 'brosr-canvas-tools-'));
let chrome = null;
const tabs = [];

try {
  if (!base) {
    const port = await freePort(9660);
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RELAY_QUIET: '1' },
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`${base}/health`)).ok, 'relay');
  }
  console.log(`relay ${base}, room ${ROOM}, browser ${path.basename(browser)}`);

  const devPort = await freePort(9740);
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
  await sleep(1000);
  await tab.eval(PROBE);
  // The sheet writes documents to the relay by default, and this check makes
  // hundreds of model changes it does not need to store.
  await tab.eval(`(() => {
    const store = document.getElementById('doc-store');
    if (store && store.checked) store.click();
    return true;
  })()`);

  // 1. The size slider reaches 400, and a 300 px eraser is accepted. Each tool
  // keeps its own width, so going back to the pencil does not carry it over.
  const sizeMax = await tab.eval(`document.getElementById('size').max`);
  assert.equal(sizeMax, '400', `the size slider stops at ${sizeMax}`);
  await tab.eval(`(() => {
    const el = document.getElementById('size');
    el.value = '300';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(await tab.eval('state.size'), 300, 'the slider did not set a 300 px brush');
  await tab.eval(`setPreset('eraser')`);
  assert.equal(await tab.eval('state.size'), 60, 'the eraser did not open at its own size');
  await tab.eval(`(() => {
    const el = document.getElementById('size');
    el.value = '300';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await tab.eval(`setPreset('ink')`);
  assert.equal(await tab.eval('state.size'), 7, 'a fresh tool did not open at its default width');
  await tab.eval(`setPreset('pencil')`);
  assert.equal(await tab.eval('state.size'), 300, 'the pencil lost the width it was given');
  await tab.eval(`setPreset('eraser')`);
  assert.equal(await tab.eval('state.size'), 300, 'the eraser forgot its 300 px width');
  console.log('  the slider reaches 400 and each tool keeps its own width');

  // 2. An eraser on the top layer cuts that layer only. Blue sits on the lower
  // layer under a red line on the upper one, so the blue coming back is the
  // proof that no lower ink was touched.
  await tab.eval('probe.reset()');
  await tab.eval(`probe.line(0, 'ink', '${BLUE}', 80, 1200)`);
  const blueBefore = await tab.eval(`probe.count('${BLUE}')`);
  assert.ok(blueBefore > 20000, `the blue line painted ${blueBefore} pixels`);
  await tab.eval(`probe.line(1, 'ink', '${RED}', 80, 1200)`);
  const redBefore = await tab.eval(`probe.count('${RED}')`);
  assert.ok(redBefore > 20000, `the red line painted ${redBefore} pixels`);
  await tab.eval(`probe.line(1, 'eraser', '#000000', 300, 1200)`);
  const redAfter = await tab.eval(`probe.count('${RED}')`);
  const blueAfter = await tab.eval(`probe.count('${BLUE}')`);
  assert.ok(
    redAfter < redBefore * 0.02,
    `the eraser left ${redAfter} of ${redBefore} red pixels on its own layer`
  );
  assert.ok(
    blueAfter >= blueBefore * 0.95,
    `the eraser cut the lower layer from ${blueBefore} to ${blueAfter} blue pixels`
  );
  console.log(
    `  a 300 px eraser cleared ${redBefore} red pixels and kept all ${blueAfter} blue pixels below`
  );

  // 2b. A trackpad sends a fractional wheel delta for a two-finger scroll, so
  // the sheet pans and the zoom stays. A wheel notch still zooms.
  const viewBefore = await tab.eval('({ x: view.x, y: view.y, z: view.z })');
  const stage = await tab.eval(`(() => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await tab.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: stage.x,
    y: stage.y,
    deltaX: 14.5,
    deltaY: 9.5,
  });
  await sleep(150);
  const panned = await tab.eval('({ x: view.x, y: view.y, z: view.z })');
  assert.ok(
    Math.abs(panned.z - viewBefore.z) < 1e-9,
    `two fingers changed the zoom from ${viewBefore.z} to ${panned.z}`
  );
  assert.ok(
    Math.abs(panned.x - viewBefore.x) > 5 && Math.abs(panned.y - viewBefore.y) > 5,
    `two fingers moved the view from ${viewBefore.x},${viewBefore.y} to ${panned.x},${panned.y}`
  );
  await tab.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: stage.x,
    y: stage.y,
    deltaX: 0,
    deltaY: 500,
  });
  await sleep(150);
  const wheeled = await tab.eval('({ x: view.x, y: view.y, z: view.z })');
  assert.ok(
    wheeled.z < panned.z - 0.01,
    `a wheel notch left the zoom at ${wheeled.z} from ${panned.z}`
  );
  console.log(
    `  two fingers panned ${Math.round(panned.x - viewBefore.x)},${Math.round(panned.y - viewBefore.y)} px at ${viewBefore.z.toFixed(2)} and a wheel notch zoomed to ${wheeled.z.toFixed(2)}`
  );

  // 3. Layers add, draw a row each, delete, and never empty the sheet.
  await tab.eval('probe.reset()');
  await tab.eval('addLayer()');
  assert.equal(await tab.eval('state.layers.length'), 3, 'Add did not add a layer');
  assert.equal(
    await tab.eval(`document.querySelectorAll('#layers .layer').length`),
    3,
    'the layer list did not follow the stack'
  );
  assert.equal(
    await tab.eval(`document.getElementById('layer-count').textContent`),
    '3/6',
    'the layer count reads the wrong number'
  );
  await tab.eval('removeLayer(0)');
  assert.equal(await tab.eval('state.layers.length'), 2, 'Delete did not remove a layer');
  await tab.eval('removeLayer(0)');
  await tab.eval('removeLayer(0)');
  assert.equal(await tab.eval('state.layers.length'), 1, 'the last layer was removed');
  assert.match(
    await tab.eval(`document.getElementById('note').textContent`),
    /at least one layer/i,
    'the guard did not say why the last layer stayed'
  );
  console.log('  layers add, delete, and stop at one');

  // 4. A hex code from the field is the colour, and it lands in the recents.
  await tab.eval(`(() => {
    const el = document.getElementById('hex');
    el.value = '#15803d';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(await tab.eval('state.colour'), '#15803d', 'the hex field did not set the colour');
  assert.equal(
    await tab.eval(`document.getElementById('colour').value`),
    '#15803d',
    'the colour picker did not follow the hex field'
  );
  assert.equal(
    await tab.eval(`document.querySelector('.swatch[data-color="#15803d"]').getAttribute('aria-pressed')`),
    'true',
    'the matching swatch is not pressed'
  );
  assert.ok(
    (await tab.eval(`document.querySelectorAll('#recents .recent-swatch').length`)) >= 1,
    'the recents row stayed empty'
  );
  console.log('  a hex code sets the colour and joins the recents');

  // 5. An imported image lands on the active layer, appears in the list, and
  // covers paper in the finished picture.
  await tab.eval('probe.reset()');
  const paperBefore = await tab.eval(`probe.count('${PAPER}')`);
  const item = await tab.eval(`insertImageSource(${JSON.stringify(PNG)}, 'probe').then((held) => held ? { id: held.id, width: held.width, height: held.height } : null)`);
  assert.ok(item && item.id, 'the image did not land');
  assert.ok(item.width > 100 && item.height > 100, `the image landed at ${item.width} x ${item.height}`);
  assert.equal(
    await tab.eval('state.layers[state.activeLayer].images.length'),
    1,
    'the image is not on the active layer'
  );
  assert.equal(
    await tab.eval(`document.querySelectorAll('#image-list .image-row').length`),
    1,
    'the image list did not show the image'
  );
  const paperAfter = await tab.eval(`probe.count('${PAPER}')`);
  assert.ok(
    paperAfter < paperBefore * 0.75,
    `the image covered ${paperBefore - paperAfter} of ${paperBefore} paper pixels`
  );
  console.log(
    `  an image landed at ${Math.round(item.width)} x ${Math.round(item.height)} and covers the sheet`
  );

  // 6. The GIF modal opens over the sheet, keeps a key, and Escape closes it
  // even while the search field has the focus.
  await tab.eval(`document.getElementById('gif-open').click()`);
  assert.equal(
    await tab.eval(`document.getElementById('gif-dialog').hidden`),
    false,
    'the GIF dialog did not open'
  );
  assert.ok(
    await tab.eval(`!!document.getElementById('gif-key')`),
    'the GIF dialog has no key field'
  );
  await tab.eval(`(() => {
    const el = document.getElementById('gif-key');
    el.value = 'probe-key';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(
    await tab.eval(`localStorage.getItem('brosr.canvas.tenor')`),
    'probe-key',
    'the Tenor key was not stored'
  );
  await tab.eval(`document.getElementById('gif-query').focus()`);
  await tab.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  assert.equal(
    await tab.eval(`document.getElementById('gif-dialog').hidden`),
    true,
    'Escape did not close the GIF dialog from its search field'
  );
  console.log('  the GIF dialog opens, stores a key and closes on Escape');

  // 7. Undo is local. A stroke of mine and one from a peer sit on the same
  // layer, and the button takes back only mine. A peer's clear leaves mine.
  await tab.eval('probe.reset()');
  const undone = await tab.eval(`(() => {
    const mine = {
      id: 'undo-mine', layer: 1, tool: 'pencil', colour: '#18181b', size: 4, opacity: 1,
      owner: PEER, points: [{ x: 100, y: 100 }, { x: 200, y: 200 }],
    };
    const theirs = {
      id: 'undo-theirs', layer: 1, tool: 'pencil', colour: '#18181b', size: 4, opacity: 1,
      owner: 'peer-b', points: [{ x: 300, y: 300 }, { x: 400, y: 400 }],
    };
    addStroke(mine);
    addStroke(theirs);
    state.history.push({ kind: 'add', stroke: mine });
    undo();
    const count = (id) => state.layers.reduce((n, layer) => n + layer.strokes.filter((s) => s.id === id).length, 0);
    return { mine: count('undo-mine'), theirs: count('undo-theirs') };
  })()`);
  assert.equal(undone.mine, 0, 'undo left my own stroke on the sheet');
  assert.equal(undone.theirs, 1, 'undo removed a peer stroke');
  console.log('  undo removed my stroke and left the peer stroke');

  const cleared = await tab.eval(`(() => {
    addStroke({
      id: 'undo-mine-2', layer: 1, tool: 'pencil', colour: '#18181b', size: 4, opacity: 1,
      owner: PEER, points: [{ x: 100, y: 100 }, { x: 200, y: 200 }],
    });
    handle('peer-b', { op: 'layer', kind: 'clear', index: 1 });
    const count = (id) => state.layers.reduce((n, layer) => n + layer.strokes.filter((s) => s.id === id).length, 0);
    return { mine: count('undo-mine-2'), theirs: count('undo-theirs') };
  })()`);
  assert.equal(cleared.mine, 1, 'a peer clear removed my stroke');
  assert.equal(cleared.theirs, 0, 'a peer clear left that peer stroke behind');
  console.log('  a peer clear took their stroke and left mine');

  // 8. A page that joins late gets the room replayed, and a stroke and an image
  // keep the author that made them, so the new page's undo leaves both alone.
  await tab.eval(`handle('peer-b', {
    op: 'stroke', id: 'late-peer', layer: 1, tool: 'pencil', colour: '#18181b',
    size: 4, opacity: 1, owner: 'peer-b', part: 0, parts: 1,
    points: [{ x: 100, y: 100 }, { x: 200, y: 200 }],
  })`);
  assert.equal(
    await tab.eval(`state.layers.reduce((n, l) => n + l.strokes.filter((s) => s.id === 'late-peer').length, 0)`),
    1,
    'the peer stroke did not land on the first page'
  );
  await tab.eval(`handle('peer-b', {
    op: 'image', layer: 1, id: 'late-image', src: ${JSON.stringify(PNG)},
    x: 200, y: 200, width: 400, height: 400, opacity: 1, owner: 'peer-b', animated: false,
  })`);
  assert.equal(
    await tab.eval(`state.layers.reduce((n, l) => n + l.images.filter((i) => i.id === 'late-image').length, 0)`),
    1,
    'the peer image did not land on the first page'
  );
  const lateTarget = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const lateWs = new WebSocket(lateTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    lateWs.addEventListener('open', resolve, { once: true });
    lateWs.addEventListener('error', () => reject(new Error('late debug socket')), { once: true });
  });
  const late = new Tab(lateWs);
  tabs.push(late);
  await late.send('Page.enable');
  await late.send('Runtime.enable');
  await late.send('Page.navigate', { url: page });
  await waitFor(
    () => late.eval('document.readyState === "complete" && !!document.getElementById("sheet")'),
    page
  );
  await waitFor(
    () => late.eval(`state.layers.some((l) => l.strokes.some((s) => s.id === 'late-peer')) &&
      state.layers.some((l) => l.images.some((i) => i.id === 'late-image'))`),
    'late sync'
  );
  const replay = await late.eval(`(async () => {
    const arrived = state.layers.flatMap((l) => l.strokes).find((s) => s.id === 'late-peer');
    const picture = state.layers.flatMap((l) => l.images).find((i) => i.id === 'late-image');
    const count = (id) => state.layers.reduce((n, l) => n + l.strokes.filter((s) => s.id === id).length, 0);
    const pictures = (id) => state.layers.reduce((n, l) => n + l.images.filter((i) => i.id === id).length, 0);
    const mine = {
      id: 'late-mine', layer: 1, tool: 'pencil', colour: '#18181b', size: 4, opacity: 1,
      owner: PEER, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    };
    addStroke(mine);
    state.history.push({ kind: 'add', stroke: mine });
    const own = await insertImageSource(${JSON.stringify(PNG)}, 'late');
    undo();
    const first = { imageMine: pictures(own && own.id), mine: count('late-mine') };
    undo();
    return {
      strokeOwner: arrived && arrived.owner,
      imageOwner: picture && picture.owner,
      first,
      mine: count('late-mine'),
      theirs: count('late-peer'),
      imageMine: pictures(own && own.id),
      imageTheirs: pictures('late-image'),
    };
  })()`);
  assert.equal(replay.strokeOwner, 'peer-b', `the replay lost the stroke author, it reads ${replay.strokeOwner}`);
  assert.equal(replay.imageOwner, 'peer-b', `the replay lost the image author, it reads ${replay.imageOwner}`);
  assert.equal(replay.first.imageMine, 0, 'the first undo left my image');
  assert.equal(replay.first.mine, 1, 'the first undo took my stroke before its image');
  assert.equal(replay.mine, 0, 'undo left the late page its own stroke');
  assert.equal(replay.theirs, 1, 'undo removed the replayed peer stroke');
  assert.equal(replay.imageMine, 0, 'undo left the late page its own image');
  assert.equal(replay.imageTheirs, 1, 'undo removed the replayed peer image');
  console.log('  a late page kept both peer authors and undid only its own work');

  console.log('PASS: the canvas tools work on the sheet');
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
