// The room lifecycle for the app. One call builds a profile, starts the relay,
// opens the browser and writes a run file. The app reads that file for status
// and calls stop to end it.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newRoomKey } from '../core/seal.mjs';
import { prepareProfile } from '../zen/profile.mjs';
import { buildChrome, buildXpi } from '../zen/package.mjs';
import { detect, find, launchArgs, pinChromeExtension, rememberStart } from './browsers.mjs';
import { blockerCopy, stageBlocker } from './blockers.mjs';
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
// A Chromium room keeps its own data directory, because the add-on format and
// the profile layout are not the ones Gecko reads.
const PROFILE_CHROME = path.join(RUN_DIR, 'profile-chrome');
// A person can host and join. A second window on one profile is refused by the
// browser, so a join keeps its own folder.
const PROFILE_GUEST = path.join(RUN_DIR, 'profile-guest');
const PROFILE_GUEST_CHROME = path.join(RUN_DIR, 'profile-guest-chrome');
const CHROME_BRIDGE = path.join(RUNTIME, 'bridge-chrome');
const BRIDGE = path.join(RUNTIME, 'bridge.xpi');
const RELAY = path.join(ROOT, 'spike', 'relay.js');

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
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
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

export function readRun() {
  try {
    return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeRun(run) {
  ensureDir(RUN_DIR);
  fs.writeFileSync(RUN_FILE, JSON.stringify(run, null, 2));
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
  role = 'host',
  peer = 'host',
  panel = true,
}) {
  // The landing page is the front door of a room. The room params below are
  // what mark it as the room tab, so no second fixture page is needed.
  const url = new URL(`http://${formatAddress(host, port)}/`);
  url.searchParams.set('role', role);
  url.searchParams.set('room', room);
  url.searchParams.set('peer', peer);
  url.searchParams.set('name', name);
  // The page connects to the relay on this port. Without it the page falls back
  // to 8787, which is wrong as soon as the first port is busy.
  url.searchParams.set('relay', String(port));
  if (panel) url.searchParams.set('panel', '1');
  url.hash = `k=${key}`;
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

export function guestInvite({ host = '127.0.0.1', port, room, key, name = 'Guest' }) {
  return roomUrl({ host, port, room, key, name, role: 'peer', peer: guestId(), panel: false });
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
    const profileDir = guest ? PROFILE_GUEST_CHROME : PROFILE_CHROME;
    const existed = fs.existsSync(profileDir);
    if (typeof onProgress === 'function') {
      onProgress({ step: 1, total: 2, label: 'Building the bridge' });
    }
    const bridge = ensureChromeBridge();
    if (typeof onProgress === 'function') {
      onProgress({ step: 2, total: 2, label: 'Loading the blocker' });
    }
    const blocker = await ensureChromeBlocker();
    // The bridge goes first, because the room panel lives in it. The blocker
    // follows when its folder is there.
    const dirs = [bridge.dir, blocker.dir].filter(Boolean);
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

// One room at a time. A second start stops the first, because two relays on one
// port and two windows on one profile would fight.
export async function start(options = {}) {
  const previous = readRun();
  if (previous && (alive(previous.relayPid) || alive(previous.browserPid))) stop();

  // Each leg is timed, because the whole wait is the sum of three steps and the
  // report says which one cost the time.
  const began = Date.now();
  const host = bindHost();
  const browser = find(options.browser);
  const port = Number(options.port) || (await freePort(8787, host));
  const room = options.room || roomId();
  const name = options.name || 'Host';
  const key = newRoomKey();

  // The relay does not read the profile, so it boots while the profile is
  // written. A cold first run then costs the larger of the two legs, not both.
  const relay = spawn(process.execPath, [RELAY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: host },
    detached: true,
    stdio: 'ignore',
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

  const url = roomUrl({ host, port, room, key, name });
  const args = launchArgs(browser, {
    profile: prepared.profile,
    url,
    headless: Boolean(options.headless),
    extension: prepared.extensionDirs || prepared.extension || null,
  });
  const child = spawn(browser.path, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const launchedAt = Date.now();

  const run = writeRun({
    ok: true,
    started: new Date().toISOString(),
    browser: { id: browser.id, name: browser.name, path: browser.path, family: browser.family },
    room,
    name,
    host,
    port,
    url,
    invite: guestInvite({ host, port, room, key }),
    profile: prepared.profile,
    relayPid: relay.pid,
    browserPid: child.pid,
    bridge: prepared.bridge,
    extensions: prepared.extensions,
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
  const guest = joined ? killTree(joined.browserPid) : false;
  for (const file of [RUN_FILE, JOIN_FILE]) {
    try {
      fs.rmSync(file);
    } catch {
      // A second stop has nothing to remove.
    }
  }
  if (!run && !joined) return { ok: true, stopped: false, reason: 'no room is running' };
  return {
    ok: true,
    stopped: relay || browser || guest,
    relay,
    browser,
    guest,
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
  const child = spawn(browser.path, args, { detached: true, stdio: 'ignore' });
  child.unref();

  return writeJoin({
    ok: true,
    joined: true,
    started: new Date().toISOString(),
    browser: { id: browser.id, name: browser.name, path: browser.path, family: browser.family },
    room: link.room,
    host: link.host,
    port: link.relayPort,
    url: link.url,
    name: name || link.name || 'Guest',
    peer: link.peer,
    profile: prepared.profile,
    browserPid: child.pid,
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
  // On Windows the launcher that spawn returns is not the browser that stays
  // up, so a dead pid alone does not mean the guest is gone. A page in the room
  // is the stronger proof, and it is the state a person sees.
  return {
    ...join,
    role: 'peer',
    running: browser || peers > 0,
    relayAlive: ready,
    browserAlive: browser,
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
  return {
    ...run,
    running: relay || browser,
    relayAlive: relay,
    browserAlive: browser,
    relayReady: ready,
    peers,
  };
}

export { RUN_FILE, PROFILE };
