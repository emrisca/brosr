// The room lifecycle for the app. One call builds a profile, starts the relay,
// opens the browser and writes a run file. The app reads that file for status
// and calls stop to end it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRoomKey } from '../core/seal.mjs';
import { prepareProfile } from '../zen/profile.mjs';
import { buildChrome, buildXpi } from '../zen/package.mjs';
import { detect, find, launchArgs, pinChromeExtension, rememberStart } from './browsers.mjs';
import { holdChrome } from './chrome-hold.mjs';
import { blockerCopy, stageBlocker } from './blockers.mjs';
import { pstreamCopy, stagePStream, why } from './pstream.mjs';
import { bindHost } from './friends.mjs';
import { formatAddress, parseInviteLink } from '../core/friends.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');

// ROOT holds the sources. The app bundle seals them, so nothing may write
// there. The state folder comes from the app, which points it at the user data
// directory. A dev run keeps the old layout under host/.run.
const STATE = process.env.BROSR_STATE ? path.resolve(process.env.BROSR_STATE) : path.join(here, '.run');
const RUNTIME = process.env.BROSR_ZEN_RUNTIME
  ? path.resolve(process.env.BROSR_ZEN_RUNTIME)
  : path.join(ROOT, 'zen', '.runtime');
const RUN_DIR = STATE;
const RUN_FILE = path.join(RUN_DIR, 'room.json');
const JOIN_FILE = path.join(RUN_DIR, 'join.json');
const PROFILE = path.join(RUN_DIR, 'profile');
// A person can host and join. A second window on one profile is refused by the
// browser, so a join keeps its own folder.
const PROFILE_GUEST = path.join(RUN_DIR, 'profile-guest');

// Chromium builds keep one profile per browser. Brave and Edge write different
// vendor state into the same folder, and Edge exits when it inherits a folder
// that Brave created.
function chromiumProfile(browser, guest) {
  return path.join(
    RUN_DIR,
    guest ? `profile-guest-${browser.id}` : `profile-${browser.id}`
  );
}
const CHROME_BRIDGE = path.join(RUNTIME, 'bridge-chrome');
const BRIDGE = path.join(RUNTIME, 'bridge.xpi');
const RELAY = path.join(ROOT, 'spike', 'relay.js');
// The trusted input helper. It owns the BiDi session and the loopback agent.
const TRUST = path.join(here, 'trust.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The relay serves the fixtures, so the bridge has to be in the build the relay
// hands to the page. The build is refreshed when it is missing or older than a
// source file. Without the second check a room could install a panel from an
// earlier tree, which is how the toolbar once kept an older surface.
const SOURCE_DIRS = ['bridge', 'core', 'assets'].map((name) => path.join(ROOT, name));

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(file) : fs.statSync(file).mtimeMs);
  }
  return newest;
}

export function ensureBridge() {
  let built = !fs.existsSync(BRIDGE);
  if (!built) {
    const builtAt = fs.statSync(BRIDGE).mtimeMs;
    built = SOURCE_DIRS.some((dir) => newestMtime(dir) > builtAt);
  }
  if (built) {
    ensureDir(RUNTIME);
    buildXpi(BRIDGE);
  }
  return { file: BRIDGE, built };
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

export async function freePort(start = 8787, host = '127.0.0.1') {
  for (let port = start; port < start + 40; port += 1) {
    if (await portOpen(port, host)) return port;
  }
  throw new Error(`no free port between ${start} and ${start + 39}`);
}

function relayReady(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const request = http.get(
      { host, port, path: '/', timeout: 800 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

// The room count the app shows comes from the relay itself, so a peer that
// left is gone on the next poll. A relay that cannot answer reads as zero.
function relayStatus(port, room, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host,
        port,
        path: `/status?room=${encodeURIComponent(room)}`,
        timeout: 800,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function waitForRelay(port, host = '127.0.0.1', ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await relayReady(port, host)) return true;
    await delay(120);
  }
  return false;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A browser starts helper processes. On POSIX the spawn is a group leader, so
// one signal reaches the whole tree. Windows needs taskkill for the same job.
function killTree(pid) {
  if (!alive(pid)) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

// A Chromium launch can hand the URL to an existing browser and exit, leaving
// the actual window under a different PID. Windows also lets a launcher exit
// while its browser tree stays alive. The room profile is unique to this app, so
// every process carrying that profile belongs to the room. Stop each tree, not
// only the PID that spawn returned.
function killProfile(profile) {
  if (!profile || !fs.existsSync(profile)) return false;
  if (process.platform === 'win32') {
    const script = [
      '$hits = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:BROSR_PROFILE) })',
      'foreach ($hit in $hits) { taskkill.exe /PID $hit.ProcessId /T /F 2>$null | Out-Null }',
      '$hits.Count',
    ].join('; ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, BROSR_PROFILE: profile },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000,
        windowsHide: true,
      }
    );
    return Number.parseInt(String(result.stdout || '0').trim(), 10) > 0;
  }
  try {
    const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    const hits = String(result.stdout || '')
      .split(/\r?\n/)
      .filter((line) => line.includes(profile));
    for (const line of hits) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (!pid || pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // The process exited between listing and signaling.
      }
    }
    return hits.length > 0;
  } catch {
    return false;
  }
}

// A Windows launcher can exit while the browser it started keeps the profile
// open, so a dead pid is not proof the browser is gone. Ask for a process that
// still carries this room's profile. Other platforms hand back the browser pid
// from spawn, so the scan stays on Windows.
function profileAlive(profile) {
  if (process.platform !== 'win32' || !profile || !fs.existsSync(profile)) return false;
  const script = [
    '$hits = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:BROSR_PROFILE) })',
    '$hits.Count',
  ].join('; ');
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, BROSR_PROFILE: profile },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000,
        windowsHide: true,
      }
    );
    return Number.parseInt(String(result.stdout || '0').trim(), 10) > 0;
  } catch {
    return false;
  }
}

function roomProfiles() {
  try {
    return fs
      .readdirSync(RUN_DIR, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name === 'profile' || entry.name.startsWith('profile-'))
      )
      .map((entry) => path.join(RUN_DIR, entry.name));
  } catch {
    return [];
  }
}

function stopProfiles() {
  return roomProfiles().map((profile) => killProfile(profile));
}

export function readRun() {
  try {
    return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeRun(run) {
  ensureDir(RUN_DIR);
  // The run file can hold a trusted input token, so only this user reads it.
  fs.writeFileSync(RUN_FILE, JSON.stringify(run, null, 2), { mode: 0o600 });
  return run;
}

export function roomId() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `room-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

// The room page reads the key from the fragment, so the relay never sees it.
export function roomUrl({
  host = '127.0.0.1',
  port,
  room,
  key,
  name,
  roomName = 'Room',
  role = 'host',
  peer = 'host',
  panel = true,
  trust = null,
  docs = null,
}) {
  // The landing page is the front door of a room. The room params below are
  // what mark it as the room tab, so no second fixture page is needed.
  const url = new URL(`http://${formatAddress(host, port)}/`);
  url.searchParams.set('role', role);
  url.searchParams.set('room', room);
  url.searchParams.set('peer', peer);
  url.searchParams.set('name', name);
  url.searchParams.set('rname', roomName);
  // The page connects to the relay on this port. Without it the page falls back
  // to 8787, which is wrong as soon as the first port is busy.
  url.searchParams.set('relay', String(port));
  if (panel) url.searchParams.set('panel', '1');
  // The key and the trusted token ride in the fragment, so neither reaches the
  // relay or a request line. The token opens the loopback agent and nothing
  // else, and only while a peer holds a grant.
  const fragment = [`k=${key}`];
  if (trust && trust.port && trust.token) {
    fragment.push(`t=${trust.token}`, `tp=${trust.port}`);
  }
  // The docs token lets the host tab read and write the canvas and note
  // library. A guest invite never carries it, so a peer only sees the room copy.
  if (docs) fragment.push(`dt=${docs}`);
  url.hash = fragment.join('&');
  return url.toString();
}

// A guest link needs its own peer id. The room keys its member map by peer id,
// so a guest that reuses 'host' replaces the host entry and the panel never
// shows a second person.
export function guestId() {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return `guest-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function guestInvite({ host = '127.0.0.1', port, room, key, name = 'Guest', roomName = 'Room' }) {
  return roomUrl({
    host,
    port,
    room,
    key,
    name,
    roomName,
    role: 'peer',
    peer: guestId(),
    panel: false,
  });
}

// A Chromium room loads the bridge as an unpacked folder, so the build is a
// directory and not an XPI.
function ensureChromeBridge() {
  ensureDir(RUNTIME);
  return { dir: buildChrome(CHROME_BRIDGE).dir, built: true };
}

// The Chromium blocker is a release zip, not an add-on file. A cold start
// fetches and unpacks it once, and a later start reads the folder beside the
// bridge. A failed fetch leaves the room without a blocker and says so, so a
// network problem never stops the room.
async function ensureChromeBlocker() {
  ensureDir(RUNTIME);
  try {
    const hit = await stageBlocker(RUNTIME);
    return { dir: hit.dir, staged: Boolean(hit.staged), tag: hit.tag || null, error: null };
  } catch (error) {
    return { dir: blockerCopy(RUNTIME), staged: false, tag: null, error: error.message };
  }
}

// P-Stream is a Chrome Web Store CRX on Chromium. It stages beside the blocker,
// and a failed download leaves the room with the extensions it already has.
async function ensureChromePStream() {
  ensureDir(RUNTIME);
  try {
    const hit = await stagePStream(RUNTIME);
    return {
      dir: hit.dir,
      staged: Boolean(hit.staged),
      version: hit.version || null,
      error: null,
    };
  } catch (error) {
    return {
      dir: pstreamCopy(RUNTIME),
      staged: false,
      version: null,
      error: why(error),
    };
  }
}

// A prepared profile is the slow step. The app shows the result line by line,
// so this returns a report instead of only a path.
export async function prepare({ browser: browserId, bridge = true, onProgress, guest = false } = {}) {
  const browser = find(browserId);
  // A build that refuses the add-on cannot host a room. The reason is the same
  // one the setup screen shows, so nothing is hidden behind a silent launch.
  if (!browser.supported) {
    throw new Error(browser.reason || `${browser.name} cannot host a room`);
  }
  if (browser.family === 'chromium') {
    const profileDir = chromiumProfile(browser, guest);
    const existed = fs.existsSync(profileDir);
    if (typeof onProgress === 'function') {
      onProgress({ step: 1, total: 3, label: 'Building the bridge' });
    }
    const bridge = ensureChromeBridge();
    if (typeof onProgress === 'function') {
      onProgress({ step: 2, total: 3, label: 'Loading the blocker' });
    }
    const blocker = await ensureChromeBlocker();
    if (typeof onProgress === 'function') {
      onProgress({ step: 3, total: 3, label: 'Loading P-Stream' });
    }
    const pstream = await ensureChromePStream();
    // The bridge goes first, because the room panel lives in it. The blocker
    // and P-Stream follow when their folders are there.
    const dirs = [bridge.dir, blocker.dir, pstream.dir].filter(Boolean);
    ensureDir(profileDir);
    const pins = pinChromeExtension(profileDir, dirs);
    return {
      browser,
      profile: profileDir,
      bridge: { file: bridge.dir, built: bridge.built, version: bridgeVersion() },
      extension: bridge.dir,
      extensionDirs: dirs,
      pinned: pins.ids,
      extensions: dirs.length,
      reused: existed,
      blocker: Boolean(blocker.dir),
      blockerError: blocker.error,
      pstream: Boolean(pstream.dir),
      pstreamError: pstream.error,
      staged: blocker.staged ? { tag: blocker.tag, dir: blocker.dir } : null,
    };
  }
  const bridgeInfo = bridge ? ensureBridge() : { file: BRIDGE, built: false };
  const profileDir = guest ? PROFILE_GUEST : PROFILE;
  const report = await prepareProfile(profileDir, {
    bridge: bridgeInfo.file,
    native: browser.native,
    configure: false,
    onProgress,
    // A room profile that already matches its inputs is ready as it stands, so
    // the second start of a room does not copy anything.
    reuse: true,
  });
  const extensions = report.safeBrowsing ? report.safeBrowsing.installed.length : 0;
  return {
    browser,
    profile: report.profile,
    bridge: {
      file: bridgeInfo.file,
      built: bridgeInfo.built,
      version: bridgeVersion(),
    },
    extensions,
    reused: Boolean(report.reused),
    blocker: Boolean(report.blocker),
    staged: report.safeBrowsing ? report.safeBrowsing.staged : null,
  };
}

function bridgeVersion() {
  try {
    const manifest = path.join(ROOT, 'bridge', 'manifest.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || null;
  } catch {
    return null;
  }
}

// A branded Chrome closes when its devtools pipe closes, and that pipe is what
// installs the add-ons. So a helper process owns both: it starts the window,
// installs each folder, reports the ids and stays alive beside the window. Every
// other build takes the flags on the command line and is spawned here.
async function launch(browser, args, dirs) {
  if (browser.family !== 'chromium' || !browser.branded) {
    const child = spawn(browser.path, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { pid: child.pid, holderPid: null, ids: null, errors: [] };
  }
  const held = await holdChrome({ bin: browser.path, args, dirs, state: RUN_DIR });
  if (!held.pid) {
    killTree(held.holderPid);
    const detail = held.errors.map((hit) => hit.error).filter(Boolean).join('; ');
    throw new Error(`${browser.name} did not load its add-ons${detail ? `: ${detail}` : ''}`);
  }
  return { pid: held.pid, holderPid: held.holderPid, ids: held.ids, errors: held.errors };
}

// One room at a time. A second start stops the first, because two relays on one
// port and two windows on one profile would fight.
export async function start(options = {}) {
  const previous = readRun();
  if (previous) stop();

  // Each leg is timed, because the whole wait is the sum of three steps and the
  // report says which one cost the time.
  const began = Date.now();
  const host = bindHost();
  const browser = find(options.browser);
  const port = Number(options.port) || (await freePort(8787, host));
  const room = options.room || roomId();
  const name = options.name || 'Host';
  const roomName = options.roomName || 'Room';
  const key = newRoomKey();
  // The docs folder holds the host canvas and note library. It sits beside the
  // run file, which is the app data folder in a packaged run.
  const docsDir = ensureDir(path.join(STATE, 'docs'));
  const docsToken = crypto.randomBytes(24).toString('base64url');
  // Trusted input follows the browser family. Gecko opens a BiDi session and
  // Chromium a CDP one, and the helper picks its client from the family.
  const trust = options.trusted
    ? {
        token: crypto.randomBytes(32).toString('base64url'),
        port: await freePort(9330, '127.0.0.1'),
      }
    : null;

  // The relay does not read the profile, so it boots while the profile is
  // written. A cold first run then costs the larger of the two legs, not both.
  const relay = spawn(process.execPath, [RELAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      BROSR_DOCS_DIR: docsDir,
      BROSR_DOCS_TOKEN: docsToken,
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  relay.unref();

  let prepared;
  try {
    prepared = await prepare({ browser: browser.id });
  } catch (error) {
    killTree(relay.pid);
    throw error;
  }
  const preparedAt = Date.now();

  const ready = await waitForRelay(port, host);
  if (!ready) {
    killTree(relay.pid);
    throw new Error(`the relay did not answer on port ${port}`);
  }
  const relayAt = Date.now();

  const url = roomUrl({ host, port, room, key, name, roomName, trust, docs: docsToken });
  const args = launchArgs(browser, {
    profile: prepared.profile,
    url,
    headless: Boolean(options.headless),
    extension: prepared.extensionDirs || prepared.extension || null,
    remotePort: trust ? trust.port : null,
  });
  const launched = await launch(browser, args, prepared.extensionDirs || []);
  const launchedAt = Date.now();

  // The helper waits for the room tab, then binds its listener only when the
  // page reports a granted peer. A room with no grant keeps the port closed.
  let helper = null;
  if (trust) {
    helper = spawn(
      process.execPath,
      [
        TRUST,
        `--debug-port=${trust.port}`,
        `--room=${room}`,
        `--token=${trust.token}`,
        `--family=${browser.family}`,
      ],
      { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }
    );
    helper.unref();
  }

  const run = writeRun({
    ok: true,
    started: new Date().toISOString(),
    browser: { id: browser.id, name: browser.name, path: browser.path, family: browser.family },
    room,
    roomName,
    name,
    host,
    port,
    docsDir,
    url,
    invite: guestInvite({ host, port, room, key, roomName }),
    profile: prepared.profile,
    relayPid: relay.pid,
    browserPid: launched.pid,
    // The helper that holds the devtools pipe on a branded Chrome. It exits
    // with the window, and stop closes it with the window.
    pipePid: launched.holderPid,
    extensionIds: launched.ids,
    extensionErrors: launched.errors.length ? launched.errors : null,
    // The token stays here. Only the helper and the room tab read it, and the
    // status command reports the port and the helper without the token.
    trust: trust
      ? {
          port: trust.port,
          token: trust.token,
          helperPid: helper ? helper.pid : null,
          url: `http://127.0.0.1:${trust.port}`,
        }
      : null,
    bridge: prepared.bridge,
    extensions: prepared.extensions,
    pstream: prepared.pstream,
    pstreamError: prepared.pstreamError,
    timings: {
      prepareMs: preparedAt - began,
      relayMs: relayAt - preparedAt,
      launchMs: launchedAt - relayAt,
      totalMs: launchedAt - began,
      reused: Boolean(prepared.reused),
    },
  });
  return run;
}

export function stop() {
  const run = readRun();
  const joined = readJoin();
  const relay = run ? killTree(run.relayPid) : false;
  const browser = run ? killTree(run.browserPid) : false;
  // The pipe helper shares the window's process group, so it goes with it. A
  // helper that outlived a failed launch is closed here too.
  if (run && run.pipePid) killTree(run.pipePid);
  // The helper closes the listener before it exits. Killing it here is the
  // app-exit rule, so no control channel outlives the room.
  const trust = run && run.trust && run.trust.helperPid ? killTree(run.trust.helperPid) : false;
  const guest = joined ? killTree(joined.browserPid) : false;
  if (joined && joined.pipePid) killTree(joined.pipePid);
  const profiles = stopProfiles();
  const profileStopped = profiles.some(Boolean);
  for (const file of [RUN_FILE, JOIN_FILE]) {
    try {
      fs.rmSync(file);
    } catch {
      // A second stop has nothing to remove.
    }
  }
  if (!run && !joined) {
    return {
      ok: true,
      stopped: profileStopped,
      reason: profileStopped ? 'stale room browser stopped' : 'no room is running',
    };
  }
  return {
    ok: true,
    stopped: relay || browser || guest || profileStopped,
    relay,
    browser,
    guest,
    profileStopped,
    room: run ? run.room : joined.room,
  };
}

export function readJoin() {
  try {
    return JSON.parse(fs.readFileSync(JOIN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeJoin(run) {
  ensureDir(RUN_DIR);
  fs.writeFileSync(JOIN_FILE, JSON.stringify(run, null, 2));
  return run;
}

// Join a room someone invited this machine to. The link decides the relay, so
// this launches one browser on the guest profile and keeps no local relay.
// Every address in the link was checked against the loopback and tailnet rules
// before the first byte is written to disk.
export async function joinRoom({ url, browser: browserId, name = '' } = {}) {
  const link = parseInviteLink(url);
  const previous = readJoin();
  if (previous && alive(previous.browserPid)) killTree(previous.browserPid);
  if (previous && previous.pipePid) killTree(previous.pipePid);

  const available = detect();
  const chosen = browserId || (available[0] && available[0].id);
  if (!chosen) throw new Error('No browser can join a room. Run detect to see the builds.');
  const browser = find(chosen);
  if (!browser.supported) {
    throw new Error(browser.reason || `${browser.name} cannot join a room`);
  }

  const prepared = await prepare({ browser: browser.id, guest: true });
  const args = launchArgs(browser, {
    profile: prepared.profile,
    url: link.url,
    extension: prepared.extensionDirs || prepared.extension || null,
  });
  const launched = await launch(browser, args, prepared.extensionDirs || []);

  return writeJoin({
    ok: true,
    joined: true,
    started: new Date().toISOString(),
    browser: { id: browser.id, name: browser.name, path: browser.path, family: browser.family },
    room: link.room,
    roomName: link.roomName || 'Room',
    host: link.host,
    port: link.relayPort,
    url: link.url,
    name: name || link.name || 'Guest',
    peer: link.peer,
    profile: prepared.profile,
    browserPid: launched.pid,
    pipePid: launched.holderPid,
    bridge: prepared.bridge,
    extensions: prepared.extensions,
  });
}

// A machine that joined someone else's room runs no local relay, so it has no
// room.json. Its join file is the record, and the relay it reports on is the
// one the invite named.
async function guestStatus() {
  const join = readJoin();
  if (!join) return { ok: true, running: false };
  const browser = alive(join.browserPid);
  const ready = await relayReady(join.port, join.host);
  const link = ready ? await relayStatus(join.port, join.room, join.host) : null;
  const peers = link ? link.peers : 0;
  // On Windows the launcher that spawn returns can exit while the browser it
  // started stays up, so a dead pid alone does not mean the guest is gone. Ask
  // for a process that still carries the room profile.
  const browserOpen = browser || profileAlive(join.profile);
  return {
    ...join,
    role: 'peer',
    running: browser || peers > 0,
    relayAlive: ready,
    browserAlive: browserOpen,
    relayReady: ready,
    peers,
  };
}

export async function status() {
  const run = readRun();
  if (!run) return guestStatus();
  const relay = alive(run.relayPid);
  const browser = alive(run.browserPid);
  const host = run.host || '127.0.0.1';
  const ready = relay ? await relayReady(run.port, host) : false;
  const link = ready ? await relayStatus(run.port, run.room, host) : null;
  const peers = link ? link.peers : 0;
  // The first peer proves the page loaded and the bridge ran. That wait is the
  // start time a person feels, so it is recorded once and kept for the order.
  if (peers > 0 && !run.liveMs) {
    run.liveMs = Date.now() - Date.parse(run.started);
    writeRun(run);
    rememberStart(run.browser.id, run.liveMs);
  }
  // The pid from spawn can be a Windows launcher that exits at once. The room
  // profile is unique to this app, so a process carrying it is the browser.
  const browserOpen = browser || profileAlive(run.profile);
  return {
    ...run,
    running: relay || browser || peers > 0,
    relayAlive: relay,
    browserAlive: browserOpen,
    relayReady: ready,
    peers,
  };
}

export { RUN_FILE, PROFILE };
