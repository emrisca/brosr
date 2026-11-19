// Two people type in one note at the same time. The room carries characters,
// not whole bodies, so this lane drives a real host and a real guest in one
// relay and checks that both words survive, that the guest sees a caret, that a
// guest edit lands while the host has its own caret in the page, and that a
// reader who arrives later gets the merged note.
//
//   node scripts/check-notes-cotyping.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-notes-cotyping.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createBrowserLog, describeSilentRenderer } from './lane-diagnostics.mjs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.BROSR_RELAY || '';
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
      if (message.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        return;
      }
      if (!message.id) return;
      const held = this.pending.get(message.id);
      if (!held) return;
      this.pending.delete(message.id);
      if (message.error) held.reject(new Error(JSON.stringify(message.error)));
      else held.resolve(message.result);
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    return this.sendOnce(method, params, timeoutMs);
  }

  // A busy renderer can drop the navigate reply while the page itself loads.
  // The page change is then made from inside the renderer, and the readiness
  // wait after it decides whether the page arrived.
  async navigate(url, timeoutMs = 20000) {
    const started = Date.now();
    try {
      return await this.sendOnce('Page.navigate', { url }, timeoutMs);
    } catch (error) {
      if (!String(error.message).startsWith('cdp timeout')) throw error;
      const answered = await this.sendOnce(
        'Runtime.evaluate',
        { expression: '1 + 1', returnByValue: true },
        5000
      )
        .then((out) => Boolean(out && out.result && out.result.value === 2))
        .catch(() => false);
      if (!answered) {
        throw new Error(
          `the page stopped answering after Page.navigate timed out: ${describeSilentRenderer({
            url,
            elapsedMs: Date.now() - started,
            socketOpen: this.ws.readyState === 1,
            child: chrome,
            browserLog,
          })}`
        );
      }
      await this.sendOnce(
        'Runtime.evaluate',
        { expression: `location.href = ${JSON.stringify(url)}` },
        5000
      ).catch(() => null);
      console.log('  Page.navigate did not answer, set the location from the page');
      return { fallback: true };
    }
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

const CARET_AT_END = `(() => {
  const editor = document.getElementById('editor');
  editor.focus();
  const blocks = editor.querySelectorAll('[data-b]');
  const last = blocks[blocks.length - 1] || editor;
  const range = document.createRange();
  range.selectNodeContents(last);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()`;

const TEXT = `(() => {
  const editor = document.getElementById('editor');
  return (editor.innerText || '').replace(/\\s+/g, ' ').trim();
})()`;

const browser = BROWSERS.find((file) => fs.existsSync(file));
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}

let relay = null;
let base = LIVE.replace(/\/$/, '');
let cdp = '';
const profile = await mkdtemp(path.join(tmpdir(), 'brosr-notes-cotyping-'));
// A fresh library per run, so a saved note from an earlier run cannot leak in.
const store = await mkdtemp(path.join(tmpdir(), 'brosr-notes-store-'));
let chrome = null;
const browserLog = createBrowserLog();
const tabs = [];
const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`  FAIL ${message}`);
};
const pass = (message) => console.log(`  ok ${message}`);

async function page(query, label) {
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
  await tab.navigate(`${base}/notes/${query}`);
  await waitFor(
    () =>
      tab.eval(
        'document.readyState === "complete" && !!document.getElementById("editor") && !!document.querySelector(".editor [data-b]")'
      ),
    `the ${label} page`
  );
  await sleep(250);
  return tab;
}

let laneRetry = false;

try {
  if (!base) {
    const port = await freePort(9670);
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        RELAY_QUIET: '1',
        BROSR_DOCS_DIR: store,
      },
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`${base}/health`)).ok, 'relay');
  }
  console.log(`relay ${base}, browser ${path.basename(browser)}`);

  const devPort = await freePort(9780);
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
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  chrome.stderr.on('data', (chunk) => browserLog.push(chunk));
  cdp = `http://127.0.0.1:${devPort}`;
  await waitFor(async () => (await fetch(`${cdp}/json/version`)).ok, 'devtools endpoint');

  const host = await page('?room=type&role=host&name=Host', 'host');
  const guest = await page('?room=type&name=Ana', 'guest');

  // The guest parks on the host page before anyone types, so both pages share
  // one document rather than two empty ones.
  await waitFor(() => host.eval('document.getElementById("doc-state").textContent !== "Opening"'), 'host ready');
  await waitFor(() => guest.eval('document.getElementById("doc-state").textContent === "Shared"'), 'guest shared');
  await waitFor(
    () => guest.eval('document.querySelectorAll(".editor [data-b]").length > 0'),
    'guest to hold a block'
  );

  await host.eval(CARET_AT_END);
  await host.send('Input.insertText', { text: 'alpha ' });
  await waitFor(async () => (await guest.eval(TEXT)).includes('alpha'), 'the guest to see the first word');
  pass('a word typed on the host reaches the guest');

  // Both hands at once, at the same end of the same paragraph.
  await host.eval(CARET_AT_END);
  await guest.eval(CARET_AT_END);
  await Promise.all([
    host.send('Input.insertText', { text: 'mine ' }),
    guest.send('Input.insertText', { text: 'yours ' }),
  ]);

  const merged = await waitFor(async () => {
    const a = await host.eval(TEXT);
    const b = await guest.eval(TEXT);
    return a.includes('mine') && a.includes('yours') && b.includes('mine') && b.includes('yours')
      ? { a, b }
      : null;
  }, 'both words on both pages');

  if (merged.a !== merged.b) {
    fail(`the two pages show different notes: "${merged.a}" and "${merged.b}"`);
  } else {
    pass('simultaneous typing keeps both words and one text');
  }
  if ((merged.a.match(/mine/g) || []).length !== 1 || (merged.a.match(/yours/g) || []).length !== 1) {
    fail(`a word doubled after the merge: "${merged.a}"`);
  } else {
    pass('neither word is duplicated by the merge');
  }

  // The old body swap skipped a remote page while the host was typing. A guest
  // edit has to land while the host caret sits in the note.
  const carets = await waitFor(
    () => host.eval('document.querySelectorAll("#carets .peer-caret").length > 0'),
    'a guest caret on the host page'
  );
  if (!carets) fail('the host never drew the guest caret');
  else pass('the host draws a remote caret with a name');

  await host.eval(CARET_AT_END);
  await guest.eval(CARET_AT_END);
  await guest.send('Input.insertText', { text: 'gamma ' });
  const landed = await waitFor(
    async () => {
      const text = await host.eval(TEXT);
      return text.includes('gamma') ? text : null;
    },
    'a guest edit while the host caret is in the page'
  );
  if (!landed) fail('a guest edit was dropped while the host had focus');
  else pass('a guest edit lands while the host is typing');

  // A reader who joins last gets the merged note, not an empty page.
  const late = await page('?room=type&name=Cee', 'late guest');
  const arrived = await waitFor(
    async () => {
      const text = await late.eval(TEXT);
      return ['alpha', 'mine', 'yours', 'gamma'].every((word) => text.includes(word)) ? text : null;
    },
    'a late reader to receive the whole note'
  );
  if (!arrived) fail('a late reader did not receive every word');
  else pass('a late reader receives the merged note');

  if (failures.length) {
    throw new Error(`${failures.length} notes fault${failures.length === 1 ? '' : 's'}`);
  }
  console.log('PASS: two hands write one note and every page agrees');
} catch (error) {
  const message = String((error && error.message) || error);
  // A fresh Chrome can come up with a renderer that never answers, and the
  // lane then fails before it reads a box. One relaunch gives the lane a new
  // browser without weakening a check.
  if (!process.env.BROSR_LANE_RETRY && message.includes('Page.navigate')) {
    laneRetry = true;
    console.error(`FAIL, relaunching once: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
} finally {
  for (const tab of tabs) tab.ws.close();
  if (chrome) {
    chrome.kill('SIGTERM');
    await sleep(600);
    chrome.kill('SIGKILL');
  }
  if (relay) relay.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true });
  await rm(store, { recursive: true, force: true });
}

if (laneRetry) {
  console.error('the browser stopped answering, running the lane again in a fresh one');
  const again = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, BROSR_LANE_RETRY: '1' },
  });
  process.exit(again.status === null ? 1 : again.status);
}
