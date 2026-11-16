// Shared cursor identity: the room name, the colours a person can pick, and the
// custom pointer image that replaces them. The browser client and the panel
// both use these rules, so a name or colour is cleaned once.

export const ROOM_COLOURS = [
  '#e2603f',
  '#3f86e2',
  '#d94f8a',
  '#2f9e6b',
  '#b07a2a',
  '#7a5cd6',
  '#cf3b3b',
  '#2f8fa8',
  '#8f6a3d',
  '#6366f1',
  '#c2410c',
  '#15803d',
];

const COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
// A presence frame is capped at 16 KB. Leave room for the rest of the frame.
export const CURSOR_DATA_LIMIT = 12000;

export function isColour(value) {
  return typeof value === 'string' && COLOUR.test(value.trim());
}

export function cleanRoomName(value, fallback = 'Room') {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (text || fallback).slice(0, 48);
}

// Two people see each other's pointer only on the same site. Presence carries
// the page it came from, so this key decides whether a cursor belongs here.
// A bare domain and its www host are one site, while another subdomain, a
// different scheme or another port is not. An unreadable address answers an
// empty key, which never matches a real site.
const WWW = /^www\./i;
export function siteOf(href) {
  try {
    const url = new URL(String(href || ''));
    if (url.origin === 'null') return '';
    const host = url.hostname.replace(WWW, '');
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return '';
  }
}

// A brosr app runs on a path of the same origin as the room, so the site key
// alone cannot tell Canvas from Notes. An app adds its own suffix, and every
// other page keeps the plain site key.
const APPS = ['/canvas', '/notes'];
export function cursorSiteOf(href) {
  const base = siteOf(href);
  if (!base) return '';
  try {
    const path = new URL(String(href)).pathname.toLowerCase().replace(/\/+$/, '');
    const app = APPS.find((name) => path === name || path.startsWith(`${name}/`));
    return app ? `${base}${app}` : base;
  } catch {
    return base;
  }
}

// Canvas and Notes are the only sites that show pointers until the host says
// otherwise. Every other site starts off.
export function defaultCursorSites(href) {
  const base = siteOf(href);
  if (!base) return [];
  return APPS.map((name) => `${base}${name}`);
}

// The host sends the site list, so it is cleaned and bounded here. An empty
// list is a real choice: no site shows a pointer.
export function cleanCursorSites(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    // A site key is normalized the same way presence is, so a trailing slash
    // or a www host never splits one site into two.
    const key = cursorSiteOf(entry.trim().slice(0, 200));
    if (!key) continue;
    seen.add(key);
  }
  return [...seen].slice(0, 60);
}

function channel(value) {
  return Math.round(value).toString(16).padStart(2, '0');
}

function hsl(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  return `#${channel((r + m) * 255)}${channel((g + m) * 255)}${channel((b + m) * 255)}`;
}

export function randomColour(random = Math.random) {
  const index = Math.floor(Math.max(0, Math.min(0.999999, random())) * ROOM_COLOURS.length);
  return ROOM_COLOURS[index];
}

// A room with more people than swatches still gets a distinct colour. The
// palette is tried first, then a deterministic hue walk fills the gaps.
export function nextColour(used = []) {
  const taken = new Set(
    [...used].filter(isColour).map((colour) => colour.toLowerCase())
  );
  const free = ROOM_COLOURS.find((colour) => !taken.has(colour.toLowerCase()));
  if (free) return free;
  for (let index = 0; index < 360; index += 1) {
    const colour = hsl((index * 137.508) % 360, 62, 54);
    if (!taken.has(colour.toLowerCase())) return colour;
  }
  return ROOM_COLOURS[0];
}

// A custom pointer is a small, self-contained image. Refusing anything else
// keeps a remote frame from making a page fetch an arbitrary address.
export function cleanCursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const src = typeof value.src === 'string' ? value.src : '';
  if (!/^data:image\/(?:png|webp|gif|jpeg);base64,[a-z0-9+/=]+$/i.test(src)) return null;
  if (src.length > CURSOR_DATA_LIMIT) return null;
  const width = Math.max(1, Math.min(64, Math.round(Number(value.w) || 32)));
  const height = Math.max(1, Math.min(64, Math.round(Number(value.h) || 32)));
  const name = typeof value.name === 'string' ? value.name.replace(/\s+/g, ' ').trim() : '';
  return {
    src,
    name: name.slice(0, 40),
    w: width,
    h: height,
  };
}
