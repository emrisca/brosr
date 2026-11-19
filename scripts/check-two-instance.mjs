// Two real browsers, one grant, one trusted run. The host page opens a room with
// a grant for a named peer and starts its own trust agent. The guest joins the
// same relay in a second browser, the host grants it through the URL, and the
// guest's keys travel to the host form through the browser's input pipeline.
//
// The Zen lane installs what a room actually loads: the signed copy when it
// matches this tree, otherwise a bundle built from the tree into a temp file. A
// signed copy that lags the tree fails the run, because that is the artifact the
// profile resolver would hand to the browser.
//
// Two lanes share the flow. The default lane uses two Zen profiles. The
// --chrome lane loads the unpacked Chromium build in two windows. Branded
// Google Chrome 137 and later ignore --load-extension. Brave, Chromium and
// Chrome for Testing still read the flag at 157, so the lane prefers those.
//
// Everything stays on loopback: its own relay, temp profiles and three free
// ports. It never touches the app browser on 9333.
//
//   node scripts/check-two-instance.mjs
//   node scripts/check-two-instance.mjs --chrome
//   node scripts/check-two-instance.mjs --zen=/path/to/zen
//   BROSR_CHECK_BROWSER=/path/to/chromium node scripts/check-two-instance.mjs --chrome
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { bridgeEntries, buildChrome, buildXpi } from '../zen/package.mjs';
import { zipEntry } from '../spike/unzip.mjs';
import { findZen, writeProfile } from '../zen/profile.mjs';
import { createTrustAgent } from '../host/trust.mjs';
import { newRoomKey } from '../core/seal.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY = path.join(root, 'relay', 'target', 'debug', 'brosr-relay');
const TOKEN = 'check-two-instance-token';
const RELAY_PORT = 8891;
const HOST_PORT = 9351;
const GUEST_PORT = 9352;
const ROOM = 'twolocal';
const PEER = 'guest-1';

// A room on a LAN or tailnet address is not a secure context, and that is the
// case the seal's plain JavaScript HKDF exists for. Loopback is a secure
// context, so a loopback run would never exercise it. The Zen lane therefore
// uses this machine's private IPv4 when it has one and joins with a keyed
// invite. BROSR_CHECK_ORIGIN pins another address, and a machine with none
// falls back to loopback and reports the seal as skipped.
const LAN = (() => {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const [a, b] = item.address.split('.').map(Number);
      const private4 =
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127);
      if (private4) return item.address;
    }
  }
  return null;
})();
const ORIGIN = process.env.BROSR_CHECK_ORIGIN || LAN || '127.0.0.1';
const ORIGIN_SECURE = /^(127\.0\.0\.1|localhost)$/.test(ORIGIN);
const CHROMIUM = [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = { steps: {} };
const chromeLane = process.argv.includes('--chrome');

function free(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function connect(port, ms = 45000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${port}/session`).connect();
    } catch (error) {
      last = error;
      await sleep(300);
    }
  }
  throw new Error(`no BiDi on ${port}${last ? `: ${last.message}` : ''}`);
}

async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out on ${label}${last ? `: ${last.message}` : ''}`);
}

// A page is the only surface the flow needs: an evaluate, a key run and the
// action list the trust agent sends. A Zen page forwards all three to BiDi. A
// Chromium page maps them to CDP, which has no input.performActions method.
function zenPage(bidi, context) {
  const evalIn = async (expression) => {
    const res = await bidi.cmd('script.evaluate', {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    return res && res.result ? res.result.value : undefined;
  };
  return {
    eval: evalIn,
    sendActions: (actions) => bidi.cmd('input.performActions', { context, actions }),
    keys: (text) =>
      bidi.cmd('input.performActions', {
        context,
        actions: [
          {
            type: 'key',
            id: 'brosr-check-keys',
            actions: [...text].flatMap((ch) => [
              { type: 'keyDown', value: ch },
              { type: 'keyUp', value: ch },
            ]),
          },
        ],
      }),
    read: async () => {
      const raw = await evalIn("document.documentElement.dataset.brosr || ''").catch(() => '');
      try {
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
  };
}

class ChromiumPage {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const held = this.pending.get(message.id);
      if (!held) return;
      this.pending.delete(message.id);
      if (message.error) held.reject(new Error(JSON.stringify(message.error)));
      else held.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text +
          ' ' +
          (result.exceptionDetails.exception?.description || '')
      );
    }
    return result.result.value;
  }

  // Chrome inserts a character on a keyDown with text. The virtual key code
  // keeps the event shaped like a real key, and the page sees isTrusted true.
  async sendActions(actions) {
    // The form tab sits behind the guest while it types, and a background tab
    // can drop synthetic keys. Raising it first gives the field focus back.
    await this.send('Page.bringToFront').catch(() => {});
    // The raise can clear the emulation the tab was opened with, and a page
    // that reports itself unfocused drops injected keys. Set it again here.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    // Raising a tab does not always restore the element it had focused, and a
    // key event goes to whatever holds focus. A headless runner left the body
    // focused and the field empty, so the field is focused again here.
    await this.eval(
      "(() => { const active = document.activeElement; if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return true; const field = document.querySelector('input, textarea, [contenteditable]'); if (!field) return false; field.focus(); return document.activeElement === field; })()"
    ).catch(() => false);
    for (const group of actions || []) {
      if (group.type !== 'key') continue;
      for (const step of group.actions || []) {
        const value = String(step.value || '');
        if (step.type === 'keyDown') {
          const code = value.length === 1 ? value.toUpperCase().charCodeAt(0) : 0;
          await this.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: value,
            code: value.length === 1 ? `Key${value.toUpperCase()}` : undefined,
            windowsVirtualKeyCode: code,
            nativeVirtualKeyCode: code,
            text: value,
            unmodifiedText: value,
          });
        } else {
          await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value });
        }
      }
    }
  }

  async keys(text) {
    await this.send('Page.bringToFront');
    await this.sendActions([
      {
        type: 'key',
        actions: [...text].flatMap((ch) => [
          { type: 'keyDown', value: ch },
          { type: 'keyUp', value: ch },
        ]),
      },
    ]);
  }

  async read() {
    const raw = await this.eval("document.documentElement.dataset.brosr || ''").catch(() => '');
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}

async function openChromiumTab(port, url) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('debug socket')), { once: true });
  });
  const page = new ChromiumPage(ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  // A headless page on a runner can report itself unfocused even after the tab
  // is raised, and an unfocused page drops injected key events. Focus emulation
  // makes the page behave as if the window held focus.
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await page.send('Page.navigate', { url });
  await until(async () => (await page.eval('document.readyState')) === 'complete', 'the page load', 20000);
  return page;
}

// A build downloaded by @puppeteer/browsers lives under the runtime folder. It
// is the supported way to keep --load-extension on a current Chromium.
function findChromeForTesting() {
  const base = path.join(root, 'zen', '.runtime', 'cft', 'chrome');
  let versions = [];
  try {
    versions = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const version of versions) {
    const dir = path.join(base, version);
    let builds = [];
    try {
      builds = fs.readdirSync(dir).filter((name) => name.startsWith('chrome-mac'));
    } catch {
      continue;
    }
    for (const build of builds) {
      const file = path.join(
        dir,
        build,
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing'
      );
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

function chromiumBuild() {
  const explicit = process.env.BROSR_CHECK_BROWSER;
  const candidates = [explicit, ...CHROMIUM, findChromeForTesting()].filter(Boolean);
  const rejected = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const probe = spawnSync(file, ['--version'], { encoding: 'utf8' });
    const shown = String((probe.stdout || probe.stderr || '').trim());
    const major = Number((shown.match(/(\d+)\./) || [])[1]);
    // Only branded Google Chrome carries the refusal. Brave loads the flag at
    // 157 despite the Chromium version it shares, which the service worker
    // target in a probe confirmed.
    const branded = /Google Chrome\.app/.test(file);
    if (branded && major >= 137) {
      if (explicit) {
        throw new Error(
          `${path.basename(file)} ${major} ignores --load-extension. Point BROSR_CHECK_BROWSER at Brave, Chromium or Chrome for Testing.`
        );
      }
      rejected.push(`${path.basename(file)} ${major}`);
      continue;
    }
    return { file, version: shown || String(major) };
  }
  throw new Error(
    `no Chromium build here accepts --load-extension${rejected.length ? ` (ignored by ${rejected.join(', ')})` : ''}. Run npx @puppeteer/browsers install chrome@stable --path zen/.runtime/cft, or use Brave.`
  );
}

// The page publishes one dataset object, and the room panel reads the same
// object. A key that leaves it breaks the panel without breaking the wire, so
// the check names every key it needs and the shape each one must hold. The
// host adds the trust client, which only a host page opens.
const CONTRACT = [
  'socket',
  'role',
  'peerId',
  'granted',
  'capture',
  'peers',
  'peerList',
  'trustTarget',
  'media',
  'mediaEchoLocal',
  'mediaDrops',
  'mediaDropTicks',
  'lastMediaDrop',
  'viewers',
];
const HOST_ONLY = ['trust'];

function contractOf(state, keys) {
  const missing = keys.filter((key) => !state || !(key in state));
  const wrong = [];
  if (state) {
    if (state.socket !== 1) wrong.push(`socket=${state.socket}`);
    if (state.role !== 'host' && state.role !== 'peer') wrong.push(`role=${state.role}`);
    if (typeof state.peerId !== 'string' || !state.peerId) wrong.push(`peerId=${state.peerId}`);
    if (typeof state.granted !== 'boolean') wrong.push(`granted=${state.granted}`);
    if (typeof state.capture !== 'boolean') wrong.push(`capture=${state.capture}`);
    if (typeof state.peers !== 'number') wrong.push(`peers=${state.peers}`);
    if (!Array.isArray(state.peerList)) wrong.push(`peerList=${typeof state.peerList}`);
    // The Watch section reads the film and the viewer list. A room with nothing
    // playing carries a null film, and the keys must still be there so the panel
    // never reads undefined. A film that is present names its key and its URL.
    const film = state.media;
    if (!(film === null || (typeof film === 'object' && !Array.isArray(film)))) {
      wrong.push(`media=${JSON.stringify(film)}`);
    } else if (film) {
      if (typeof film.key !== 'string' || !film.key) wrong.push(`media.key=${film.key}`);
      if (typeof film.url !== 'string' || !film.url) wrong.push(`media.url=${film.url}`);
      if (typeof film.position !== 'number') wrong.push(`media.position=${film.position}`);
    }
    if (typeof state.mediaEchoLocal !== 'number') {
      wrong.push(`mediaEchoLocal=${typeof state.mediaEchoLocal}`);
    }
    if (
      !state.mediaDrops ||
      typeof state.mediaDrops !== 'object' ||
      Array.isArray(state.mediaDrops)
    ) {
      wrong.push(`mediaDrops=${typeof state.mediaDrops}`);
    }
    if (
      !state.mediaDropTicks ||
      typeof state.mediaDropTicks !== 'object' ||
      Array.isArray(state.mediaDropTicks)
    ) {
      wrong.push(`mediaDropTicks=${typeof state.mediaDropTicks}`);
    }
    if (
      !(
        state.lastMediaDrop === null ||
        (typeof state.lastMediaDrop === 'object' &&
          !Array.isArray(state.lastMediaDrop))
      )
    ) {
      wrong.push(`lastMediaDrop=${JSON.stringify(state.lastMediaDrop)}`);
    }
    if (!Array.isArray(state.viewers)) wrong.push(`viewers=${typeof state.viewers}`);
  }
  return { ok: missing.length === 0 && wrong.length === 0, missing, wrong };
}

// A room loads the panel as well, but the panel is UI and another machine is
// editing it. A stale panel shows an old layout and cannot break the trust
// path, so its differing bytes are reported as drift rather than failed. Every
// code file still has to match the tree byte for byte, because a module that
// was missing from the bundle is what broke a room before.
const CODE = ['background.js', 'content.js', 'bridge-youtube.js'];
const isCode = (name) => name.startsWith('core/') || CODE.includes(name);

// One reader for a bundle on disk: its version, the AMO signature, and every
// name that is missing from this tree, differs as code, or drifts as UI.
function bundleState(file) {
  const raw = zipEntry(file, 'manifest.json');
  if (!raw) return { error: 'no manifest.json' };
  const manifest = JSON.parse(raw.toString('utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'bridge', 'manifest.json'), 'utf8'));
  const entries = bridgeEntries();
  const missing = [];
  const changed = [];
  const drift = [];

  for (const entry of entries) {
    // AMO rewrites the manifest while signing, so only payload files are
    // compared byte for byte. The version and id are read from the manifest.
    if (entry.name === 'manifest.json') continue;
    const held = zipEntry(file, entry.name);
    if (!held) missing.push(entry.name);
    else if (!held.equals(Buffer.from(entry.data))) {
      if (isCode(entry.name)) changed.push(entry.name);
      else drift.push(entry.name);
    }
  }

  return {
    version: manifest.version,
    id: manifest.browser_specific_settings?.gecko?.id || null,
    want: source.version,
    wantId: source.browser_specific_settings?.gecko?.id || null,
    files: entries.length,
    missing,
    changed,
    drift,
    signature: Boolean(zipEntry(file, 'META-INF/mozilla.rsa')),
  };
}

// The profile installs zen/.runtime/bridge.xpi, not the file this check builds.
// A stale copy can pass every lane here while the browser gets a bundle that is
// one module short, which is the failure this check exists for. So compare what
// ships against the tree and name every file that differs.
function shippedBridge() {
  const file = path.join(root, 'zen', '.runtime', 'bridge.xpi');
  if (!fs.existsSync(file)) return { ok: true, skipped: 'zen/.runtime/bridge.xpi is absent' };
  try {
    const state = bundleState(file);
    if (state.error) return { ok: false, reason: `the shipped bridge has ${state.error}` };
    return {
      file: path.relative(root, file),
      ...state,
      ok:
        state.version === state.want &&
        state.id === state.wantId &&
        state.missing.length === 0 &&
        state.changed.length === 0,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `the shipped bridge is unreadable: ${String(error.message || error)}`,
    };
  }
}

// The profile prefers the signed copy, so that file is what a room loads. It
// has to carry the AMO signature and the same bytes as this tree, or the lane
// would be proving something nobody installs.
function signedBridge() {
  const file = path.join(root, 'zen', '.runtime', 'bridge-signed.xpi');
  if (!fs.existsSync(file)) {
    return { ok: true, signed: false, skipped: 'zen/.runtime/bridge-signed.xpi is absent' };
  }
  try {
    const state = bundleState(file);
    if (state.error) return { ok: false, signed: false, reason: `the signed bridge has ${state.error}` };
    return {
      file: path.relative(root, file),
      ...state,
      ok:
        state.signature &&
        state.version === state.want &&
        state.id === state.wantId &&
        state.missing.length === 0 &&
        state.changed.length === 0,
    };
  } catch (error) {
    return {
      ok: false,
      signed: false,
      reason: `the signed bridge is unreadable: ${String(error.message || error)}`,
    };
  }
}

let relay = null;
let host = null;
let guest = null;
let hostBidi = null;
let guestBidi = null;
let agent = null;
let relayLog = '';
let chromium = null;
let extensionDir = null;
let hostProfile = null;
let guestProfile = null;
let bridge = null;
let bridgeTemp = false;
let shipped = null;
let signed = null;
let offerServer = null;
let fixturesDir = null;

try {
  shipped = shippedBridge();
  out.steps.shipped = shipped;
  if (!shipped.ok) {
    process.stderr.write(
      `[brosr] the shipped bridge is behind the tree: ${JSON.stringify({
        version: shipped.version,
        want: shipped.want,
        missing: shipped.missing,
        changed: shipped.changed,
      })}\n`
    );
  }

  signed = signedBridge();
  out.steps.signed = signed;
  if (!signed.ok) {
    process.stderr.write(
      `[brosr] the signed bridge does not match the tree: ${JSON.stringify({
        version: signed.version,
        want: signed.want,
        signature: signed.signed,
        missing: signed.missing,
        changed: signed.changed,
      })}\n`
    );
  }

  for (const [name, port, host] of [
    ['the relay', RELAY_PORT, ORIGIN],
    ['the host browser', HOST_PORT, '127.0.0.1'],
    ['the guest browser', GUEST_PORT, '127.0.0.1'],
  ]) {
    if (!(await free(port, host))) throw new Error(`port ${port} for ${name} is busy`);
  }

  // The relay serves the room at its root, and a room URL names the relay, so
  // the real landing page has to come from that same origin. A copy on its own
  // port would lose the room the moment a guest follows the host, because the
  // follow strips the room params and sessionStorage does not cross origins.
  // Only the pages this lane opens are copied.
  fixturesDir = await mkdtemp(path.join(tmpdir(), 'brosr-check-fixtures-'));
  for (const [name, from] of [
    ['sync.html', 'landing/index.html'],
    ['landing.css', 'landing/landing.css'],
    ['favicon.svg', 'landing/favicon.svg'],
    ['form.html', 'spike/fixtures/form.html'],
  ]) {
    fs.copyFileSync(path.join(root, from), path.join(fixturesDir, name));
  }

  relay = spawn(RELAY, [], {
    cwd: root,
    env: {
      ...process.env,
      HOST: ORIGIN,
      PORT: String(RELAY_PORT),
      FIXTURES: fixturesDir,
      ASSETS: path.join(root, 'assets'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => {
    relayLog += chunk;
  });
  relay.stderr.on('data', (chunk) => {
    relayLog += chunk;
  });
  await until(
    async () => (await fetch(`http://${ORIGIN}:${RELAY_PORT}/health`)).ok,
    'the relay',
    15000
  );
  out.steps.relay = `http://${ORIGIN}:${RELAY_PORT}`;

  let openHost;
  let openGuest;
  if (chromeLane) {
    const build = chromiumBuild();
    chromium = build;
    out.steps.lane = 'chromium';
    out.steps.browser = `${path.basename(build.file)} ${build.version.replace(/^[^\d]*/, '')}`;
    extensionDir = await mkdtemp(path.join(tmpdir(), 'brosr-check-ext-'));
    buildChrome(extensionDir);
    hostProfile = await mkdtemp(path.join(tmpdir(), 'brosr-chrome-host-'));
    guestProfile = await mkdtemp(path.join(tmpdir(), 'brosr-chrome-guest-'));
    const launch = (profile, port) =>
      spawn(
        build.file,
        [
          '--headless=new',
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-gpu',
          '--disable-features=Translate,MediaRouter',
          '--window-size=1400,900',
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
          'about:blank',
        ],
        { stdio: 'ignore' }
      );
    host = launch(hostProfile, HOST_PORT);
    guest = launch(guestProfile, GUEST_PORT);
    for (const port of [HOST_PORT, GUEST_PORT]) {
      await until(
        async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
        `the devtools endpoint on ${port}`,
        30000
      );
    }
    openHost = (url) => openChromiumTab(HOST_PORT, url);
    openGuest = (url) => openChromiumTab(GUEST_PORT, url);
  } else {
    const zen = findZen();
    if (!zen) throw new Error('no Zen binary found. Pass --zen=<path>.');
    out.steps.lane = 'zen';
    out.steps.browser = 'Zen';
    // The app installs the signed copy when the profile resolver prefers it, so
    // the lane loads that exact file. This proves the shipped artifact instead
    // of a rebuild of it. A missing signed copy falls back to the tree, and a
    // lagging one already failed the guard above.
    if (out.steps.signed.ok && !out.steps.signed.skipped) {
      bridge = path.resolve(root, out.steps.signed.file);
      out.steps.bridge = {
        source: 'signed',
        version: out.steps.signed.version,
        signature: out.steps.signed.signature,
      };
    } else {
      bridge = path.join(tmpdir(), `brosr-check-bridge-${process.pid}.xpi`);
      bridgeTemp = true;
      buildXpi(bridge);
      out.steps.bridge = {
        source: 'tree',
        version: JSON.parse(
          fs.readFileSync(path.join(root, 'bridge', 'manifest.json'), 'utf8')
        ).version,
      };
    }
    hostProfile = await mkdtemp(path.join(tmpdir(), 'brosr-zen-host-'));
    guestProfile = await mkdtemp(path.join(tmpdir(), 'brosr-zen-guest-'));
    writeProfile(hostProfile, { bridge });
    writeProfile(guestProfile, { bridge });
    const launch = (profile, port) =>
      spawn(
        zen,
        ['--profile', profile, '--no-remote', '--new-instance', '--remote-debugging-port', String(port), '-headless', 'about:blank'],
        { stdio: 'ignore' }
      );
    host = launch(hostProfile, HOST_PORT);
    guest = launch(guestProfile, GUEST_PORT);
    hostBidi = await connect(HOST_PORT);
    guestBidi = await connect(GUEST_PORT);
    openHost = async (url) => {
      const created = await hostBidi.cmd('browsingContext.create', { type: 'tab' });
      await hostBidi.cmd('browsingContext.navigate', {
        context: created.context,
        url,
        wait: 'complete',
      });
      return zenPage(hostBidi, created.context);
    };
    openGuest = async (url) => {
      const created = await guestBidi.cmd('browsingContext.create', { type: 'tab' });
      await guestBidi.cmd('browsingContext.navigate', {
        context: created.context,
        url,
        wait: 'complete',
      });
      return zenPage(guestBidi, created.context);
    };
  }

  // Every open page in the guest browser, so an Open click is judged by the tab
  // it created and not by the row that says it did.
  const guestTabUrls = async () => {
    if (!chromeLane) {
      const tree = await guestBidi.cmd('browsingContext.getTree', {});
      const urls = [];
      const visit = (node) => {
        if (node && node.url) urls.push(node.url);
        for (const child of (node && node.children) || []) visit(child);
      };
      for (const node of (tree && tree.contexts) || []) visit(node);
      return urls;
    }
    const list = await (await fetch(`http://127.0.0.1:${GUEST_PORT}/json/list`)).json();
    return list.map((item) => item.url);
  };

  const formUrl = `http://${ORIGIN}:${RELAY_PORT}/form.html`;
  out.steps.form = formUrl;
  // The form fixture name matches the bridge's room page pattern, and the
  // bridge keeps one room tab per browser. Opening the form first made the
  // background record it as the room, so the real room tab's hello was ignored
  // and the host could never publish a tab offer. The form therefore opens
  // after the room tab has claimed that role.
  let form = null;

  // The agent binds before the page reads its port, because the room's trust
  // client posts to this exact address and no other. The page object stands in
  // for a BiDi session, so one agent serves both lanes.
  agent = await createTrustAgent({
    bidi: { cmd: (method, params = {}) => form.sendActions(params.actions) },
    context: 'form',
    token: TOKEN,
    grant: { peerId: PEER, active: true },
  });
  out.steps.agent = agent.url;

  // A plain HTTP page on a private address has no crypto.subtle, so this key
  // path runs the seal's own HKDF. The key stays in the fragment, so the relay
  // never sees it in a request line.
  const inviteKey = !ORIGIN_SECURE ? newRoomKey() : null;
  const hostUrl =
    `http://${ORIGIN}:${RELAY_PORT}/?role=host&room=${ROOM}&peer=host&name=Host` +
    `&relay=${RELAY_PORT}&grant=${PEER}#${inviteKey ? `k=${inviteKey}&` : ''}t=${TOKEN}&tp=${agent.port}`;
  const hostPage = await openHost(hostUrl);
  out.steps.hostUrl = hostUrl;
  const hostState = await until(async () => {
    const s = await hostPage.read();
    return s && s.socket === 1 && s.role === 'host' ? s : null;
  }, 'the host socket', 30000);
  if (!hostState.trust) throw new Error('the host page has no trust client');

  form = await openHost(formUrl);
  await form.eval(
    "(() => { const f = document.getElementById('field'); if (!f) return false; f.focus(); window.__keys = []; f.addEventListener('keydown', (e) => window.__keys.push({ key: e.key, trusted: e.isTrusted })); return true; })()"
  );

  // The guest loads the same real landing page at the relay root, so the Open
  // button under test is the one a person clicks and the page sits on the
  // origin a room URL uses.
  out.steps.landing = 'landing/index.html served at /';
  const guestUrl =
    `http://${ORIGIN}:${RELAY_PORT}/?role=peer&room=${ROOM}&peer=${PEER}&name=Guest` +
    `&relay=${RELAY_PORT}${inviteKey ? `#k=${inviteKey}` : ''}`;
  const guestPage = await openGuest(guestUrl);
  out.steps.guestUrl = guestUrl;
  // A guest that never joins is the one failure a bare timeout cannot explain.
  // The page itself names the reason: no dataset means the core never started,
  // a dataset with socket 0 means it started and the wire stayed shut.
  let joined;
  try {
    joined = await until(async () => {
      const s = await guestPage.read();
      return s && s.socket === 1 ? s : null;
    }, 'the guest socket', 30000);
  } catch (error) {
    out.steps.guestDiagnosis = await guestPage
      .eval(
        "JSON.stringify({ href: location.href, title: document.title, ready: document.readyState, dataset: document.documentElement.dataset.brosr || null, error: document.documentElement.dataset.brosrError || null, entries: Array.from(document.querySelectorAll('script[data-brosr-entry], script[data-brosr-player]')).map((tag) => tag.src) })"
      )
      .catch((cause) => String(cause));
    throw error;
  }
  out.steps.guestJoined = { socket: joined.socket, role: joined.role, peerId: joined.peerId };

  const granted = await until(async () => {
    const s = await guestPage.read();
    return s && s.granted === true && s.capture === true ? s : null;
  }, 'the grant and capture at the guest', 30000);
  out.steps.granted = { guest: granted.granted, capture: granted.capture, peers: granted.peers };

  const hostSees = await until(async () => {
    const s = await hostPage.read();
    const peers = (s && s.peerList) || [];
    return peers.some((p) => p.id === PEER && p.granted === true) ? s : null;
  }, 'the grant at the host', 20000);
  out.steps.hostGrant = {
    peers: hostSees.peerList.map((p) => ({ id: p.id, granted: p.granted })),
    trust: Boolean(hostSees.trust),
  };

  // A sealed room is the one path a loopback run cannot prove. Both ends must
  // derive the same key on a page the browser calls insecure, and the guest
  // must open the frames the host seals.
  const pageSecure = Boolean(await hostPage.eval('window.isSecureContext'));
  const hostSeal = hostSees.seal || null;
  const guestSeal = granted.seal || null;
  const sealOk =
    !inviteKey ||
    (pageSecure === false &&
      Boolean(hostSeal && hostSeal.mode === 'on') &&
      Boolean(guestSeal && guestSeal.mode === 'on' && guestSeal.in > 0));
  out.steps.seal = {
    origin: ORIGIN,
    keyed: Boolean(inviteKey),
    pageSecure,
    host: hostSeal,
    guest: guestSeal,
    ok: sealOk,
  };
  if (inviteKey && !sealOk) {
    process.stderr.write(
      `[brosr] the sealed room did not open: ${JSON.stringify(out.steps.seal)}\n`
    );
  }

  // A wrong key must open nothing. The tab seals its own frames, so it can
  // read its own echo, but the host and its granted guest must stay invisible
  // to it and it must stay invisible to them. Checking both directions keeps a
  // one-sided relay echo from passing as a joined room.
  if (inviteKey) {
    const wrongKey = newRoomKey();
    const wrongUrl =
      `http://${ORIGIN}:${RELAY_PORT}/?role=peer&room=${ROOM}&peer=wrong-1&name=Wrong&relay=${RELAY_PORT}` +
      `#k=${wrongKey}`;
    const wrongPage = await openGuest(wrongUrl);
    const wrongSealed = await until(async () => {
      const s = await wrongPage.read();
      return s && s.socket === 1 && s.seal && s.seal.mode === 'on' ? s : null;
    }, 'the wrong key tab', 20000).catch(() => null);
    await sleep(1500);
    const wrongState = (await wrongPage.read().catch(() => null)) || wrongSealed;
    const hostNow = (await hostPage.read().catch(() => null)) || hostSees;
    const hostSeesWrong = (hostNow.peerList || []).some((p) => p.id === 'wrong-1');
    const wrongPeers = ((wrongState && wrongState.peerList) || []).map((p) => p.id);
    const wrongOk =
      Boolean(wrongState) &&
      Boolean(wrongState.seal && wrongState.seal.mode === 'on') &&
      !hostSeesWrong &&
      !wrongPeers.includes('host') &&
      !wrongPeers.includes(PEER);
    out.steps.wrongKey = {
      peer: 'wrong-1',
      openedFrames: wrongState && wrongState.seal ? wrongState.seal.in : null,
      peers: wrongPeers,
      hostSeesWrong,
      ok: wrongOk,
    };
    if (!wrongOk) {
      process.stderr.write(
        `[brosr] the wrong key opened a room: ${JSON.stringify(out.steps.wrongKey)}\n`
      );
    }
  }

  // Both pages are live here, so this reads the object a person would get by
  // opening the panel. It sits before the typing run because a missing key
  // should be named even when the keyboard path also fails.
  const hostContract = contractOf(await hostPage.read(), [...CONTRACT, ...HOST_ONLY]);
  const guestContract = contractOf(await guestPage.read(), CONTRACT);
  out.steps.contract = {
    ok: hostContract.ok && guestContract.ok,
    keys: CONTRACT,
    hostOnly: HOST_ONLY,
    host: hostContract,
    guest: guestContract,
  };
  if (!out.steps.contract.ok) {
    process.stderr.write(
      `[brosr] the dataset contract is short: ${JSON.stringify(out.steps.contract)}\n`
    );
  }

  // A headless tab can drop the first batch after it loses focus, so one retry
  // clears the field and types again before the run reports a failure.
  const typeTrusted = async () => {
    await form.eval(
      "document.getElementById('field').focus(); document.getElementById('field').value = ''; window.__keys = []; true"
    );
    await sleep(500);
    await guestPage.keys('trusted');
    return until(async () => {
      const raw = await form.eval(
        "JSON.stringify({ value: document.getElementById('field').value, keys: window.__keys })"
      );
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.value === 'trusted' ? parsed : null;
    }, 'the host field', 25000);
  };
  let typed;
  try {
    typed = await typeTrusted();
  } catch (first) {
    // A first batch can land on a page that lost focus. The retry clears the
    // field first, so a partial batch never leaves the value doubled.
    out.steps.retry = String((first && first.message) || first);
    try {
      typed = await typeTrusted();
    } catch (error) {
      // A timeout here has three possible ends: the guest never captured, the
      // host never sent a batch, or the agent never applied one. Record all
      // three so a failing run names the step that broke.
      out.steps.diagnosis = {
        form: await form
          .eval(
            "JSON.stringify({ value: document.getElementById('field').value, keys: (window.__keys || []).length, active: (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || null, focused: document.hasFocus(), visibility: document.visibilityState })"
          )
          .catch((e) => String(e)),
        host: await hostPage.read().catch(() => null),
        guest: await guestPage.read().catch(() => null),
        agent: agent && agent.stats ? agent.stats : null,
      };
      throw error;
    }
  }
  const keys = typed.keys || [];
  out.steps.typed = {
    value: typed.value,
    keys: keys.length,
    trusted: keys.filter((k) => k.trusted === true).length,
    all: keys.length > 0 && keys.every((k) => k.trusted === true),
  };

  // The page publishes on a timer, and its reply counter lands after the keys
  // do. A single read here can catch the batch mid-flight and report applied 0
  // for a run that worked, so wait for the settled count before judging it.
  const settled = await until(async () => {
    const s = await hostPage.read();
    return s && s.trust && s.trust.applied >= 7 && s.trust.failed === 0 ? s : null;
  }, 'the applied trust count', 10000).catch(() => null);
  const hostTrust = settled || (await hostPage.read());
  out.steps.hostTrust = hostTrust && { trust: hostTrust.trust, target: hostTrust.trustTarget };

  // A tab the host opens is an offer, not a push. The guest page must read it
  // from the room grouped under the host, and the host's own page must show the
  // same row. The landing page fixture proves the drawing, so this is the only
  // step that proves the offer channel between two real browsers.
  let offerOk = true;
  try {
    offerServer = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Offered tab</title><p>offer</p>');
    });
    await new Promise((resolve) => offerServer.listen(0, '127.0.0.1', resolve));
    const offerUrl = `http://127.0.0.1:${offerServer.address().port}/offer.html`;
    const readTabs = async (page) => {
      const raw = await page.eval("document.documentElement.dataset.brosrTabs || ''");
      try {
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    };
    await openHost(offerUrl);
    // A host page sends its own offer out and keeps its list for others, so the
    // guest is the side that must show the row. The row also has to sit under
    // the host, because the owner comes from the sender and not from a claim.
    const offered = await until(async () => {
      const state = await readTabs(guestPage);
      const groups = (state && state.groups) || [];
      const host = groups.find((group) => group.role === 'host');
      return host && host.tabs.some((tab) => tab.url === offerUrl) ? { host } : null;
    }, 'the host tab offer at the guest', 20000).catch(() => null);
    const key = offered ? offered.host.tabs.find((tab) => tab.url === offerUrl).key : null;
    // Open is the real button on the landing page. It posts join-tab, the core
    // asks the bridge for a local tab, and the copy has to appear in this
    // browser and land in the joined list. A row that opens nothing is the
    // failure this step exists for.
    const clicked = key
      ? await guestPage.eval(
          "(() => { const button = document.querySelector('.live-row .live-action'); if (!button) return false; button.click(); return true; })()"
        )
      : false;
    const joinedOk = clicked
      ? Boolean(
          await until(async () => {
            const state = await readTabs(guestPage);
            return ((state && state.joined) || []).includes(key) ? state : null;
          }, 'the joined key at the guest', 20000).catch(() => null)
        )
      : false;
    const openedTabs = joinedOk
      ? await until(async () => {
          const urls = await guestTabUrls();
          return urls.includes(offerUrl) ? urls : null;
        }, 'the opened copy in the guest browser', 20000).catch(() => null)
      : null;
    offerOk = Boolean(offered) && Boolean(clicked && joinedOk && openedTabs);
    out.steps.offer = {
      url: offerUrl,
      guestOwner: offered ? offered.host.owner : null,
      guestRole: offered ? offered.host.role : null,
      guestTabs: offered ? offered.host.tabs.map((tab) => tab.url) : null,
      open: { key, clicked, joined: joinedOk, tabs: openedTabs },
      ok: offerOk,
    };
    if (!offerOk) {
      const guestTabs = await readTabs(guestPage).catch(() => null);
      out.steps.offer.groups = guestTabs
        ? guestTabs.groups.map((group) => ({
            owner: group.owner,
            role: group.role,
            tabs: group.tabs.length,
          }))
        : null;
      process.stderr.write(`[brosr] the offer did not reach the guest: ${JSON.stringify(out.steps.offer)}\n`);
    }
  } catch (error) {
    offerOk = false;
    out.steps.offer = { ok: false, error: String((error && error.message) || error) };
    process.stderr.write(`[brosr] the offer step failed: ${out.steps.offer.error}\n`);
  } finally {
    if (offerServer) offerServer.close();
  }

  const wrongKeyOk = out.steps.wrongKey ? out.steps.wrongKey.ok : true;
  out.ok =
    shipped.ok &&
    signed.ok &&
    sealOk &&
    wrongKeyOk &&
    out.steps.contract.ok &&
    offerOk &&
    typed.value === 'trusted' &&
    keys.length >= 7 &&
    keys.every((k) => k.trusted === true) &&
    Boolean(hostTrust && hostTrust.trust && hostTrust.trust.applied >= 7 && hostTrust.trust.failed === 0);
} catch (error) {
  out.error = String((error && error.message) || error);
  out.relayLog = relayLog.slice(-2000);
} finally {
  if (agent) await agent.close().catch(() => {});
  if (hostBidi) hostBidi.close();
  if (guestBidi) guestBidi.close();
  if (host) host.kill('SIGTERM');
  if (guest) guest.kill('SIGTERM');
  if (relay) relay.kill('SIGTERM');
  if (hostProfile) await rm(hostProfile, { recursive: true, force: true }).catch(() => {});
  if (guestProfile) await rm(guestProfile, { recursive: true, force: true }).catch(() => {});
  if (extensionDir) await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
  if (fixturesDir) await rm(fixturesDir, { recursive: true, force: true }).catch(() => {});
  if (bridge && bridgeTemp) await rm(bridge, { force: true }).catch(() => {});
}

// A pipe write is asynchronous, and an exit straight after it cut the JSON
// short exactly when the diagnosis mattered most.
await new Promise((resolve) =>
  process.stdout.write(JSON.stringify(out, null, 2) + '\n', resolve)
);
process.exit(out.ok ? 0 : 1);
