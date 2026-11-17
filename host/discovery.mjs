// Room discovery. A lobby advertises only the room its machine is running, and
// this module asks every online tailnet peer for that list. The lobby address
// stays local to the tailnet, so nothing here searches the public internet.
import { spawnSync } from 'node:child_process';
import { DEFAULT_LOBBY_PORT, formatAddress, isAllowedHost, isTailnetHost } from '../core/friends.mjs';

const QUERY_TIMEOUT_MS = 1400;
const STATUS_TIMEOUT_MS = 4000;

function binaries() {
  if (process.platform === 'win32') {
    return [
      'tailscale',
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    ];
  }
  return [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/usr/bin/tailscale',
  ];
}

// The status document names every node. A node has both an IPv4 and an IPv6
// tailnet address, and either interface can be the one its lobby bound. Keep
// both, with IPv4 first because a Tailscale network usually gives it first.
export function tailnetFromStatus(value) {
  if (!value || typeof value !== 'object' || !value.Self) return null;
  const peers = [];
  for (const node of Object.values(value.Peer || {})) {
    if (!node || node.Online === false) continue;
    const ips = Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs : [];
    const usable = [...new Set(ips.map(String).filter(isTailnetHost))];
    if (!usable.length) continue;
    const host = usable.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || usable[0];
    const hosts = [host, ...usable.filter((ip) => ip !== host)];
    peers.push({
      host,
      hosts,
      name: String(node.HostName || node.DNSName || host).replace(/\.$/, ''),
    });
  }
  return { tailnet: true, peers };
}

export function tailscaleStatus() {
  for (const binary of binaries()) {
    const result = spawnSync(binary, ['status', '--json'], {
      encoding: 'utf8',
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !result.stdout) continue;
    try {
      return tailnetFromStatus(JSON.parse(result.stdout));
    } catch {
      // Another candidate may still answer with valid JSON.
    }
  }
  return null;
}

function roomFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const room = typeof value.room === 'string' ? value.room.trim() : '';
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  const port = Number(value.port);
  const url = typeof value.url === 'string' ? value.url.trim() : '';
  if (!room || !host || !url || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  if (!isAllowedHost(host)) return null;
  try {
    const link = new URL(url);
    const linkHost = link.hostname.replace(/^\[|\]$/g, '');
    if (link.protocol !== 'http:' || !isAllowedHost(linkHost)) return null;
  } catch {
    return null;
  }
  return {
    room,
    roomName: typeof value.roomName === 'string' && value.roomName.trim() ? value.roomName.trim() : 'Room',
    host,
    port,
    address:
      typeof value.address === 'string' && value.address.trim()
        ? value.address.trim()
        : formatAddress(host, port),
    url,
    peers: Math.max(0, Number(value.peers) || 0),
    started: typeof value.started === 'string' ? value.started : null,
  };
}

async function askLobby(host, port, timeout, fetchImpl) {
  try {
    const response = await fetchImpl(`http://${formatAddress(host, port)}/rooms`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body && body.rooms) ? body.rooms.map(roomFrom).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// A peer's lobby runs on the default port. BROSR_LOBBY_PORT separates two dev
// instances on one machine, so it must never be the port a peer is asked on.
export async function discoverRooms({
  status = tailscaleStatus(),
  port = DEFAULT_LOBBY_PORT,
  timeout = QUERY_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const peers = status && Array.isArray(status.peers) ? status.peers : [];
  // A lobby may listen on only one of a node's two tailnet addresses, so ask
  // both. A timeout on one family costs nothing to the other query.
  const hosts = [
    ...new Set(
      peers.flatMap((peer) =>
        Array.isArray(peer.hosts) && peer.hosts.length ? peer.hosts : [peer.host]
      )
    ),
  ].filter(Boolean);
  const lists = await Promise.all(hosts.map((host) => askLobby(host, port, timeout, fetchImpl)));
  const seen = new Set();
  const rooms = [];
  for (const room of lists.flat()) {
    const key = `${room.room}|${room.address}|${room.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rooms.push(room);
  }
  rooms.sort((a, b) => a.roomName.localeCompare(b.roomName) || a.address.localeCompare(b.address));
  return {
    tailnet: Boolean(status && status.tailnet),
    peers: peers.length,
    rooms,
  };
}
