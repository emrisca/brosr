// Bumps the bridge version, rebuilds the XPI, signs it with AMO and proves the
// guard accepts the result. AMO credentials come from the environment or from
// .secrets/amo.env, which git ignores.
//
// A failure before AMO accepts the source restores both manifests and rebuilds
// the unsigned XPI, so a half finished release leaves the tree where it started.
// A failure after the signature lands leaves the bumped version in place, since
// AMO already holds that version and a local rollback would only hide it.
//
//   node scripts/release-bridge.mjs patch
//   node scripts/release-bridge.mjs minor
//   node scripts/release-bridge.mjs 0.5.0
//   node scripts/release-bridge.mjs patch --dry-run
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildXpi, stageBridge } from '../zen/package.mjs';
import { signedGap } from '../zen/profile.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'zen', '.runtime');
const manifests = [
  path.join(root, 'bridge', 'manifest.json'),
  path.join(root, 'bridge', 'manifest.chrome.json'),
];
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const asked = args.find((value) => !value.startsWith('--')) || 'patch';

const readVersion = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).version;

function bump(version, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`the manifest version ${version} is not three numbers`);
  }
  if (kind === 'patch') parts[2] += 1;
  else if (kind === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else if (kind === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else {
    throw new Error(`unknown bump ${kind}. Pass patch, minor, major or a version.`);
  }
  return parts.join('.');
}

// The version line is replaced in place so the rest of the manifest keeps its
// formatting, and a manifest with no matching line fails instead of silently
// shipping the old version.
function setVersion(file, version) {
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
  if (next === text) throw new Error(`no version line in ${path.relative(root, file)}`);
  fs.writeFileSync(file, next);
}

function loadKeys() {
  if (process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) return {};
  const file = path.join(root, '.secrets', 'amo.env');
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const hit = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (hit) env[hit[1]] = hit[2];
  }
  return env;
}

const versions = manifests.map(readVersion);
if (new Set(versions).size !== 1) {
  throw new Error(`the manifests disagree on the version: ${versions.join(' and ')}`);
}
const current = versions[0];
const next = bump(current, asked);
console.log(`[release] bridge ${current} -> ${next}`);

if (dryRun) {
  const gap = signedGap(runtime);
  console.log(JSON.stringify({ dryRun: true, from: current, to: next, guard: gap }));
  process.exit(gap.ok ? 0 : 1);
}

const originals = manifests.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
const restore = () => {
  for (const { file, text } of originals) fs.writeFileSync(file, text);
  // The unsigned XPI carries the bumped version too, so put it back as well.
  buildXpi();
};

let signed = false;
try {
  for (const file of manifests) setVersion(file, next);

  const built = buildXpi();
  console.log(`[release] built ${built.entries} files at ${path.relative(root, built.out)}`);

  const stage = path.join(runtime, 'amo-stage');
  const artifacts = path.join(runtime, 'amo-out');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(artifacts, { recursive: true, force: true });
  const staged = stageBridge(stage);
  console.log(`[release] staged ${staged.entries} files at ${path.relative(root, staged.dir)}`);

  const env = loadKeys();
  if (!process.env.WEB_EXT_API_KEY && !env.WEB_EXT_API_KEY) {
    throw new Error('no AMO credentials. Put WEB_EXT_API_KEY and WEB_EXT_API_SECRET in .secrets/amo.env.');
  }

  const sign = spawnSync(
    'npx',
    [
      '--yes',
      'web-ext@10.8.0',
      'sign',
      '--source-dir',
      stage,
      '--artifacts-dir',
      artifacts,
      '--channel',
      'unlisted',
      '--no-input',
    ],
    {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      // AMO can hold a submission in approval for minutes. A fixed five minute
      // cap turned a queued signature into a rollback, so the cap is adjustable.
      timeout: Number(process.env.BROSR_SIGN_TIMEOUT_MS || 300000),
    }
  );
  if (sign.error) throw new Error(`web-ext could not run: ${sign.error.message}`);
  if (sign.status !== 0) throw new Error(`web-ext sign exited ${sign.status}`);

  const made = fs.existsSync(artifacts)
    ? fs.readdirSync(artifacts).filter((name) => name.endsWith('.xpi'))
    : [];
  if (!made.length) throw new Error('AMO returned no xpi');

  const target = path.join(runtime, 'bridge-signed.xpi');
  fs.copyFileSync(path.join(artifacts, made[0]), target);
  signed = true;
  console.log(`[release] signed ${made[0]} -> ${path.relative(root, target)}`);
} catch (error) {
  if (!signed) {
    restore();
    console.error(`[release] ${error.message}`);
    console.error('[release] manifests restored, the tree is unchanged');
  } else {
    console.error(`[release] ${error.message}`);
    console.error('[release] the bumped version stays because AMO already holds it');
  }
  process.exit(1);
}

const gap = signedGap(runtime);
console.log(JSON.stringify(gap));
if (!gap.ok) {
  console.error('[release] the guard rejects the signed copy. Inspect it before shipping.');
  process.exit(1);
}
console.log(`[release] bridge ${next} is signed and the guard accepts it. Commit the two manifests.`);
