// One updater feed for every platform. Three release jobs used to write this
// one file at once, so the last job to finish won with only its own platform in
// it, and Apple Silicon was left with no update. The builds now upload their
// signed bundles and signatures, and this script turns those into one feed.
import fs from 'node:fs';
import path from 'node:path';

// A caller can write --name=value or --name value. The release workflow uses
// the space form, and a parser that only knew the equals form read every value
// as empty and exited with a usage error after every platform had built.
function valueOf(name, fallback = '') {
  const flag = `--${name}`;
  const hit = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  if (hit) return hit.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const dir = valueOf('dir');
const tag = valueOf('tag');
const repo = valueOf('repo');
const notesPath = valueOf('notes');
const out = valueOf('out');
if (!dir || !tag || !repo || !out) {
  console.error(
    'usage: updater-json.mjs --dir=<signatures> --tag=<v0.0.0> --repo=<owner/name> --notes=<file> --out=<file>'
  );
  process.exit(2);
}

const version = tag.replace(/^v/, '');
const files = fs.readdirSync(dir);

// A signature names the asset it signed by dropping the suffix, so the feed
// needs no table of file names that a rename would quietly break.
function signed(pattern, description) {
  const name = files.find((entry) => pattern.test(entry));
  if (!name) {
    console.error(`latest.json needs ${description}, and no signature for it is attached.`);
    process.exit(1);
  }
  return {
    signature: fs.readFileSync(path.join(dir, name), 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${name.replace(/\.sig$/, '')}`,
  };
}

const msi = signed(/^Brosr_.*_x64_en-US\.msi\.sig$/, 'the Windows msi');
const exe = signed(/^Brosr_.*_x64-setup\.exe\.sig$/, 'the Windows exe setup');
const intel = signed(/^Brosr_x64\.app\.tar\.gz\.sig$/, 'the Intel Mac bundle');
const silicon = signed(/^Brosr_aarch64\.app\.tar\.gz\.sig$/, 'the Apple Silicon Mac bundle');

// The msi answers both the plain and the msi key because an older app can ask
// for either. The -app keys name the same tarball as their plain key.
const platforms = {
  'windows-x86_64': msi,
  'windows-x86_64-msi': msi,
  'windows-x86_64-nsis': exe,
  'darwin-x86_64': intel,
  'darwin-x86_64-app': intel,
  'darwin-aarch64': silicon,
  'darwin-aarch64-app': silicon,
};

const notes = notesPath && fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : '';
const feed = { version, notes, pub_date: new Date().toISOString(), platforms };
fs.writeFileSync(out, JSON.stringify(feed, null, 2) + '\n');
console.log(`latest.json for ${version}: ${Object.keys(platforms).join(', ')}`);
