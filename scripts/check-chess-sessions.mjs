// Three people, one board, on loopback. A guest has to ask for the open seat
// with Join game, a third person has to land in the queue, and opening the seat
// has to hand it to the first person waiting. New game has to move every tab to
// the next session number.
//
//   node scripts/check-chess-sessions.mjs
//
// The run starts its own relay and one headless Chrome with three tabs. It never
// touches the app browser on 9333 or the relay on 8790. The host tab owns the
// game, so the host tab opens first.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOM = 'chesscheck';
const SHOT = path.join(tmpdir(), 'chess-sessions.png');
const SHOT_JOIN = path.join(tmpdir(), 'chess-join.png');
const SHOT_QUEUE = path.join(tmpdir(), 'chess-queue.png');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(start) {
  const scan = async () => {
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
  };
  return scan();
}

async function waitForOk(url, tries = 40) {
  let last = null;
  for (let index = 0; index < tries; index += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = new Error(`status ${res.status}`);
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`no answer from ${url}: ${last ? last.message : 'unknown'}`);
}

async function getJson(url, tries = 80) {
  let last = null;
  for (let index = 0; index < tries; index += 1) {
    try {
      return await (await fetch(url)).json();
    } catch (error) {
      last = error;
      await sleep(250);
    }
  }
  throw new Error(`no answer from ${url}: ${last ? last.message : 'unknown'}`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails);
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message || 'cdp error'));
      else waiting.resolve(message.result);
    });
  }

  cmd(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.socket.send(
      JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
    );
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.socket.close();
  }
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return new Cdp(socket);
}

const READ = `JSON.stringify((() => {
  const text = (id) => { const node = document.getElementById(id); return node ? node.textContent.trim() : null; };
  const hidden = (id) => { const node = document.getElementById(id); return node ? node.hidden : null; };
  return {
    room: text('room-state'),
    session: text('session-number'),
    sessionState: text('session-state'),
    whiteName: text('white-name'),
    blackName: text('black-name'),
    joinHidden: hidden('join-game'),
    joinText: text('join-game'),
    leaveHidden: hidden('leave-seat'),
    blackYou: hidden('black-you'),
    queueBlock: hidden('queue-block'),
    queue: [...document.querySelectorAll('#queue .queue-name')].map((node) => node.textContent),
    status: text('status'),
    squares: document.querySelectorAll('.board .square').length,
    boardDisabled: Boolean(document.querySelector('.square') && document.querySelector('.square').disabled),
  };
})())`;

const report = { ok: false, checks: [], tabs: {}, shots: {} };

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}`);
  if (!fs.existsSync(path.join(root, 'spike', 'relay.js'))) {
    throw new Error('spike/relay.js is missing');
  }

  const relayPort = await freePort(8937);
  const debugPort = await freePort(9247);
  const profile = await mkdtemp(path.join(tmpdir(), 'brosr-chess-'));
  const relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
    cwd: path.join(root, 'spike'),
    stdio: 'ignore',
    env: { ...process.env, PORT: String(relayPort), HOST: '127.0.0.1' },
  });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let browser = null;
  const watchdog = setTimeout(() => {
    console.error('FAIL: the check ran past 150 s');
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    if (relay.exitCode === null) relay.kill('SIGKILL');
    process.exit(2);
  }, 150000);
  try {
    await waitForOk(`http://127.0.0.1:${relayPort}/health`);
    const version = await getJson(`http://127.0.0.1:${debugPort}/json/version`);
    browser = await connect(version.webSocketDebuggerUrl);

    const open = async (name) => {
      const created = await browser.cmd('Target.createTarget', { url: 'about:blank' });
      const attached = await browser.cmd('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      });
      const sessionId = attached.sessionId;
      const page = {
        sessionId,
        cmd: (method, params = {}) => browser.cmd(method, params, sessionId),
        async eval(expression) {
          const res = await browser.cmd(
            'Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true },
            sessionId
          );
          if (res.exceptionDetails) {
            throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
          }
          return res.result ? res.result.value : undefined;
        },
        async sample() {
          return JSON.parse(await this.eval(READ));
        },
      };
      await page.cmd('Page.enable');
      await page.cmd('Runtime.enable');
      await page.cmd('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.cmd('Page.navigate', {
        url: `http://127.0.0.1:${relayPort}/chess/?room=${ROOM}&peer=${name}&name=${encodeURIComponent(
          name === 'host' ? 'Host' : name === 'g1' ? 'Guest One' : 'Guest Two'
        )}${name === 'host' ? '&role=host' : ''}`,
      });
      return page;
    };

    const capture = async (page, file) => {
      const shot = await page.cmd('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      report.shots[path.basename(file)] = { path: file, bytes: fs.statSync(file).size };
    };

    const host = await open('host');
    console.log('[chess] host tab open');
    let hostState = null;
    for (let index = 0; index < 80 && !hostState; index += 1) {
      const seen = await host.sample();
      if (seen.room === 'Hosting' && seen.squares === 64) hostState = seen;
      else await sleep(250);
    }
    if (!hostState) throw new Error('the host never drew a board or connected');
    const first = await open('g1');
    const third = await open('g2');
    console.log('[chess] guest tabs open');

    async function until(page, label, want, timeoutMs = 15000) {
      const end = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < end) {
        last = await page.sample().catch(() => null);
        if (last && want(last)) return last;
        await sleep(200);
      }
      throw new Error(`timeout: ${label}, last ${JSON.stringify(last)}`);
    }

    async function check(page, label, want) {
      const seen = await until(page, label, want);
      report.checks.push({ label, got: seen, ok: true });
      return seen;
    }

    // 1. The second person sees a seat and has to ask for it.
    const guestReady = await check(
      first,
      'guest sees the open seat and a join button',
      (seen) => seen.room === 'Spectating' && seen.joinHidden === false
    );
    report.checks.push({ label: 'join label', got: guestReady.joinText, ok: true });
    await capture(first, SHOT_JOIN);

    console.log('[chess] joining Black');
    await first.eval("document.getElementById('join-game').click(); true");
    await check(
      first,
      'guest takes Black after joining',
      (seen) =>
        seen.blackYou === false &&
        seen.blackName === 'Guest One' &&
        seen.joinHidden === true &&
        seen.leaveHidden === false
    );
    await check(host, 'host sees Black filled', (seen) => seen.sessionState === 'In play');

    // 2. The third person has no seat, so they get one line instead.
    const thirdReady = await check(
      third,
      'third person is offered the queue',
      (seen) => seen.joinHidden === false && seen.joinText === 'Join queue'
    );
    report.checks.push({ label: 'third person join label', got: thirdReady.joinText, ok: true });

    await third.eval("document.getElementById('join-game').click(); true");
    await check(
      third,
      'third person is queued',
      (seen) =>
        seen.room === 'In line' &&
        seen.joinText === 'Leave queue' &&
        seen.queueBlock === false &&
        seen.queue.length === 1 &&
        seen.queue[0] === 'Guest Two'
    );
    await check(
      first,
      'the seated player sees the queue',
      (seen) => seen.queue.length === 1 && seen.queue[0] === 'Guest Two'
    );
    await capture(third, SHOT_QUEUE);

    // 3. Opening the seat hands it to the first person waiting.
    console.log('[chess] opening the seat');
    await host.eval("document.getElementById('open-seat').click(); true");
    await check(
      third,
      'the queued person is seated when the seat opens',
      (seen) =>
        seen.blackYou === false &&
        seen.blackName === 'Guest Two' &&
        seen.queueBlock === true &&
        seen.leaveHidden === false
    );
    await check(
      first,
      'the previous player is back to spectating',
      (seen) => seen.room === 'Spectating' && seen.joinHidden === false && seen.boardDisabled === true
    );

    // 4. A new game moves everyone to the next session.
    console.log('[chess] starting the next session');
    await host.eval("document.getElementById('new-game').click(); true");
    for (const [name, page] of [['host', host], ['first guest', first], ['third person', third]]) {
      await check(
        page,
        `${name} shows the next session`,
        (seen) => seen.session === '2' && seen.sessionState === 'In play'
      );
    }

    await capture(host, SHOT);

    for (const [name, page] of [['host', host], ['g1', first], ['g2', third]]) {
      report.tabs[name] = await page.sample();
    }
    if (browser.exceptions.length) {
      throw new Error(
        'page exceptions: ' + JSON.stringify(browser.exceptions).slice(0, 400)
      );
    }

    report.ok = true;
    console.log(
      `[chess] PASS: ${report.checks.length} checks, session ${report.tabs.host.session}, ` +
        `Black ${report.tabs.host.blackName}, shots ${Object.keys(report.shots).join(', ')}`
    );
  } finally {
    clearTimeout(watchdog);
    browser?.close?.();
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    if (relay.exitCode === null) relay.kill('SIGKILL');
    await sleep(600);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then(() => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    report.error = String((error && error.message) || error);
    console.error(`FAIL: ${report.error}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  });
