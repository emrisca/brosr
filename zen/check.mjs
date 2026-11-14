// Headless proof that a room runs inside Zen. Starts the spike relay, builds
// the bridge with the room panel, installs it over WebDriver BiDi, reads the
// dataset and then checks the panel's own render report and grant action.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { makeZip } from '../spike/zip.mjs';
import { findZen, writeProfile } from './profile.mjs';
import { dockPanel } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.join(here, '..', 'spike');
const core = path.join(here, '..', 'core');
const runtime = path.join(here, '.runtime');
const PORT = Number(process.env.BROSR_ZEN_BIDI || 9334);
const MARIONETTE = Number(process.env.BROSR_ZEN_MARIONETTE || 2834);
const RELAY = 8787;
const PEER = 'p2';
const PEER_NAME = 'Peer Two';

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

// Zen starts child processes that outlive the parent. taskkill /T takes the
// whole tree, so a headless run leaves no browser behind.
function killTree(child) {
  if (!child) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

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
  const out = path.join(runtime, 'bridge-zen.xpi');
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

function readIni(zen) {
  for (const base of [path.dirname(zen), path.join(path.dirname(zen), '..')]) {
    const file = path.join(base, 'application.ini');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const grab = (key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] || null;
    return {
      version: grab('Version'),
      buildId: grab('BuildID'),
      source: grab('SourceStamp'),
      engine: grab('MinVersion'),
    };
  }
  return { version: null, buildId: null, source: null, engine: null };
}

async function waitHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${RELAY}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }
  throw new Error('relay did not answer on 8787');
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

async function readDataset(bidi, context) {
  const raw = await evaluate(
    bidi,
    context,
    'JSON.stringify({ data: document.documentElement.dataset.brosr || "", error: document.documentElement.dataset.brosrError || "" })'
  );
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error('core error: ' + parsed.error);
  return parsed.data ? JSON.parse(parsed.data) : null;
}

async function waitForDataset(bidi, context, predicate, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await readDataset(bidi, context).catch(() => null);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  return last;
}

// The panel reports itself through the background page, and the content
// script copies that report into the dataset. The grant arrives last, so that
// is the condition to wait for.
async function readPanel(bidi, panelContext) {
  const raw = await evaluate(
    bidi,
    panelContext,
    "JSON.stringify({ notice: document.getElementById('notice').textContent, control: !document.getElementById('control').hidden, names: [...document.querySelectorAll('#peers .name')].map((node) => node.textContent), grantedPeers: [...document.querySelectorAll('#peers li')].filter((node) => node.dataset.granted === '1').map((node) => node.dataset.peer), history: [...document.querySelectorAll('#history li')].map((node) => node.textContent), state: document.getElementById('dot').dataset.state, room: document.getElementById('room').textContent })"
  );
  return raw ? JSON.parse(raw) : null;
}

async function waitPanelReady(bidi, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tree = await bidi.cmd('browsingContext.getTree', {}).catch(() => null);
    const panel =
      tree && tree.contexts.find((item) => String(item.url || '').includes('/panel/room.html'));
    if (panel) {
      await bidi.cmd('browsingContext.activate', { context: panel.context }).catch(() => {});
      await evaluate(bidi, panel.context, "document.getElementById('refresh').click(); true").catch(
        () => {}
      );
      const state = await readPanel(bidi, panel.context).catch(() => null);
      if (state && state.control && state.names.some((name) => String(name).includes(PEER_NAME))) {
        return panel.context;
      }
    }
    await sleep(400);
  }
  return null;
}

async function waitPanelNotice(bidi, panelContext, phrase, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await readPanel(bidi, panelContext).catch(() => null);
    if (last && String(last.notice).includes(phrase)) return last;
    await sleep(300);
  }
  return null;
}

// The dock runs in chrome scope. This build stops BiDi from reading tab
// content while the Marionette listener runs, so the dock gets a window of its
// own. The stock bookmarks sidebar fills the same box as the room panel, and
// the BiDi run above proves the panel content.
async function probeDock(zen) {
  const dir = path.join(runtime, 'dock-profile');
  fs.rmSync(dir, { recursive: true, force: true });
  const profile = writeProfile(dir);
  fs.appendFileSync(
    path.join(profile, 'user.js'),
    `user_pref("marionette.port", ${MARIONETTE});\n`
  );
  const browser = spawn(
    zen,
    [
      '--profile',
      profile,
      '--no-remote',
      '--new-instance',
      '--headless',
      '--marionette',
      '--width',
      '1280',
      '--height',
      '900',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, MOZ_HEADLESS: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  );
  const dock = {
    injected: false,
    geometry: null,
    sidebar: 'viewBookmarksSidebar',
    hidden: null,
    restored: null,
    error: null,
  };
  try {
    const probe = await dockPanel({
      port: MARIONETTE,
      open: true,
      sidebarId: 'viewBookmarksSidebar',
      // The chip shows only while the panel is shut, so the probe shuts the
      // sidebar and clicks the chip in the same session.
      after: [
        { script: 'return (window.__brosrHidePanel ? window.__brosrHidePanel() : "")', wait: 0 },
        { script: 'return (window.__brosrDock ? window.__brosrDock() : null)', wait: 800 },
        {
          script: 'return (window.__brosrClickToggle ? window.__brosrClickToggle() : false)',
          wait: 0,
        },
        { script: 'return (window.__brosrDock ? window.__brosrDock() : null)', wait: 1200 },
      ],
    });
    if (!probe.ok) {
      dock.error = probe.error || 'the dock script did not run';
      return dock;
    }
    dock.injected = true;
    dock.geometry = probe.result || null;
    const g = dock.geometry;
    if (!g || typeof g !== 'object') dock.error = 'the dock script returned no state';
    else if (!g.docked) dock.error = 'the panel is not docked';
    else if (!g.open) dock.error = 'the sidebar did not open';
    else if (!(g.inset > 0)) dock.error = 'the dock reports no inset';
    else if (Math.abs(g.x - g.inset) > 2) dock.error = `the panel starts at x=${g.x}`;
    else if (!String(g.radius || '').startsWith('8')) dock.error = `the panel corner is ${g.radius}`;
    else if (g.surface !== 'rgba(0, 0, 0, 0)') dock.error = `the box paints over the card: ${g.surface}`;
    else if (g.panelWidth < 300) dock.error = `the panel is ${g.panelWidth} wide`;
    else if (g.panelHeight < 120) dock.error = `the panel is ${g.panelHeight} tall`;
    else if (!g.bar) dock.error = 'the drag bar is missing';
    const steps = Array.isArray(probe.steps) ? probe.steps : [];
    dock.hidden = steps[1] || null;
    dock.restored = steps[3] || null;
    if (!dock.error && dock.hidden) {
      if (dock.hidden.open) dock.error = 'the sidebar did not hide';
      else if (!dock.hidden.toggle) dock.error = 'the show chip stayed hidden';
    }
    if (!dock.error && !dock.restored) dock.error = 'the show chip did not answer';
    else if (!dock.error && !dock.restored.open) {
      dock.error = 'the show chip did not open the sidebar';
    }
    return dock;
  } finally {
    killTree(browser);
  }
}

async function main() {
  const zen = findZen() || arg('zen', '');
  if (!zen || !fs.existsSync(zen)) throw new Error('no Zen binary. Pass --zen=<path>.');
  const info = readIni(zen);
  // A reused profile restores the room and panel tabs from the last run, and
  // their panels drive control too. The default profile is disposable.
  const givenProfile = arg('profile', '');
  if (!givenProfile) fs.rmSync(path.join(runtime, 'profile'), { recursive: true, force: true });
  const profile = writeProfile(givenProfile || path.join(runtime, 'profile'));
  const xpi = buildXpi();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(spike, 'bridge', 'manifest.json'), 'utf8')
  );
  if (!manifest.sidebar_action || manifest.sidebar_action.default_panel !== 'panel/room.html') {
    throw new Error('the manifest does not declare the room sidebar');
  }
  if (manifest.browser_action && manifest.browser_action.default_popup) {
    throw new Error('the toolbar still opens a popup');
  }
  const background = fs.readFileSync(path.join(spike, 'bridge', 'background.js'), 'utf8');
  if (!background.includes('browserAction.onClicked') || !background.includes('sidebarAction') || !background.includes('openRoomPanel')) {
    throw new Error('the toolbar does not open the sidebar');
  }
  if (!manifest.commands || !manifest.commands['open-room-panel']) {
    throw new Error('the manifest does not declare the panel shortcut');
  }
  if (!background.includes('commands.onCommand')) {
    throw new Error('the background page does not handle the shortcut');
  }
  log('[zen] binary', zen, `(${info.version || 'unknown'})`);

  const relay = spawn(process.execPath, ['relay.js'], { cwd: spike, stdio: 'ignore' });
  const browser = spawn(
    zen,
    [
      '--profile',
      profile,
      '--no-remote',
      '--new-instance',
      '--headless',
      '--remote-debugging-port',
      String(PORT),
      '--width',
      '1280',
      '--height',
      '900',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, MOZ_HEADLESS: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  );

  let result = { zen: info, check: { ok: false, error: 'not run' }, dataset: null, panel: null };
  try {
    await waitHealth();
    const bidi = await connect();
    const installed = await bidi.cmd('webExtension.install', {
      extensionData: { type: 'archivePath', path: xpi },
    });
    log('[zen] installed', installed.extension);

    // The first context is not always a real tab, and the extension cannot see
    // a windowless one. Create a tab so sender.tab exists for the panel.
    const created = await bidi.cmd('browsingContext.create', { type: 'tab' });
    const context = created.context;
    const room = arg('room', 'zen');
    const url = `http://127.0.0.1:${RELAY}/room-b.html?role=host&room=${room}&peer=host&name=Host&panel=1`;
    await bidi.cmd('browsingContext.navigate', { context, url, wait: 'complete' });

    const data = await waitForDataset(bidi, context, (d) => d.socket === 1);
    if (!data) throw new Error('no dataset from the content script');
    if (data.source !== 'content-script') throw new Error(`source was ${data.source}`);
    if (data.socket !== 1) throw new Error(`socket was ${data.socket}`);
    if (!data.panelUrl) throw new Error('the content script did not publish a panel URL');


    // A real second peer joins the room, so the grant has a receiver.
    const peerContext = (await bidi.cmd('browsingContext.create', { type: 'tab' })).context;
    log('[zen] tabs', JSON.stringify({ host: context, peer: peerContext }));
    const peerUrl = `http://127.0.0.1:${RELAY}/room-b.html?role=peer&room=${room}&peer=${PEER}&name=${encodeURIComponent(PEER_NAME)}`;
    await bidi.cmd('browsingContext.navigate', {
      context: peerContext,
      url: peerUrl,
      wait: 'complete',
    });
    const joined = await waitForDataset(
      bidi,
      context,
      (d) =>
        Number(d.peers) >= 2 &&
        Array.isArray(d.peerList) &&
        d.peerList.some((peer) => peer.id === PEER),
      30000
    );
    if (!joined || !Array.isArray(joined.peerList)) {
      const peerState = await readDataset(bidi, peerContext).catch(() => null);
      throw new Error(
        'the host never saw the second peer. peer=' +
          JSON.stringify(peerState && { socket: peerState.socket, error: peerState.error })
      );
    }

    const panelContext = await waitPanelReady(bidi);
    if (!panelContext) throw new Error('the panel did not render the peer list');

    await evaluate(
      bidi,
      panelContext,
      `document.querySelector('#peers li[data-peer="${PEER}"] .peer-control').click(); true`
    );
    const grantedPanel = await waitPanelNotice(bidi, panelContext, 'Control granted');
    if (!grantedPanel) throw new Error('the panel did not report a grant');
    if (!grantedPanel.control) throw new Error('the host controls are hidden');
    if (!grantedPanel.names.some((name) => String(name).includes(PEER_NAME))) {
      throw new Error(`the panel did not list ${PEER_NAME}`);
    }
    if (!Array.isArray(grantedPanel.grantedPeers) || !grantedPanel.grantedPeers.includes(PEER)) {
      throw new Error(`the panel did not mark ${PEER} as controlled`);
    }
    if (
      !Array.isArray(grantedPanel.history) ||
      !grantedPanel.history.some((row) => row.includes(PEER) && row.includes('granted'))
    ) {
      throw new Error('the panel history did not record the grant');
    }

    const peerGranted = await waitForDataset(bidi, peerContext, (d) => d.granted === true, 20000);
    if (!peerGranted || peerGranted.granted !== true) {
      throw new Error('the peer did not receive control');
    }
    const hostGranted = await waitForDataset(
      bidi,
      context,
      (d) =>
        Array.isArray(d.peerList) &&
        d.peerList.some((peer) => peer.id === PEER && peer.granted === true),
      20000
    );
    if (!hostGranted) throw new Error('the host did not record the grant');

    await evaluate(
      bidi,
      panelContext,
      `document.querySelector('#peers li[data-peer="${PEER}"] .peer-control').click(); true`
    );
    const revokedPanel = await waitPanelNotice(bidi, panelContext, 'Control revoked');
    if (!revokedPanel) throw new Error('the panel did not report a revoke');
    if (!Array.isArray(revokedPanel.grantedPeers) || revokedPanel.grantedPeers.includes(PEER)) {
      throw new Error(`the panel still marks ${PEER} as controlled`);
    }
    if (
      !Array.isArray(revokedPanel.history) ||
      !revokedPanel.history.some((row) => row.includes(PEER) && row.includes('revoked'))
    ) {
      throw new Error('the panel history did not record the revoke');
    }
    const peerRevoked = await waitForDataset(bidi, peerContext, (d) => d.granted === false, 20000);
    if (!peerRevoked || peerRevoked.granted !== false) {
      throw new Error('the peer kept control after the revoke');
    }

    const shortcut = { key: 'Ctrl+Alt+B', proven: false, reason: 'headless run' };

    result = {
      zen: info,
      check: { ok: true, error: null },
      dataset: {
        socket: data.socket,
        source: data.source,
        elapsed: data.elapsed,
        location: data.location,
        peers: Number.isFinite(data.peers)
          ? data.peers
          : Array.isArray(data.peers)
            ? data.peers.length
            : null,
      },
      peer: {
        id: PEER,
        name: PEER_NAME,
        joined: joined.peerList.some((peer) => peer.id === PEER),
        granted: peerGranted.granted,
        revoked: peerRevoked.granted,
        controls: peerRevoked.controls,
      },
      shortcut,
      dock: null,
      panel: {
        state: grantedPanel.state,
        room: grantedPanel.room,
        control: grantedPanel.control,
        peers: revokedPanel.names,
        grantedPeers: revokedPanel.grantedPeers,
        grantedNotice: grantedPanel.notice,
        notice: revokedPanel.notice,
      },
    };
    log('[zen] room live:', JSON.stringify(result.dataset));
    log('[zen] panel:', JSON.stringify(result.panel));
  } catch (error) {
    result.check.error = error.message;
    log('[zen] failed:', error.message);
  } finally {
    killTree(browser);
    killTree(relay);
    await sleep(300);
  }

  if (result.check.ok) {
    result.dock = await probeDock(zen);
    if (result.dock.error) {
      result.check.ok = false;
      result.check.error = 'dock: ' + result.dock.error;
    }
    log('[zen] dock', JSON.stringify(result.dock));
  }

  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, 'results.json'),
    JSON.stringify({ when: new Date().toISOString(), ...result }, null, 2) + '\n'
  );
  process.exit(result.check.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[zen]', error.message);
  process.exit(1);
});
