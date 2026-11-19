// The landing page is a bento of tiles that share one grid, so the same
// control has to sit the same distance from the edge of every card it appears
// in. This check reads boxes at four widths: a tile that keeps dead space
// under its heading, a row that scrolls sideways, or a label too small to
// read is a fault the link check cannot see.
//
//   node scripts/check-landing-layout.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-landing-layout.mjs
//   BROSR_SHOTS=/tmp/shots node scripts/check-landing-layout.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.BROSR_RELAY || '';
const SHOTS = process.env.BROSR_SHOTS || '';
const WIDTHS = [1440, 1024, 900, 760, 640, 360];
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
    const call = () => this.sendOnce(method, params, timeoutMs);
    if (method !== 'Page.navigate') return call();
    // A busy renderer can drop the navigate reply. One retry covers that, and
    // a second miss stays a failure.
    return call().catch((error) => {
      if (!String(error.message).startsWith('cdp timeout')) throw error;
      return call();
    });
  }

  sendOnce(method, params = {}, timeoutMs = 15000) {
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

// One snapshot answers every lane, so a failure names the box that moved.
const SNAPSHOT = `(() => {
  const round = (value) => Math.round(value * 100) / 100;
  const box = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: round(rect.left),
      top: round(rect.top),
      right: round(rect.right),
      bottom: round(rect.bottom),
      width: round(rect.width),
      height: round(rect.height),
    };
  };
  const tiles = [...document.querySelectorAll('.tile')].map((tile) => {
    const style = getComputedStyle(tile);
    const rect = tile.getBoundingClientRect();
    const pad = parseFloat(style.paddingRight);
    const contentRight = rect.right - pad;
    const contentBottom = rect.bottom - parseFloat(style.paddingBottom);
    const head = tile.querySelector('.tile-head');
    const open = tile.querySelector('.tile-open');
    const parts = [...tile.querySelectorAll('*')].map((node) => node.getBoundingClientRect());
    return {
      cls: tile.className,
      ...box(tile),
      contentRight: round(contentRight),
      overflowRight: round(Math.max(...parts.map((part) => part.right)) - contentRight),
      overflowBottom: round(Math.max(...parts.map((part) => part.bottom)) - contentBottom),
      gapBelowOpen: open ? round(contentBottom - open.getBoundingClientRect().bottom) : null,
      gapAboveOpen: open && head ? round(open.getBoundingClientRect().top - head.getBoundingClientRect().bottom) : null,
    };
  });
  const labels = [...document.querySelectorAll('.tile-name, .tile-note, .site-name, .site-host, .site-group-title, .site-filter-label, .site-filter-count, .site-empty, .live-title, .live-note, .live-count, .live-owner-name, .live-role, .live-tab-title, .live-tab-host, .live-empty, .live-action, .live-state, .live-stop, .live-play')].map((node) => ({
    cls: node.className,
    text: node.textContent.trim().slice(0, 40),
    size: round(parseFloat(getComputedStyle(node).fontSize)),
    clipped: node.scrollWidth - node.clientWidth,
  }));
  const sites = [...document.querySelectorAll('.site')].map(box);
  const brand = document.querySelector('.brand');
  const page = document.querySelector('.page');
  return {
    inner: { width: innerWidth, height: innerHeight },
    scroll: {
      width: document.scrollingElement.scrollWidth,
      height: document.scrollingElement.scrollHeight,
    },
    tiles,
    labels,
    sites,
    brand: box(brand),
    page: box(page),
    text: document.body.innerText,
    muted: {
      ink: getComputedStyle(document.querySelector('.tile-note')).color,
      ground: getComputedStyle(document.querySelector('.tile-youtube')).backgroundColor,
    },
  };
})()`;

const browser = BROWSERS.find((file) => fs.existsSync(file));
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}

let relay = null;
let base = LIVE.replace(/\/$/, '');
const profile = await mkdtemp(path.join(tmpdir(), 'brosr-landing-layout-'));
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
    const port = await freePort(9620);
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RELAY_QUIET: '1' },
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`${base}/health`)).ok, 'relay');
  }
  console.log(`relay ${base}, browser ${path.basename(browser)}`);

  const devPort = await freePort(9745);
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
      '--window-size=1440,1000',
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

  async function visit(width, height) {
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await tab.send('Page.navigate', { url: `${base}/` });
    await waitFor(
      () => tab.eval('document.readyState === "complete" && document.querySelectorAll(".tile").length >= 5'),
      'the landing page'
    );
    await tab.eval('document.fonts.ready');
    await sleep(250);
    return tab.eval(SNAPSHOT);
  }

  async function shot(name, width, height) {
    if (!SHOTS) return;
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(250);
    const out = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `landing-${name}.png`), Buffer.from(out.data, 'base64'));
  }

  // 1. Every width keeps the page inside the window, and every tile keeps its
  // content inside the tile.
  for (const width of WIDTHS) {
    const page = await visit(width, width < 700 ? 2000 : 1200);
    if (page.scroll.width > page.inner.width + 1) {
      fail(`${width} px scrolls sideways by ${page.scroll.width - page.inner.width} px`);
    } else {
      pass(`${width} px does not scroll sideways`);
    }
    const spills = page.tiles.filter((tile) => tile.overflowRight > 0.5);
    if (spills.length) {
      fail(`${width} px puts content past the tile edge: ${spills.map((tile) => `${tile.cls} by ${tile.overflowRight}`).join('; ')}`);
    }
    const dropped = page.tiles.filter((tile) => tile.overflowBottom > 0.5);
    if (dropped.length) {
      fail(`${width} px drops content below the tile edge: ${dropped.map((tile) => `${tile.cls} by ${tile.overflowBottom}`).join('; ')}`);
    }
  }

  // 2. The same control sits in the same place in every card. The open link is
  // the one control every tile carries, so its distance from the tile edge is
  // the page's promise that the cards belong to one set.
  const wide = await visit(1440, 1200);
  const gaps = wide.tiles.map((tile) => tile.gapBelowOpen).filter((gap) => gap !== null);
  if (!same(gaps)) {
    const detail = wide.tiles
      .filter((tile) => tile.gapBelowOpen !== null)
      .map((tile) => `${tile.cls.split(' ').pop()}: ${tile.gapBelowOpen}`)
      .join(', ');
    fail(`the open link sits at a different height in each card (${detail})`);
  } else {
    pass(`the open link keeps ${round(gaps[0])} px under it in all ${gaps.length} cards`);
  }

  // 3. A card that is mostly empty is a card that lost its layout. The gap
  // between the heading row and the open link is the measure.
  const airy = wide.tiles.filter((tile) => tile.gapAboveOpen !== null && tile.gapAboveOpen > 32);
  if (airy.length) {
    fail(
      `a card holds ${airy.map((tile) => `${tile.cls.split(' ').pop()} ${tile.gapAboveOpen} px`).join(', ')} of empty space under its heading`
    );
  } else {
    pass('every card keeps its heading and its open link together');
  }

  // 4. Labels are readable. A host name under a site is a label, not fine
  // print, and a group heading has to be legible at arm's length.
  const small = wide.labels.filter((label) => label.size < 11.5);
  if (small.length) {
    const detail = [...new Set(small.map((label) => `${label.cls} at ${label.size} px`))].join(', ');
    fail(`a label is smaller than 11.5 px: ${detail}`);
  } else {
    pass('every label is at least 11.5 px');
  }

  // 5. A row is a pointer target, so it is tall enough to hit.
  const rows = wide.sites.map((site) => site.height);
  if (Math.min(...rows) < 32) {
    fail(`a site row is ${round(Math.min(...rows))} px tall`);
  } else {
    pass(`site rows are ${round(Math.min(...rows))} to ${round(Math.max(...rows))} px tall`);
  }

  // 6. The brand and the tiles share one left edge, so the page reads as one
  // column instead of one column and a tab.
  if (Math.abs(wide.brand.left - wide.tiles[0].left) > 0.5) {
    fail(`the brand starts at ${wide.brand.left} and the first tile at ${wide.tiles[0].left}`);
  } else {
    pass(`the brand and the tiles start at ${round(wide.tiles[0].left)} px`);
  }

  // 7. The page is ASCII. A middle dot or a curly quote shows up in an
  // accessibility tree as a character screen readers announce.
  if (/[^\x20-\x7e\n\t]/.test(wide.text)) {
    const bad = [...new Set(wide.text.split('').filter((char) => !/[\x20-\x7e\n\t]/.test(char)))].join(' ');
    fail(`the page holds characters outside ASCII: ${JSON.stringify(bad)}`);
  } else {
    pass('the visible page is ASCII');
  }

  // 8. A muted label stays readable on its card in both colour schemes. The
  // lane paints the two colours and reads the pixels, so a token that only
  // looks right in one scheme fails here.
  const CONTRAST = `(() => {
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
    const note = document.querySelector('.tile-note');
    const card = document.querySelector('.tile-youtube');
    const ink = rgb(getComputedStyle(note).color);
    const ground = rgb(getComputedStyle(card).backgroundColor);
    const a = lum(ink);
    const b = lum(ground);
    return {
      alpha: [ink[3], ground[3]],
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      ink: getComputedStyle(note).color,
      ground: getComputedStyle(card).backgroundColor,
    };
  })()`;
  for (const scheme of ['light', 'dark']) {
    await tab.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
    // The card fades its background over 240 ms, so the lane waits for the
    // colour it lands on and not the one it passes through.
    await sleep(600);
    const contrast = await tab.eval(CONTRAST);
    if (contrast.alpha[0] !== 255 || contrast.alpha[1] !== 255) {
      fail(`the ${scheme} note or card is not opaque: ${contrast.alpha.join(', ')}`);
    } else if (contrast.ratio < 4.5) {
      fail(`the ${scheme} note is ${contrast.ratio.toFixed(2)}:1 on its card (${contrast.ink} on ${contrast.ground})`);
    } else {
      pass(`the ${scheme} note is ${contrast.ratio.toFixed(2)}:1 on its card`);
    }
  }

  // 9. The Watch directory answers a name. A filter that leaves rows it
  // should hide, a count that disagrees with the rows, or an empty list with
  // no words is a fault, not a feature.
  const FILTER = `(async () => {
    const input = document.querySelector('.site-filter-input');
    const count = document.querySelector('.site-filter-count');
    const empty = document.querySelector('.site-empty');
    if (!input || !count || !empty) return { missing: true };
    const rows = [...document.querySelectorAll('.site')];
    const shown = () => rows.filter((row) => row.getClientRects().length > 0);
    const titles = [...document.querySelectorAll('.site-group-title')];
    const set = async (value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        names: shown().map((row) => row.querySelector('.site-name').textContent.trim()),
        hosts: shown().map((row) => row.querySelector('.site-host').textContent.trim()),
        count: count.textContent.trim(),
        groups: titles.filter((title) => title.getClientRects().length > 0).map((title) => title.textContent.trim()),
        empty: empty.getClientRects().length > 0,
        emptyText: empty.textContent.trim(),
      };
    };
    const total = shown().length;
    const all = await set('');
    const some = await set('cine');
    const none = await set('zzzz');
    const back = await set('');
    return { missing: false, total, all, some, none, back };
  })()`;
  const filter = await tab.eval(FILTER);
  if (filter.missing) {
    fail('the Watch directory has no filter input, count or empty state');
  } else {
    if (!filter.some.names.length || filter.some.names.length >= filter.total) {
      fail(`the filter for "cine" shows ${filter.some.names.length} of ${filter.total} rows`);
    } else if (!filter.some.names.every((name) => name.toLowerCase().includes('cine')) || !filter.some.hosts.every((host) => host.toLowerCase().includes('cine'))) {
      fail(`the filter for "cine" keeps a row that does not match: ${filter.some.names.join(', ')}`);
    } else {
      pass(`the filter for "cine" keeps ${filter.some.names.length} of ${filter.total} rows and drops the rest`);
    }
    if (!filter.some.count.includes(String(filter.some.names.length))) {
      fail(`the count reads "${filter.some.count}" beside ${filter.some.names.length} rows`);
    } else {
      pass(`the count reads "${filter.some.count}" beside ${filter.some.names.length} rows`);
    }
    if (filter.none.names.length || !filter.none.empty || filter.none.groups.length) {
      fail(`a name with no match leaves ${filter.none.names.length} rows, ${filter.none.groups.length} headings and an empty state ${filter.none.empty ? 'on' : 'off'}`);
    } else {
      pass(`a name with no match hides every row and heading and shows "${filter.none.emptyText}"`);
    }
    if (filter.back.names.length !== filter.total || filter.back.empty) {
      fail(`clearing the filter restores ${filter.back.names.length} of ${filter.total} rows and leaves the empty state ${filter.back.empty ? 'on' : 'off'}`);
    } else {
      pass(`clearing the filter restores all ${filter.total} rows`);
    }
  }

  // 10. The filter is a control, so it answers the keyboard. The field takes
  // focus in the tab order, the label names it, and Escape puts the whole list
  // back without a pointer.
  const keyboard = await tab.eval(`(() => {
    const input = document.querySelector('.site-filter-input');
    if (!input) return { missing: true };
    input.focus();
    input.value = 'cine';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      missing: false,
      focused: document.activeElement === input,
      tabbable: input.tabIndex >= 0 && !input.disabled && !input.readOnly,
      label: input.labels && input.labels.length ? input.labels[0].textContent.trim() : '',
      narrowed: [...document.querySelectorAll('.site')].filter((row) => row.getClientRects().length > 0).length,
    };
  })()`);
  if (keyboard.missing) {
    fail('the Watch filter cannot take focus');
  } else {
    await sleep(120);
    for (const type of ['keyDown', 'keyUp']) {
      await tab.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
    await sleep(120);
    const cleared = await tab.eval(`(() => {
      const input = document.querySelector('.site-filter-input');
      const count = document.querySelector('.site-filter-count');
      return {
        value: input.value,
        shown: [...document.querySelectorAll('.site')].filter((row) => row.getClientRects().length > 0).length,
        count: count.textContent.trim(),
      };
    })()`);
    if (!keyboard.focused || !keyboard.tabbable) {
      fail('the Watch filter is not in the tab order');
    } else if (keyboard.label !== 'Filter') {
      fail(`the Watch filter is named "${keyboard.label}" and not "Filter"`);
    } else {
      pass('the Watch filter is a labelled field in the tab order');
    }
    if (cleared.value !== '' || cleared.shown !== filter.total || cleared.count !== filter.all.count) {
      fail(
        `Escape leaves "${cleared.value}", ${cleared.shown} of ${filter.total} rows and the count "${cleared.count}"`
      );
    } else {
      pass(`Escape clears the field and restores all ${filter.total} rows`);
    }
  }

  // 11. Live tabs are offers, not instructions. The core sends one group per
  // person with the host first, and the page must keep that order. Every row
  // starts at Open until someone joins it, a click joins one row, and Stop
  // puts that row back without closing anything. A hidden section with two
  // offers is a page a peer cannot use.
  const LIVE = `(async () => {
    const fixture = {
      role: 'peer',
      peerId: 'peer-2',
      hostId: 'host-1',
      joined: [],
      groups: [
        {
          ownerId: 'host-1',
          owner: 'Ana',
          role: 'host',
          tabs: [{ key: '1', url: 'https://www.youtube.com/watch?v=1', title: 'A long film', playing: true }],
        },
        {
          ownerId: 'peer-3',
          owner: 'Bo',
          role: 'control',
          tabs: [{ key: '2', url: 'https://example.com/notes', title: 'Notes for the room', playing: false }],
        },
      ],
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // The lane stands in for the core. It records what the page asked for and
    // answers with the state that request would produce.
    const sent = [];
    const push = (state) => {
      document.documentElement.dataset.brosrTabs = JSON.stringify(state);
      window.postMessage({ source: 'brosr-tabs', type: 'state', state: state }, location.origin);
    };
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const message = event.data;
      if (!message || message.source !== 'brosr-app') return;
      if (message.type === 'join-tab') {
        sent.push({ type: 'join-tab', key: message.key });
        push(Object.assign({}, fixture, { joined: [message.key] }));
      }
      if (message.type === 'leave-tab') {
        sent.push({ type: 'leave-tab', key: message.key });
        push(Object.assign({}, fixture, { joined: [] }));
      }
    });
    document.documentElement.dataset.brosrTabs = JSON.stringify(fixture);
    for (let i = 0; i < 30; i += 1) {
      if (document.querySelectorAll('.live-row').length === 2) break;
      await wait(100);
    }
    const section = document.querySelector('.live');
    const groups = [...document.querySelectorAll('.live-group')];
    const rows = () => [...document.querySelectorAll('.live-row')];
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    const sectionBox = section ? box(section) : null;
    const pageBox = box(document.querySelector('.page'));
    // A joined row reports through a state pill and a Stop button, so the lane
    // reads both shapes instead of assuming one button per row.
    const actionText = (row) => {
      const button = row.querySelector('.live-action');
      if (button) return button.textContent.trim();
      const state = row.querySelector('.live-state');
      return state ? state.textContent.trim() : '';
    };
    const startRows = rows();
    const buttons = startRows.map((row) => row.querySelector('.live-action'));
    const titles = startRows.map((row) => row.querySelector('.live-tab-title').textContent.trim());
    const plays = startRows.map((row) => {
      const play = row.querySelector('.live-play');
      return play ? play.textContent.trim() : '';
    });
    const labels = startRows.map(actionText);
    const pressed = buttons.map((button) => (button ? button.getAttribute('aria-pressed') : null));
    // A row is a choice. The click reaches the core, and the answer turns that
    // one row into Synced with a Stop beside it.
    const open = startRows[0] ? startRows[0].querySelector('.live-action') : null;
    if (open) open.click();
    await wait(80);
    for (let i = 0; i < 40; i += 1) {
      if (rows()[0] && actionText(rows()[0]) === 'Synced') break;
      await wait(50);
    }
    const afterJoin = rows().map(actionText);
    const stopButton = rows()[0] ? rows()[0].querySelector('.live-stop') : null;
    const stopHeight = stopButton ? stopButton.getBoundingClientRect().height : 0;
    const stopLabel = stopButton ? stopButton.textContent.trim() : '';
    if (stopButton) stopButton.click();
    // The row repaints at once, and the message the click queued arrives on a
    // later task. The lane waits for that task, not only for the paint.
    await wait(120);
    for (let i = 0; i < 40; i += 1) {
      if (rows()[0] && actionText(rows()[0]) === 'Open') break;
      await wait(50);
    }
    const afterStop = rows().map(actionText);
    return {
      hidden: !section || section.hidden,
      rows: rows().length,
      owners: groups.map((group) => group.querySelector('.live-owner-name').textContent.trim()),
      roles: groups.map((group) => group.querySelector('.live-role').textContent.trim()),
      titles: titles,
      plays: plays,
      labels: labels,
      pressed: pressed,
      afterJoin: afterJoin,
      afterStop: afterStop,
      stop: stopLabel,
      stopHeight: stopHeight,
      stopped: rows().every((row) => !row.querySelector('.live-stop')),
      sent: sent,
      empty: document.querySelector('.live-empty').getClientRects().length > 0,
      count: document.querySelector('.live-count').textContent.trim(),
      overflow:
        sectionBox === null
          ? null
          : Math.max(0, ...rows().map((row) => box(row).right - sectionBox.right)),
      insidePage:
        sectionBox === null
          ? false
          : sectionBox.left >= pageBox.left - 0.5 && sectionBox.right <= pageBox.right + 0.5,
    };
  })()`;
  const live = await tab.eval(LIVE);
  if (live.hidden) {
    fail('the Live tabs section stays hidden with two offers');
  } else {
    if (live.owners.join(',') !== 'Ana,Bo') {
      fail(`the Live tabs section groups as ${live.owners.join(', ') || 'nothing'} and not the host first`);
    } else {
      pass(`Live tabs puts ${live.owners[0]} (${live.roles[0]}) first and ${live.owners[1]} second`);
    }
    if (live.rows !== 2 || live.titles[0] !== 'A long film' || live.titles[1] !== 'Notes for the room') {
      fail(`Live tabs draws ${live.rows} rows as ${live.titles.join(', ') || 'nothing'}`);
    } else {
      pass('Live tabs draws one row per offer under its owner');
    }
    if (live.labels.join(',') !== 'Open,Open' || live.pressed.join(',') !== 'false,false') {
      fail(`Live tabs starts with ${live.labels.join(', ') || 'no rows'} and pressed ${live.pressed.join(', ')}`);
    } else {
      pass('every Live tab starts at Open and none is pressed');
    }
    if (live.empty || live.count !== '2 tabs') {
      fail(`Live tabs shows the empty state ${live.empty ? 'on' : 'off'} beside the count "${live.count}"`);
    } else {
      pass('Live tabs counts 2 tabs and hides the empty state');
    }
    if (live.plays.join(',') !== 'Playing,Paused') {
      fail(`Live tabs shows ${live.plays.join(', ') || 'no playback state'} on two offers`);
    } else {
      pass('Live tabs shows Playing and Paused on the offers that report one');
    }
    if (!live.sent.some((entry) => entry.type === 'join-tab' && entry.key === '1')) {
      fail('a click on a Live tab row sends no join');
    } else if (live.afterJoin.join(',') !== 'Synced,Open') {
      fail(`a joined row reads ${live.afterJoin.join(', ') || 'nothing'} beside ${live.afterJoin[1] || 'nothing'}`);
    } else {
      pass('a click joins one row as Synced and leaves the other at Open');
    }
    if (!live.sent.some((entry) => entry.type === 'leave-tab' && entry.key === '1')) {
      fail('Stop sends no leave to the core');
    } else if (live.stop !== 'Stop' || live.afterStop.join(',') !== 'Open,Open') {
      fail(`Stop reads ${live.stop || 'nothing'} and the rows after it read ${live.afterStop.join(', ')}`);
    } else {
      pass('Stop asks the core to leave and puts the row back to Open');
    }
    if (!live.stopped) {
      fail('a stopped row keeps its Stop control');
    } else if (live.stopHeight < 28) {
      fail(`the Stop control is ${round(live.stopHeight)} px tall`);
    } else {
      pass(`the Stop control is ${round(live.stopHeight)} px tall`);
    }
    if (live.overflow > 0.5) {
      fail(`a Live tab row runs ${live.overflow} px past its section`);
    } else {
      pass('Live tab rows stay inside the section');
    }
    if (!live.insidePage) {
      fail('the Live tabs section reaches outside the page column');
    } else {
      pass('the Live tabs section sits inside the page column');
    }
  }

  if (SHOTS) {
    await tab.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    await visit(1440, 1200);
    await shot('wide', 1440, 1200);
    await shot('narrow', 760, 2400);
    await tab.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await visit(1440, 1200);
    await shot('wide-light', 1440, 1200);
    await shot('narrow-light', 760, 2400);
  }

  if (failures.length) {
    throw new Error(`${failures.length} layout fault${failures.length === 1 ? '' : 's'}`);
  }
  console.log('PASS: the landing tiles keep one edge and one open link');
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
