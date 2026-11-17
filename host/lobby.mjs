// The invite lobby. It listens on loopback and on the tailnet only, so a
// friend on the tailnet can hand over an invite and a public network cannot
// reach it. It holds two routes a friend uses and one this app uses.
//
//   POST /invite   accept an invite from a friend on the tailnet
//   GET  /invites  read the inbox, loopback only, because the link holds the key
//   GET  /health   liveness for the CLI
//
// The CLI spawns this file detached on demand. It keeps no socket to the app.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatAddress, isAllowedHost, isLoopbackHost, isTailnetHost } from '../core/friends.mjs';
import { addInvite, lobbyBinds, LOBBY_PORT, readInvites, STATE } from './friends.mjs';

const LOBBY_FILE = path.join(STATE, 'lobby.json');
const ROOM_FILE = path.join(STATE, 'room.json');
const MAX_BODY = 16 * 1024;
const MAX_PORT_ATTEMPTS = 1;
// A lobby from an older build may lack /rooms or may have bound before
// Tailscale connected. The record carries this number so the app replaces it.
const LOBBY_VERSION = 2;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readLobby() {
  try {
    return JSON.parse(fs.readFileSync(LOBBY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLobby(value) {
  fs.mkdirSync(path.dirname(LOBBY_FILE), { recursive: true });
  fs.writeFileSync(LOBBY_FILE, JSON.stringify(value, null, 2) + '\n');
}

function clearLobby(pid) {
  const saved = readLobby();
  if (!saved || saved.pid === pid) {
    try {
      fs.rmSync(LOBBY_FILE);
    } catch {
      // Two stops have nothing to remove between them.
    }
  }
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

// A running lobby is good only while it listens on every address this machine
// has now. A lobby that started before Tailscale connected holds loopback only
// and would otherwise be reused for as long as its process lives.
function sameBinds(saved, binds) {
  const addresses = Array.isArray(saved.addresses) ? saved.addresses : [];
  return addresses.length === binds.length && binds.every((host) => addresses.includes(host));
}

async function stopLobby(pid) {
  if (!alive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // A lobby that exited first has nothing to stop.
  }
  const until = Date.now() + 1500;
  while (Date.now() < until && alive(pid)) await delay(50);
}

function remoteHost(value) {
  const text = String(value || '').replace(/%.+$/, '');
  return text.startsWith('::ffff:') ? text.slice(7) : text.replace(/^\[|\]$/g, '');
}

function readRun() {
  try {
    return JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function relayStatus(run) {
  return new Promise((resolve) => {
    const host = run.host === '0.0.0.0' ? '127.0.0.1' : run.host;
    const request = http.get(
      {
        host,
        port: run.port,
        path: `/status?room=${encodeURIComponent(run.room)}`,
        timeout: 700,
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

// A room is advertised only while its relay answers. The room file can outlive
// a crashed relay, so the endpoint reads the live count instead of trusting it.
async function currentRoom() {
  const run = readRun();
  if (!run || !run.room || !run.host || !run.port || !run.invite) return null;
  const live = await relayStatus(run);
  if (!live) return null;
  const people = Number.isFinite(live.people) ? live.people : live.peers;
  return {
    room: String(run.room),
    roomName: String(run.roomName || 'Room'),
    host: String(run.host),
    port: Number(run.port),
    address: formatAddress(String(run.host), Number(run.port)),
    url: String(run.invite),
    peers: Math.max(0, Number(people) || 0),
    started: typeof run.started === 'string' ? run.started : null,
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('the invite is over the size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function handler(addresses) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const from = remoteHost(req.socket.remoteAddress);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, pid: process.pid, port: LOBBY_PORT, addresses });
    }

    // A room discovery request lists the active room on this machine. The
    // endpoint answers the tailnet and this machine only, and the join link is
    // included so another app can enter the room in one step.
    if (req.method === 'GET' && url.pathname === '/rooms') {
      if (!isLoopbackHost(from) && !isTailnetHost(from)) {
        return json(res, 403, { ok: false, error: `${from} is not on the tailnet` });
      }
      const room = await currentRoom();
      return json(res, 200, { ok: true, rooms: room ? [room] : [] });
    }

    // The inbox holds invite links, and a link holds the room key. Only this
    // machine may read it, so a peer on the tailnet cannot list what it sent.
    if (req.method === 'GET' && url.pathname === '/invites') {
      if (!isLoopbackHost(from)) {
        return json(res, 403, { ok: false, error: 'the inbox is loopback only' });
      }
      return json(res, 200, { ok: true, invites: readInvites() });
    }

    if (req.method === 'POST' && url.pathname === '/invite') {
      if (!isAllowedHost(from)) {
        return json(res, 403, { ok: false, error: `${from} is not on the local network` });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return json(res, 413, { ok: false, error: error.message });
      }
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        return json(res, 400, { ok: false, error: 'the invite is not JSON' });
      }
      try {
        const invite = addInvite(value);
        return json(res, 200, { ok: true, id: invite.id, room: invite.room });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    }

    return json(res, 404, { ok: false, error: 'not found' });
  };
}

function start() {
  const binds = lobbyBinds();
  const addresses = [];
  const servers = [];
  let ready = 0;
  let failed = false;

  const listen = (host) => {
    const server = http.createServer(handler(addresses));
    server.on('error', (error) => {
      if (failed) return;
      failed = true;
      process.stderr.write(`[lobby] cannot listen on ${host}:${LOBBY_PORT}: ${error.code || error.message}\n`);
      for (const other of servers) other.close();
      process.exit(1);
    });
    server.listen(LOBBY_PORT, host, () => {
      addresses.push(host);
      ready += 1;
      if (ready !== binds.length) return;
      const saved = {
        ok: true,
        version: LOBBY_VERSION,
        pid: process.pid,
        port: LOBBY_PORT,
        addresses: [...addresses],
        started: new Date().toISOString(),
      };
      writeLobby(saved);
      process.stdout.write(`[lobby] listening on ${addresses.join(', ')}:${LOBBY_PORT}\n`);
    });
    servers.push(server);
  };

  if (!binds.length) binds.push('127.0.0.1');
  if (binds.length > MAX_PORT_ATTEMPTS * 8) {
    process.stderr.write('[lobby] too many addresses to bind\n');
    process.exit(1);
  }
  for (const host of binds) listen(host);

  const stop = () => {
    for (const server of servers) server.close();
    clearLobby(process.pid);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function healthy(port, ms = 700) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: ms },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

// A running lobby is reused, and a missing one is started detached. The app
// calls this on every poll, so the second call costs one health request.
export async function ensureLobby() {
  const saved = readLobby();
  const binds = lobbyBinds();
  if (
    saved &&
    saved.version === LOBBY_VERSION &&
    alive(saved.pid) &&
    sameBinds(saved, binds) &&
    (await healthy(saved.port || LOBBY_PORT))
  ) {
    return {
      running: true,
      started: false,
      pid: saved.pid,
      port: saved.port || LOBBY_PORT,
      addresses: Array.isArray(saved.addresses) ? saved.addresses : [],
    };
  }
  if (saved && alive(saved.pid)) await stopLobby(saved.pid);

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, BROSR_LOBBY_PORT: String(LOBBY_PORT) },
  });
  child.unref();

  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const check = readLobby();
    if (check && check.pid === child.pid && (await healthy(check.port || LOBBY_PORT))) {
      return {
        running: true,
        started: true,
        pid: check.pid,
        port: check.port || LOBBY_PORT,
        addresses: Array.isArray(check.addresses) ? check.addresses : [],
      };
    }
    await delay(80);
  }
  throw new Error(`The invite lobby did not start on port ${LOBBY_PORT}.`);
}

export { LOBBY_FILE };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();
}
