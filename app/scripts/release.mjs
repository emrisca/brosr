// Bumps the app version in the three files Tauri reads, moves the lock entry
// and prints the tag command. One version, one release.
//
//   npm run release 0.3.0
//   npm run release 0.3.0 -- --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');

const FILES = {
  package: path.join(app, 'package.json'),
  manifest: path.join(app, 'package-lock.json'),
  conf: path.join(app, 'src-tauri', 'tauri.conf.json'),
  cargo: path.join(app, 'src-tauri', 'Cargo.toml'),
  lock: path.join(app, 'src-tauri', 'Cargo.lock'),
};

const SEMVER = /^\d+\.\d+\.\d+$/;

const args = process.argv.slice(2);
const version = args.find((value) => !value.startsWith('--')) || '';
const dry = args.includes('--dry-run');

function stop(why) {
  console.error(`[brosr] ${why}`);
  process.exit(1);
}

if (!SEMVER.test(version)) {
  stop('usage: npm run release <major.minor.patch> [-- --dry-run]');
}

const read = (file) => fs.readFileSync(file, 'utf8');

// Every release starts from one version. A tree that already disagrees would
// carry the disagreement into the tag.
function current() {
  const pkg = JSON.parse(read(FILES.package)).version;
  const conf = JSON.parse(read(FILES.conf)).version;
  const cargo = /^\[package\][\s\S]*?\nversion = "([^"]+)"/m.exec(read(FILES.cargo));
  const found = { package: pkg, conf, cargo: cargo ? cargo[1] : null };
  const values = [...new Set(Object.values(found))];
  if (values.length !== 1 || !values[0]) {
    stop(`the version files disagree: ${JSON.stringify(found)}`);
  }
  return values[0];
}

const from = current();
if (from === version) stop(`the tree is already on ${version}`);

const writes = [];

// JSON files keep their two space shape and the trailing newline.
function writeJson(file, change) {
  const text = read(file);
  const data = JSON.parse(text);
  change(data);
  writes.push({ file, text: JSON.stringify(data, null, 2) + '\n' });
}

// The Cargo files are TOML. Only the version line of the named block moves, so
// comments and ordering stay as they are.
function writeCargo(file, block) {
  const text = read(file);
  const pattern =
    block === 'package'
      ? /(\[package\][\s\S]*?\r?\nversion = ")[^"]+(")/
      : /(\[\[package\]\]\r?\nname = "brosr-app"\r?\nversion = ")[^"]+(")/;
  if (!pattern.test(text)) stop(`no ${block} version in ${path.basename(file)}`);
  writes.push({ file, text: text.replace(pattern, `$1${version}$2`) });
}

writeJson(FILES.package, (data) => {
  data.version = version;
});
// npm records the root version twice in its lock. Both move together, so the
// lock and the bundle never disagree.
if (fs.existsSync(FILES.manifest)) {
  writeJson(FILES.manifest, (data) => {
    data.version = version;
    if (data.packages && data.packages['']) data.packages[''].version = version;
  });
}
writeJson(FILES.conf, (data) => {
  data.version = version;
});
writeCargo(FILES.cargo, 'package');
// Tauri reads the lock file too. Its own package entry carries no checksum, so
// the version moves here without a cargo run.
if (fs.existsSync(FILES.lock)) writeCargo(FILES.lock, 'package-entry');

const changed = writes.filter((entry) => entry.text !== read(entry.file));

console.log(`[brosr] ${from} -> ${version}${dry ? ' (dry run)' : ''}`);
for (const entry of writes) {
  const state = changed.some((item) => item.file === entry.file) ? 'write' : 'same';
  console.log(`[brosr] ${state} ${path.relative(app, entry.file)}`);
}

if (dry) {
  console.log('[brosr] nothing written. Drop --dry-run to keep the change.');
  process.exit(0);
}

for (const entry of writes) fs.writeFileSync(entry.file, entry.text);

const files = writes.map((entry) => path.relative(app, entry.file)).join(' ');
console.log('');
console.log('[brosr] next:');
console.log(`  git add ${files}`);
console.log(`  git commit -m "Release ${version}"`);
console.log(`  git tag -a v${version} -m "Brosr ${version}"`);
console.log(`  git push origin HEAD v${version}`);
