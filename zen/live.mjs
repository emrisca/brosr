// Starts the relay and a headful Zen window on a persistent profile, installs
// the bridge, opens a host room and opens the room panel. It sends the real
// shortcut chord, so the sidebar opens expanded. If no sidebar report arrives,
// it falls back to a panel tab. Nothing is killed on the way out, so the window
// stays usable by hand. Pass --bridge=built to run the unsigned build in
// zen/.runtime/bridge.xpi instead of the signed copy.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { dockPanel } from './chrome.mjs';
import { BRIDGE_ID, bridgeSource, findZen, prepareProfile } from './profile.mjs';
import { readExtensions } from './safe-browsing.mjs';
import { newRoomKey } from '../core/seal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.join(here, '..', 'spike');
const runtime = path.join(here, '.runtime');

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const PROFILE = path.resolve(arg('profile', path.join(runtime, 'live-profile')));
// A build of the current tree can run before AMO signs it. The profile then
// carries no signature check, because the file is unsigned.
const BUILT = path.join(runtime, 'bridge.xpi');
const USE_BUILT = arg('bridge', 'auto') === 'built';
// The safe browsing pass opens its own headless window and fetches a list, so a
// quick lane can skip it and keep its marker out of a throwaway profile.
const CONFIGURE = !process.argv.includes('--no-configure');
const PORT = Number(arg('port', 9335));
const RELAY = Number(arg('relay', 8787));
const ROOM = arg('room', 'live');
const NAME = arg('name', 'Host');
// Each run mints its own room key, so every frame leaves this machine as
// ciphertext and the relay captures bytes it cannot read.
const ROOM_KEY = arg('key', '') || newRoomKey();
const MARIONETTE = Number(arg('marionette', 2828));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

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

// Marionette takes its port from the default and ignores a port argument, so a
// second window on this machine would die on a bind failure. A busy port means
// the dock is unavailable, not that the room cannot start.
function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (free) => {
      socket.destroy();
      resolve(free);
    };
    socket.once('connect', () => done(false));
    socket.once('error', () => done(true));
    socket.setTimeout(600, () => done(true));
  });
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

// extensions.json lands a moment after startup.
async function waitForAddon(id, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < end) {
    seen = readExtensions(PROFILE)[id] || null;
    if (seen && seen.active) return seen;
    await sleep(400);
  }
  return seen;
}

async function main() {
  const zen = findZen();
  if (!zen || !fs.existsSync(zen)) throw new Error('no Zen binary');
  fs.mkdirSync(runtime, { recursive: true });
  // The setup pass runs once per profile, so the room gets the extensions, the
  // list and the script without a manual step. The marker keeps later runs quick.
  const prepared = await prepareProfile(PROFILE, {
    configure: CONFIGURE,
    bridge: USE_BUILT && fs.existsSync(BUILT) ? BUILT : undefined,
    log: (line) => log('[live] ' + line),
  });
  // The profile writer copied the bridge before the window starts. Nothing is
  // installed over BiDi now, because a second copy would shadow the signed one.
  const bridge =
    USE_BUILT && fs.existsSync(BUILT)
      ? { name: path.basename(BUILT), path: BUILT, signed: false, signaturesRequired: false }
      : bridgeSource();
  log(
    '[live] bridge',
    JSON.stringify({
      name: bridge.name,
      version: bridge.version,
      signed: bridge.signed,
      want: bridge.want,
      stale: bridge.stale,
      signaturesRequired: bridge.signaturesRequired,
    })
  );

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

  const marionetteFree = await portFree(MARIONETTE);
  const browserArgs = [
    '--profile',
    PROFILE,
    '--no-remote',
    '--new-instance',
    '--remote-debugging-port',
    String(PORT),
  ];
  if (marionetteFree) browserArgs.push('--marionette');
  browserArgs.push('--width', '1440', '--height', '900', 'about:blank');

  const browser = spawn(
    zen,
    browserArgs,
    {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  );
  browser.unref();

  let result = {
    relay: { pid: relay ? relay.pid : null, reused: !relay, port: RELAY },
    browser: {
      pid: browser.pid,
      port: PORT,
      marionette: MARIONETTE,
      profile: PROFILE,
      blocker: prepared.blocker,
    },
    bridge: null,
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
    // The dock is a nicety. A window without Marionette still gets the room and
    // the panel, so a refused dock records the error instead of ending the run.
    const dock = marionetteFree
      ? await dockPanel({ port: MARIONETTE, open: true }).catch((error) => ({
          injected: false,
          geometry: null,
          error: error.message,
        }))
      : { injected: false, geometry: null, error: `marionette port ${MARIONETTE} is busy` };
    result.dock = dock;
    log('[live] dock', JSON.stringify(dock));

    const bidi = await connect();
    // The window reads the add-on from the profile at startup, so this reads what
    // the browser wrote rather than asking for an install that could replace it.
    const addon = await waitForAddon(BRIDGE_ID, 20000);
    result.bridge = addon;
    log('[live] bridge state', JSON.stringify(addon));

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
    // The key rides in the fragment. The relay logs the request line, so a key
    // in the query string would land in its log and in any proxy on the way.
    // The panel flag goes before the fragment, or it would join the key.
    const invite = `${base}#k=${encodeURIComponent(ROOM_KEY)}`;
    const panelInvite = `${base}&panel=1#k=${encodeURIComponent(ROOM_KEY)}`;
    // The room tab opens as a normal tab. The chord below opens the sidebar
    // beside it, which is the surface this run is proving.
    await bidi.cmd('browsingContext.navigate', {
      context,
      url: invite,
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
    result.room = {
      context,
      url: base,
      invite,
      sealed: Boolean(roomData.seal && roomData.seal.mode === 'on'),
      peers: roomData.peerList || roomData.peers || null,
    };

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
      if (state && state.visible === 'visible') {
        // A live sidebar can report zero width until Zen expands it, so a live
        // state is enough to accept the panel. The route says how it got here.
        if (state.state === 'live' || Number(state.width) > 100) {
          panel = state;
          mode = state.surface || (Number(state.width) > 700 ? 'tab' : 'window');
          if (state.state === 'live') break;
        }
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
        url: panelInvite,
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
    log('[live] uBlock Origin', prepared.blocker ? 'installed' : 'missing');
  log('[live] zen pid', browser.pid, 'port', PORT);
    log('[live] room', base);
    log('[live] sealed invite', invite);
    if (result.panel && result.panel.mode === 'window') {
      log(
        '[live] panel window',
        JSON.stringify({
          width: result.panel.width,
          height: result.panel.height,
          surface: result.panel.surface || null,
          route: result.panel.route || null,
          geometry: result.panel.geometry || null,
        })
      );
      log('[live] the room window is open. The browser stays usable by hand.');
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
