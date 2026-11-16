// One real trusted run. A record reaches a form through the browser's own input
// pipeline, so the page reports isTrusted true. The same check proves the agent
// refuses without a grant, closes on revoke, and that the helper process closes
// its listener when the room stops.
//
// The app keeps its browser on port 9333, so this check uses a temp profile, its
// own debug port and its own page server.
//
//   node scripts/check-trusted-input.mjs
//   BROSR_CHECK_BROWSER=/path/to/zen node scripts/check-trusted-input.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { createTrustAgent } from '../host/trust.mjs';
import { findZen } from '../zen/profile.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(root, 'spike', 'fixtures', 'form.html');
const HELPER = path.join(root, 'host', 'trust.mjs');
const TOKEN = 'check-trusted-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BROWSERS = [
  process.env.BROSR_CHECK_BROWSER,
  findZen(),
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
].filter(Boolean);

async function freePort(start) {
  for (let port = start; port < start + 60; port += 1) {
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

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/form.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(FIXTURE));
      return;
    }
    if (url.pathname === '/room.html') {
      // The helper watches this page. The peer list is the grant the room page
      // publishes on a real run.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><script>document.documentElement.dataset.brosr = ' +
          JSON.stringify(JSON.stringify({ peerList: [{ id: 'peer', granted: true, self: false }] })) +
          ';</script>'
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function connect(port, timeout = 45000) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${port}/session`).connect();
    } catch (error) {
      last = error;
      await sleep(300);
    }
  }
  throw new Error(`no BiDi on ${port}: ${last ? last.message : 'unknown'}`);
}

async function evaluate(bidi, context, expression) {
  const res = await bidi.cmd('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  return res && res.result ? res.result.value : undefined;
}

async function waitFor(fn, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function listenerOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const binary = BROWSERS.find((file) => file && fs.existsSync(file));
  if (!binary) throw new Error('no Zen or Firefox build found. Set BROSR_CHECK_BROWSER');
  const profile = await mkdtemp(path.join(tmpdir(), 'brosr-trust-check-'));
  const server = await serve();
  const pagePort = server.address().port;
  const debugPort = await freePort(9340);
  const result = { ok: false, browser: binary, pagePort, debugPort, steps: {} };
  let browser = null;
  let bidi = null;
  let helper = null;
  try {
    const page = `http://127.0.0.1:${pagePort}/form.html`;
    browser = spawn(
      binary,
      ['--profile', profile, '--no-remote', '--new-instance', '--remote-debugging-port', String(debugPort), '-headless', page],
      { stdio: 'ignore' }
    );
    bidi = await connect(debugPort);
    const tree = await bidi.cmd('browsingContext.getTree', {});
    const context = (tree.contexts || [])[0] && tree.contexts[0].context;
    if (!context) throw new Error('no browsing context');
    await bidi.cmd('browsingContext.navigate', { context, url: page, wait: 'complete' });
    await evaluate(bidi, context, "document.getElementById('field').focus(); true");
    result.steps.context = context;

    let refusedWithoutGrant = false;
    try {
      await createTrustAgent({ bidi, context });
    } catch {
      refusedWithoutGrant = true;
    }

    const agent = await createTrustAgent({
      bidi,
      context,
      token: TOKEN,
      grant: { peerId: 'peer', active: true },
    });
    result.steps.agent = { host: agent.host, port: agent.port, refusedWithoutGrant };
    result.steps.noToken = (
      await fetch(`${agent.url}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ records: [{ kind: 'key', key: 'x' }] }),
      })
    ).status;

    const typed = await fetch(`${agent.url}/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        records: [
          { kind: 'key', key: 't' },
          { kind: 'text', value: 'rust' },
        ],
      }),
    });
    result.steps.action = await typed.json();
    const seen = await waitFor(async () => {
      const value = await evaluate(
        bidi,
        context,
        "JSON.stringify({ value: document.getElementById('field').value, keys: window.__keys })"
      );
      const parsed = value ? JSON.parse(value) : null;
      return parsed && parsed.value === 'trust' ? parsed : null;
    }, 'the typed value');
    result.steps.typed = seen;
    const keys = Array.isArray(seen.keys) ? seen.keys : [];
    const trustedKeys = keys.filter((entry) => entry.trusted === true);

    await agent.revoke();
    const closedAfterRevoke = !(await listenerOpen(agent.port));
    result.steps.revoke = { active: agent.isActive(), closedAfterRevoke };

    // The room stop closes the session. The helper watches a page that reports
    // a grant, opens its listener, then receives SIGTERM as an app exit would.
    await bidi.cmd('browsingContext.navigate', {
      context,
      url: `http://127.0.0.1:${pagePort}/room.html?room=check`,
      wait: 'complete',
    });
    // Firefox keeps one session per browser. The helper needs its own, so this
    // check ends its session before the helper opens one.
    await bidi.cmd('session.end', {}).catch(() => {});
    bidi.close();
    bidi = null;
    helper = spawn(
      process.execPath,
      [HELPER, `--debug-port=${debugPort}`, '--room=check', `--token=${TOKEN}`],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let log = '';
    const helperPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`helper log: ${log.trim()}`)), 30000);
      helper.stderr.on('data', (chunk) => {
        log += String(chunk);
        const hit = log.match(/agent for peer on http:\/\/127\.0\.0\.1:(\d+)/);
        if (hit) {
          clearTimeout(timer);
          resolve(Number(hit[1]));
        }
      });
      helper.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`helper exited ${code}: ${log.trim()}`));
      });
    });
    const helperWasOpen = await listenerOpen(helperPort);
    const exited = new Promise((resolve) => helper.once('exit', (code) => resolve(code)));
    helper.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')]);
    const closedAfterStop = !(await listenerOpen(helperPort));
    result.steps.helper = { helperPort, helperWasOpen, code, closedAfterStop, log: log.trim() };

    result.ok = Boolean(
      refusedWithoutGrant &&
        result.steps.noToken === 401 &&
        result.steps.action &&
        result.steps.action.ok === true &&
        result.steps.action.applied === 2 &&
        seen.value === 'trust' &&
        keys.length >= 5 &&
        trustedKeys.length === keys.length &&
        closedAfterRevoke &&
        helperWasOpen &&
        code !== 'timeout' &&
        closedAfterStop
    );
  } catch (error) {
    result.error = String((error && error.message) || error);
  } finally {
    if (helper) helper.kill('SIGKILL');
    if (bidi) bidi.close();
    if (browser) browser.kill('SIGTERM');
    server.close();
    await rm(profile, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

main()
  .then((result) => {
    if (!result.ok) {
      process.stderr.write('trusted input check failed\n');
      process.exit(1);
    }
    process.stdout.write('trusted input check passed\n');
  })
  .catch((error) => {
    process.stderr.write(`trusted input check failed: ${error.message}\n`);
    process.exit(1);
  });
