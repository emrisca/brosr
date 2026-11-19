// The app carries an updater, and an install accepts a release only when the
// bundle signature checks out against the pubkey in the Tauri config. This lane
// reads the published feed the way an installed app does: fetch latest.json,
// require an entry and a signature for every platform, download this machine's
// bundle, and verify the minisign signature before trusting the file. When a
// local Brosr.app is installed, the lane also proves the installed binary is
// the published one and that the versions agree.
//
//   node scripts/check-updater-feed.mjs
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  fs.readFileSync(path.join(root, 'app', 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const updater = (config.plugins && config.plugins.updater) || {};
const endpoint = (updater.endpoints || [])[0];
const pubkey = updater.pubkey;

const PLATFORMS = [
  'darwin-aarch64',
  'darwin-aarch64-app',
  'darwin-x86_64',
  'darwin-x86_64-app',
  'windows-x86_64',
  'windows-x86_64-msi',
  'windows-x86_64-nsis',
];

const fail = (message) => {
  throw new Error(message);
};
const pass = (message) => console.log(`  ok ${message}`);

// A minisign key packet is algorithm[2], key id[8], key[32]. Tauri stores the
// key as base64 of the whole minisign document.
function publicKey(text) {
  const lines = Buffer.from(text, 'base64').toString('utf8').trim().split('\n');
  if (lines.length < 2) fail('the updater pubkey is not a minisign key');
  const packet = Buffer.from(lines[1], 'base64');
  if (packet.length !== 42) fail(`the updater pubkey packet is ${packet.length} bytes, not 42`);
  return {
    id: packet.subarray(2, 10).toString('hex'),
    key: crypto.createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: packet.subarray(10, 42).toString('base64url'),
      },
      format: 'jwk',
    }),
  };
}

// Tauri writes the whole minisign document as one base64 line. The packet is
// algorithm[2], key id[8], signature[64]. "ED" signs the blake2b hash, and
// "Ed" signs the bytes, so the algorithm decides what is verified.
function signature(text) {
  const raw = Buffer.from(text, 'base64').toString('utf8').trim();
  const lines = raw.startsWith('untrusted comment:') ? raw.split('\n') : null;
  if (!lines || lines.length < 3) fail('the updater signature is not a minisign document');
  const packet = Buffer.from(lines[1], 'base64');
  if (packet.length !== 74) fail(`the signature packet is ${packet.length} bytes, not 74`);
  return {
    algorithm: packet.subarray(0, 2).toString('latin1'),
    id: packet.subarray(2, 10).toString('hex'),
    bytes: packet.subarray(10, 74),
    trusted: lines[2].replace(/^trusted comment:\s*/, ''),
    global: lines[3] ? Buffer.from(lines[3], 'base64') : null,
  };
}

function verify(data, text, key) {
  const sig = signature(text);
  if (sig.id !== key.id) fail(`the signature names key ${sig.id}, not ${key.id}`);
  const message = sig.algorithm === 'ED'
    ? crypto.createHash('blake2b512').update(data).digest()
    : data;
  if (!crypto.verify(null, message, key.key, sig.bytes)) {
    fail(`the ${sig.algorithm} signature does not verify`);
  }
  if (sig.global && !crypto.verify(null, Buffer.concat([sig.bytes, Buffer.from(sig.trusted)]), key.key, sig.global)) {
    fail('the trusted comment signature does not verify');
  }
  return sig;
}

const total = await (async () => {
  if (!endpoint) fail('app/src-tauri/tauri.conf.json names no updater endpoint');
  if (!pubkey) fail('app/src-tauri/tauri.conf.json carries no updater pubkey');
  const key = publicKey(pubkey);
  console.log(`feed ${endpoint}`);

  const answer = await fetch(endpoint, { redirect: 'follow' });
  if (!answer.ok) fail(`latest.json answers ${answer.status}`);
  const feed = await answer.json();
  if (!/^\d+\.\d+\.\d+$/.test(feed.version || '')) fail(`the feed names version ${feed.version}`);
  if (!Number.isFinite(Date.parse(feed.pub_date))) fail(`the feed names pub_date ${feed.pub_date}`);
  pass(`the feed publishes ${feed.version} from ${feed.pub_date}`);

  const seen = Object.keys(feed.platforms || {}).sort();
  if (seen.join(',') !== [...PLATFORMS].sort().join(',')) {
    fail(`the feed covers ${seen.join(', ')}, not all seven platforms`);
  }
  for (const name of PLATFORMS) {
    const entry = feed.platforms[name];
    if (!entry || typeof entry.url !== 'string' || !entry.url.startsWith('https://github.com/')) {
      fail(`the feed has no release url for ${name}`);
    }
    if (!entry.signature) fail(`the feed has no signature for ${name}`);
  }
  pass('every platform carries a release url and a signature');

  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const platform = process.platform === 'darwin' ? `darwin-${arch}` : `windows-x86_64`;
  const entry = feed.platforms[platform];
  console.log(`bundle ${platform} ${entry.url}`);
  const bundle = await fetch(entry.url, { redirect: 'follow' });
  if (!bundle.ok) fail(`${platform} answers ${bundle.status}`);
  const data = Buffer.from(await bundle.arrayBuffer());
  if (data.length < 1000000) fail(`${platform} is only ${data.length} bytes`);

  const sig = verify(data, entry.signature, key);
  if (!sig.trusted.includes(`version:${feed.version}`)) {
    fail(`the signature is for "${sig.trusted}", not version ${feed.version}`);
  }
  pass(`${platform} is ${data.length} bytes and signs as version ${feed.version}`);

  // The installed binary is what the user runs. When one is present, prove it
  // is the published file rather than naming the version and hoping.
  const installed = '/Applications/Brosr.app';
  if (!fs.existsSync(installed)) {
    pass('no local Brosr.app to compare');
    return { version: feed.version, platform, bytes: data.length };
  }
  const plist = path.join(installed, 'Contents', 'Info.plist');
  const read = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], {
    encoding: 'utf8',
  });
  const local = (read.stdout || '').trim();
  if (local !== feed.version) fail(`the installed app is ${local || 'unknown'}, the feed is ${feed.version}`);
  pass(`the installed app is ${local}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-updater-'));
  try {
    const tar = path.join(dir, 'bundle.tar.gz');
    fs.writeFileSync(tar, data);
    const untar = spawnSync('tar', ['-xzf', tar, '-C', dir], { encoding: 'utf8' });
    if (untar.status !== 0) fail(`the bundle does not extract: ${untar.stderr.trim()}`);
    const published = path.join(dir, 'Brosr.app', 'Contents', 'MacOS', 'Brosr');
    if (!fs.existsSync(published)) fail('the bundle holds no Brosr.app/Contents/MacOS/Brosr');
    const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const mine = hash(published);
    const theirs = hash(path.join(installed, 'Contents', 'MacOS', 'Brosr'));
    if (mine !== theirs) fail(`the installed binary is ${theirs}, the published one is ${mine}`);
    pass('the installed binary is the published binary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { version: feed.version, platform, bytes: data.length };
})();

console.log(`PASS: the updater feed signs ${total.version} for ${total.platform}`);
