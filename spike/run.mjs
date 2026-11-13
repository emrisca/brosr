import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from './bidi.mjs';
import { makeZip } from './zip.mjs';
import { unzipTo } from './unzip.mjs';
import { createAgent } from './agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(here, '.runtime');
const core = path.join(here, '..', 'core');
const BASE = 'http://127.0.0.1:8787';
const PROXY_PORT = 8788;
const AD_URL = 'https://cdn.taboola.com/libtrc/loader.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const seconds = Number(arg('seconds', '25'));
const jitterSeconds = Number(arg('jitter', '20'));
const soakSeconds = Number(arg('soak', '0'));
// A two-window canvas game over the app channel.
const gameSeconds = Number(arg('game', '0'));
// A comma list of checks: ad, bidi, media, room, jitter, agent. The default is all.
const only = arg('only', 'all');
// A full path to a browser binary. ensureFirefox() downloads a Windows build, so
// a macOS run passes the path instead.
const firefoxPath = arg('firefox', '');
const want = (name) => only === 'all' || only.split(',').includes(name);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, body);
  return body.length;
}

async function ensureFirefox() {
  if (process.platform !== 'win32') {
    throw new Error('the download in ensureFirefox() is a Windows build. Pass --firefox=<path>.');
  }
  const exe = path.join(runtime, 'firefox', 'firefox.exe');
  if (fs.existsSync(exe)) return exe;

  const versions = await (
    await fetch('https://product-details.mozilla.org/1.0/firefox_versions.json')
  ).json();
  const candidates = [
    `https://archive.mozilla.org/pub/devedition/releases/${versions.FIREFOX_DEVEDITION}/win64/en-US/firefox-${versions.FIREFOX_DEVEDITION}.zip`,
    `https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/firefox-${versions.FIREFOX_NIGHTLY}.en-US.win64.zip`,
    `https://archive.mozilla.org/pub/firefox/releases/${versions.LATEST_FIREFOX_VERSION}/win64/en-US/firefox-${versions.LATEST_FIREFOX_VERSION}.zip`,
  ];

  mkdir(runtime);
  let lastError = new Error('no Firefox archive tried');
  for (const url of candidates) {
    try {
      log('[firefox] downloading', url);
      const zipPath = path.join(runtime, 'firefox.zip');
      const size = await download(url, zipPath);
      log('[firefox] downloaded', Math.round(size / 1048576), 'MB');
      unzipTo(zipPath, runtime);
      if (!fs.existsSync(exe)) throw new Error('archive did not contain firefox/firefox.exe');
      fs.rmSync(zipPath, { force: true });
      return exe;
    } catch (error) {
      lastError = error;
      log('[firefox] failed:', error.message);
    }
  }
  throw lastError;
}

async function ensureUbo() {
  const dest = path.join(runtime, 'ubo.xpi');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) return dest;
  const size = await download(
    'https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi',
    dest
  );
  log('[ubo] downloaded', Math.round(size / 1024), 'KB');
  return dest;
}

// A real clip, because a scripted clock proves nothing about an element.
function ensureClip() {
  const dest = path.join(runtime, 'clip.webm');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 20000) return dest;
  const attempts = [
    ['-c:v', 'libvpx', '-b:v', '150k', '-deadline', 'realtime', '-cpu-used', '8'],
    ['-c:v', 'libvpx-vp9', '-b:v', '150k', '-deadline', 'realtime', '-cpu-used', '8'],
    ['-c:v', 'libaom-av1', '-b:v', '150k', '-cpu-used', '8'],
  ];
  for (const codec of attempts) {
    try {
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x180:rate=30',
          '-t',
          '120',
          ...codec,
          dest,
        ],
        { stdio: 'ignore' }
      );
      if (fs.existsSync(dest) && fs.statSync(dest).size > 20000) {
        log('[clip]', codec[1], Math.round(fs.statSync(dest).size / 1024), 'KB');
        return dest;
      }
    } catch {
      fs.rmSync(dest, { force: true });
    }
  }
  throw new Error('ffmpeg could not build the test clip');
}

const PREFS = [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.page", 0);',
  'user_pref("browser.startup.homepage", "about:blank");',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("browser.sessionstore.resume_from_crash", false);',
  'user_pref("browser.tabs.warnOnClose", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.enabled", false);',
  'user_pref("app.update.enabled", false);',
  'user_pref("xpinstall.signatures.required", false);',
  'user_pref("extensions.autoDisableScopes", 0);',
  'user_pref("extensions.enabledScopes", 15);',
  'user_pref("dom.disable_open_during_load", false);',
  'user_pref("media.autoplay.default", 0);',
  'user_pref("media.autoplay.blocking_policy", 0);',
].join('\n');

function makeProfile(name, uboPath) {
  const dir = path.join(runtime, `profile-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  mkdir(path.join(dir, 'extensions'));
  fs.writeFileSync(path.join(dir, 'user.js'), PREFS);
  if (uboPath) fs.copyFileSync(uboPath, path.join(dir, 'extensions', 'uBlock0@raymondhill.net.xpi'));
  return dir;
}

function coreModules() {
  return fs
    .readdirSync(core)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => ({ name: `core/${name}`, data: fs.readFileSync(path.join(core, name)) }));
}

function buildBridge() {
  const xpi = path.join(runtime, 'bridge.xpi');
  fs.writeFileSync(
    xpi,
    makeZip([
      { name: 'manifest.json', data: fs.readFileSync(path.join(here, 'bridge', 'manifest.json')) },
      { name: 'content.js', data: fs.readFileSync(path.join(here, 'bridge', 'content.js')) },
      {
        name: 'background.js',
        data: fs.readFileSync(path.join(here, 'bridge', 'background.js')),
      },
      // The manifest names a room panel, so the XPI has to carry it.
      ...['room.html', 'room.css', 'room.js'].map((name) => ({
        name: `panel/${name}`,
        data: fs.readFileSync(path.join(here, '..', 'zen', 'panel', name)),
      })),
      ...coreModules(),
    ])
  );
  return xpi;
}

function launch(exe, profile, port) {
  return spawn(
    exe,
    [
      '--profile',
      profile,
      '--no-remote',
      '--new-instance',
      '--headless',
      '--remote-debugging-port',
      String(port),
      '--width',
      '1280',
      '--height',
      '900',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, MOZ_HEADLESS: '1' },
      // killTree() kills a POSIX process group, so the browser needs its own.
      detached: process.platform !== 'win32',
    }
  );
}

async function connect(port, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${port}/session`).connect();
    } catch (error) {
      last = error;
      await sleep(400);
    }
  }
  throw new Error(`no BiDi on port ${port}: ${last ? last.message : 'unknown'}`);
}

async function firstContext(bidi) {
  const tree = await bidi.cmd('browsingContext.getTree', {});
  if (!tree.contexts || !tree.contexts.length) throw new Error('no browsing context');
  return tree.contexts[0].context;
}

async function navigate(bidi, context, url) {
  await bidi.cmd('browsingContext.navigate', { context, url, wait: 'complete' });
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
  if (!parsed.data) return null;
  try {
    return JSON.parse(parsed.data);
  } catch {
    return null;
  }
}

async function waitForDataset(bidi, context, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const data = await readDataset(bidi, context).catch(() => null);
    if (data) return data;
    await sleep(300);
  }
  return null;
}

async function waitForDatasetWhere(bidi, context, predicate, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await readDataset(bidi, context).catch(() => null);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  return last;
}

async function installBridge(bidi, xpi) {
  try {
    const res = await bidi.cmd('webExtension.install', {
      extensionData: { type: 'archivePath', path: xpi },
    });
    return { ok: true, id: res.extension };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function waitHealthOn(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }
  throw new Error(`no health on port ${port}`);
}

async function startRelay() {
  const child = spawn(process.execPath, [path.join(here, 'relay.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitHealthOn(8787);
  return child;
}

function readAddon(profile, id) {
  const file = path.join(profile, 'extensions.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const addon = (data.addons || []).find((entry) => entry.id === id);
    if (!addon) return null;
    return { id: addon.id, version: addon.version, active: addon.active, signedState: addon.signedState };
  } catch {
    return null;
  }
}

function systemFirefox() {
  const candidates = [
    'C:/Program Files/Mozilla Firefox/firefox.exe',
    'C:/Program Files (x86)/Mozilla Firefox/firefox.exe',
    `${process.env.LOCALAPPDATA || ''}/Mozilla Firefox/firefox.exe`,
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
    '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // Firefox starts content processes. One signal to the group stops all of
  // them, and a harness run must not leave a browser behind.
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

const keyActions = (value) => [
  {
    type: 'key',
    id: 'brosr-keyboard',
    actions: [
      { type: 'keyDown', value },
      { type: 'keyUp', value },
    ],
  },
];

const results = {
  when: new Date().toISOString(),
  machine: { node: process.version, platform: process.platform },
  firefox: null,
  q1Profile: null,
  q2Bridge: null,
  q3Ubo: null,
  q4BidiKey: null,
  q5Media: null,
  q6Agent: null,
  q7Room: null,
  q8Jitter: null,
  q9Input: null,
  soak: null,
  game: null,
};

let relay = null;
let proxy = null;
const firefoxes = [];

try {
  mkdir(runtime);
  relay = await startRelay();

  const exe = firefoxPath ? path.resolve(firefoxPath) : await ensureFirefox();
  if (!fs.existsSync(exe)) throw new Error(`no Firefox binary at ${exe}`);
  const ubo = await ensureUbo();
  const clip = ensureClip();
  const bridge = buildBridge();

  let version = 'unknown';
  try {
    version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    // A Windows build often has no --version output. Keep the default.
  }

  results.firefox = {
    path: exe,
    version,
    uboBytes: fs.statSync(ubo).size,
    clipBytes: fs.statSync(clip).size,
    bridgeModules: coreModules().length,
  };

  const profileA = makeProfile('a', ubo);
  const profileB = makeProfile('b', null);
  const profileC = makeProfile('c', null);
  const profileD = makeProfile('d', null);

  const firefoxA = launch(exe, profileA, 9222);
  const firefoxB = launch(exe, profileB, 9223);
  const firefoxC = launch(exe, profileC, 9224);
  const firefoxD = launch(exe, profileD, 9225);
  firefoxes.push(firefoxA, firefoxB, firefoxC, firefoxD);

  const bidiA = await connect(9222);
  const bidiB = await connect(9223);
  const bidiC = await connect(9224);
  const bidiD = await connect(9225);
  const ctxA = await firstContext(bidiA);
  const ctxB = await firstContext(bidiB);
  const ctxC = await firstContext(bidiC);
  const ctxD = await firstContext(bidiD);

  results.q1Profile = {
    ok: true,
    detail: 'four separate profiles started as separate instances, all reached a BiDi session',
    dailyBrowserPresent: systemFirefox() !== null,
    profiles: [profileA, profileB, profileC, profileD],
  };

  results.q2Bridge = {
    a: await installBridge(bidiA, bridge),
    b: await installBridge(bidiB, bridge),
    c: await installBridge(bidiC, bridge),
    d: await installBridge(bidiD, bridge),
    contentScript: null,
  };

  // Q4: the raw BiDi path, before any token sits in front of it.
  if (want('bidi')) {
    await navigate(bidiA, ctxA, `${BASE}/form.html`);
    await evaluate(bidiA, ctxA, "document.getElementById('field').focus(); true");
    await bidiA.cmd('input.performActions', { context: ctxA, actions: keyActions('a') });
    await sleep(400);
    const form = JSON.parse(
      await evaluate(
        bidiA,
        ctxA,
        "JSON.stringify({ keys: window.__keys, value: document.getElementById('field').value })"
      )
    );
    results.q4BidiKey = {
      ok: Boolean(form.keys && form.keys.length && form.keys[0].trusted),
      keys: form.keys,
      value: form.value,
    };
  }

  // Q3: full uBlock Origin against a profile without it.
  if (want('ad')) {
    await navigate(bidiA, ctxA, `${BASE}/ad.html?ad=${encodeURIComponent(AD_URL)}`);
    await sleep(48000);
    const withUbo = JSON.parse(await evaluate(bidiA, ctxA, 'JSON.stringify(window.__ad)'));
    await navigate(bidiB, ctxB, `${BASE}/ad.html?ad=${encodeURIComponent(AD_URL)}`);
    await sleep(9000);
    const withoutUbo = JSON.parse(await evaluate(bidiB, ctxB, 'JSON.stringify(window.__ad)'));
    results.q3Ubo = {
      ok: Boolean(withUbo.blocked) && Boolean(withoutUbo.loaded),
      withUbo,
      withoutUbo,
      addon: readAddon(profileA, 'uBlock0@raymondhill.net'),
    };
  }

  // Q5: two windows, one real video element, and a peer that joins late.
  if (want('media')) {
    await navigate(bidiA, ctxA, `${BASE}/media.html?role=host&room=spike&peer=host&name=Host`);
    await sleep(2500);
    await navigate(
      bidiB,
      ctxB,
      `${BASE}/media.html?role=peer&room=spike&peer=peer&name=Peer&bias=0.18`
    );
    const hostFirst = await waitForDataset(bidiA, ctxA);
    const peerFirst = await waitForDataset(bidiB, ctxB);
    log(
      `[media] running ${seconds}s, host=${hostFirst ? hostFirst.source : 'missing'}, peer=${peerFirst ? peerFirst.source : 'missing'}`
    );
    await sleep(seconds * 1000);

    const hostFinal = (await readDataset(bidiA, ctxA)) || {};
    const peerFinal = (await readDataset(bidiB, ctxB)) || {};
    const drift = stats(peerFinal.samples || []);
    results.q2Bridge.contentScript = Boolean(
      hostFirst && hostFirst.source === 'content-script' && peerFirst && peerFirst.source === 'content-script'
    );
    results.q5Media = {
      ok: Boolean(
        peerFinal.sampleCount > 10 &&
          drift &&
          drift.p95 <= 250 &&
          (peerFinal.cursors || 0) >= 1 &&
          (hostFinal.cursors || 0) >= 1 &&
          String(peerFinal.key || '').endsWith('/media/clip.webm')
      ),
      source: peerFinal.source || null,
      hostSource: hostFinal.source || null,
      key: peerFinal.key || null,
      firstDrift: peerFinal.firstDrift ?? null,
      convergedAt: peerFinal.convergedAt ?? null,
      hostPosition: hostFinal.position ?? null,
      peerPosition: peerFinal.position ?? null,
      seeks: peerFinal.seeks ?? null,
      nudges: peerFinal.nudges ?? null,
      rate: peerFinal.driftRate ?? null,
      rtt: peerFinal.rtt ?? null,
      clockOffset: peerFinal.clockOffset ?? null,
      cursors: { host: hostFinal.cursors ?? 0, peer: peerFinal.cursors ?? 0 },
      drift,
      debug: peerFinal.debug || null,
      seconds,
    };
  }

  // Q7: four peers in one room, cursor latency, then a navigation and a scroll.
  if (want('room')) {
    const peers = [
      { id: 'p2', bidi: bidiB, ctx: ctxB },
      { id: 'p3', bidi: bidiC, ctx: ctxC },
      { id: 'p4', bidi: bidiD, ctx: ctxD },
    ];
    const roomUrl = (id, role) =>
      `${BASE}/room-a.html?role=${role}&room=lan&peer=${id}&host=host&name=${id}`;

    await navigate(bidiA, ctxA, roomUrl('host', 'host'));
    for (const peer of peers) await navigate(peer.bidi, peer.ctx, roomUrl(peer.id, 'peer'));
    for (const peer of peers) await waitForDataset(peer.bidi, peer.ctx, 20000);
    await waitForDataset(bidiA, ctxA, 20000);
    await sleep(6000);

    const before = [];
    for (const peer of peers) {
      const data = (await readDataset(peer.bidi, peer.ctx)) || {};
      before.push({
        id: peer.id,
        cursors: data.cursors || 0,
        source: data.source,
        latencies: data.latencies || [],
      });
    }
    if (before.every((entry) => entry.source === 'content-script')) {
      results.q2Bridge.contentScript = true;
    }

    const latency = stats(before.flatMap((entry) => entry.latencies));

    await evaluate(bidiA, ctxA, "document.getElementById('go').click(); true");
    const followed = [];
    for (const peer of peers) {
      const data = await waitForDatasetWhere(
        peer.bidi,
        peer.ctx,
        (entry) => String(entry.url || '').includes('room-b.html'),
        25000
      );
      followed.push({ id: peer.id, url: data ? data.url : null, location: data ? data.location : null });
    }
    const hostAfterNav = await waitForDatasetWhere(
      bidiA,
      ctxA,
      (entry) => String(entry.url || '').includes('room-b.html'),
      25000
    );

    await evaluate(
      bidiA,
      ctxA,
      'window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * 0.55); true'
    );
    await sleep(3000);

    const readScroll = async (bidi, context) =>
      JSON.parse(
        await evaluate(
          bidi,
          context,
          'JSON.stringify({ ratio: Number((window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)).toFixed(3)) })'
        )
      );

    const hostScroll = await readScroll(bidiA, ctxA);
    const scrollPeers = [];
    for (const peer of peers) {
      const scroll = await readScroll(peer.bidi, peer.ctx);
      const data = (await readDataset(peer.bidi, peer.ctx)) || {};
      scrollPeers.push({
        id: peer.id,
        ratio: scroll.ratio,
        reported: data.scroll,
        mismatch: data.layoutMismatch,
      });
    }
    const closeEnough = scrollPeers.every((entry) => Math.abs(entry.ratio - hostScroll.ratio) <= 0.08);

    results.q7Room = {
      ok: Boolean(
        latency &&
          latency.n >= 30 &&
          latency.p95 <= 80 &&
          before.every((entry) => entry.cursors >= 3) &&
          followed.length === 3 &&
          followed.every((entry) => String(entry.url || '').includes('room-b.html')) &&
          closeEnough
      ),
      peers: peers.length + 1,
      latency,
      cursors: before.map((entry) => ({ id: entry.id, cursors: entry.cursors })),
      followed,
      hostUrl: hostAfterNav ? hostAfterNav.url : null,
      scroll: { host: hostScroll.ratio, peers: scrollPeers },
      closeEnough,
    };
  }

  // Q8: the same two-window media test over a slow, lossy link.
  if (want('jitter')) {
    proxy = spawn(process.execPath, [path.join(here, 'proxy.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(PROXY_PORT),
        UPSTREAM: 'ws://127.0.0.1:8787',
        DELAY_MS: '120',
        DROP_RATE: '0.05',
      },
    });
    proxy.stdout.on('data', (chunk) => process.stdout.write(chunk));
    proxy.stderr.on('data', (chunk) => process.stderr.write(chunk));
    await waitHealthOn(PROXY_PORT);

    try {
      await navigate(
        bidiA,
        ctxA,
        `${BASE}/media.html?role=host&room=jitter&peer=host&host=host&name=Host&relay=${PROXY_PORT}`
      );
      await sleep(2500);
      await navigate(
        bidiB,
        ctxB,
        `${BASE}/media.html?role=peer&room=jitter&peer=peer&host=host&name=Peer&bias=0.18&relay=${PROXY_PORT}`
      );
      await waitForDataset(bidiA, ctxA, 20000);
      await waitForDataset(bidiB, ctxB, 20000);
      log(`[jitter] running ${jitterSeconds}s through the proxy`);
      await sleep(jitterSeconds * 1000);

      const hostData = (await readDataset(bidiA, ctxA)) || {};
      const peerData = (await readDataset(bidiB, ctxB)) || {};
      if (hostData.source === 'content-script' && peerData.source === 'content-script') {
        results.q2Bridge.contentScript = true;
      }
      const link = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/stats`)).json();
      const drift = stats(peerData.samples || []);
      results.q8Jitter = {
        ok: Boolean(
          drift &&
            drift.n >= 15 &&
            drift.p95 <= 250 &&
            (peerData.seeks || 0) <= 3 &&
            peerData.convergedAt !== null &&
            link.droppedDown > 0
        ),
        delayMs: link.delayMs,
        dropRate: link.dropRate,
        dropped: { up: link.droppedUp, down: link.droppedDown },
        forwarded: { up: link.up, down: link.down },
        firstDrift: peerData.firstDrift ?? null,
        convergedAt: peerData.convergedAt ?? null,
        seeks: peerData.seeks ?? null,
        nudges: peerData.nudges ?? null,
        drift,
        hostPosition: hostData.position ?? null,
        peerPosition: peerData.position ?? null,
        seconds: jitterSeconds,
      };
    } finally {
      killTree(proxy);
      proxy = null;
    }
  }

  // Q9: a granted peer clicks, and the host replays it on its own copy.
  if (want('input')) {
    const board = 'host=host&room=input';
    await navigate(bidiA, ctxA, `${BASE}/board.html?role=host&peer=host&grant=peer&${board}`);
    await sleep(1200);
    await navigate(bidiB, ctxB, `${BASE}/board.html?role=peer&peer=peer&capture=1&${board}`);
    await waitForDataset(bidiB, ctxB, 15000);
    await sleep(2000);

    const peerState = (await readDataset(bidiB, ctxB)) || {};
    const rect = JSON.parse(
      await evaluate(
        bidiB,
        ctxB,
        "JSON.stringify((() => { const r = document.getElementById('board').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })())"
      )
    );
    const clickX = Math.round(rect.left + rect.width / 2);
    const clickY = Math.round(rect.top + rect.height / 2);
    await bidiB.cmd('input.performActions', {
      context: ctxB,
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: clickX, y: clickY, origin: 'viewport' },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    await sleep(1500);

    const hostData = (await readDataset(bidiA, ctxA)) || {};
    const clicks = JSON.parse(
      await evaluate(bidiA, ctxA, 'JSON.stringify(window.__board.clicks)')
    );

    // A password field must never carry relayed typing, on either side.
    await evaluate(bidiB, ctxB, "document.getElementById('password').focus(); true");
    await bidiB.cmd('input.performActions', { context: ctxB, actions: keyActions('p') });
    await sleep(1000);
    const password = await evaluate(bidiA, ctxA, "document.getElementById('password').value");

    const click = clicks[0] || null;
    results.q9Input = {
      ok: Boolean(
        peerState.granted === true &&
          hostData.inputApplied >= 1 &&
          click &&
          click.trusted === false &&
          click.x >= 0 &&
          click.x <= rect.width &&
          click.y >= 0 &&
          click.y <= rect.height &&
          password === ''
      ),
      granted: peerState.granted === true,
      applied: hostData.inputApplied ?? 0,
      dropped: hostData.inputDropped ?? 0,
      reasons: hostData.inputReasons || {},
      clicks: clicks.slice(0, 3),
      canvas: { width: rect.width, height: rect.height },
      passwordOnReceiver: password,
    };
  }

  // Soak: four peers, a scroll, and a relay restart in the middle of it.
  if (soakSeconds > 0) {
    const peers = [
      { id: 'p2', bidi: bidiB, ctx: ctxB },
      { id: 'p3', bidi: bidiC, ctx: ctxC },
      { id: 'p4', bidi: bidiD, ctx: ctxD },
    ];
    const url = (id, role) =>
      `${BASE}/room-b.html?role=${role}&room=soak&peer=${id}&host=host&name=${id}`;

    await navigate(bidiA, ctxA, url('host', 'host'));
    for (const peer of peers) await navigate(peer.bidi, peer.ctx, url(peer.id, 'peer'));
    for (const peer of peers) await waitForDataset(peer.bidi, peer.ctx, 20000);
    await waitForDataset(bidiA, ctxA, 20000);
    await sleep(3000);

    const start = Date.now();
    let restarted = false;
    let step = 0;
    while (Date.now() - start < soakSeconds * 1000) {
      const ratio = [0.2, 0.6, 0.35][step % 3];
      step += 1;
      await evaluate(
        bidiA,
        ctxA,
        `window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * ${ratio}); true`
      );
      if (!restarted && Date.now() - start > 12000) {
        restarted = true;
        log('[soak] restarting the relay');
        killTree(relay);
        await sleep(2500);
        relay = await startRelay();
      }
      await sleep(2500);
    }
    await sleep(4000);

    const hostData = (await readDataset(bidiA, ctxA)) || {};
    const peerData = [];
    for (const peer of peers) {
      const data = (await readDataset(peer.bidi, peer.ctx)) || {};
      peerData.push({
        id: peer.id,
        reconnects: data.reconnects ?? 0,
        socket: data.socket ?? -1,
        scroll: data.scroll ?? null,
        latencies: data.latencies || [],
      });
    }
    const latency = stats(peerData.flatMap((entry) => entry.latencies));
    const hostScroll = JSON.parse(
      await evaluate(
        bidiA,
        ctxA,
        'JSON.stringify({ ratio: Number((window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)).toFixed(3)) })'
      )
    );
    const closeEnough = peerData.every(
      (entry) => entry.scroll !== null && Math.abs(entry.scroll - hostScroll.ratio) <= 0.08
    );

    results.soak = {
      ok: Boolean(
        latency &&
          latency.n >= 30 &&
          latency.p95 <= 80 &&
          peerData.every((entry) => entry.reconnects >= 1 && entry.socket === 1) &&
          closeEnough
      ),
      seconds: soakSeconds,
      relayRestarted: restarted,
      latency,
      peers: peerData,
      hostScroll: hostScroll.ratio,
      closeEnough,
    };
  }

  // Game: two windows, one canvas game. The host simulates and sends state;
  // the peer sends its paddle and renders what it receives.
  if (gameSeconds > 0) {
    const url = (role, peer) =>
      `${BASE}/game.html?role=${role}&room=game&peer=${peer}&host=host&name=${peer}`;
    await navigate(bidiA, ctxA, url('host', 'host'));
    await sleep(1200);
    await navigate(bidiB, ctxB, url('peer', 'peer'));
    const hostReady = await waitForDataset(bidiA, ctxA, 20000);
    const peerReady = await waitForDataset(bidiB, ctxB, 20000);
    log(`[game] running ${gameSeconds}s, host=${hostReady ? hostReady.source : 'missing'}, peer=${peerReady ? peerReady.source : 'missing'}`);
    // The peer follows the host's clean URL once and keeps the room from
    // sessionStorage. Drive its paddle after that reload settles.
    await sleep(2500);
    const until = Date.now() + gameSeconds * 1000;
    let moves = 0;
    while (Date.now() < until) {
      const y = moves % 2 === 0 ? 130 : 235;
      moves += 1;
      await bidiB
        .cmd('input.performActions', {
          context: ctxB,
          actions: [
            {
              type: 'pointer',
              id: 'mouse',
              parameters: { pointerType: 'mouse' },
              actions: [{ type: 'pointerMove', x: 420, y, origin: 'viewport' }],
            },
          ],
        })
        .catch(() => {});
      await sleep(2000);
    }

    const hostData = (await readDataset(bidiA, ctxA)) || {};
    const peerData = (await readDataset(bidiB, ctxB)) || {};
    const hostGame = JSON.parse(
      await evaluate(bidiA, ctxA, 'JSON.stringify(window.__game || null)')
    );
    const peerGame = JSON.parse(
      await evaluate(bidiB, ctxB, 'JSON.stringify(window.__game || null)')
    );
    const scoresMatch = Boolean(
      hostGame &&
        peerGame &&
        JSON.stringify(hostGame.scores) === JSON.stringify(peerGame.scores)
    );
    results.game = {
      ok: Boolean(
        hostData.app &&
          hostData.app.received > 0 &&
          peerData.app &&
          peerData.app.received > 0 &&
          hostGame &&
          peerGame &&
          peerGame.states > 10 &&
          hostGame.paddles > 10 &&
          scoresMatch &&
          hostData.peers >= 1 &&
          peerData.peers >= 2
      ),
      seconds: gameSeconds,
      moves,
      channel: { host: hostData.app || null, peer: peerData.app || null },
      host: hostGame,
      peer: peerGame,
      scoresMatch,
      peers: { host: hostData.peers ?? null, peer: peerData.peers ?? null },
    };
    log(
      `[game] peer states ${peerGame ? peerGame.states : '?'}, host paddles ${hostGame ? hostGame.paddles : '?'}, scores ${JSON.stringify(hostGame ? hostGame.scores : null)}`
    );
  }

  // Q6: the launcher's loopback channel, with a token and a grant.
  if (want('agent')) {
    await navigate(bidiA, ctxA, `${BASE}/form.html`);
    await evaluate(bidiA, ctxA, "document.getElementById('field').focus(); true");

    let refusedWithoutGrant = false;
    try {
      await createAgent({ bidi: bidiA, context: ctxA });
    } catch {
      refusedWithoutGrant = true;
    }

    const grant = { peerId: 'peer', tab: 'form.html', origin: BASE, active: true };
    const agent = await createAgent({ bidi: bidiA, context: ctxA, grant });

    const callAgent = async (headers, actions) => {
      try {
        const res = await fetch(`${agent.url}/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ actions }),
        });
        let body = null;
        try {
          body = await res.json();
        } catch {
          // Keep null.
        }
        return { status: res.status, body };
      } catch (error) {
        // A revoked grant closes the listener, so the caller sees a refusal at
        // the socket instead of a status code.
        return { status: 0, error: error.message };
      }
    };

    const noToken = await callAgent({}, keyActions('z'));
    const badToken = await callAgent({ authorization: 'Bearer not-the-token' }, keyActions('z'));
    const goodToken = await callAgent({ authorization: `Bearer ${agent.token}` }, keyActions('t'));
    await sleep(400);
    const afterAgent = JSON.parse(
      await evaluate(
        bidiA,
        ctxA,
        "JSON.stringify({ keys: window.__keys, value: document.getElementById('field').value })"
      )
    );
    await agent.revoke();
    const afterRevoke = await callAgent({ authorization: `Bearer ${agent.token}` }, keyActions('x'));

    results.q6Agent = {
      ok: Boolean(
        refusedWithoutGrant &&
          noToken.status === 401 &&
          badToken.status === 401 &&
          goodToken.status === 200 &&
          afterAgent.value === 't' &&
          afterAgent.keys.some((entry) => entry.key === 't' && entry.trusted) &&
          afterRevoke.status !== 200
      ),
      host: agent.host,
      port: agent.port,
      grant: grant.peerId,
      refusedWithoutGrant,
      noToken: noToken.status,
      badToken: badToken.status,
      goodToken: goodToken.status,
      typed: afterAgent,
      afterRevoke,
      agentActive: agent.isActive(),
      stats: agent.stats,
    };
  }

  bidiA.close();
  bidiB.close();
  bidiC.close();
  bidiD.close();
} catch (error) {
  results.error = error.stack || error.message;
  console.error('[spike] failed:', error.stack || error.message);
} finally {
  fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2));
  for (const child of firefoxes) killTree(child);
  killTree(proxy);
  killTree(relay);
  await sleep(500);

  log('\n--- results ---');
  log(JSON.stringify(results, null, 2));
  // Only the room, media, jitter and input lanes load the core, so the content
  // script stays unknown when a run takes none of them.
  const bridgeInstalled = ['a', 'b', 'c', 'd'].every(
    (key) => results.q2Bridge && results.q2Bridge[key] && results.q2Bridge[key].ok
  );
  const bridgeContent = results.q2Bridge ? results.q2Bridge.contentScript : null;
  const verdicts = [
    ['Q1 profile', Boolean(results.q1Profile && results.q1Profile.ok)],
    ['Q2 bridge install', bridgeInstalled],
  ];
  if (want('ad')) verdicts.push(['Q3 uBlock', results.q3Ubo && results.q3Ubo.ok]);
  if (want('bidi')) verdicts.push(['Q4 BiDi key', results.q4BidiKey && results.q4BidiKey.ok]);
  if (want('media')) verdicts.push(['Q5 media', results.q5Media && results.q5Media.ok]);
  if (want('room')) verdicts.push(['Q7 four-peer room', results.q7Room && results.q7Room.ok]);
  if (want('jitter')) verdicts.push(['Q8 jitter link', results.q8Jitter && results.q8Jitter.ok]);
  if (want('input')) verdicts.push(['Q9 input relay', results.q9Input && results.q9Input.ok]);
  if (soakSeconds > 0) verdicts.push([`Soak ${soakSeconds}s`, results.soak && results.soak.ok]);
  if (gameSeconds > 0) verdicts.push([`Game ${gameSeconds}s`, results.game && results.game.ok]);
  if (want('agent')) verdicts.push(['Q6 agent', results.q6Agent && results.q6Agent.ok]);
  log('');
  for (const [name, ok] of verdicts) log(`${name}: ${ok ? 'PASS' : 'FAIL'}`);
  const contentVerdict =
    bridgeContent === null ? 'NOT EXERCISED by these lanes' : bridgeContent ? 'PASS' : 'FAIL';
  log(`Q2 content script: ${contentVerdict}`);
  log('results.json written');
  process.exit(results.error ? 1 : 0);
}
