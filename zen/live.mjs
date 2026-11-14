// Starts the relay and a headful Zen window on a persistent profile, installs
// the bridge, opens a host room, and then exits. Nothing is killed on the way
// out, so the panel stays usable by hand.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { makeZip } from '../spike/zip.mjs';
import { findZen, writeProfile } from './profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.join(here, '..', 'spike');
const core = path.join(here, '..', 'core');
const runtime = path.join(here, '.runtime');
const PROFILE = path.join(runtime, 'live-profile');

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const PORT = Number(arg('port', 9335));
const RELAY = Number(arg('relay', 8787));
const ROOM = arg('room', 'live');
const NAME = arg('name', 'Host');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

const CORE = [
  'protocol.mjs',
  'clock.mjs',
  'drift.mjs',
  'media.mjs',
  'room.mjs',
  'overlay.mjs',
  'input.mjs',
  'sync.mjs',
  'browser-entry.mjs',
  'youtube.mjs',
];

function buildXpi() {
  fs.mkdirSync(runtime, { recursive: true });
  const out = path.join(runtime, 'bridge-live.xpi');
  const panel = ['room.html', 'room.css', 'room.js'];
  fs.writeFileSync(
    out,
    makeZip([
      { name: 'manifest.json', data: fs.readFileSync(path.join(spike, 'bridge', 'manifest.json')) },
      { name: 'content.js', data: fs.readFileSync(path.join(spike, 'bridge', 'content.js')) },
      {
        name: 'background.js',
        data: fs.readFileSync(path.join(spike, 'bridge', 'background.js')),
      },
      ...CORE.map((name) => ({ name: `core/${name}`, data: fs.readFileSync(path.join(core, name)) })),
      ...panel.map((name) => ({
        name: `panel/${name}`,
        data: fs.readFileSync(path.join(here, 'panel', name)),
      })),
    ])
  );
  return out;
}

// The chord is the only way to open the real sidebar, because the panel tab
// path in background.js is a fallback. The helper activates the pid and posts
// a trusted chord to it.
function keypostPath() {
  if (process.platform !== 'darwin') return null;
  const source = path.join(here, 'keypost.swift');
  const out = path.join(runtime, 'keypost');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(source).mtimeMs) return out;
  const build = spawnSync('swiftc', ['-parse-as-library', '-O', source, '-o', out], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (build.status !== 0) {
    log('[live] keypost build failed', String(build.stderr || '').trim().slice(0, 300));
    return null;
  }
  return out;
}

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${RELAY}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealth(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await healthy()) return;
    await sleep(100);
  }
  throw new Error(`relay did not answer on ${RELAY}`);
}

async function connect(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${PORT}/session`).connect();
    } catch (error) {
      last = error;
      await sleep(400);
    }
  }
  throw new Error(`no BiDi on ${PORT}: ${last ? last.message : 'unknown'}`);
}

async function evaluate(bidi, context, expression) {
  const res = await bidi.cmd('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  if (res.type === 'exception') {
    throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  }
  return res.result ? res.result.value : undefined;
}

async function main() {
  const zen = findZen();
  if (!zen || !fs.existsSync(zen)) throw new Error('no Zen binary');
  fs.mkdirSync(runtime, { recursive: true });
  writeProfile(PROFILE);
  const xpi = buildXpi();

  let relay = null;
  if (!(await healthy())) {
    relay = spawn(process.execPath, ['relay.js'], {
      cwd: spike,
      stdio: 'ignore',
      detached: true,
    });
    relay.unref();
    await waitHealth();
  }

  const browser = spawn(
    zen,
    [
      '--profile',
      PROFILE,
      '--no-remote',
      '--new-instance',
      '--remote-debugging-port',
      String(PORT),
      '--width',
      '1440',
      '--height',
      '900',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  );
  browser.unref();

  let result = {
    relay: { pid: relay ? relay.pid : null, reused: !relay, port: RELAY },
    browser: { pid: browser.pid, port: PORT, profile: PROFILE },
    room: null,
    panel: null,
  };

  try {
    const bidi = await connect();
    await bidi
      .cmd('webExtension.install', { extensionData: { type: 'archivePath', path: xpi } })
      .then((installed) => log('[live] installed', installed.extension))
      .catch((error) => log('[live] install skipped', error.message));

    // Headful create hangs on this build, so reuse the window's own tab.
    const tree = await bidi.cmd('browsingContext.getTree', {});
    if (!tree.contexts.length) throw new Error('no window context');
    const views = [];
    for (const item of tree.contexts) {
      const visibility = await evaluate(bidi, item.context, 'document.visibilityState').catch(
        () => 'unknown'
      );
      views.push({ id: item.context, url: item.url, visibility });
    }
    log('[live] contexts', JSON.stringify(views));
    const context = (views.find((item) => item.visibility === 'visible') || views[0]).id;
    const url =
      `http://127.0.0.1:${RELAY}/room-b.html?role=host&room=${encodeURIComponent(ROOM)}` +
      `&peer=host&name=${encodeURIComponent(NAME)}`;
    await bidi.cmd('browsingContext.navigate', { context, url, wait: 'complete' });

    let roomData = null;
    for (let i = 0; i < 100 && !roomData; i += 1) {
      const raw = await evaluate(
        bidi,
        context,
        'document.documentElement.dataset.brosr || ""'
      ).catch(() => '');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.socket === 1) roomData = parsed;
        } catch {
          // Mid-write.
        }
      }
      if (!roomData) await sleep(300);
    }
    if (!roomData) throw new Error('the room tab did not connect');
    result.room = { context, url, peers: roomData.peerList || roomData.peers || null };

    const helper = keypostPath();
    if (helper) {
      const sent = spawnSync(helper, ['chord', String(browser.pid)], {
        encoding: 'utf8',
        timeout: 20000,
      });
      log('[live] chord', sent.status, String(sent.stdout || '').trim(), String(sent.stderr || '').trim());
      result.chord = { status: sent.status, out: String(sent.stdout || '').trim() };
    }
    await sleep(1500);

    const findPanel = async (tries) => {
      for (let i = 0; i < tries; i += 1) {
        const now = await bidi.cmd('browsingContext.getTree', {});
        const panel = now.contexts.find((item) =>
          String(item.url || '').includes('/panel/room.html')
        );
        if (panel) return panel.context;
        await sleep(300);
      }
      return null;
    };
    let panelContext = await findPanel(40);
    let openedTab = false;
    if (!panelContext) {
      // A sidebar can open without a listed context. The panel tab gives an
      // extension page to ask from, and it is the visible fallback.
      log('[live] no sidebar context. Opening the panel as a tab.');
      await bidi.cmd('browsingContext.navigate', {
        context,
        url: `${url}&panel=1`,
        wait: 'complete',
      });
      panelContext = await findPanel(40);
      openedTab = Boolean(panelContext);
    }
    if (panelContext) {
      const raw = await evaluate(
        bidi,
        panelContext,
        `(async () => {
          let open = null;
          try {
            open = await browser.sidebarAction.isOpen({});
          } catch (error) {
            open = 'error: ' + error.message;
          }
          return JSON.stringify({
            open,
            visible: document.visibilityState,
            status: document.getElementById('status').textContent,
            room: document.getElementById('room').textContent,
            peers: [...document.querySelectorAll('#peers .name')].map((node) => node.textContent),
            latency: [...document.querySelectorAll('#peers .latency')].map((node) => node.textContent),
            mode: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            width: innerWidth,
            overflow: [...document.querySelectorAll('li')].filter((row) => row.scrollWidth > row.clientWidth + 1).length,
          });
        })()`
      );
      const state = JSON.parse(raw);
      result.panel = { context: panelContext, ...state, openedTab };
      log('[live] panel', JSON.stringify(result.panel));
      if (state.open === true && openedTab) {
        // The sidebar is the real surface, so drop the helper tab.
        await bidi.cmd('browsingContext.close', { context: panelContext }).catch(() => {});
      }
      const front = state.open === true ? context : panelContext;
      await bidi.cmd('browsingContext.activate', { context: front }).catch(() => {});
    } else {
      log('[live] panel context not found. Press Ctrl+Alt+B to open it.');
    }

    fs.writeFileSync(
      path.join(runtime, 'live.json'),
      JSON.stringify({ when: new Date().toISOString(), ...result }, null, 2) + '\n'
    );
    log('[live] relay', result.relay.reused ? 'reused' : `pid ${result.relay.pid}`);
    log('[live] zen pid', browser.pid, 'port', PORT);
    log('[live] room', url);
    log('[live] window left running. Ctrl+Alt+B opens the panel.');
    process.exit(0);
  } catch (error) {
    log('[live] failed:', error.message);
    fs.writeFileSync(
      path.join(runtime, 'live.json'),
      JSON.stringify({ when: new Date().toISOString(), ...result, error: error.message }, null, 2) +
        '\n'
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[live]', error.message);
  process.exit(1);
});
