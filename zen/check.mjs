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

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.join(here, '..', 'spike');
const core = path.join(here, '..', 'core');
const runtime = path.join(here, '.runtime');
const PORT = Number(process.env.BROSR_ZEN_BIDI || 9334);
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
async function waitForPanel(bidi, context, phrase, timeoutMs = 40000, extra = () => true) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    const data = await readDataset(bidi, context).catch(() => null);
    last = data && data.panelState ? data.panelState : null;
    if (last && last.notice && String(last.notice).includes(phrase) && extra(last)) return last;
    await sleep(300);
  }
  return last;
}

async function main() {
  const zen = findZen() || arg('zen', '');
  if (!zen || !fs.existsSync(zen)) throw new Error('no Zen binary. Pass --zen=<path>.');
  const info = readIni(zen);
  const profile = writeProfile(arg('profile', path.join(runtime, 'profile')));
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
    { stdio: 'ignore', env: { ...process.env, MOZ_HEADLESS: '1' } }
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
    const url = `http://127.0.0.1:${RELAY}/room-b.html?role=host&room=${room}&peer=host&name=Host&panel=1&selftest=1`;
    await bidi.cmd('browsingContext.navigate', { context, url, wait: 'complete' });

    const data = await waitForDataset(bidi, context, (d) => d.socket === 1);
    if (!data) throw new Error('no dataset from the content script');
    if (data.source !== 'content-script') throw new Error(`source was ${data.source}`);
    if (data.socket !== 1) throw new Error(`socket was ${data.socket}`);
    if (!data.panelUrl) throw new Error('the content script did not publish a panel URL');


    // A real second peer joins the room, so the grant has a receiver.
    const peerContext = (await bidi.cmd('browsingContext.create', { type: 'tab' })).context;
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
      throw new Error('the host never saw the second peer');
    }

    const granted = await waitForPanel(
      bidi,
      context,
      'Control granted',
      40000,
      (panel) => Array.isArray(panel.grantedPeers) && panel.grantedPeers.includes(PEER)
    );
    if (!granted) throw new Error('the panel did not report a grant');
    if (granted.state !== 'live') throw new Error(`panel state was ${granted.state}`);
    if (granted.room !== room) throw new Error(`panel room was ${granted.room}`);
    if (!granted.control) throw new Error('the host controls are hidden');
    if (!granted.peers || !granted.peers.some((name) => String(name).includes(PEER_NAME))) {
      throw new Error(`the panel did not list ${PEER_NAME}`);
    }

    const peerGranted = await waitForDataset(bidi, peerContext, (d) => d.granted === true, 20000);
    if (!peerGranted || peerGranted.granted !== true) {
      throw new Error('the peer did not receive control');
    }

    const revoked = await waitForPanel(
      bidi,
      context,
      'Control revoked',
      40000,
      (panel) => Array.isArray(panel.grantedPeers) && !panel.grantedPeers.includes(PEER)
    );
    if (!revoked) throw new Error('the panel did not report a revoke');
    if (!String(revoked.notice).includes('Control revoked')) {
      throw new Error(`revoke notice was ${JSON.stringify(revoked.notice)}`);
    }
    const peerRevoked = await waitForDataset(bidi, peerContext, (d) => d.granted === false, 20000);
    if (!peerRevoked || peerRevoked.granted !== false) {
      throw new Error('the peer kept control after the revoke');
    }

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
      },
      panel: { ...revoked, grantedNotice: granted.notice },
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
