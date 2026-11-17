// Stages the host runtime into src-tauri/resources, because the bundle runs
// host/cli.mjs and that file imports core, zen and a few spike helpers. The
// folder is generated, never committed, and rebuilt on every frontend build so
// a shipped file cannot be older than its source.
//
//   node scripts/stage-host.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');
const repo = path.join(app, '..');
const out = path.join(app, 'src-tauri', 'resources');

// One entry per file the host opens at run time. A missing entry stops the
// build here, not on a user's first launch.
const FILES = [
  'host/cli.mjs',
  'host/room.mjs',
  'host/panel.mjs',
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
  'bridge/manifest.json',
  'bridge/manifest.chrome.json',
  'bridge/background.js',
  'bridge/content.js',
  // content.js injects this page-scope script, and the profile builder packs
  // it into both extension builds. Without it, prepare stops on a missing file.
  'bridge/bridge-youtube.js',
  'bridge/panel/room.html',
  'bridge/panel/room.css',
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

function stop(why) {
  console.error(`[stage-host] ${why}`);
  process.exit(1);
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

// Every staged module can import another staged file, and the list above is
// kept by hand. A missed entry ships a tree that only fails on a user's first
// launch, so each relative import is resolved against the staged copy and a
// target that never landed stops the build here.
const IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
const SERVER_SIDE = ['host/', 'core/', 'zen/', 'spike/'];
const holes = [];
for (const relative of copied) {
  if (!/\.(mjs|js)$/.test(relative)) continue;
  if (!SERVER_SIDE.some((prefix) => relative.startsWith(prefix))) continue;
  const file = path.join(out, relative);
  for (const match of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!target.startsWith(out + path.sep)) continue;
    if (fs.existsSync(target)) continue;
    holes.push(`${relative} imports ${match[1]}`);
  }
}
if (holes.length) stop(`staged modules import files that did not land:\n  ${holes.sort().join('\n  ')}`);

// The app reads these names, so a bundle that lost one fails here.
for (const required of [
  'host/cli.mjs',
  'host/bookmarks.mjs',
  'core/seal.mjs',
  'bridge/manifest.json',
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

const kb = Math.round(bytes / 1024);
console.log(`[stage-host] ${count} files, ${kb} KB -> src-tauri/resources`);
