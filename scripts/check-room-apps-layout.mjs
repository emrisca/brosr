// Notes and Chess are the two room apps that carry a lot of small chrome, so
// this check reads their boxes at three widths: a header control that spills
// out of the bar, a button too small to hit, a label below 11 px, a status bar
// under the fold or a page with no light theme fails without a person looking.
//
//   node scripts/check-room-apps-layout.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-room-apps-layout.mjs
//   BROSR_SHOTS=/tmp/shots node scripts/check-room-apps-layout.mjs
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
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 760, height: 900 },
  { width: 360, height: 800 },
];
const BROWSERS = [
  process.env.BROSR_CHECK_BROWSER,
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
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

// One snapshot answers every box lane for one app.
const snapshot = (app) => `(() => {
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
  const visible = (node) => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  };
  const name = (node) => (node.id ? '#' + node.id : '.' + String(node.className || node.tagName).split(' ').filter(Boolean).join('.'));
  const header = document.querySelector('.top');
  const headerBox = box(header);
  const padRight = parseFloat(getComputedStyle(header).paddingRight);
  const titleNode = header.querySelector('h1');
  const headerChildren = [...header.children]
    .filter(visible)
    .map((node) => ({ name: name(node), isTitle: node === titleNode, ...box(node) }));
  const buttons = [...document.querySelectorAll('button, select')]
    .filter(visible)
    .map((node) => ({ name: name(node), ...box(node), text: (node.textContent || '').trim().slice(0, 20) }));
  const small = [];
  for (const node of document.querySelectorAll('body *')) {
    if (!visible(node)) continue;
    if (node.closest('.coord, .piece, .player-piece, .promotion-options, .sr-only')) continue;
    const own = [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim());
    if (!own) continue;
    const size = parseFloat(getComputedStyle(node).fontSize);
    if (size < 11) small.push({ name: name(node), size: round(size), text: node.textContent.trim().slice(0, 24) });
  }
  const spill = [];
  for (const node of document.querySelectorAll('.top > *, .panel > *, .toolbar > *, .workspace > *')) {
    if (!visible(node)) continue;
    const parent = node.parentElement;
    const parentBox = parent.getBoundingClientRect();
    const parentRight = parentBox.right - parseFloat(getComputedStyle(parent).paddingRight);
    const childBox = node.getBoundingClientRect();
    if (childBox.right > parentRight + 0.5) spill.push({ name: name(node), over: round(childBox.right - parentRight) });
  }
  const title = titleNode;
  const squares = [...document.querySelectorAll('.square')].map(box);
  const glyphs = [...document.querySelectorAll('.square')]
    .map((node) => {
      const glyph = node.querySelector('.piece');
      return glyph ? { square: node.dataset.square || '', glyph: box(glyph), cell: box(node) } : null;
    })
    .filter(Boolean);
  const parts = {};
  for (const selector of ['.board', '.board-shell', '.editor', '.editor-wrap', '.toolbar', '.files', '.panel', '.workspace', '.status']) {
    const node = document.querySelector(selector);
    if (node && visible(node)) parts[selector] = box(node);
  }
  const muted = document.querySelector(${app === 'notes' ? "'.files-foot, .doc-meta, .doc-preview, .status'" : "'.hint, .status'"});
  const panel = document.querySelector(${app === 'notes' ? "'.files'" : "'.panel'"});
  return {
    inner: { width: innerWidth, height: innerHeight },
    scroll: { width: document.scrollingElement.scrollWidth, height: document.scrollingElement.scrollHeight },
    header: { ...headerBox, contentRight: round(headerBox.right - padRight) },
    headerChildren,
    title: title ? box(title) : null,
    buttons,
    small,
    spill,
    squares,
    glyphs,
    parts,
    pageBg: getComputedStyle(document.body).backgroundColor,
    muted: muted ? getComputedStyle(muted).color : getComputedStyle(document.body).color,
    panelBg: panel ? getComputedStyle(panel).backgroundColor : getComputedStyle(document.body).backgroundColor,
  };
})()`;

const browser = BROWSERS.find((file) => fs.existsSync(file));
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}

let relay = null;
let base = LIVE.replace(/\/$/, '');
const profile = await mkdtemp(path.join(tmpdir(), 'brosr-apps-layout-'));
let chrome = null;
let tab = null;
const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`  FAIL ${message}`);
};
const pass = (message) => console.log(`  ok ${message}`);

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
  console.log(`relay ${base}, browser ${path.basename(browser)}`);

  const devPort = await freePort(9750);
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

  async function visit(app, width, height) {
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await tab.send('Emulation.setEmulatedMedia', { features: [] });
    await tab.send('Page.navigate', { url: `${base}/${app}/` });
    const ready =
      app === 'notes'
        ? 'document.readyState === "complete" && !!document.getElementById("editor")'
        : 'document.readyState === "complete" && document.querySelectorAll(".square").length === 64';
    await waitFor(() => tab.eval(ready), `the ${app} page`);
    await tab.eval('document.fonts.ready');
    await sleep(300);
    return tab.eval(snapshot(app));
  }

  async function shot(app, name, width, height) {
    if (!SHOTS) return;
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(250);
    const out = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${app}-${name}.png`), Buffer.from(out.data, 'base64'));
  }

  const APPS = ['notes', 'chess'];
  for (const app of APPS) {
    console.log(`- ${app}`);
    for (const { width, height } of WIDTHS) {
      const page = await visit(app, width, height);

      // 1. The page keeps its width, and no child spills out of its row.
      if (page.scroll.width > page.inner.width + 1) {
        fail(`${app} at ${width} px scrolls sideways by ${page.scroll.width - page.inner.width} px`);
      }
      const spilled = page.headerChildren.filter((child) => child.right > page.header.contentRight + 0.5);
      if (spilled.length) {
        fail(
          `${app} at ${width} px puts ${spilled.map((child) => `${child.name} ${round(child.right - page.header.contentRight)} px`).join(', ')} past the header edge`
        );
      }
      if (page.spill.length) {
        fail(`${app} at ${width} px spills a child: ${page.spill.map((child) => `${child.name} by ${child.over}`).join('; ')}`);
      }
      pass(`${app} at ${width} px keeps its rows inside their boxes`);

      // 2. The title is never covered by a control beside it.
      if (page.title) {
        const over = page.headerChildren.filter(
          (child) =>
            !child.isTitle &&
            child.left < page.title.right - 0.5 &&
            child.right > page.title.left + 0.5 &&
            Math.abs(child.top - page.title.top) < 4
        );
        if (over.length) {
          fail(`${app} at ${width} px covers the title with ${over.map((child) => child.name).join(', ')}`);
        }
      }

      // 3. A button is a pointer target, so it is at least 24 px each way.
      const tiny = page.buttons.filter((button) => button.height < 24 || button.width < 24);
      if (tiny.length) {
        fail(
          `${app} at ${width} px has a small target: ${tiny
            .map((button) => `${button.name} ${round(button.width)}x${round(button.height)}`)
            .join(', ')}`
        );
      } else {
        pass(`${app} at ${width} px keeps every button at least 24 px`);
      }

      // 4. A word a person reads is at least 11 px. Board coordinates and
      // pieces are symbols and stay out of this.
      if (page.small.length) {
        fail(
          `${app} at ${width} px sets text under 11 px: ${page.small
            .map((item) => `${item.name} at ${item.size} px`)
            .join(', ')}`
        );
      } else {
        pass(`${app} at ${width} px keeps every word at least 11 px`);
      }

      // 5. The status line ends inside the window, and a square board stays
      // square.
      if (page.parts['.status'] && page.parts['.status'].bottom > page.inner.height + 1) {
        fail(`${app} at ${width} px puts the status line at ${page.parts['.status'].bottom}, under the window`);
      }
      if (page.parts['.board'] && Math.abs(page.parts['.board'].width - page.parts['.board'].height) > 1) {
        fail(
          `${app} at ${width} px draws a ${round(page.parts['.board'].width)}x${round(page.parts['.board'].height)} board`
        );
      }

      // 6. Every square on the board is the same size. Rows that grow with
      // their contents make the ranks with pieces taller than the empty ones.
      if (page.squares.length === 64) {
        const spread = (values) => round(Math.max(...values) - Math.min(...values));
        const widths = page.squares.map((square) => square.width);
        const heights = page.squares.map((square) => square.height);
        if (spread(widths) > 0.5 || spread(heights) > 0.5) {
          fail(
            `${app} at ${width} px draws squares ${round(Math.min(...widths))} to ${round(Math.max(...widths))} px wide and ${round(Math.min(...heights))} to ${round(Math.max(...heights))} px tall`
          );
        } else {
          pass(`${app} at ${width} px keeps all 64 squares the same size`);
        }
      }

      // 7. A piece stays inside the square that holds it. The glyph grows with
      // the window, so a font that renders wider than the tile pushes ink past
      // the board edge and over the next file.
      if (page.squares.length === 64) {
        const grown = page.glyphs.filter(
          (item) =>
            item.glyph.left < item.cell.left - 0.5 ||
            item.glyph.top < item.cell.top - 0.5 ||
            item.glyph.right > item.cell.right + 0.5 ||
            item.glyph.bottom > item.cell.bottom + 0.5
        );
        if (grown.length) {
          fail(
            `${app} at ${width} px lets ${grown.length} piece${grown.length === 1 ? '' : 's'} grow past the square: ${grown
              .slice(0, 3)
              .map(
                (item) =>
                  `${item.square} ${round(item.glyph.width)}x${round(item.glyph.height)} in ${round(item.cell.width)}x${round(item.cell.height)}`
              )
              .join(', ')}`
          );
        } else {
          pass(`${app} at ${width} px keeps every piece inside its square`);
        }
      }

      // 8. An empty note keeps its sheet at the width of the pane. A sheet
      // that shrinks to its text turns a blank note into a narrow strip.
      if (page.parts['.editor'] && page.parts['.editor-wrap']) {
        const sheet = page.parts['.editor'];
        const pane = page.parts['.editor-wrap'];
        if (sheet.width < Math.min(760, pane.width) - 120) {
          fail(
            `${app} at ${width} px draws a ${round(sheet.width)} px sheet in a ${round(pane.width)} px pane`
          );
        } else {
          pass(
            `${app} at ${width} px keeps the sheet ${round(sheet.width)} px wide in a ${round(pane.width)} px pane`
          );
        }
        const leftGap = sheet.left - pane.left;
        const rightGap = pane.right - sheet.right;
        if (Math.abs(leftGap - rightGap) > 2) {
          fail(
            `${app} at ${width} px puts the sheet ${round(leftGap)} px from the left and ${round(rightGap)} px from the right`
          );
        }
      }
    }

    // 9. The app answers both colour schemes. A page that keeps one set of
    // colours in light and dark fails here, and so does a muted label under
    // 4.5:1 on its own panel.
    const themes = {};
    for (const scheme of ['light', 'dark']) {
      await tab.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await sleep(450);
      themes[scheme] = await tab.eval(snapshot(app));
      const ratio = await tab.eval(`(() => {
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
        const muted = document.querySelector(${app === 'notes' ? "'.files-foot, .doc-meta, .doc-preview, .status'" : "'.hint, .status'"});
        const panel = document.querySelector(${app === 'notes' ? "'.files'" : "'.panel'"});
        const ink = rgb(muted ? getComputedStyle(muted).color : getComputedStyle(document.body).color);
        const ground = rgb(panel ? getComputedStyle(panel).backgroundColor : getComputedStyle(document.body).backgroundColor);
        const a = lum(ink);
        const b = lum(ground);
        return { alpha: [ink[3], ground[3]], ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      })()`);
      if (ratio.alpha[0] !== 255 || ratio.alpha[1] !== 255) {
        fail(`${app} ${scheme} text or panel is not opaque: ${ratio.alpha.join(', ')}`);
      } else if (ratio.ratio < 4.5) {
        fail(`${app} ${scheme} muted text is ${ratio.ratio.toFixed(2)}:1 on the panel`);
      } else {
        pass(`${app} ${scheme} muted text is ${ratio.ratio.toFixed(2)}:1 on the panel`);
      }
      if (SHOTS) {
        await shot(app, scheme, 1440, 900);
        await shot(app, `${scheme}-narrow`, 760, 900);
      }
    }
    const light = themes.light.pageBg;
    const dark = themes.dark.pageBg;
    if (light === dark) {
      fail(`${app} paints the same page in light and dark: ${light}`);
    } else {
      pass(`${app} paints ${light} in light and ${dark} in dark`);
    }
  }

  if (failures.length) {
    throw new Error(`${failures.length} layout fault${failures.length === 1 ? '' : 's'}`);
  }
  console.log('PASS: notes and chess keep their rows, their targets and their words');
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
