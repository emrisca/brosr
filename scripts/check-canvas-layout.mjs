// The canvas panel is a column of controls that has to stay inside its 244 px
// rail, and the page has to stay usable when the rail goes full width. This
// check reads boxes, not pixels: a control that is clipped by the rail, a row
// that grows under the status bar, or a status line that mixes in a character
// the rest of the app never uses is a layout fault the drawing tests cannot
// see.
//
//   node scripts/check-canvas-layout.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-canvas-layout.mjs
//   BROSR_RELAY=http://127.0.0.1:8787 BROSR_ROOM=room-1 node scripts/check-canvas-layout.mjs
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
const ROOM = process.env.BROSR_ROOM || `layout-${Date.now().toString(36)}`;
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
const round = (value) => Math.round(value * 10) / 10;

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

// Every lane reads the same snapshot, so a failure names the box that moved
// instead of only the control it belongs to.
const SNAPSHOT = `(async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const panel = document.querySelector('.panel');
  const style = getComputedStyle(panel);
  const padRight = parseFloat(style.paddingRight);
  const panelRect = panel.getBoundingClientRect();
  const swatches = [...document.querySelectorAll('.swatch')].map(box);
  const layers = [...document.querySelectorAll('.layer')].map(box);
  const actions = document.querySelector('.layer-actions');
  const opacityHeading = document.querySelector('label[for="layer-opacity"]');
  const groups = [...document.querySelectorAll('.panel > .group')];
  const status = document.querySelector('.status');
  const statusSpans = [...status.children].filter((node) => node.textContent.trim());
  return {
    inner: { width: innerWidth, height: innerHeight },
    scroll: {
      width: document.scrollingElement.scrollWidth,
      height: document.scrollingElement.scrollHeight,
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
    },
    panel: {
      ...box(panel),
      contentRight: panelRect.right - padRight,
      scrollWidth: panel.scrollWidth,
      clientWidth: panel.clientWidth,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
    },
    colourRow: box(document.querySelector('.colour-row')),
    colourRowParts: [...document.querySelectorAll('.colour-row > *')].map((node) => ({
      name: node.id || node.className || node.tagName,
      ...box(node),
    })),
    hex: box(document.querySelector('.hex-input')),
    pick: box(document.getElementById('pick')),
    swatches,
    recents: box(document.querySelector('.recents')),
    layers,
    actions: box(actions),
    opacityHeading: box(opacityHeading),
    lastGroup: box(groups[groups.length - 1]),
    stage: box(document.querySelector('.stage')),
    status: { ...box(status), scrollWidth: status.scrollWidth, clientWidth: status.clientWidth },
    statusSpans: statusSpans.map((node) => ({ text: node.textContent, ...box(node) })),
    statusText: status.textContent,
    zoom: box(document.querySelector('.zoom')),
    dialog: (() => {
      const node = document.getElementById('gif-dialog');
      const card = node.querySelector('.dialog-card');
      return { hidden: node.hidden, card: box(card) };
    })(),
  };
})()`;

const browser = BROWSERS.find((file) => fs.existsSync(file));
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}

let relay = null;
let base = LIVE.replace(/\/$/, '');
const profile = await mkdtemp(path.join(tmpdir(), 'brosr-canvas-layout-'));
let chrome = null;
let tab = null;
const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`  FAIL ${message}`);
};
const pass = (message) => console.log(`  ok ${message}`);

const same = (values) => Math.max(...values) - Math.min(...values) <= 0.5;

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
      '--window-size=1440,900',
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
  tab = new Tab(ws);
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');

  async function shot(name) {
    if (!process.env.BROSR_SHOTS) return;
    const out = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.BROSR_SHOTS, `canvas-${name}.png`), Buffer.from(out.data, 'base64'));
  }
  await tab.send('Page.navigate', { url: `${base}/canvas/?room=${encodeURIComponent(ROOM)}` });
  await waitFor(
    () => tab.eval('document.readyState === "complete" && !!document.getElementById("sheet")'),
    'the canvas page'
  );
  await sleep(700);

  // 1. The rail keeps its controls inside itself. A row that asks for more
  // width than the rail gives is clipped, and the last control is the one that
  // pays for it.
  let wide = await tab.eval(SNAPSHOT);
  assert.ok(wide.panel.width >= 240, `the rail is ${round(wide.panel.width)} px wide`);
  if (wide.panel.scrollWidth > wide.panel.clientWidth + 1) {
    fail(`the rail overflows by ${wide.panel.scrollWidth - wide.panel.clientWidth} px`);
  } else {
    pass(`the rail holds its controls at ${round(wide.panel.width)} px`);
  }
  for (const part of wide.colourRowParts) {
    if (part.right > wide.panel.contentRight + 0.5) {
      fail(`the colour row puts ${part.name} at ${round(part.right)}, past the content edge ${round(wide.panel.contentRight)}`);
    }
  }
  if (wide.pick && wide.pick.right > wide.panel.contentRight + 0.5) {
    fail(`the pick button ends at ${round(wide.pick.right)}, past ${round(wide.panel.contentRight)}`);
  }

  // 2. A swatch is a button, so it is one size. A selected swatch may paint a
  // ring, but the ring cannot make the button itself wider than its neighbours.
  const widths = wide.swatches.map((item) => item.width);
  if (!same(widths)) {
    fail(`swatches differ in width: ${[...new Set(widths.map(round))].join(', ')}`);
  } else {
    pass(`all ${widths.length} swatches are ${round(widths[0])} px wide`);
  }
  if (Math.max(...widths) > 34) {
    fail(`a swatch is ${round(Math.max(...widths))} px wide, which is a panel tile and not a swatch`);
  }

  // 3. Layer rows are the same kind of row, so they share one height, and the
  // opacity control keeps a group gap above it instead of touching the buttons.
  const heights = wide.layers.map((item) => item.height);
  if (!same(heights)) {
    fail(`layer rows differ in height: ${heights.map(round).join(', ')}`);
  } else {
    pass(`layer rows are ${round(heights[0])} px tall`);
  }
  const headingGap = wide.opacityHeading.top - wide.actions.bottom;
  if (headingGap < 8) {
    fail(`the layer opacity heading sits ${round(headingGap)} px under the layer buttons`);
  } else {
    pass(`the layer opacity heading keeps ${round(headingGap)} px above it`);
  }

  // 4. The status line is ASCII and its parts are separated by space, so no two
  // labels read as one word.
  // The markup indents the spans, so the check reads the line a person sees
  // and not the whitespace between the elements.
  const statusLine = wide.statusText.replace(/\s+/g, ' ').trim();
  if (/[^\x20-\x7e]/.test(statusLine)) {
    fail(`the status line holds a character outside ASCII: ${JSON.stringify(statusLine)}`);
  } else {
    pass(`the status line is ASCII: "${statusLine}"`);
  }
  const overlaps = [];
  for (let i = 1; i < wide.statusSpans.length; i += 1) {
    const gap = wide.statusSpans[i].left - wide.statusSpans[i - 1].right;
    if (gap < 6) overlaps.push(`${wide.statusSpans[i - 1].text} / ${wide.statusSpans[i].text} at ${round(gap)} px`);
  }
  if (overlaps.length) {
    fail(`status labels run together: ${overlaps.join('; ')}`);
  } else {
    pass(`the ${wide.statusSpans.length} status labels keep their own space`);
  }
  if (wide.status.scrollWidth > wide.status.clientWidth + 1) {
    fail(`the status line is ${wide.status.scrollWidth - wide.status.clientWidth} px too wide`);
  }

  // 5. The zoom control stays over the stage and inside the window.
  if (wide.stage && wide.zoom) {
    if (wide.zoom.bottom > wide.stage.bottom + 0.5 || wide.zoom.right > wide.stage.right + 0.5) {
      fail('the zoom control hangs outside the stage');
    } else if (wide.zoom.left < wide.stage.left || wide.zoom.top < wide.stage.top) {
      fail('the zoom control starts before the stage');
    } else {
      pass(`the zoom control sits ${round(wide.stage.right - wide.zoom.right)} px in from the stage edge`);
    }
  }

  // 6. A narrow window drops the rail to one column. The page has to grow with
  // it: the last section has to be reachable, and the status line has to land
  // after that section instead of covering it.
  await tab.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
  const narrow = await tab.eval(SNAPSHOT);
  if (narrow.scroll.width > narrow.inner.width + 1) {
    fail(`the narrow page scrolls sideways by ${narrow.scroll.width - narrow.inner.width} px`);
  } else {
    pass('the narrow page does not scroll sideways');
  }
  const narrowWidths = narrow.swatches.map((item) => item.width);
  if (Math.max(...narrowWidths) > 40) {
    fail(`a swatch grows to ${round(Math.max(...narrowWidths))} px in a narrow window`);
  } else {
    pass(`swatches stay ${round(Math.max(...narrowWidths))} px in a narrow window`);
  }

  const reach = await tab.eval(`(async () => {
    window.scrollTo(0, document.scrollingElement.scrollHeight);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const last = [...document.querySelectorAll('.panel > .group')].pop();
    const target = document.getElementById('image-import');
    target.scrollIntoView({ block: 'center' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    const status = document.querySelector('.status').getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      scrollHeight: document.scrollingElement.scrollHeight,
      innerHeight,
      target: { top: rect.top, bottom: rect.bottom },
      status: { top: status.top, bottom: status.bottom },
      lastGroupBottom: last.getBoundingClientRect().bottom,
      statusAfterLast: status.top >= last.getBoundingClientRect().bottom - 1,
    };
  })()`);
  if (reach.target.bottom > reach.status.top + 0.5) {
    fail(`the import button lands at ${round(reach.target.bottom)}, under the status line at ${round(reach.status.top)}`);
  } else if (!reach.statusAfterLast) {
    fail('the status line sits inside the control column instead of after it');
  } else {
    pass('a narrow page scrolls to its last control with the status line after it');
  }

  // 7. The GIF dialog is one card, so it takes one inset on every side and
  // never reaches past the window.
  await tab.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);
  await tab.eval(`document.getElementById('gif-open').click()`);
  await sleep(250);
  const open = await tab.eval(SNAPSHOT);
  if (open.dialog.hidden) {
    fail('the find GIF button did not open the dialog');
  } else {
    const card = open.dialog.card;
    if (!card || card.left < 0 || card.top < 0 || card.right > open.inner.width + 0.5 || card.bottom > open.inner.height + 0.5) {
      fail(`the dialog card at ${round(card?.left)},${round(card?.top)} to ${round(card?.right)},${round(card?.bottom)} leaves the ${open.inner.width}x${open.inner.height} window`);
    } else {
      const inset = Math.min(card.left, open.inner.width - card.right);
      pass(`the dialog card keeps ${round(inset)} px at the sides`);
    }
  }
  await tab.eval(`document.getElementById('gif-close').click()`);

  // 8. The theme button turns the same roles to daylight, and the choice is
  // still there after a reload. A muted label has to stay readable on the
  // panel in both sets, so the lane paints the two colours and reads the
  // pixels instead of trusting the token.
  const THEME = `(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgb = (css) => {
      ctx.fillStyle = '#ff00ff';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const px = ctx.getImageData(0, 0, 1, 1).data;
      return [px[0], px[1], px[2], px[3]];
    };
    const lum = (rgb) => {
      const f = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const ratio = (a, b) => {
      const x = lum(a);
      const y = lum(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const status = document.querySelector('.status');
    const panel = document.querySelector('.panel');
    const button = document.getElementById('theme');
    const ink = rgb(getComputedStyle(status).color);
    const ground = rgb(getComputedStyle(panel).backgroundColor);
    return {
      theme: document.documentElement.dataset.theme || '',
      label: button.textContent.trim(),
      stored: (() => { try { return localStorage.getItem('brosr.canvas.theme'); } catch (e) { return null; } })(),
      alpha: [ink[3], ground[3]],
      ratio: ratio(ink, ground),
    };
  })()`;
  const themeFault = (report, name) => {
    if (report.alpha[0] !== 255 || report.alpha[1] !== 255) {
      fail(`${name} text and panel are not opaque: ${report.alpha.join(', ')}`);
    } else if (report.ratio < 4.5) {
      fail(`${name} muted text is ${report.ratio.toFixed(2)}:1 on the panel`);
    } else {
      pass(`${name} muted text is ${report.ratio.toFixed(2)}:1 on the panel`);
    }
  };

  let theme = await tab.eval(THEME);
  if (theme.theme !== 'dark' || theme.label !== 'Light') {
    fail(`the page opens on ${JSON.stringify(theme.theme)} with a ${JSON.stringify(theme.label)} button`);
  } else {
    pass('the page opens dark with a Light button');
  }
  themeFault(theme, 'dark');

  await tab.eval(`document.getElementById('theme').click()`);
  theme = await tab.eval(THEME);
  if (theme.theme !== 'light') fail(`the theme button set ${JSON.stringify(theme.theme)}`);
  else pass(`the theme button switches to light (${theme.label} button)`);
  if (theme.stored !== 'light') fail(`the choice was stored as ${JSON.stringify(theme.stored)}`);
  themeFault(theme, 'light');
  await shot('light');

  await tab.send('Page.navigate', { url: `${base}/canvas/?room=${encodeURIComponent(ROOM)}` });
  await waitFor(
    () => tab.eval('document.readyState === "complete" && !!document.getElementById("sheet")'),
    'the canvas page after a reload'
  );
  await sleep(500);
  const reloaded = await tab.eval(THEME);
  if (reloaded.theme !== 'light') {
    fail(`a reload came back ${JSON.stringify(reloaded.theme)} instead of light`);
  } else {
    pass('a reload keeps the light theme');
  }
  await tab.eval(`document.getElementById('theme').click()`);
  theme = await tab.eval(THEME);
  if (theme.theme !== 'dark' || theme.stored !== 'dark') {
    fail(`the theme button did not return to dark (${JSON.stringify(theme.theme)})`);
  }

  // 9. A search is twelve tiles that have not arrived yet. The lane holds the
  // network open and reads the grid mid-search, so a line of text where the
  // pictures will be is a fault.
  await tab.eval(`(() => {
    window.fetch = () => new Promise(() => {});
    document.getElementById('gif-open').click();
    const query = document.getElementById('gif-query');
    query.value = 'cat';
    document.getElementById('gif-go').click();
  })()`);
  await sleep(250);
  await shot('gif-busy');
  const searching = await tab.eval(`(() => {
    const results = document.getElementById('gif-results');
    const status = document.getElementById('gif-status');
    const box = status.getBoundingClientRect();
    const tiles = [...results.children].map((node) => {
      const rect = node.getBoundingClientRect();
      return { cls: node.className, width: rect.width, height: rect.height };
    });
    return {
      count: tiles.length,
      skeletons: tiles.filter((tile) => tile.cls === 'gif-skeleton').length,
      square: tiles.every((tile) => Math.abs(tile.width - tile.height) <= 0.5),
      width: tiles.length ? tiles[0].width : 0,
      busy: results.getAttribute('aria-busy'),
      statusBusy: status.dataset.busy || '',
      statusText: status.textContent,
      statusWidth: box.width,
      statusHeight: box.height,
    };
  })()`);
  if (searching.count !== 12 || searching.skeletons !== 12) {
    fail(`a search shows ${searching.count} tiles with ${searching.skeletons} placeholders`);
  } else {
    pass(`a search shows ${searching.count} placeholders in the grid`);
  }
  if (!searching.square || searching.width < 40) {
    fail(`a placeholder is ${round(searching.width)} px wide and not square`);
  } else {
    pass(`a placeholder is a ${round(searching.width)} px square`);
  }
  if (searching.busy !== 'true' || searching.statusBusy !== 'true') {
    fail(`the grid marks busy as ${JSON.stringify(searching.busy)} and the words as ${JSON.stringify(searching.statusBusy)}`);
  }
  if (searching.statusWidth > 2 || searching.statusHeight > 2) {
    fail(`the busy words still take ${round(searching.statusWidth)}x${round(searching.statusHeight)} px`);
  } else if (!searching.statusText.trim()) {
    fail('the busy search has no words for a screen reader');
  } else {
    pass('the busy words are for a screen reader and take no room');
  }
  await tab.send('Page.navigate', { url: `${base}/canvas/?room=${encodeURIComponent(ROOM)}` });
  await waitFor(
    () => tab.eval('document.readyState === "complete" && !!document.getElementById("sheet")'),
    'the canvas page after the search lane'
  );

  if (failures.length) {
    throw new Error(`${failures.length} layout fault${failures.length === 1 ? '' : 's'}`);
  }
  console.log('PASS: the panel, the narrow page and the dialog keep their boxes');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (tab) tab.ws.close();
  if (chrome) {
    chrome.kill('SIGTERM');
    await sleep(600);
    chrome.kill('SIGKILL');
  }
  if (relay) relay.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true });
}
