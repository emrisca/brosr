// The friend list, the invite inbox and the addresses this machine offers.
// Both lists are small JSON files in the app state folder, because a one shot
// CLI keeps nothing between calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LOBBY_PORT,
  MAX_INVITE_AGE_MS,
  MAX_INVITES,
  formatAddress,
  isAllowedHost,
  normalizeAddress,
  splitAddress,
  validateInvite,
} from '../core/friends.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.BROSR_STATE ? path.resolve(process.env.BROSR_STATE) : path.join(here, '.run');
const FRIENDS_FILE = path.join(STATE, 'friends.json');
const INVITES_FILE = path.join(STATE, 'invites.json');

export const LOBBY_PORT = Number(process.env.BROSR_LOBBY_PORT) || DEFAULT_LOBBY_PORT;

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return value;
}

function cleanName(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 64) : fallback;
}

// The tailnet hands this machine one address in 100.64/10. A second interface
// is possible, so every candidate is returned and the first usable one wins.
export function tailnetHosts() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (!entry || entry.internal) continue;
      const family = entry.family;
      if ((family === 'IPv4' || family === 4) && entry.address.startsWith('100.')) {
        const second = Number(entry.address.split('.')[1]);
        if (second >= 64 && second <= 127) out.push(entry.address);
      } else if ((family === 'IPv6' || family === 6) && /^f[cd]/i.test(entry.address)) {
        out.push(entry.address);
      }
    }
  }
  return [...new Set(out)];
}

// One address for the relay. A tailnet address is reachable by a friend, so it
// wins over loopback. BROSR_BIND forces a choice, and a public value is refused
// so the variable can never widen the room by accident.
export function bindHost() {
  const forced = process.env.BROSR_BIND;
  if (forced) {
    if (!isAllowedHost(forced)) {
      throw new Error(`${forced} is not a loopback, local network or tailnet address`);
    }
    return forced;
  }
  return tailnetHosts()[0] || '127.0.0.1';
}

export function lobbyBinds() {
  return [...new Set([bindHost(), '127.0.0.1'])];
}

// The address friends see. With no tailnet it is loopback, which is only
// useful on this machine, and the app says so.
export function localLobbyAddress() {
  return formatAddress(bindHost(), LOBBY_PORT);
}

export function readFriends() {
  const saved = readJson(FRIENDS_FILE, []);
  const list = Array.isArray(saved) ? saved : [];
  return list
    .filter((entry) => entry && typeof entry.address === 'string')
    .map((entry) => {
      try {
        const address = normalizeAddress(entry.address);
        const { host, port } = splitAddress(address);
        return {
          address,
          host,
          port,
          name: cleanName(entry.name, host),
          addedAt: Number(entry.addedAt) || 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function addFriend({ address, name = '' } = {}) {
  const normalized = normalizeAddress(address);
  const { host, port } = splitAddress(normalized);
  const list = readFriends();
  const existing = list.find((entry) => entry.address === normalized);
  const friend = {
    address: normalized,
    host,
    port,
    name: cleanName(name, existing ? existing.name : host),
    addedAt: existing ? existing.addedAt : Date.now(),
  };
  const next = [friend, ...list.filter((entry) => entry.address !== normalized)];
  writeJson(FRIENDS_FILE, next);
  return friend;
}

export function findFriend(address) {
  const normalized = normalizeAddress(address);
  const friend = readFriends().find((entry) => entry.address === normalized);
  if (!friend) throw new Error(`Add ${normalized} as a friend before you send it an invite.`);
  return friend;
}

export function removeFriend(address) {
  const normalized = normalizeAddress(address);
  const list = readFriends();
  const next = list.filter((entry) => entry.address !== normalized);
  writeJson(FRIENDS_FILE, next);
  return { removed: next.length !== list.length, address: normalized };
}

// An invite is kept until it is answered or a day passes. The list is capped,
// so a peer on the tailnet cannot fill the disk with offers.
export function readInvites() {
  const saved = readJson(INVITES_FILE, []);
  const list = Array.isArray(saved) ? saved : [];
  const now = Date.now();
  const out = [];
  for (const entry of list) {
    try {
      const invite = validateInvite(entry);
      if (now - invite.createdAt > MAX_INVITE_AGE_MS) continue;
      out.push(invite);
    } catch {
      // A record that no longer validates is dropped, not repaired.
    }
  }
  return out;
}

export function addInvite(value) {
  const invite = validateInvite(value);
  const next = [invite, ...readInvites().filter((entry) => entry.id !== invite.id)].slice(0, MAX_INVITES);
  writeJson(INVITES_FILE, next);
  return invite;
}

export function getInvite(id) {
  const invite = readInvites().find((entry) => entry.id === id);
  if (!invite) throw new Error(`There is no invite ${id}.`);
  return invite;
}

export function removeInvite(id) {
  const list = readInvites();
  const next = list.filter((entry) => entry.id !== id);
  writeJson(INVITES_FILE, next);
  return next.length !== list.length;
}

export function readFriendState() {
  return { friends: readFriends(), invites: readInvites(), me: localLobbyAddress() };
}

// Hand one invite to another machine's lobby. The address was checked against
// the same rules when it was added as a friend, and it is checked again here.
export async function sendInvite(address, invite) {
  const normalized = normalizeAddress(address);
  const body = JSON.stringify(validateInvite(invite));
  let response;
  try {
    response = await fetch(`http://${normalized}/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new Error(`${normalized} did not answer: ${error.message}`);
  }
  let answer = null;
  try {
    answer = await response.json();
  } catch {
    answer = null;
  }
  if (!response.ok) {
    throw new Error((answer && answer.error) || `${normalized} refused the invite.`);
  }
  return answer || { ok: true };
}

export { STATE, FRIENDS_FILE, INVITES_FILE };
