// Chess is played with a pointer and a seat is claimed through the room, so
// this lane drives a real host and real guests in one relay. A piece drags to a
// legal square, an illegal drop snaps back, a tap still selects and clears, a
// second guest waits in line for the seat the first one leaves, and a double
// click on Open seat does not take that seat back off the guest it promoted.
//
//   node scripts/check-chess-play.mjs
//   BROSR_CHECK_BROWSER=/path/to/chrome node scripts/check-chess-play.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

async function waitFor(fn, label, timeout = 12000) {
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
      // A confirm in the page would stall every later evaluate, so answer it.
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

const browser = BROWSERS.find((file) => fs.existsSync(file));
if (!browser) {
  console.error('No Chromium found. Set BROSR_CHECK_BROWSER to one.');
  process.exit(1);
}

let relay = null;
let base = LIVE.replace(/\/$/, '');
let cdp = '';
const profile = await mkdtemp(path.join(tmpdir(), 'brosr-chess-play-'));
let chrome = null;
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
  await tab.send('Page.navigate', { url: `${base}/chess/${query}` });
  await waitFor(
    () => tab.eval('document.readyState === "complete" && document.querySelectorAll(".square").length === 64'),
    `the ${label} board`
  );
  await tab.eval('document.fonts.ready');
  await sleep(200);
  return tab;
}

async function center(tab, square) {
  return tab.eval(`(() => {
    const node = document.querySelector('button[data-square="${square}"]');
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
}

async function mouse(tab, type, x, y, extra) {
  await tab.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
}

async function clickAt(tab, x, y) {
  await mouse(tab, 'mouseMoved', x, y, { button: 'none', buttons: 0 });
  await mouse(tab, 'mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse(tab, 'mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(150);
}

// A real press, a real path across the board and a real release, so the page
// sees the same pointer sequence a hand produces.
async function drag(tab, from, to) {
  const start = await center(tab, from);
  const end = await center(tab, to);
  await mouse(tab, 'mouseMoved', start.x, start.y, { button: 'none', buttons: 0 });
  await mouse(tab, 'mousePressed', start.x, start.y, { button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 6; step += 1) {
    await mouse(
      tab,
      'mouseMoved',
      start.x + ((end.x - start.x) * step) / 6,
      start.y + ((end.y - start.y) * step) / 6,
      { button: 'left', buttons: 1 }
    );
    await sleep(20);
  }
  await mouse(tab, 'mouseReleased', end.x, end.y, { button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
}

try {
  if (!base) {
    const port = await freePort(9650);
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RELAY_QUIET: '1' },
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`${base}/health`)).ok, 'relay');
  }
  console.log(`relay ${base}, browser ${path.basename(browser)}`);

  const devPort = await freePort(9770);
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
  cdp = `http://127.0.0.1:${devPort}`;
  await waitFor(async () => (await fetch(`${cdp}/json/version`)).ok, 'devtools endpoint');

  // A host alone in its own room, so the drag checks are not mixed with seats.
  const host = await page('?room=drag&role=host&name=Host', 'host');

  const g1 = await center(host, 'g1');
  await clickAt(host, g1.x, g1.y);
  let picked = await host.eval('document.querySelectorAll(".square.is-selected").length');
  if (picked !== 1) fail('a tap on a knight does not select it');
  else pass('a tap still selects a piece');

  await clickAt(host, g1.x, g1.y);
  picked = await host.eval('document.querySelectorAll(".square.is-selected").length');
  if (picked !== 0) fail('a second tap on a knight leaves it selected');
  else pass('a second tap clears the selection');

  await drag(host, 'e2', 'e5');
  const illegal = await host.eval(`(() => ({
    moves: document.querySelectorAll('.move-row').length,
    e2: !!document.querySelector('button[data-square="e2"] .piece'),
    e5: !!document.querySelector('button[data-square="e5"] .piece'),
    selected: document.querySelectorAll('.square.is-selected').length,
  }))()`);
  if (illegal.moves || !illegal.e2 || illegal.e5 || illegal.selected) {
    fail(`an illegal drop changes the board: ${JSON.stringify(illegal)}`);
  } else {
    pass('an illegal drop snaps the piece back');
  }

  await drag(host, 'e2', 'e4');
  const moved = await host.eval(`(() => ({
    san: [...document.querySelectorAll('.move-san')].map((node) => node.textContent.trim()),
    e2: !!document.querySelector('button[data-square="e2"] .piece'),
    e4: !!document.querySelector('button[data-square="e4"] .piece'),
    selected: document.querySelectorAll('.square.is-selected').length,
  }))()`);
  if (moved.san[0] !== 'e4' || moved.e2 || !moved.e4) {
    fail(`a drag from e2 to e4 does not land: ${JSON.stringify(moved)}`);
  } else {
    pass('a dragged pawn lands on e4');
  }
  if (moved.selected) fail('a finished drag leaves the landed piece selected');
  else pass('a finished drag leaves nothing selected');

  // A second room, so the join flow starts from the opening position and the
  // leave confirm has nothing to ask about.
  const seatHost = await page('?room=seats&role=host&name=Host', 'seat host');
  const ana = await page('?room=seats&name=Ana', 'Ana');
  const ben = await page('?room=seats&name=Ben', 'Ben');

  await ana.eval('document.getElementById("join-game").click()');
  await waitFor(
    () =>
      ana.eval(
        '!document.getElementById("black-you").hidden && document.getElementById("black-name").textContent.trim() === "Ana"'
      ),
    'Ana to take Black'
  );
  const named = await seatHost.eval(`(() => ({
    black: document.getElementById('black-name').textContent.trim(),
    you: !document.getElementById('black-you').hidden,
    joinHidden: document.getElementById('join-game').hidden,
  }))()`);
  if (named.black !== 'Ana') fail(`the host shows ${named.black} on Black after Ana joins`);
  else pass('the host names the guest on Black');
  if (named.you) fail('the host marks the guest seat as its own');
  if (!named.joinHidden) fail('a seated guest keeps the Join button');

  await ben.eval('document.getElementById("join-game").click()');
  await waitFor(
    () => seatHost.eval('document.querySelectorAll("#queue .queue-row").length === 1'),
    'Ben to reach the queue'
  );
  const queued = await ben.eval(`(() => ({
    label: document.getElementById('join-game').textContent.trim(),
    hidden: document.getElementById('join-game').hidden,
    you: !document.getElementById('black-you').hidden,
  }))()`);
  if (queued.you || queued.hidden || queued.label !== 'Leave queue') {
    fail(`a guest in line shows ${JSON.stringify(queued)}`);
  } else {
    pass('a full board puts the next guest in line');
  }

  await ana.eval('document.getElementById("leave-seat").click()');
  await waitFor(
    () =>
      ben.eval(
        '!document.getElementById("black-you").hidden && document.getElementById("black-name").textContent.trim() === "Ben"'
      ),
    'Ben to take the free seat'
  );
  const promoted = await seatHost.eval(`(() => ({
    rows: document.querySelectorAll('#queue .queue-row').length,
    hidden: document.getElementById('queue-block').hidden,
    black: document.getElementById('black-name').textContent.trim(),
  }))()`);
  if (promoted.rows || !promoted.hidden || promoted.black !== 'Ben') {
    fail(`the queue does not empty into the seat: ${JSON.stringify(promoted)}`);
  } else {
    pass('leaving a seat hands it to the person in line');
  }

  const cee = await page('?room=seats&name=Cee', 'Cee');
  await cee.eval('document.getElementById("join-game").click()');
  await waitFor(
    () => seatHost.eval('document.querySelectorAll("#queue .queue-row").length === 1'),
    'Cee to reach the queue'
  );
  // Two clicks in one task share a timestamp, so the cooldown is what holds
  // the seat for the guest the first click promoted.
  await seatHost.eval(`(() => {
    const button = document.getElementById('open-seat');
    button.click();
    button.click();
  })()`);
  await waitFor(
    () =>
      cee.eval(
        '!document.getElementById("black-you").hidden && document.getElementById("black-name").textContent.trim() === "Cee"'
      ),
    'Cee to take the opened seat'
  );
  await sleep(300);
  const kept = await seatHost.eval(`(() => ({
    black: document.getElementById('black-name').textContent.trim(),
    queue: document.querySelectorAll('#queue .queue-row').length,
  }))()`);
  const ceeSeated = await cee.eval('!document.getElementById("black-you").hidden');
  if (kept.black !== 'Cee' || kept.queue !== 0 || !ceeSeated) {
    fail(`a double click on Open seat kicks the guest it just promoted: ${JSON.stringify(kept)}`);
  } else {
    pass('a double click on Open seat promotes one guest, not two');
  }

  if (failures.length) {
    throw new Error(`${failures.length} chess fault${failures.length === 1 ? '' : 's'}`);
  }
  console.log('PASS: chess drags, taps and seats behave');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
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
