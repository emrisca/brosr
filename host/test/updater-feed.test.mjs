import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', '..', 'app', 'scripts', 'updater-json.mjs');

const SIGS = [
  'Brosr_0.3.24_x64_en-US.msi.sig',
  'Brosr_0.3.24_x64-setup.exe.sig',
  'Brosr_x64.app.tar.gz.sig',
  'Brosr_aarch64.app.tar.gz.sig',
];

const PLATFORMS = [
  'darwin-aarch64',
  'darwin-aarch64-app',
  'darwin-x86_64',
  'darwin-x86_64-app',
  'windows-x86_64',
  'windows-x86_64-msi',
  'windows-x86_64-nsis',
];

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-updater-'));
  for (const name of SIGS) fs.writeFileSync(path.join(dir, name), `signature for ${name}\n`);
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, 'Notes for the feed.\n');
  return { dir, notes, out: path.join(dir, 'latest.json') };
}

function feedFor(args) {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

test('the workflow argument form writes one feed for every platform', () => {
  const { dir, notes, out } = stage();
  // The release workflow passes --name value, not --name=value. A parser that
  // only knew the equals form read every value as empty and failed the job
  // after all three platform builds had already succeeded.
  feedFor(['--dir', dir, '--tag', 'v0.3.24', '--repo', 'emrisca/brosr', '--notes', notes, '--out', out]);

  const feed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(feed.version, '0.3.24');
  assert.equal(feed.notes, 'Notes for the feed.');
  assert.deepEqual(Object.keys(feed.platforms).sort(), PLATFORMS);

  const silicon = feed.platforms['darwin-aarch64'];
  assert.equal(
    silicon.url,
    'https://github.com/emrisca/brosr/releases/download/v0.3.24/Brosr_aarch64.app.tar.gz'
  );
  assert.equal(silicon.signature, 'signature for Brosr_aarch64.app.tar.gz.sig');
  assert.equal(feed.platforms['windows-x86_64-nsis'].url.endsWith('Brosr_0.3.24_x64-setup.exe'), true);
});

test('the equals argument form still writes the same feed', () => {
  const { dir, notes, out } = stage();
  feedFor([
    `--dir=${dir}`,
    '--tag=v0.3.24',
    '--repo=emrisca/brosr',
    `--notes=${notes}`,
    `--out=${out}`,
  ]);

  const feed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(feed.platforms).sort(), PLATFORMS);
});
