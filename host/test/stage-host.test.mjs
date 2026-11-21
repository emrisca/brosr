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
  delete env.BROSR_NODE_BIN;
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

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const fetchNodeScript = path.join(repo, 'app', 'scripts', 'fetch-node.mjs');

test('stage-host always creates resources/node/README.md and stages BROSR_NODE_BIN with executable permissions', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'brosr-stage-node-'));
  const outDefault = path.join(scratch, 'resources-default');
  const outWithNode = path.join(scratch, 'resources-with-node');
  const dummyPayload = '#!/bin/sh\necho dummy-node\n';
  const dummyNode = path.join(scratch, nodeName);
  try {
    const defaultRun = runStage(outDefault);
    assert.equal(defaultRun.status, 0, defaultRun.stderr || defaultRun.stdout);
    assert.equal(
      fs.existsSync(path.join(outDefault, 'node', 'README.md')),
      true,
      'staged node/README.md must always exist so resources/node is never empty'
    );

    fs.writeFileSync(dummyNode, dummyPayload);
    if (process.platform !== 'win32') fs.chmodSync(dummyNode, 0o755);

    const nodeRun = runStage(outWithNode, { BROSR_NODE_BIN: dummyNode });
    assert.equal(nodeRun.status, 0, nodeRun.stderr || nodeRun.stdout);

    const stagedNode = path.join(outWithNode, 'node', nodeName);
    assert.equal(fs.existsSync(stagedNode), true, `expected ${stagedNode} to be staged`);
    assert.equal(fs.readFileSync(stagedNode, 'utf8'), dummyPayload);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(stagedNode).mode & 0o777;
      assert.notEqual(mode & 0o111, 0, `expected executable permissions on ${stagedNode}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('stage-host fails fast when BROSR_NODE_BIN points to a nonexistent path or directory', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'brosr-stage-node-missing-'));
  const outDir = path.join(scratch, 'resources');
  const missing = path.join(scratch, 'does-not-exist-node');
  try {
    const missingRun = runStage(outDir, { BROSR_NODE_BIN: missing });
    assert.notEqual(missingRun.status, 0, 'stage-host must fail when BROSR_NODE_BIN is missing');
    assert.match(missingRun.stderr, /BROSR_NODE_BIN/);

    const dirRun = runStage(outDir, { BROSR_NODE_BIN: scratch });
    assert.notEqual(dirRun.status, 0, 'stage-host must fail when BROSR_NODE_BIN is a directory');
    assert.match(dirRun.stderr, /BROSR_NODE_BIN/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('fetch-node.mjs pins all three release targets and validates binary headers', async () => {
  const mod = await import(`${pathToFileURL(fetchNodeScript).href}?t=${Date.now()}`);
  for (const target of [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
  ]) {
    const spec = mod.targetSpec(target);
    assert.match(spec.sha256, /^[0-9a-f]{64}$/);
    assert.ok(spec.archive.includes(mod.NODE_VERSION));
  }
  assert.throws(() => mod.targetSpec('unknown-target'), /unsupported target/i);

  // Mach-O arm64 vs x86_64 header verification catches cross-arch mix-ups.
  const machoArm64 = Buffer.alloc(16);
  machoArm64.writeUInt32LE(0xfeedfacf, 0);
  machoArm64.writeUInt32LE(0x0100000c, 4);
  assert.doesNotThrow(() => mod.verifyBinaryHeader(machoArm64, 'macho-arm64'));
  assert.throws(() => mod.verifyBinaryHeader(machoArm64, 'macho-x64'), /cpu/i);

  const machoX64 = Buffer.alloc(16);
  machoX64.writeUInt32LE(0xfeedfacf, 0);
  machoX64.writeUInt32LE(0x01000007, 4);
  assert.doesNotThrow(() => mod.verifyBinaryHeader(machoX64, 'macho-x64'));
  assert.throws(() => mod.verifyBinaryHeader(machoX64, 'macho-arm64'), /cpu/i);

  // Windows PE x64 header verification.
  const peX64 = Buffer.alloc(128);
  peX64[0] = 0x4d;
  peX64[1] = 0x5a;
  peX64.writeUInt32LE(64, 60);
  peX64.write('PE\0\0', 64, 'ascii');
  peX64.writeUInt16LE(0x8664, 68);
  assert.doesNotThrow(() => mod.verifyBinaryHeader(peX64, 'pe-x64'));
  assert.throws(() => mod.verifyBinaryHeader(machoArm64, 'pe-x64'), /pe|mz/i);
});

test('release workflow and tauri.conf.json package bundled Node under resources/node', () => {
  const yml = fs.readFileSync(releaseWorkflow, 'utf8');
  const fetchIndex = yml.indexOf('node app/scripts/fetch-node.mjs --target ${{ matrix.target }}');
  const tauriIndex = yml.indexOf('uses: tauri-apps/tauri-action@v0');
  assert.notEqual(fetchIndex, -1, 'release.yml must fetch the bundled Node runtime for matrix.target');
  assert.equal(
    fetchIndex < tauriIndex,
    true,
    'bundled Node fetch must run before tauri-apps/tauri-action'
  );
  assert.match(yml, /BROSR_NODE_BIN:/, 'release.yml must pass BROSR_NODE_BIN to tauri-action');

  const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  assert.ok(
    Array.isArray(conf.bundle?.resources) && conf.bundle.resources.includes('resources/node'),
    'app/src-tauri/tauri.conf.json bundle.resources must include resources/node'
  );
});

test('staged host/cli.mjs and host/trust.mjs execute cleanly via non-canonical/symlinked paths', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'brosr-stage-symlink-'));
  const outDir = path.join(scratch, 'resources');
  try {
    const res = runStage(outDir);
    assert.equal(res.status, 0, res.stderr || res.stdout);

    // Intentionally pass outDir without fs.realpathSync (on macOS os.tmpdir()
    // sits under /var -> /private/var), verifying direct CLI execution still runs.
    const cliProbe = spawnSync(process.execPath, [path.join(outDir, 'host', 'cli.mjs'), 'detect'], {
      cwd: outDir,
      encoding: 'utf8',
    });
    assert.equal(cliProbe.status, 0, cliProbe.stderr || cliProbe.stdout);
    const parsed = JSON.parse(cliProbe.stdout.trim().split('\n').at(-1));
    assert.equal(parsed.ok, true);

    const trustProbe = spawnSync(process.execPath, [path.join(outDir, 'host', 'trust.mjs')], {
      cwd: outDir,
      encoding: 'utf8',
    });
    assert.equal(trustProbe.status, 2, trustProbe.stderr || trustProbe.stdout);
    assert.match(trustProbe.stderr, /--debug-port/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('release workflow publishes atomically via draft release after uploading latest.json', () => {
  const yml = fs.readFileSync(releaseWorkflow, 'utf8');
  assert.match(
    yml,
    /releaseDraft:\s*true/,
    'release.yml must keep releaseDraft: true while matrix builds run so /releases/latest never serves a partial release without latest.json'
  );
  const uploadIdx = yml.indexOf('gh release upload "$TAG" "$RUNNER_TEMP/latest.json" --clobber');
  const publishIdx = yml.indexOf('gh release edit "$TAG" --draft=false');
  assert.notEqual(uploadIdx, -1, 'release.yml must upload latest.json');
  assert.notEqual(publishIdx, -1, 'release.yml must publish the draft release via gh release edit --draft=false');
  assert.equal(
    uploadIdx < publishIdx,
    true,
    'release.yml must upload latest.json before flipping --draft=false'
  );
});

test('windows NSIS hooks and pre-update flow release bundled node.exe and relay locks', () => {
  const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  const hooksRel = conf?.bundle?.windows?.nsis?.installerHooks;
  assert.equal(
    typeof hooksRel,
    'string',
    'tauri.conf.json must configure bundle.windows.nsis.installerHooks'
  );
  const hooksFile = path.resolve(path.dirname(tauriConfPath), hooksRel);
  assert.equal(fs.existsSync(hooksFile), true, `missing NSIS hooks file at ${hooksFile}`);
  const hooks = fs.readFileSync(hooksFile, 'utf8');
  assert.match(hooks, /!macro\s+NSIS_HOOK_PREINSTALL/);
  assert.match(hooks, /!macro\s+NSIS_HOOK_PREUNINSTALL/);
  assert.match(hooks, /\$\{__FILEDIR__\}/);
  assert.match(hooks, /stop-helpers\.ps1/);
  assert.match(hooks, /nsExec::ExecToLog/);
  assert.match(hooks, /-InstallDir "\$INSTDIR\\\."/);
  assert.match(hooks, /Pop \$0/);

  const psFile = path.join(path.dirname(hooksFile), 'stop-helpers.ps1');
  assert.equal(fs.existsSync(psFile), true, `missing PowerShell helper at ${psFile}`);
  const ps = fs.readFileSync(psFile, 'utf8');
  assert.match(ps, /\$root\\resources\\/);
  assert.match(ps, /\$root\\Brosr\.exe/);
  assert.match(ps, /taskkill\.exe/);
  assert.doesNotMatch(
    ps,
    /\/IM\s+node\.exe/i,
    'stop-helpers.ps1 must only stop processes under $INSTDIR, never unrelated system node.exe'
  );

  const updateTs = fs.readFileSync(path.join(repo, 'app/src/lib/update.ts'), 'utf8');
  const downloadIdx = updateTs.indexOf('update.download(');
  const prepareIdx = updateTs.indexOf("invoke('prepare_update')");
  const installIdx = updateTs.indexOf('update.install(');
  const resumeIdx = updateTs.indexOf("invoke('resume_host')");
  assert.notEqual(downloadIdx, -1, 'update.ts must call update.download before stopping helpers');
  assert.notEqual(prepareIdx, -1, 'update.ts must invoke prepare_update before update.install');
  assert.notEqual(installIdx, -1, 'update.ts must call update.install after prepare_update');
  assert.notEqual(resumeIdx, -1, 'update.ts must invoke resume_host if install fails');
  assert.equal(downloadIdx < prepareIdx && prepareIdx < installIdx, true);
});

test('host/cli.mjs shutdown stops a live detached invite lobby and removes lobby.json', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'brosr-shutdown-'));
  const port = 43000 + Math.floor(Math.random() * 10000);
  const env = {
    ...process.env,
    BROSR_STATE: scratch,
    BROSR_LOBBY_PORT: String(port),
  };
  let lobbyPid = null;
  try {
    const startRes = spawnSync(process.execPath, [path.join(repo, 'host/cli.mjs'), 'friends'], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    assert.equal(startRes.status, 0, startRes.stderr || startRes.stdout);
    const started = JSON.parse(startRes.stdout.trim().split('\n').at(-1));
    assert.equal(started.ok, true);
    assert.equal(started.lobby.running, true);
    lobbyPid = started.lobby.pid;
    assert.equal(Number.isInteger(lobbyPid), true);
    assert.doesNotThrow(() => process.kill(lobbyPid, 0), 'detached lobby should be alive before shutdown');

    const stopRes = spawnSync(process.execPath, [path.join(repo, 'host/cli.mjs'), 'shutdown'], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    assert.equal(stopRes.status, 0, stopRes.stderr || stopRes.stdout);
    const stopped = JSON.parse(stopRes.stdout.trim().split('\n').at(-1));
    assert.equal(stopped.ok, true);
    assert.equal(stopped.lobby.stopped, true);
    assert.equal(stopped.lobby.pid, lobbyPid);
    assert.throws(() => process.kill(lobbyPid, 0), 'detached lobby should be dead after shutdown');
    assert.equal(fs.existsSync(path.join(scratch, 'lobby.json')), false, 'lobby.json should be removed');
    lobbyPid = null;
  } finally {
    if (lobbyPid) {
      try {
        process.kill(lobbyPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
