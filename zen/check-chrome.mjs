// Headless proof that a room runs inside a Chromium build. Chrome 137 refuses
// --load-extension, so this lane picks a build that still reads the flag: Brave,
// Edge, Chromium or Chrome for Testing. The landing page carries no bridge
// code, so a live dataset can only come from the loaded add-on.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newRoomKey } from '../core/seal.mjs';
import { detect, launchArgs } from '../host/browsers.mjs';
import { freePort, roomUrl } from '../host/room.mjs';
import { buildChrome } from './package.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.join(here, '..', 'spike');
const runtime = path.join(here, '.runtime');

const arg = (name, fallback = '') => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

// The browser starts helper processes, so one group signal reaches the tree.
function killTree(child) {
  if (!child) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // A process that already left needs no second signal.
    }
  }
}

function get(port, pathname, timeout = 800) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function waitRelay(port, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const answer = await get(port, '/');
    if (answer && answer.status === 200) return true;
    await sleep(120);
  }
  return false;
}

// The debugging endpoint lists one target per page. The room page is the only
// page this lane opens, so its URL names the target.
async function waitTarget(port, needle, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const answer = await get(port, '/json/list');
    if (answer && answer.status === 200) {
      try {
        const targets = JSON.parse(answer.body);
        const hit = targets.find(
          (target) => target.type === 'page' && String(target.url || '').includes(needle)
        );
        if (hit && hit.webSocketDebuggerUrl) return hit;
      } catch {
        // A half written list answers again on the next poll.
      }
    }
    await sleep(300);
  }
  return null;
}

// Node ships a WebSocket client, so the lane needs no package for the protocol.
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const waiting = new Map();
    let next = 1;
    socket.addEventListener('message', (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      if (message.error) entry.reject(new Error(String(message.error.message || message.error)));
      else entry.resolve(message.result);
    });
    socket.addEventListener('error', () => reject(new Error('the page gave no debug socket')));
    socket.addEventListener('open', () =>
      resolve({
        cmd(name, params = {}) {
          const id = next++;
          return new Promise((ok, bad) => {
            waiting.set(id, { resolve: ok, reject: bad });
            socket.send(JSON.stringify({ id, method: name, params }));
          });
        },
        close: () => socket.close(),
      })
    );
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.cmd('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(String(result.exceptionDetails.text || 'the page threw'));
  }
  return result.result ? result.result.value : null;
}

// The content script writes the dataset once the socket opens. A page without
// the add-on never writes it, so the wait fails instead of reading a default.
async function waitDataset(cdp, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    const raw = await evaluate(cdp, "document.documentElement.dataset.brosr || ''").catch(
      () => ''
    );
    if (raw) {
      try {
        last = JSON.parse(raw);
      } catch {
        last = null;
      }
      if (last && last.socket === 1) return last;
    }
    await sleep(300);
  }
  return last;
}

async function main() {
  const wanted = arg('browser', '');
  const supported = detect().filter((entry) => entry.family === 'chromium' && entry.supported);
  const browser = wanted
    ? supported.find((entry) => entry.id === wanted)
    : supported[0];
  if (!browser) {
    throw new Error(
      wanted
        ? `${wanted} is not installed or cannot load an unpacked add-on`
        : 'no Chromium build can load an unpacked add-on. Install Brave, Edge or Chromium.'
    );
  }

  // The landing page is the control. It draws its own tiles and never writes
  // the dataset, so a live value can only come from the add-on.
  const landing = fs.readFileSync(path.join(here, '..', 'landing', 'index.html'), 'utf8');
  if (/dataset\.brosr\s*=/.test(landing)) {
    throw new Error('the landing page writes the bridge dataset, so a pass would prove nothing');
  }

  const profile = path.join(runtime, `chrome-profile-${browser.id}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const extension = buildChrome(path.join(runtime, 'bridge-chrome')).dir;
  const bridgeVersion = JSON.parse(
    fs.readFileSync(path.join(here, '..', 'bridge', 'manifest.json'), 'utf8')
  ).version;

  const relayPort = await freePort(8787);
  const debugPort = await freePort(9400);
  const room = arg('room', 'chrome');
  // The page reads its relay port from this parameter and falls back to 8787.
  // Without it, a room that already holds 8787 collects this lane's peers and
  // the lane reads an empty table on the port it started.
  // A room opens on the landing page, so the lane reads the same URL the host
  // writes. The panel adds page furniture and no socket, so it stays off here.
  const url = roomUrl({ port: relayPort, room, key: newRoomKey(), name: 'Host', panel: false });
  if (new URL(url).pathname !== '/') {
    throw new Error(`the room URL does not open the landing page: ${url}`);
  }

  const relay = spawn(process.execPath, ['relay.js'], {
    cwd: spike,
    env: { ...process.env, PORT: String(relayPort), HOST: '127.0.0.1' },
    detached: true,
    stdio: 'ignore',
  });
  relay.unref();

  const args = [
    `--remote-debugging-port=${debugPort}`,
    ...launchArgs(browser, { profile, url, headless: true, extension }),
  ];
  const child = spawn(browser.path, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  const result = {
    when: new Date().toISOString(),
    browser: { id: browser.id, name: browser.name, version: browser.version, path: browser.path },
    relay: { port: relayPort, peers: 0 },
    check: { ok: false, error: 'not run' },
    dataset: null,
  };

  try {
    if (!(await waitRelay(relayPort))) throw new Error('the relay did not answer');
    const target = await waitTarget(debugPort, `http://127.0.0.1:${relayPort}/`);
    if (!target) throw new Error('the room page never appeared in the target list');
    log('[chrome] target', target.url);

    const cdp = await connect(target.webSocketDebuggerUrl);
    try {
      await cdp.cmd('Runtime.enable');
      const data = await waitDataset(cdp);
      if (!data) throw new Error('no dataset from the content script');
      if (data.source !== 'content-script') throw new Error(`source was ${data.source}`);
      if (data.socket !== 1) throw new Error(`socket was ${data.socket}`);
      if (!data.panelUrl) throw new Error('the content script did not publish a panel URL');
      if (!data.build || data.build.version !== bridgeVersion) {
        throw new Error(
          `the content script reported bridge ${data.build && data.build.version}, expected ${bridgeVersion}`
        );
      }

      const status = await get(relayPort, `/status?room=${encodeURIComponent(room)}`);
      let peers = 0;
      try {
        peers = JSON.parse(status.body).peers;
      } catch {
        peers = 0;
      }
      if (peers !== 1) throw new Error(`the relay counts ${peers} peers`);

      result.dataset = {
        socket: data.socket,
        source: data.source,
        location: data.location,
        panelUrl: data.panelUrl,
        peers: data.peers,
      };
      result.relay.peers = peers;
      result.check = { ok: true, error: null };
      log('[chrome] room live:', JSON.stringify(result.dataset));
    } finally {
      cdp.close();
    }
  } catch (error) {
    result.check = { ok: false, error: error.message };
    log('[chrome] failed:', error.message);
  } finally {
    killTree(child);
    killTree(relay);
    await sleep(300);
  }

  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, 'check-chrome.json'),
    JSON.stringify(result, null, 2) + '\n'
  );
  log('[chrome]', result.check.ok ? 'pass' : 'fail', result.check.error || '');
  process.exit(result.check.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[chrome]', error.message);
  process.exit(1);
});
