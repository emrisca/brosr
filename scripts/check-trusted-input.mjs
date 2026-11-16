// One real trusted run. A record reaches a form through the browser's own input
// pipeline, so the page reports isTrusted true. The same check proves the agent
// refuses without a grant, closes on revoke, and that the helper process closes
// its listener when the room stops.
//
// It also drives the panel's Trusted typing switch. The panel page is the real
// bridge page with a stubbed browser API: tabs.query reports a target tab and a
// room tab, and tabs.sendMessage delivers to the room page over a local channel.
// The room page answers the same messages the real room tab answers. The helper
// is the real process, so the switch, the room handler and the helper resolution
// all take part.
//
// After the helper takes the browser's one BiDi session, the pages report their
// DOM state to this server and read commands from it. That is how the check sees
// which field changed without a second session.
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
const PANEL_HTML = path.join(root, 'bridge', 'panel', 'room.html');
const PANEL_JS = path.join(root, 'bridge', 'panel', 'room.js');
const PANEL_CSS = path.join(root, 'bridge', 'panel', 'room.css');
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

// A page that reports its own state and follows commands. A key logger records
// isTrusted on every keydown, which is the point of the whole check.
function driver(page) {
  const name = JSON.stringify(page);
  return [
    'window.__keys = [];',
    '(function () {',
    "  var field = document.getElementById('field');",
    '  if (field) {',
    "    field.addEventListener('keydown', function (event) {",
    '      window.__keys.push({ key: event.key, trusted: event.isTrusted });',
    '    });',
    '    try { field.focus(); } catch (e) {}',
    '  }',
    '  function report() {',
    "    var box = document.getElementById('trust-target');",
    "    var notice = document.getElementById('notice');",
    "    var input = document.getElementById('field');",
    '    return {',
    '      page: ' + name + ',',
    '      url: location.href,',
    '      field: input ? input.value : null,',
    '      keys: Array.isArray(window.__keys) ? window.__keys.slice(0, 64) : null,',
    '      checked: box ? box.checked : null,',
    '      notice: notice ? notice.textContent : null,',
    '    };',
    '  }',
    '  setInterval(function () {',
    "    fetch('/report', { method: 'POST', body: JSON.stringify(report()) }).catch(function () {});",
    '  }, 400);',
    '  setInterval(function () {',
    '    fetch(' + JSON.stringify('/next?page=' + page) + ')',
    '      .then(function (res) { return res.json(); })',
    '      .then(function (cmd) {',
    '        if (!cmd || !cmd.kind) return;',
    "        if (cmd.kind === 'navigate') location.assign(cmd.url);",
    "        if (cmd.kind === 'tick') {",
    "          var box = document.getElementById('trust-target');",
    '          if (!box) return;',
    '          box.checked = Boolean(cmd.on);',
    "          box.dispatchEvent(new Event('change', { bubbles: true }));",
    '        }',
    "        if (cmd.kind === 'trust' && " + name + " === 'room') window.__trust = Boolean(cmd.on);",
    '      })',
    '      .catch(function () {});',
    '  }, 200);',
    '})();',
  ].join('\n');
}

// The room page publishes what the real room tab publishes. The grant names a
// peer, so the helper starts, and the handler answers the switch the way the
// content script answers it, including the refusal when the room has no trusted
// channel.
function roomScript(origin) {
  return [
    'window.__trust = true;',
    'window.__target = null;',
    'window.__publishRoom = function () {',
    '  document.documentElement.dataset.brosr = JSON.stringify({',
    "    peerList: [{ id: 'peer', granted: true, self: false }],",
    '    trustTarget: window.__target,',
    "    trust: window.__trust ? { url: " + JSON.stringify(origin) + ', batches: 0 } : null,',
    '  });',
    '};',
    'window.__publishRoom();',
    'setInterval(window.__publishRoom, 300);',
    "var channel = new BroadcastChannel('brosr-check');",
    'channel.onmessage = function (event) {',
    '  var data = event.data || {};',
    "  if (data.to !== 'room') return;",
    '  var answer = function (value) {',
    '    channel.postMessage({ replyTo: data.id, value: value });',
    '  };',
    '  var message = data.message || {};',
    "  if (message.type === 'brosr:trust-target') {",
    '    if (!window.__trust) {',
    "      answer({ ok: false, reason: 'no-trust' });",
    '      return;',
    '    }',
    "    var url = String(message.url || '');",
    "    window.__target = /^https?:\\/\\//i.test(url) ? url : null;",
    '    window.__publishRoom();',
    '    answer({ ok: true, url: window.__target });',
    '    return;',
    '  }',
    "  if (message.type === 'brosr:status') {",
    "    answer({",
    "      ok: true, room: 'check', peerId: 'host', role: 'host', source: 'content-script',",
    '      panelUrl: null,',
    '      data: {',
    '        socket: 1,',
    "        role: 'host',",
    "        peerList: [{ id: 'peer', name: 'peer', granted: true, self: false }],",
    '        trust: window.__trust ? { url: ' + JSON.stringify(origin) + ', batches: 0 } : null,',
    '        trustTarget: window.__target,',
    '      },',
    '    });',
    '    return;',
    '  }',
    '  answer({ ok: true });',
    '};',
    driver('room'),
  ].join('\n');
}

function fieldPage(page) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
    page +
    '</title></head><body>' +
    '<input id="field" autocomplete="off" aria-label="Typing target">' +
    '<script>' +
    driver(page) +
    '</script></body></html>'
  );
}

// The panel is the real page and the real script. Only the browser API is a
// stub, and it answers the same messages the extension answers.
function panelPage(origin) {
  const roomUrl = `${origin}/room.html?room=check`;
  const targetUrl = `${origin}/target.html`;
  const stub = [
    '(function () {',
    '  var tabs = [',
    "    { id: 1, url: " + JSON.stringify(roomUrl) + ', active: false, currentWindow: true },',
    "    { id: 2, url: " + JSON.stringify(targetUrl) + ', active: true, currentWindow: true },',
    '  ];',
    '  function call(message) {',
    '    return new Promise(function (resolve) {',
    "      var channel = new BroadcastChannel('brosr-check');",
    "      var id = Math.random().toString(36).slice(2);",
    '      var timer = setTimeout(function () { channel.close(); resolve(null); }, 2500);',
    '      channel.onmessage = function (event) {',
    '        var data = event.data || {};',
    '        if (data.replyTo !== id) return;',
    '        clearTimeout(timer);',
    '        channel.close();',
    '        resolve(data.value);',
    '      };',
    "      channel.postMessage({ to: 'room', id: id, message: message });",
    '    });',
    '  }',
    '  window.browser = {',
    '    runtime: {',
    "      id: 'brosr-check',",
    '      getURL: function (value) { return new URL(String(value), location.origin).toString(); },',
    '      sendMessage: function (message) {',
    '        if (!message) return Promise.resolve({ ok: false });',
    "        if (message.type === 'brosr:room-tab') return Promise.resolve({ ok: true, tabId: 1 });",
    "        if (message.type === 'brosr:status') return call(message);",
    "        if (message.type === 'brosr:tabs-list') {",
    "          return Promise.resolve({ ok: true, role: 'host', canShare: true, tabs: [] });",
    '        }',
    '        return Promise.resolve({ ok: true });',
    '      },',
    '      onMessage: { addListener: function () {} },',
    '    },',
    '    tabs: {',
    '      query: function (filter) {',
    '        var list = filter && filter.active ? tabs.filter(function (tab) { return tab.active; }) : tabs;',
    '        return Promise.resolve(list.map(function (tab) { return Object.assign({}, tab); }));',
    '      },',
    '      getCurrent: function () {',
    '        return Promise.resolve({ id: 3, url: ' + JSON.stringify(`${origin}/panel.html`) + ' });',
    '      },',
    '      sendMessage: function (id, message) {',
    '        return id === 1 ? call(message) : Promise.resolve({ ok: false, reason: "no-tab" });',
    '      },',
    '      remove: function () { return Promise.resolve(); },',
    '    },',
    '    theme: {',
    '      getCurrent: function () { return Promise.resolve({ colors: {} }); },',
    '      onUpdated: { addListener: function () {} },',
    '    },',
    '  };',
    '})();',
  ].join('\n');
  return fs
    .readFileSync(PANEL_HTML, 'utf8')
    .replace(
      '<script src="room.js"></script>',
      `<script>${stub}</script><script src="room.js"></script><script>${driver('panel')}</script>`
    );
}

function serve() {
  const origin = { value: '' };
  const reports = new Map();
  const queues = new Map([
    ['panel', []],
    ['room', []],
    ['target', []],
  ]);
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (type, body, status = 200) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/report') {
      try {
        const body = JSON.parse(await readBody(req));
        if (body && body.page) reports.set(String(body.page), body);
      } catch {
        // A half written report is dropped. The next pass sends another.
      }
      send('application/json', '{"ok":true}');
      return;
    }
    if (url.pathname === '/next') {
      const list = queues.get(url.searchParams.get('page') || '') || [];
      send('application/json', JSON.stringify(list.shift() || {}));
      return;
    }
    if (url.pathname === '/panel.html') {
      send('text/html; charset=utf-8', panelPage(origin.value));
      return;
    }
    if (url.pathname === '/room.js') {
      send('text/javascript; charset=utf-8', fs.readFileSync(PANEL_JS));
      return;
    }
    if (url.pathname === '/room.css') {
      send('text/css; charset=utf-8', fs.readFileSync(PANEL_CSS));
      return;
    }
    if (url.pathname === '/room.html') {
      send(
        'text/html; charset=utf-8',
        '<!doctype html><html><head><meta charset="utf-8"><title>room</title></head><body>' +
          '<input id="field" autocomplete="off" aria-label="Typing target">' +
          '<script>' +
          roomScript(origin.value) +
          '</script></body></html>'
      );
      return;
    }
    if (url.pathname === '/target.html') {
      send('text/html; charset=utf-8', fieldPage('target'));
      return;
    }
    if (url.pathname === '/blank.html') {
      send(
        'text/html; charset=utf-8',
        '<!doctype html><html><body><p>No field here.</p><script>' +
          driver('blank') +
          '</script></body></html>'
      );
      return;
    }
    send('text/plain', 'not found', 404);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      origin.value = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, reports, queues, origin: origin.value });
    });
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
  let last = null;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  const detail = last ? `: ${last.message}` : '';
  throw new Error(`timed out waiting for ${label}${detail}`);
}

async function listenerOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function lastAgentPort(log) {
  const matches = [...log.matchAll(/agent for peer on http:\/\/127\.0\.0\.1:(\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : 0;
}

async function waitAgent(log, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const port = lastAgentPort(log());
    if (port && (await listenerOpen(port))) return port;
    await sleep(100);
  }
  throw new Error(`the helper agent is not listening. log: ${log().trim()}`);
}

async function type(port, value) {
  const res = await fetch(`http://127.0.0.1:${port}/action`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ records: [{ kind: 'text', value }] }),
  });
  return res.json();
}

async function main() {
  const binary = BROWSERS.find((file) => file && fs.existsSync(file));
  if (!binary) throw new Error('no Zen or Firefox build found. Set BROSR_CHECK_BROWSER');
  const profile = await mkdtemp(path.join(tmpdir(), 'brosr-trust-check-'));
  const board = await serve();
  const pagePort = new URL(board.origin).port;
  const debugPort = await freePort(9340);
  const targetUrl = `${board.origin}/target.html`;
  const roomUrl = `${board.origin}/room.html?room=check`;
  const panelUrl = `${board.origin}/panel.html`;
  const blankUrl = `${board.origin}/blank.html`;
  const result = { ok: false, browser: binary, pagePort, debugPort, steps: {} };
  let browser = null;
  let bidi = null;
  let helper = null;
  let helperLog = '';
  const log = () => helperLog;
  try {
    browser = spawn(
      binary,
      [
        '--profile',
        profile,
        '--no-remote',
        '--new-instance',
        '--remote-debugging-port',
        String(debugPort),
        '-headless',
        targetUrl,
        roomUrl,
        panelUrl,
      ],
      { stdio: 'ignore' }
    );
    bidi = await connect(debugPort);
    const findTab = async (url) => {
      const tree = await bidi.cmd('browsingContext.getTree', {});
      const want = new URL(url);
      return (
        (tree.contexts || []).find((item) => {
          try {
            const seen = new URL(item.url);
            return seen.origin === want.origin && seen.pathname === want.pathname;
          } catch {
            return false;
          }
        }) || null
      );
    };
    const openTab = async (url, name) => {
      let hit = await findTab(url).catch(() => null);
      if (hit) return hit.context;
      await waitFor(() => findTab(url), `the ${name} tab`, 6000);
      const created = await bidi.cmd('browsingContext.create', { type: 'tab' });
      await bidi.cmd('browsingContext.navigate', {
        context: created.context,
        url,
        wait: 'complete',
      });
      hit = await waitFor(() => findTab(url), `the created ${name} tab`);
      return hit.context;
    };
    const targetContext = await openTab(targetUrl, 'target');
    const roomContext = await openTab(roomUrl, 'room');
    const panelContext = await openTab(panelUrl, 'panel');
    result.steps.contexts = { targetContext, roomContext, panelContext };

    await waitFor(
      () => evaluate(bidi, panelContext, "Boolean(document.getElementById('trust-target'))"),
      'the panel switch'
    );
    await waitFor(
      () => evaluate(bidi, roomContext, "Boolean(document.documentElement.dataset.brosr)"),
      'the room grant'
    );

    await evaluate(
      bidi,
      targetContext,
      "document.getElementById('field').focus(); document.getElementById('field').value = ''; window.__keys = []; true"
    );

    let refusedWithoutGrant = false;
    try {
      await createTrustAgent({ bidi, context: targetContext });
    } catch {
      refusedWithoutGrant = true;
    }

    const agent = await createTrustAgent({
      bidi,
      context: targetContext,
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
        records: [{ kind: 'key', key: 't' }, { kind: 'text', value: 'rust' }],
      }),
    });
    result.steps.action = await typed.json();
    const seen = await waitFor(async () => {
      const value = await evaluate(
        bidi,
        targetContext,
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

    // The helper needs its own session: Firefox keeps one per browser. The tabs
    // stay open, and every later step drives them through the page server.
    await evaluate(
      bidi,
      targetContext,
      "document.getElementById('field').value = ''; window.__keys = []; true"
    );
    await bidi.cmd('session.end', {}).catch(() => {});
    bidi.close();
    bidi = null;

    helper = spawn(
      process.execPath,
      [HELPER, `--debug-port=${debugPort}`, '--room=check', `--token=${TOKEN}`],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    helper.stderr.on('data', (chunk) => {
      helperLog += String(chunk);
    });
    const exited = new Promise((resolve) => helper.once('exit', (code) => resolve(code)));

    await waitFor(() => /agent for peer on http:\/\/127\.0\.0\.1:\d+/.test(log()), 'the room agent', 30000);
    result.steps.helperStarted = true;

    // 1. The panel switch names the target tab. The real change handler asks the
    // browser for the active page and sends its URL to the room tab.
    board.queues.get('panel').push({ kind: 'tick', on: true });
    await waitFor(
      () => log().includes(`typing into ${targetUrl}`),
      'the helper to move to the target tab',
      15000
    );
    const targetPort = await waitAgent(log);
    result.steps.targetAgent = targetPort;

    result.steps.targetAction = await type(targetPort, 'trusted');
    const targetReport = await waitFor(() => {
      const report = board.reports.get('target');
      return report && report.field === 'trusted' ? report : null;
    }, 'the target field');
    const targetKeys = Array.isArray(targetReport.keys) ? targetReport.keys : [];
    const roomBefore = board.reports.get('room') || {};
    const panelReport = await waitFor(() => {
      const report = board.reports.get('panel');
      return report && report.checked === true ? report : null;
    }, 'the checked switch');
    result.steps.target = {
      field: targetReport.field,
      keys: targetKeys.length,
      trusted: targetKeys.filter((entry) => entry.trusted === true).length,
      roomField: roomBefore.field,
      panelNotice: panelReport.notice,
      targetNotice: log().includes(`typing into ${targetUrl}`),
    };

    // 2. The named tab goes away. The helper resolves it again and keeps the
    // room tab, so the next record still lands somewhere real.
    board.queues.get('target').push({ kind: 'navigate', url: blankUrl });
    await waitFor(
      () => /no tab shows .+typing into the room tab/.test(log()),
      'the fallback to the room tab',
      30000
    );
    const roomPort = await waitAgent(log);
    result.steps.fallbackAgent = roomPort;
    result.steps.fallback = await type(roomPort, 'fallback');
    const roomReport = await waitFor(() => {
      const report = board.reports.get('room');
      return report && report.field === 'fallback' ? report : null;
    }, 'the room field');
    const roomKeys = Array.isArray(roomReport.keys) ? roomReport.keys : [];
    result.steps.fallbackField = {
      field: roomReport.field,
      keys: roomKeys.length,
      trusted: roomKeys.filter((entry) => entry.trusted === true).length,
      logLine: /no tab shows .+typing into the room tab/.test(log()),
    };

    // 3. The switch turns off, then a room without a trusted channel refuses the
    // switch and the panel rolls the box back.
    board.queues.get('panel').push({ kind: 'tick', on: false });
    const offReport = await waitFor(() => {
      const report = board.reports.get('panel');
      return report && report.notice === 'Typing goes to the room tab.' ? report : null;
    }, 'the switch to turn off');
    result.steps.switchOff = { checked: offReport.checked, notice: offReport.notice };

    board.queues.get('room').push({ kind: 'trust', on: false });
    await sleep(900);
    board.queues.get('panel').push({ kind: 'tick', on: true });
    const refused = await waitFor(() => {
      const report = board.reports.get('panel');
      return report && report.checked === false && /trusted input first/i.test(report.notice || '')
        ? report
        : null;
    }, 'the switch to roll back');
    result.steps.switchRefused = { checked: refused.checked, notice: refused.notice };

    helper.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')]);
    const closedAfterStop = !(await listenerOpen(lastAgentPort(log())));
    result.steps.helper = {
      code,
      closedAfterStop,
      log: log().trim(),
    };

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
        targetReport.field === 'trusted' &&
        roomBefore.field === '' &&
        targetKeys.length > 0 &&
        targetKeys.every((entry) => entry.trusted === true) &&
        panelReport.notice &&
        // The panel labels a target by host and path, without the port.
        panelReport.notice.includes(
          new URL(targetUrl).hostname + new URL(targetUrl).pathname
        ) &&
        roomReport.field === 'fallback' &&
        roomKeys.length > 0 &&
        roomKeys.every((entry) => entry.trusted === true) &&
        offReport.checked === false &&
        refused.checked === false &&
        code !== 'timeout' &&
        closedAfterStop
    );
  } catch (error) {
    result.error = String((error && error.message) || error);
    if (helperLog) result.helperLog = helperLog.trim();
  } finally {
    if (helper) helper.kill('SIGKILL');
    if (bidi) bidi.close();
    if (browser) browser.kill('SIGTERM');
    board.server.close();
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
