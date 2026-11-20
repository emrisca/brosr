// Creates the Zen room profile. Pref names come from the shipped build's
// browser/defaults/preferences/firefox.js, so they match what Zen reads.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findZen as pickZen } from './binary.mjs';
import {
  EXTENSIONS,
  RUNTIME,
  cachedCopy,
  installExtensions,
  prepareSafeBrowsing,
  stageExtensions,
} from './safe-browsing.mjs';
import { SITES, bookmarksHtml } from '../host/bookmarks.mjs';
import { zipEntry } from '../spike/unzip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

// Full uBlock Origin is the reason this build is Firefox based. The room
// profile gets the whole safe browsing set from signed XPIs, staged once and
// copied in, so a new room starts blocked. The catalogue lives in
// safe-browsing.mjs, and this file keeps the blocker entry for a caller that
// only asks one question.
export const BLOCKER = EXTENSIONS[0];

export const BRIDGE_ID = 'bridge@brosr.app';

// The bridge is the second extension, and a room has no cursors without it. The
// profile gets it as a file, the same way the blockers arrive, so no run needs a
// prompt. A profile with signature checking on takes only the signed file, so
// the resolver prefers that one until the current build is newer. It names the
// file it picked either way.
const BRIDGE_SIGNED = 'bridge-signed.xpi';
const BRIDGE_BUILT = 'bridge.xpi';
const SOURCE_MANIFEST = path.join(here, '..', 'bridge', 'manifest.json');

function sourceVersion() {
  try {
    return JSON.parse(fs.readFileSync(SOURCE_MANIFEST, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function inspect(file) {
  const found = { path: file, version: null, signed: false, error: null };
  try {
    const manifest = JSON.parse(zipEntry(file, 'manifest.json').toString('utf8'));
    found.version = manifest.version || null;
    found.signed = Boolean(zipEntry(file, 'META-INF/mozilla.rsa'));
  } catch (error) {
    found.error = error.message;
  }
  return found;
}

// The signed file wins, because the alternative is a profile that refuses the
// add-on. A signed copy that is older than the current build would install a
// panel without this tree's fix, so the newer file wins and the signature pref
// follows the file that lands. The report names the file and any version gap.
export function bridgeSource(dir = RUNTIME) {
  const want = sourceVersion();
  const errors = [];
  // The signed file wins, so a signed copy left over from an earlier build
  // would install silently and drop the current panel. Name that state.
  const signedFile = path.join(dir, BRIDGE_SIGNED);
  const builtFile = path.join(dir, BRIDGE_BUILT);
  const signedBehind = (() => {
    try {
      return (
        fs.statSync(builtFile).mtimeMs > fs.statSync(signedFile).mtimeMs
      );
    } catch {
      return false;
    }
  })();
  const order = signedBehind ? [BRIDGE_BUILT, BRIDGE_SIGNED] : [BRIDGE_SIGNED, BRIDGE_BUILT];
  for (const name of order) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const found = inspect(file);
    if (found.error) {
      errors.push(`${name}: ${found.error}`);
      continue;
    }
    return {
      ...found,
      name,
      want,
      stale: Boolean(want && found.version && found.version !== want),
      signedBehind,
      signaturesRequired: found.signed,
      errors,
    };
  }
  return {
    path: null,
    name: null,
    version: null,
    want,
    signed: false,
    stale: false,
    signedBehind,
    signaturesRequired: false,
    errors,
  };
}

export function installBridge(profile, dir = RUNTIME) {
  const source = bridgeSource(dir);
  if (!source.path) return { installed: false, ...source };
  const dest = path.join(profile, 'extensions');
  fs.mkdirSync(dest, { recursive: true });
  const file = path.join(dest, `${BRIDGE_ID}.xpi`);
  fs.copyFileSync(source.path, file);
  return { installed: true, file, ...source };
}

// A release reads the same resolver a room uses. A signed copy that lags the
// source would ship an older panel with signature checking on, so this reports
// the gap instead of letting the install hide it.
export function signedGap(dir = RUNTIME) {
  const want = sourceVersion();
  const name = BRIDGE_SIGNED;
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return { ok: false, reason: 'no signed copy', name, version: null, want };
  const found = inspect(file);
  if (found.error) return { ok: false, reason: found.error, name, version: null, want };
  if (!found.signed) return { ok: false, reason: 'the signed copy has no signature', name, version: found.version, want };
  if (!want) return { ok: false, reason: 'no source manifest to compare', name, version: found.version, want };
  if (found.version !== want) {
    return {
      ok: false,
      reason: `signed ${found.version} but source is ${want}`,
      name,
      version: found.version,
      want,
    };
  }
  return { ok: true, reason: 'signed copy matches the source', name, version: found.version, want };
}

// A named file reports the same shape as bridgeSource, so the CLI can print the
// build it actually installed instead of the default one.
export function bridgeFile(file) {
  const found = inspect(file);
  const want = sourceVersion();
  return {
    ...found,
    name: path.basename(file),
    want,
    stale: Boolean(want && found.version && found.version !== want),
    signedBehind: false,
    signaturesRequired: found.signed,
    errors: found.error ? [found.error] : [],
  };
}

// A named file installs as it is, so a run of the current tree does not wait
// for AMO. The signature pref follows the file, and an unsigned build needs the
// check off.
export function installBridgeFile(profile, file) {
  const found = inspect(file);
  if (found.error) return { installed: false, ...found, signaturesRequired: false };
  const dest = path.join(profile, 'extensions');
  fs.mkdirSync(dest, { recursive: true });
  const target = path.join(dest, `${BRIDGE_ID}.xpi`);
  fs.copyFileSync(file, target);
  return {
    installed: true,
    file: target,
    ...found,
    name: path.basename(file),
    signaturesRequired: found.signed,
  };
}

export function findZen() {
  return pickZen(arg('zen', ''));
}

// Vertical tabs and compact chrome are the Zen shape. The rest keeps the
// profile quiet, because a room is not a browsing session.
const PREFS = [
  ['zen.tabs.vertical', true],
  ['zen.tabs.vertical.right-side', false],
  // Single toolbar parks the URL bar inside the tab column. Off puts it across
  // the top of the page, which is the layout a room wants.
  ['zen.view.use-single-toolbar', false],
  ['zen.view.compact.hide-tabbar', false],
  ['zen.view.compact.hide-toolbar', false],
  ['zen.view.compact.show-sidebar-and-toolbar-on-hover', true],
  ['zen.view.sidebar-expanded', true],
  ['zen.view.sidebar-expanded.max-width', 640],
  ['zen.view.show-newtab-button-top', true],
  ['zen.workspaces.continue-where-left-off', false],
  ['zen.theme.hide-unified-extensions-button', false],
  ['browser.shell.checkDefaultBrowser', false],
  ['browser.startup.page', 0],
  ['browser.startup.homepage', 'about:blank'],
  // The welcome flow is what creates the Zen Basics tab group. A room does not
  // need it, and the profile removes its session state below as well.
  ['zen.welcome-screen.seen', true],
  ['browser.startup.homepage_override.mstone', 'ignore'],
  ['datareporting.policy.dataSubmissionEnabled', false],
  ['toolkit.telemetry.enabled', false],
  ['toolkit.legacyUserProfileCustomizations.stylesheets', true],
  // The dock paints the window surface at 90 percent, so the macOS window needs
  // its material on and the browser layers must allow a see through surface.
  ['zen.widget.macos.window-vibrancy', true],
  ['browser.tabs.allow_transparent_browser', true],
  // The add-ons arrive as sideloaded signed XPIs, so the profile must allow that
  // scope and must not disable them on first start. The signature pref is not in
  // this list, because it follows the bridge file the profile actually gets.
  ['extensions.autoDisableScopes', 0],
  ['extensions.enabledScopes', 15],
  // A new profile imports bookmarks.html once at first start, then clears this
  // pref itself, so the import does not run a second time.
  ['browser.places.importBookmarksHTML', true],
  // The essentials strip at the column top reads this list. The profile seeds
  // the two pages a room opens first, so the strip is filled on the first
  // start and a reused profile keeps whatever the room put there.
  ['brosr.sites', JSON.stringify(['https://www.youtube.com/', 'https://fmhy.net/'])],
  // DNS-over-HTTPS (mode 2 falls back to native DNS for local/LAN hosts) plus
  // Encrypted Client Hello keeps ISP DNS/SNI filters from breaking Watch links.
  ['network.trr.mode', 2],
  ['network.trr.uri', 'https://mozilla.cloudflare-dns.com/dns-query'],
  ['network.dns.echconfig.enabled', true],
  ['network.dns.http3_echconfig.enabled', true],
];

function userJs(signaturesRequired, native) {
  // A plain Gecko browser ignores the zen.* names, but a profile should not
  // carry preferences that only one fork reads. A native adapter keeps them.
  const prefs = native ? PREFS : PREFS.filter(([name]) => !name.startsWith('zen.'));
  const lines = [
    '// Written by host/cli.mjs. The room profile is disposable.',
    '// Edit this file and rerun the setup step.',
    '',
  ];
  for (const [name, value] of [
    ...prefs,
    ['xpinstall.signatures.required', signaturesRequired],
  ]) {
    lines.push(`user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
  }
  return lines.join('\n') + '\n';
}


// Zen restores the sidebar width from xulstore.json, and its own default on
// macOS is 230 pixels. The room panel shares that column, so it starts a little
// wider than Zen and no wider than the panel needs.
const XULSTORE_DOC = 'chrome://browser/content/browser.xhtml';
const SIDEBAR_WIDTH = '320px';
// A room is the whole job of this window, so it opens zoomed to the screen
// instead of at the size Zen stored. The window manager reads that mode from
// the same store as the width.
const WINDOW_MODE = 'maximized';

// Room profiles start with no bookmarks. The landing page is the site list.
const BOOKMARKS = SITES;

function writeBookmarks(profile) {
  fs.writeFileSync(path.join(profile, 'bookmarks.html'), bookmarksHtml());
}

// Gecko imports bookmarks.html only into a new places database. A profile made
// before the list grew keeps its old database, so this drops that database once
// per bookmark set. A later room keeps the bookmarks a person added.
function resetBookmarkDatabase(profile, hash) {
  const marker = path.join(profile, 'brosr-bookmarks.json');
  let seen = null;
  try {
    seen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    seen = null;
  }
  if (seen && seen.hash === hash) return false;
  for (const name of ['places.sqlite', 'places.sqlite-wal', 'places.sqlite-shm', 'bookmarkbackups']) {
    fs.rmSync(path.join(profile, name), { recursive: true, force: true });
  }
  fs.writeFileSync(
    marker,
    JSON.stringify({ version: 1, hash, bookmarks: BOOKMARKS.length }, null, 2) + '\n'
  );
  return true;
}

// Zen stores the welcome tab group in both the normal session and its own
// workspace sessions. Clearing them before a room starts keeps Zen Basics out
// of the profile; the room opens the URL it was given instead of restoring tabs.
export function clearSessions(profile) {
  for (const name of [
    'sessionstore.jsonlz4',
    'sessionstore-backups',
    'zen-sessions.jsonlz4',
    'zen-sessions-backup',
    'zen-live-folders.jsonlz4',
    'sessionCheckpoints.json',
    'recovery.jsonlz4',
    'recovery.baklz4',
  ]) {
    fs.rmSync(path.join(profile, name), { recursive: true, force: true });
  }
}

function writeXulstore(profile) {
  const file = path.join(profile, 'xulstore.json');
  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A new profile has no store yet.
  }
  const doc = store[XULSTORE_DOC] || {};
  doc['navigator-toolbox'] = { ...(doc['navigator-toolbox'] || {}), width: SIDEBAR_WIDTH };
  doc['main-window'] = { ...(doc['main-window'] || {}), sizemode: WINDOW_MODE };
  store[XULSTORE_DOC] = doc;
  fs.writeFileSync(file, JSON.stringify(store));
}

// A profile built before the set changed still holds the old add-on, and a
// reused profile is never written again. The folder is reconciled on every
// prepare, so only the bridge and the current catalogue stay.
function pruneExtensions(profile) {
  const dest = path.join(profile, 'extensions');
  if (!fs.existsSync(dest)) return;
  const keep = new Set([`${BRIDGE_ID}.xpi`, ...EXTENSIONS.map((entry) => entry.file)]);
  for (const name of fs.readdirSync(dest)) {
    if (!name.endsWith('.xpi') || keep.has(name)) continue;
    fs.rmSync(path.join(dest, name), { force: true });
  }
}

// The bridge goes in before the first window, and the signature pref follows the
// file that landed. Pass bridge false for a harness that installs its own build
// over BiDi, because signature checking would refuse that one. Pass a file path
// to install a named build, such as the unsigned copy of the current tree.
export function writeProfile(dir, options = {}) {
  const profile = path.resolve(dir);
  // Only a native adapter, which today means Zen, reads the column width from
  // xulstore. A stock Gecko browser starts on its own width.
  const native = options.native !== false;
  fs.mkdirSync(profile, { recursive: true });
  clearSessions(profile);
  const bridge =
    options.bridge === false
      ? { installed: false, signaturesRequired: false }
      : typeof options.bridge === 'string'
        ? installBridgeFile(profile, options.bridge)
        : installBridge(profile);
  fs.writeFileSync(path.join(profile, 'user.js'), userJs(bridge.signaturesRequired, native));
  resetBookmarkDatabase(
    profile,
    createHash('sha256').update(JSON.stringify(BOOKMARKS)).digest('hex')
  );
  writeBookmarks(profile);
  if (native) writeXulstore(profile);
  installExtensions(profile);
  return profile;
}

// A room opens the same profile on every start, and a second build with the same
// inputs copies the same files for nothing. This stamp records what went in, so
// a match skips the copy and the profile is ready at once.
const STAMP = 'brosr-profile.json';

function inputStamp(options) {
  const runtime = options.runtime || RUNTIME;
  const parts = [options.native === false ? 'native:0' : 'native:1'];
  // A pref or bookmark edit changes the stamp, so the profile is written again.
  parts.push(
    createHash('sha256')
      .update(JSON.stringify(PREFS) + JSON.stringify(BOOKMARKS) + SIDEBAR_WIDTH + WINDOW_MODE)
      .digest('hex')
  );
  if (options.bridge) {
    try {
      const stat = fs.statSync(options.bridge);
      parts.push(`bridge:${path.basename(options.bridge)}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {
      parts.push('bridge:missing');
    }
  } else {
    parts.push('bridge:default');
  }
  for (const entry of EXTENSIONS) {
    const file = cachedCopy(entry, runtime);
    if (!file) {
      parts.push(`${entry.id}:missing`);
      continue;
    }
    const stat = fs.statSync(file);
    parts.push(`${entry.id}:${stat.size}:${Math.round(stat.mtimeMs)}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function readStamp(profile) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profile, STAMP), 'utf8'));
  } catch {
    return null;
  }
}

// A stamp counts only when every extension landed, so a download that failed is
// retried on the next run instead of being remembered as done. A reuse request
// also stands aside for a configure pass, a refresh or a force.
function reusable(profile, options, want) {
  if (!options.reuse) return null;
  if (options.force || options.refresh || options.configure) return null;
  const seen = readStamp(profile);
  if (!seen || !seen.complete || seen.input !== want) return null;
  return seen;
}

function writeStamp(profile, stamp) {
  fs.writeFileSync(path.join(profile, STAMP), JSON.stringify(stamp, null, 2) + '\n');
}

// One call for the start path. It stages every extension first, so the profile
// copies land in the same pass as the prefs that enable them. The optional
// configure pass runs the one headless setup for the list.
export async function prepareProfile(dir, options = {}) {
  // Three stages, each reported on the way in. The app turns them into a bar,
  // so a slow fetch looks like work and not a stall.
  const total = 3;
  const report = (step, label) => {
    if (typeof options.onProgress === 'function') options.onProgress({ step, total, label });
  };
  const profile = path.resolve(dir);
  const runtime = options.runtime || RUNTIME;
  clearSessions(profile);
  pruneExtensions(profile);
  // The add-ons land before the stamp is read. A stamp taken before the first
  // download names four missing files, so the run after it could never match
  // and every start rewrote the profile for nothing.
  const cold = EXTENSIONS.some((entry) => !cachedCopy(entry, runtime));
  report(1, cold ? 'Fetching add-ons' : 'Checking add-ons');
  const staged = await stageExtensions(runtime, {
    onEach: cold ? (done) => report(1, `Fetching add-ons, ${done} of ${EXTENSIONS.length}`) : null,
  });
  const input = inputStamp({ ...options, runtime });
  const seen = reusable(profile, options, input);
  if (seen) {
    report(total, 'Room profile ready');
    return {
      profile,
      reused: true,
      blocker: Boolean(seen.blocker),
      safeBrowsing: {
        staged: { ready: seen.extensions, missing: [] },
        installed: seen.extensions,
        configured: Boolean(seen.configured),
        marker: null,
      },
      staged: { ready: seen.extensions, missing: [] },
    };
  }
  report(2, 'Writing the profile');
  writeProfile(profile, { bridge: options.bridge, native: options.native });
  const safeBrowsing = await prepareSafeBrowsing(profile, {
    configure: Boolean(options.configure),
    refresh: Boolean(options.refresh),
    force: Boolean(options.force),
    port: options.port,
    log: options.log,
    report,
    staged,
    dir: runtime,
  });
  report(total, 'Room profile ready');
  const blocker = safeBrowsing.installed.includes(BLOCKER.id);
  if (!staged.missing.length && safeBrowsing.installed.length === EXTENSIONS.length) {
    writeStamp(profile, {
      when: new Date().toISOString(),
      input,
      complete: true,
      extensions: safeBrowsing.installed,
      blocker,
      configured: Boolean(safeBrowsing.configured),
    });
  }
  return { profile, reused: false, blocker, safeBrowsing, staged };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A guard reads the shipped files only, so it works before a profile exists
  // and a release can refuse a signed copy that lags the tree.
  if (process.argv.includes('--guard')) {
    const gap = signedGap(arg('dir', RUNTIME));
    console.log(JSON.stringify(gap));
    process.exit(gap.ok ? 0 : 1);
  }
  // A named build wins over the default resolver, and a typo fails here rather
  // than leaving a profile with no bridge and a silent signature pref.
  const named = arg('bridge', '');
  if (named && !fs.existsSync(named)) {
    console.error(`[zen] no bridge at ${named}`);
    process.exit(1);
  }
  const { profile, safeBrowsing } = await prepareProfile(
    arg('profile', path.join(here, '.runtime', 'profile')),
    {
      bridge: named || undefined,
      // A refresh fetches the list again, so it needs the pass as well.
      configure: process.argv.includes('--configure') || process.argv.includes('--refresh'),
      refresh: process.argv.includes('--refresh'),
      force: process.argv.includes('--force'),
      port: arg('port', '9341'),
      log: (line) => console.error(`[zen] ${line}`),
    }
  );
  const zen = findZen();
  console.log(`[zen] profile ${profile}`);
  console.log(`[zen] extensions ${safeBrowsing.installed.length} of ${EXTENSIONS.length} installed`);
  const bridge = named ? bridgeFile(named) : bridgeSource();
  console.log(
    bridge.path
      ? `[zen] bridge ${bridge.version || 'unknown'} from ${bridge.name}, signed ${bridge.signed}, signatures required ${bridge.signaturesRequired}${bridge.stale ? `, source is ${bridge.want}` : ''}`
      : `[zen] bridge missing. Run node zen/package.mjs or put the signed file in ${RUNTIME}`
  );
  if (bridge.signedBehind) {
    console.log(
      '[zen] the signed copy is older than bridge.xpi. Sign the current build before a room relies on it.'
    );
  }
  for (const miss of safeBrowsing.staged.missing) {
    console.log(`[zen] ${miss.name} is missing: ${miss.why}`);
  }
  if (safeBrowsing.configured) console.log('[zen] uBlock Origin holds the FMHY list');
  if (process.argv.includes('--refresh')) console.log('[zen] list refreshed from upstream');
  if (safeBrowsing.error) console.log(`[zen] the setup pass failed: ${safeBrowsing.error}`);
  if (!zen) {
    console.log('[zen] no Zen binary found. Pass --zen=<path>.');
    process.exit(1);
  }
  const room = arg('room', 'zen');
  const base = arg('base', 'http://127.0.0.1:8787/room-b.html');
  const url = `${base}?role=host&room=${room}&peer=host&name=Host`;
  console.log(`[zen] binary ${zen}`);
  console.log(`[zen] launch "${zen}" --profile "${profile}" --no-remote --new-instance "${url}"`);
}
