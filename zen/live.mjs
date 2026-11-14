// Starts the relay and a headful Zen window on a persistent profile, installs
// the bridge, opens a host room and opens the room panel. It sends the real
// shortcut chord, so the sidebar opens expanded. If no sidebar report arrives,
// it falls back to a panel tab. Nothing is killed on the way out, so the window
// stays usable by hand.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { makeZip } from '../spike/zip.mjs';
import { dockPanel } from './chrome.mjs';
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
const MARIONETTE = Number(arg('marionette', 2828));
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

function keypostPath() {
  // The panel shortcut is a browser command, so only a real chord opens the
  // sidebar. This helper posts that chord to the exact process id.
  if (process.platform !== 'darwin') return null;
  const source = path.join(here, 'keypost.swift');
  const out = path.join(runtime, 'keypost');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(source).mtimeMs) return out;
  fs.mkdirSync(runtime, { recursive: true });
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

function postChord(pid) {
  const helper = keypostPath();
  if (!helper) return { ok: false, out: '', err: 'no keypost helper' };
  const res = spawnSync(helper, ['chord', String(pid)], { encoding: 'utf8', timeout: 20000 });
  return {
    ok: res.status === 0,
    out: String(res.stdout || '').trim(),
    err: String(res.stderr || '').trim(),
  };
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
      '--marionette',
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
    browser: { pid: browser.pid, port: PORT, marionette: MARIONETTE, profile: PROFILE },
    room: null,
    panel: null,
    affordance: null,
    dock: null,
  };

  try {
    // The tab column and the panel are chrome elements, so the stacking and
    // the drag bar go in through Marionette. Its session replaces the first
    // window, so it runs before any browsing context is chosen. The injected
    // script polls, so it docks the panel as soon as the sidebar opens.
    const dock = await dockPanel({ port: MARIONETTE });
    result.dock = dock;
    log('[live] dock', JSON.stringify(dock));

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
    const base =
      `http://127.0.0.1:${RELAY}/room-b.html?role=host&room=${encodeURIComponent(ROOM)}` +
      `&peer=host&name=${encodeURIComponent(NAME)}`;
    // The room tab opens as a normal tab. The chord below opens the sidebar
    // beside it, which is the surface this launcher is proving.
    await bidi.cmd('browsingContext.navigate', {
      context,
      url: base,
      wait: 'complete',
    });

    const readDataset = async () => {
      const raw = await evaluate(
        bidi,
        context,
        'document.documentElement.dataset.brosr || ""'
      ).catch(() => '');
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    let roomData = null;
    for (let i = 0; i < 100 && !roomData; i += 1) {
      const parsed = await readDataset();
      if (parsed && parsed.socket === 1) roomData = parsed;
      if (!roomData) await sleep(300);
    }
    if (!roomData) throw new Error('the room tab did not connect');
    result.room = { context, url: base, peers: roomData.peerList || roomData.peers || null };

    // The page carries the button whether or not its click is driven here.
    const affordance = await evaluate(
      bidi,
      context,
      `(() => {
        const button = document.getElementById('brosr-panel-button');
        return JSON.stringify({ present: Boolean(button), label: button ? button.textContent : null });
      })()`
    ).catch(() => null);
    result.affordance = affordance ? JSON.parse(affordance) : { present: false };
    log('[live] affordance', JSON.stringify(result.affordance));

    const chord = postChord(browser.pid);
    result.chord = chord;
    log('[live] chord', JSON.stringify(chord));

    const findPanelTab = async () => {
      const now = await bidi.cmd('browsingContext.getTree', {});
      return (
        now.contexts.find((item) => String(item.url || '').includes('/panel/room.html')) || null
      );
    };

    // The panel reports its own width and visibility. A sidebar is at most 500
    // pixels, so a wider report means the panel opened as a tab.
    let panel = null;
    let mode = null;
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const state = (await readDataset())?.panelState;
      if (state && state.visible === 'visible' && Number(state.width) > 100) {
        panel = state;
        mode = Number(state.width) > 700 ? 'tab' : 'sidebar';
        if (state.state === 'live') break;
      }
      await sleep(300);
    }

    if (panel) {
      result.panel = { mode, ...panel };
      log('[live] panel', JSON.stringify(result.panel));
      // Leave the panel in front only when it is a tab. A sidebar stays open
      // beside the room tab.
      if (mode === 'tab') {
        const tab = await findPanelTab();
        if (tab) await bidi.cmd('browsingContext.activate', { context: tab.context }).catch(() => {});
      }
    } else {
      log('[live] no sidebar report, opening the panel as a tab');
      await bidi.cmd('browsingContext.navigate', {
        context,
        url: `${base}&panel=1`,
        wait: 'complete',
      });
      let panelContext = null;
      for (let i = 0; i < 40 && !panelContext; i += 1) {
        const tab = await findPanelTab();
        if (tab) panelContext = tab.context;
        else await sleep(300);
      }
      if (panelContext) {
        await bidi.cmd('browsingContext.activate', { context: panelContext }).catch(() => {});
        await sleep(200);
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
              height: innerHeight,
              overflow: [...document.querySelectorAll('li')].filter((row) => row.scrollWidth > row.clientWidth + 1).length,
            });
          })()`
        );
        result.panel = { context: panelContext, mode: 'tab', ...JSON.parse(raw) };
        log('[live] panel', JSON.stringify(result.panel));
      } else {
        log('[live] panel context not found. Click the Room panel button in the page.');
      }
    }

    fs.writeFileSync(
      path.join(runtime, 'live.json'),
      JSON.stringify({ when: new Date().toISOString(), ...result }, null, 2) + '\n'
    );
    log('[live] relay', result.relay.reused ? 'reused' : `pid ${result.relay.pid}`);
    log('[live] zen pid', browser.pid, 'port', PORT);
    log('[live] room', base);
    if (result.panel && result.panel.mode === 'sidebar') {
      log('[live] the expanded sidebar is open. The window stays usable by hand.');
    } else {
      log('[live] window left running. Click Room panel or press Ctrl+Alt+B.');
    }
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
