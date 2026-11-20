// Stages the host runtime into src-tauri/resources, because the bundle runs
// host/cli.mjs and that file imports core, zen and a few spike helpers. The
// folder is generated, never committed, and rebuilt on every frontend build so
// a shipped file cannot be older than its source.
//
//   node scripts/stage-host.mjs [--out <dir>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');
const repo = path.join(app, '..');

function argValue(name) {
  const flag = `--${name}`;
  const hit = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  if (hit) return hit.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : '';
}

const outOverride = argValue('out') || String(process.env.BROSR_STAGE_OUT || '').trim();
const out = outOverride ? path.resolve(outOverride) : path.join(app, 'src-tauri', 'resources');
const relayName = process.platform === 'win32' ? 'brosr-relay.exe' : 'brosr-relay';

function stop(why) {
  console.error(`[stage-host] ${why}`);
  process.exit(1);
}

// Resolve an optional Rust relay binary before modifying the output folder so a
// bad BROSR_RELAY_BIN fails fast with a clear diagnosis instead of silently
// shipping only the Node fallback.
function resolveRelaySource() {
  const explicit = String(process.env.BROSR_RELAY_BIN || '').trim();
  if (explicit) {
    const candidate = path.resolve(explicit);
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      stop(`BROSR_RELAY_BIN does not exist: ${candidate}`);
    }
    if (!stat.isFile()) {
      stop(`BROSR_RELAY_BIN is not a file: ${candidate}`);
    }
    return candidate;
  }
  const built = path.join(repo, 'relay', 'target', 'release', relayName);
  try {
    if (fs.statSync(built).isFile()) return built;
  } catch {
    // Optional when a local dev build has not compiled relay/ yet.
  }
  return '';
}

const relaySource = resolveRelaySource();

// One entry per file the host opens at run time. A missing entry stops the
// build here, not on a user's first launch.
const FILES = [
  'host/cli.mjs',
  'host/room.mjs',
  'host/panel.mjs',
  // The panel reads the sync report through this loader, which survives the
  // module type app/package.json puts on the staged tree.
  'host/report.mjs',
  // The room spawns trust.mjs by path rather than static import, and trust.mjs
  // imports chrome-cdp.mjs for Chromium builds. Both must land in the bundle.
  'host/trust.mjs',
  'host/chrome-cdp.mjs',
  // The room imports the hold helper, which imports the pipe client. A bundle
  // without either one stops on the first Chrome start.
  'host/chrome-hold.mjs',
  'host/chrome-pipe.mjs',
  'host/browsers.mjs',
  'host/pstream.mjs',
  'host/bookmarks.mjs',
  'host/friends.mjs',
  'host/lobby.mjs',
  'host/discovery.mjs',
  // The CLI imports both for the stop and session commands.
  'host/blockers.mjs',
  'host/session.mjs',
  'core/package.json',
  'zen/binary.mjs',
  'zen/package.mjs',
  'zen/profile.mjs',
  'zen/safe-browsing.mjs',
  // The relay is CommonJS. This file pins that, because an ancestor
  // package.json with type module would otherwise make node refuse it.
  'spike/package.json',
  'spike/relay.js',
  'spike/zip.mjs',
  'spike/unzip.mjs',
  'spike/bidi.mjs',
  // Keep resources/relay present and non-empty in every build so Tauri's
  // bundle.resources entry works both with and without a compiled Rust relay.
  'relay/README.md',
  'bridge/manifest.json',
  'bridge/manifest.chrome.json',
  'bridge/background.js',
  'bridge/content.js',
  // content.js injects this page-scope script, and the profile builder packs
  // it into both extension builds. Without it, prepare stops on a missing file.
  'bridge/bridge-youtube.js',
  'bridge/panel/room.html',
  'bridge/panel/room.css',
  'bridge/panel/sync-report.js',
  'bridge/panel/room.js',
];

// Whole families. The bridge embeds these, and the profile builder reads the
// same icons.
const GLOBS = [
  { dir: 'core', test: (name) => name.endsWith('.mjs') },
  { dir: 'assets', test: (name) => /^(icon|action)-\d+\.png$/.test(name) },
];

// Folders, copied whole. The relay serves the room page, its scripts and the
// fixtures straight from spike/fixtures, and the start path waits for a 200 on
// room-b.html. A bundle without this tree looks like a relay that never came
// up, which is the error the setup screen shows. The landing tree is the front
// door that relay answers with, so it ships beside the fixtures.
const TREES = ['spike/fixtures', 'landing'];

function copyTree(relative) {
  const from = path.join(repo, relative);
  if (!fs.existsSync(from)) stop(`missing source ${relative}`);
  let files = 0;
  let size = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Editor and sync leftovers are not part of the build.
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const to = path.join(out, path.relative(repo, full));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(full, to);
      files += 1;
      size += fs.statSync(to).size;
    }
  };
  walk(from);
  if (!files) stop(`${relative} holds no files`);
  return { files, size };
}

function copy(relative) {
  const from = path.join(repo, relative);
  if (!fs.existsSync(from)) stop(`missing source ${relative}`);
  const to = path.join(out, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

fs.rmSync(out, { recursive: true, force: true });

let count = 0;
let bytes = 0;
const copied = [];
for (const relative of FILES) {
  bytes += copy(relative);
  copied.push(relative);
  count += 1;
}

for (const { dir, test } of GLOBS) {
  const full = path.join(repo, dir);
  if (!fs.existsSync(full)) stop(`missing source ${dir}`);
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (!entry.isFile() || !test(entry.name)) continue;
    const relative = path.join(dir, entry.name);
    bytes += copy(relative);
    copied.push(relative);
    count += 1;
  }
}

for (const relative of TREES) {
  const tree = copyTree(relative);
  bytes += tree.size;
  count += tree.files;
}

let stagedRelayRel = '';
if (relaySource) {
  stagedRelayRel = path.join('relay', relayName);
  const to = path.join(out, stagedRelayRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(relaySource, to);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(relaySource).mode & 0o777;
    fs.chmodSync(to, mode);
  }
  bytes += fs.statSync(to).size;
  count += 1;
}

// Every staged module can import another staged file or spawn a sibling script
// by path, and the list above is kept by hand. A missed entry ships a tree that
// only fails on a user's first launch, so each relative import and sibling
// helper path is resolved against the staged copy and stops the build here.
const IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
const SIBLING_SCRIPT =
  /path\.join\(\s*here\s*,\s*['"]([^'"]+\.(?:mjs|js))['"]\s*\)/g;
const SERVER_SIDE = ['host/', 'core/', 'zen/', 'spike/'];
const holes = [];
for (const relative of copied) {
  if (!/\.(mjs|js)$/.test(relative)) continue;
  if (!SERVER_SIDE.some((prefix) => relative.startsWith(prefix))) continue;
  const file = path.join(out, relative);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!target.startsWith(out + path.sep)) continue;
    if (fs.existsSync(target)) continue;
    holes.push(`${relative} imports ${match[1]}`);
  }
  for (const match of source.matchAll(SIBLING_SCRIPT)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!target.startsWith(out + path.sep)) continue;
    if (fs.existsSync(target)) continue;
    holes.push(`${relative} spawns ${match[1]}`);
  }
}
if (holes.length) stop(`staged modules reference files that did not land:\n  ${holes.sort().join('\n  ')}`);

// The app reads these names, so a bundle that lost one fails here.
for (const required of [
  'host/cli.mjs',
  'host/bookmarks.mjs',
  'host/trust.mjs',
  'host/chrome-cdp.mjs',
  'core/seal.mjs',
  'bridge/manifest.json',
  'spike/relay.js',
  'relay/README.md',
  'spike/fixtures/room-b.html',
  'spike/fixtures/sync.html',
  'landing/index.html',
  'landing/canvas/canvas.js',
  'landing/chess/index.html',
  'landing/chess/chess.js',
  'landing/chess/chess-engine.mjs',
]) {
  if (!fs.existsSync(path.join(out, required))) stop(`staged tree lacks ${required}`);
}
if (stagedRelayRel && !fs.existsSync(path.join(out, stagedRelayRel))) {
  stop(`staged tree lacks ${stagedRelayRel}`);
}

// Verify the staged runtime actually imports and spawns from the staged tree.
const realOut = fs.realpathSync(out);
const roomImport = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(path.join(realOut, 'host', 'room.mjs')).href],
  { cwd: realOut, encoding: 'utf8' }
);
if (roomImport.status !== 0) {
  stop(`staged host/room.mjs failed to import: ${(roomImport.stderr || roomImport.stdout || '').trim()}`);
}

const trustProbe = spawnSync(process.execPath, [path.join(realOut, 'host', 'trust.mjs')], {
  cwd: realOut,
  encoding: 'utf8',
});
if (trustProbe.status !== 2 || !/--debug-port/.test(trustProbe.stderr || '')) {
  stop(
    `staged host/trust.mjs spawn check failed (status ${trustProbe.status}): ${(trustProbe.stderr || trustProbe.stdout || '').trim()}`
  );
}

const kb = Math.round(bytes / 1024);
const destLabel = outOverride ? out : 'src-tauri/resources';
const relayNote = stagedRelayRel ? ` (with ${stagedRelayRel})` : '';
console.log(`[stage-host] ${count} files, ${kb} KB -> ${destLabel}${relayNote}`);
