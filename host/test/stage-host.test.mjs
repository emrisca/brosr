// Boundary tests for app/scripts/stage-host.mjs.
// Verifies that packaged Tauri resources include the path-spawned trust runtime
// (host/trust.mjs + host/chrome-cdp.mjs), optionally stage the Rust relay
// binary with executable permissions, fail fast on invalid BROSR_RELAY_BIN,
// keep resources/relay listed in tauri.conf.json, and that the staged runtime
// modules import/spawn cleanly from the staged tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const stageScript = path.join(repo, 'app', 'scripts', 'stage-host.mjs');
const releaseWorkflow = path.join(repo, '.github', 'workflows', 'release.yml');
const tauriConfPath = path.join(repo, 'app', 'src-tauri', 'tauri.conf.json');
const relayName = process.platform === 'win32' ? 'brosr-relay.exe' : 'brosr-relay';

function runStage(outDir, extraEnv = {}) {
  const env = { ...process.env };
  delete env.BROSR_RELAY_BIN;
  delete env.BROSR_STAGE_OUT;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [stageScript, '--out', outDir], {
    cwd: repo,
    env,
    encoding: 'utf8',
  });
}

test('stage-host stages host/trust.mjs and host/chrome-cdp.mjs and staged runtime spawns/imports cleanly', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'brosr-stage-trust-'));
  const outDir = path.join(scratch, 'resources');
  try {
    const res = runStage(outDir);
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const stagedTrust = fs.realpathSync(path.join(outDir, 'host', 'trust.mjs'));
    const stagedCdp = path.join(outDir, 'host', 'chrome-cdp.mjs');
    const stagedRelayReadme = path.join(outDir, 'relay', 'README.md');
    assert.equal(fs.existsSync(stagedTrust), true, 'staged host/trust.mjs must exist');
    assert.equal(fs.existsSync(stagedCdp), true, 'staged host/chrome-cdp.mjs must exist');
    assert.equal(fs.existsSync(stagedRelayReadme), true, 'staged relay/README.md must exist');

    // Spawning the staged trust helper directly exercises every relative import
    // from inside the staged tree (./chrome-cdp.mjs, ../spike/bidi.mjs, ../core/trust.mjs).
    // Missing CLI flags must exit with usage code 2 rather than ERR_MODULE_NOT_FOUND.
    const probe = spawnSync(process.execPath, [stagedTrust], {
      cwd: fs.realpathSync(outDir),
      encoding: 'utf8',
    });
    assert.equal(probe.status, 2, `expected usage exit 2, got ${probe.status}: ${probe.stderr}`);
    assert.match(probe.stderr, /--debug-port/);
    assert.doesNotMatch(probe.stderr, /ERR_MODULE_NOT_FOUND/);

    // Direct ESM import from the staged copy also succeeds.
    const trustMod = await import(`${pathToFileURL(stagedTrust).href}?t=${Date.now()}`);
    assert.equal(typeof trustMod.createTrustAgent, 'function');
    assert.equal(typeof trustMod.runTrustHelper, 'function');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('stage-host stages BROSR_RELAY_BIN to relay/brosr-relay with executable permissions and staged room.mjs discovers it', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'brosr-stage-relay-'));
  const outDir = path.join(scratch, 'resources');
  const dummyPayload = '#!/bin/sh\necho dummy-brosr-relay\n';
  const dummyBin = path.join(scratch, 'dummy-relay-bin');
  const previousRelayBin = process.env.RELAY_BIN;
  try {
    fs.writeFileSync(dummyBin, dummyPayload);
    if (process.platform !== 'win32') fs.chmodSync(dummyBin, 0o755);

    const res = runStage(outDir, { BROSR_RELAY_BIN: dummyBin });
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const realOut = fs.realpathSync(outDir);
    const stagedRelay = path.join(realOut, 'relay', relayName);
    assert.equal(fs.existsSync(stagedRelay), true, `expected ${stagedRelay} to be staged`);
    assert.equal(fs.readFileSync(stagedRelay, 'utf8'), dummyPayload);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(stagedRelay).mode & 0o777;
      assert.notEqual(mode & 0o111, 0, `expected executable permissions on ${stagedRelay}, got ${mode.toString(8)}`);
    }

    // Importing the staged host/room.mjs with RELAY_BIN unset must auto-discover
    // ../relay/brosr-relay right next to host/.
    delete process.env.RELAY_BIN;
    const stagedRoom = await import(
      `${pathToFileURL(path.join(realOut, 'host', 'room.mjs')).href}?t=${Date.now()}`
    );
    const launch = stagedRoom.relayLaunch({
      host: '127.0.0.1',
      port: 8787,
      docsDir: path.join(scratch, 'docs'),
      docsToken: 'tok',
    });
    assert.equal(launch.command, stagedRelay);
    assert.deepEqual(launch.args, []);
    assert.equal(launch.source, 'staged');
    assert.equal(launch.env.LANDING, path.join(realOut, 'landing'));
    assert.equal(launch.env.FIXTURES, path.join(realOut, 'spike', 'fixtures'));
  } finally {
    if (previousRelayBin === undefined) delete process.env.RELAY_BIN;
    else process.env.RELAY_BIN = previousRelayBin;
    await rm(scratch, { recursive: true, force: true });
  }
});

test('stage-host fails fast when BROSR_RELAY_BIN points to a nonexistent path or directory', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'brosr-stage-missing-'));
  const outDir = path.join(scratch, 'resources');
  const missing = path.join(scratch, 'does-not-exist-brosr-relay');
  try {
    const missingRun = runStage(outDir, { BROSR_RELAY_BIN: missing });
    assert.notEqual(missingRun.status, 0, 'stage-host must fail when BROSR_RELAY_BIN is missing');
    assert.match(missingRun.stderr, /BROSR_RELAY_BIN/);

    const dirRun = runStage(outDir, { BROSR_RELAY_BIN: scratch });
    assert.notEqual(dirRun.status, 0, 'stage-host must fail when BROSR_RELAY_BIN is a directory');
    assert.match(dirRun.stderr, /BROSR_RELAY_BIN/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('release workflow and tauri.conf.json package brosr-relay under resources/relay', () => {
  const yml = fs.readFileSync(releaseWorkflow, 'utf8');
  const buildIndex = yml.indexOf(
    'cargo build --manifest-path relay/Cargo.toml --release --target ${{ matrix.target }}'
  );
  const tauriIndex = yml.indexOf('uses: tauri-apps/tauri-action@v0');
  assert.notEqual(buildIndex, -1, 'release.yml must build brosr-relay for matrix.target');
  assert.notEqual(tauriIndex, -1, 'release.yml must invoke tauri-apps/tauri-action@v0');
  assert.equal(
    buildIndex < tauriIndex,
    true,
    'brosr-relay build must run before tauri-apps/tauri-action'
  );
  assert.match(yml, /BROSR_RELAY_BIN:/, 'release.yml must pass BROSR_RELAY_BIN to tauri-action');
  assert.match(yml, /\.exe/, 'release.yml must handle the Windows .exe relay suffix');

  const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  assert.ok(
    Array.isArray(conf.bundle?.resources) && conf.bundle.resources.includes('resources/relay'),
    'app/src-tauri/tauri.conf.json bundle.resources must include resources/relay'
  );
});
