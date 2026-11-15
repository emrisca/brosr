// Friends and invites, kept to loopback, the local network and the tailnet.
// This module holds the address rules, the invite envelope and the id format.
// It never opens a socket and never reads a file, so the same checks run in a
// Node test, in the host and in the app's lobby.
//
// A friend is one address a person can reach: `host:port` for the other
// person's lobby. An invite carries the room link and the sender's lobby
// address, so the receiver can answer without asking anything else.

export const DEFAULT_LOBBY_PORT = 8790;
// An invite that sat unread for a day names a room that is almost surely gone.
export const MAX_INVITE_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_INVITES = 25;

function fail(message) {
  throw new Error(message);
}

function stripBrackets(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

// Four decimal octets, or null. A leading zero is refused, because one reader
// may treat `010` as ten and another as eight.
function ipv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

export function isLoopbackHost(host) {
  const clean = stripBrackets(host);
  if (clean === 'localhost' || clean === '::1') return true;
  const octets = ipv4(clean);
  return Boolean(octets && octets[0] === 127);
}

// RFC 1918, the shared address space the tailnet uses, and the two name
// suffixes a tailnet or a local network hands out. Link local is refused,
// because an address in 169.254/16 is not a stable way to find a person.
export function isPrivateHost(host) {
  const clean = stripBrackets(host);
  const octets = ipv4(clean);
  if (octets) {
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 unique local addresses, which covers the fd7a:115c:a1e0 block a
  // tailnet hands out as well as the fc00::/7 range.
  if (/^f[cd][0-9a-f]{0,2}:/.test(clean)) return true;
  return clean.endsWith('.ts.net') || clean.endsWith('.local');
}

// The one rule the whole feature rests on. Everything else checks this.
export function isAllowedHost(host) {
  return isLoopbackHost(host) || isPrivateHost(host);
}

function checkHost(host) {
  const clean = stripBrackets(host);
  if (!clean) fail('an address needs a host');
  if (!isAllowedHost(clean)) {
    fail(`${clean} is not a loopback, local network or tailnet address`);
  }
  return clean;
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${port} is not a port`);
  }
  return port;
}

export function formatAddress(host, port) {
  const clean = stripBrackets(host);
  return clean.includes(':') ? `[${clean}]:${port}` : `${clean}:${port}`;
}

// `host:port`, with brackets around an IPv6 host.
export function splitAddress(value) {
  const text = String(value || '').trim();
  if (!text) fail('an address is required');
  let host;
  let portText;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) fail(`the address ${text} has no closing bracket`);
    host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (rest && !rest.startsWith(':')) fail(`the address ${text} is not host:port`);
    portText = rest.slice(1);
  } else {
    const at = text.lastIndexOf(':');
    if (at < 0) fail(`the address ${text} has no port`);
    host = text.slice(0, at);
    portText = text.slice(at + 1);
    if (host.includes(':')) fail(`write an IPv6 address as [host]:port`);
  }
  return { host: stripBrackets(host), port: checkPort(Number(portText)) };
}

// One friend address. A scheme and a trailing slash are accepted, because a
// person will paste what the other app shows. Credentials and a path are not,
// because an address names one lobby and nothing else.
export function normalizeAddress(value, { port = DEFAULT_LOBBY_PORT } = {}) {
  if (typeof value !== 'string') fail('an address must be text');
  const text = value.trim();
  if (!text) fail('an address is required');
  let host;
  let chosen = port;
  if (text.includes('://')) {
    let url;
    try {
      url = new URL(text);
    } catch {
      fail(`the address ${text} is not a URL`);
    }
    if (url.protocol !== 'http:') fail('a friend address uses http on the local network');
    if (url.username || url.password) fail('a friend address carries no credentials');
    if (url.search || url.hash) fail('a friend address carries no query or fragment');
    if (url.pathname && url.pathname !== '/') fail('a friend address names no path');
    host = url.hostname;
    chosen = url.port ? Number(url.port) : port;
  } else if (text.startsWith('[')) {
    const parts = splitAddress(text);
    host = parts.host;
    chosen = parts.port;
  } else {
    const at = text.lastIndexOf(':');
    if (at >= 0) {
      host = text.slice(0, at);
      chosen = Number(text.slice(at + 1));
    } else {
      host = text;
    }
    if (host.includes(':')) fail('write an IPv6 address as [host]:port');
  }
  checkPort(chosen);
  return formatAddress(checkHost(host), chosen);
}

// A room link as the relay writes it: http, one room, a relay port and the
// room key in the fragment. The key never travels to a lobby, so a stored
// invite is the only place it sits outside the browser.
export function parseInviteLink(link) {
  let url;
  try {
    url = new URL(String(link || ''));
  } catch {
    fail('the invite is not a URL');
  }
  if (url.protocol !== 'http:') fail('an invite link uses http on the local network');
  const host = checkHost(url.hostname);
  const room = url.searchParams.get('room');
  if (!room) fail('the invite names no room');
  const key = new URLSearchParams(url.hash.replace(/^#/, '')).get('k');
  if (!key) fail('the invite has no room key in its fragment');
  const relayText = url.searchParams.get('relay') || url.port;
  const relayPort = relayText ? Number(relayText) : 80;
  checkPort(relayPort);
  return {
    url: url.toString(),
    host,
    port: url.port ? Number(url.port) : 80,
    relayPort,
    room,
    key,
    peer: url.searchParams.get('peer') || '',
    name: url.searchParams.get('name') || '',
  };
}

export function inviteToken() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `invite-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function cleanName(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 64) : fallback;
}

// One invite, checked before it is stored or sent. The link host and the
// sender host must agree, because an invite that names one machine and points
// at another is either a mistake or an attempt to move the key elsewhere.
export function validateInvite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('an invite must be an object');
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!/^invite-[a-f0-9]{8,32}$/.test(id)) fail('an invite needs an id');
  const from = normalizeAddress(value.from);
  const link = parseInviteLink(value.url);
  if (link.host !== splitAddress(from).host) {
    fail('the invite link and its sender name different hosts');
  }
  const createdAt = Number(value.createdAt);
  return {
    id,
    from,
    name: cleanName(value.name, splitAddress(from).host),
    room: link.room,
    url: link.url,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
  };
}

export function makeInvite({ id = inviteToken(), from, name = 'Host', url, createdAt = Date.now() } = {}) {
  return validateInvite({ id, from, name, url, createdAt });
}
