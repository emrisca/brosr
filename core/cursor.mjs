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
// An animated GIF keeps its own bytes, so the ceiling leaves about 1.8 KB for
// the peer id, the name and the address. A smaller limit refused every frame
// of a cursor that actually animates.
export const CURSOR_DATA_LIMIT = 14200;

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

// A cursor decision is a rule with a name. The panel reads the reason, so a
// hidden pointer says whether the site differs or the host turned it off.
export function cursorDecision({ peerUrl, here, sites = null, sharePointer = true } = {}) {
  if (sharePointer === false) return { allow: false, reason: 'pointer-off', site: null };
  const peerSite = cursorSiteOf(peerUrl);
  const hereSite = cursorSiteOf(here);
  if (!peerSite || !hereSite) return { allow: false, reason: 'unknown-site', site: null };
  if (peerSite !== hereSite) return { allow: false, reason: 'other-site', site: peerSite };
  if (sites !== null && !sites.includes(peerSite)) {
    return { allow: false, reason: 'site-off', site: peerSite };
  }
  return { allow: true, reason: 'ok', site: peerSite };
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

// A cursors-4u set carries one pointer per Windows role. Only the default
// role travels to the room, because a remote cursor is drawn at a point and
// has no element under it to choose a state from. The person holding the
// cursor uses every state on their own page.
export const CURSOR_ROLES = [
  'default',
  'pointer',
  'text',
  'wait',
  'progress',
  'help',
  'not-allowed',
  'move',
  'crosshair',
  'ns-resize',
  'ew-resize',
  'nwse-resize',
  'nesw-resize',
];

// A set names its files after the Windows pointer roles, often with the set
// name in front ("Scuba Cat Link Select"). Matching the role words keeps a
// renamed file in its role, and an unknown name falls back to the arrow.
export function cursorRole(value) {
  const text = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!text) return 'default';
  if (text.includes('unavailable') || text.includes('not allowed')) return 'not-allowed';
  if (text.includes('busy') || text.includes('wait')) return 'wait';
  if (text.includes('working') || text.includes('app starting') || text.includes('background')) {
    return 'progress';
  }
  if (text.includes('help')) return 'help';
  // Diagonal 2 comes first, because its name contains Diagonal 1's word too.
  if (text.includes('diagonal') && /\b(2|two)\b/.test(text)) return 'nesw-resize';
  if (text.includes('diagonal')) return 'nwse-resize';
  if (text.includes('vertical') || text.includes('north south')) return 'ns-resize';
  if (text.includes('horizontal') || text.includes('east west')) return 'ew-resize';
  // Handwriting holds the word hand, so the text roles are read first.
  if (text.includes('handwriting') || text.includes('text') || text.includes('beam')) return 'text';
  if (text.includes('link') || text.includes('hand')) return 'pointer';
  if (text.includes('crosshair') || text.includes('precision')) return 'crosshair';
  if (text.includes('move')) return 'move';
  return 'default';
}

// A state never travels to the room, so it may keep the full animated preview
// the site served. The total keeps a fifteen state set well inside the store
// quota of one origin.
export const CURSOR_STATE_LIMIT = 200000;
export const CURSOR_STATE_TOTAL = 900000;

// A set arrives from the panel as a list of named images, and from storage as
// a role map. One image per role is enough, and the first one wins so a set
// with two Normal files still has one arrow.
export function cleanCursorStates(value, limit = CURSOR_STATE_LIMIT) {
  let entries = [];
  if (Array.isArray(value)) {
    entries = value;
  } else if (value && typeof value === 'object') {
    entries = CURSOR_ROLES.filter((role) => value[role]).map((role) => ({
      ...value[role],
      role,
    }));
  }
  const states = {};
  let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const state = cleanCursorImage(entry, limit);
    if (!state) continue;
    if (total + state.src.length > CURSOR_STATE_TOTAL) continue;
    const role = CURSOR_ROLES.includes(entry.role) ? entry.role : cursorRole(entry.name);
    if (states[role]) continue;
    states[role] = {
      src: state.src,
      w: state.w,
      h: state.h,
      ...(state.animated ? { animated: true } : {}),
    };
    total += state.src.length;
  }
  return Object.keys(states).length ? states : null;
}

// The stored cursor keeps every state. cleanCursor still describes the wire
// shape, so a room frame never carries fifteen images.
export function restoreCursor(value) {
  const base = cleanCursor(value);
  if (!base) return null;
  const states = cleanCursorStates(value.states);
  return states ? { ...base, states } : base;
}

// A browser draws the first frame of a cursor image and never animates it, so
// a moving pointer needs a follower element. A set with more than one state
// needs one too, because the image changes with the element under the point.
export function cursorNeedsFollower(cursor) {
  if (!cursor) return false;
  const states = cursor.states || {};
  if (Object.keys(states).length > 1) return true;
  const local = states.default || cursor;
  if (!local || typeof local.src !== 'string' || !local.src) return false;
  if (local.animated) return true;
  return /^data:image\/gif;base64,/i.test(local.src);
}

// A custom pointer is a small, self-contained image. Refusing anything else
// keeps a remote frame from making a page fetch an arbitrary address.
export function cleanCursorImage(value, limit = CURSOR_DATA_LIMIT) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const src = typeof value.src === 'string' ? value.src : '';
  if (!/^data:image\/(?:png|webp|gif|jpeg);base64,[a-z0-9+/=]+$/i.test(src)) return null;
  if (src.length > limit) return null;
  const width = Math.max(1, Math.min(96, Math.round(Number(value.w) || 32)));
  const height = Math.max(1, Math.min(96, Math.round(Number(value.h) || 32)));
  const name = typeof value.name === 'string' ? value.name.replace(/\s+/g, ' ').trim() : '';
  return {
    src,
    name: name.slice(0, 40),
    w: width,
    h: height,
    ...(value.animated ? { animated: true } : {}),
  };
}

// The room frame keeps the small limit. A local state uses the larger one.
export function cleanCursor(value) {
  return cleanCursorImage(value, CURSOR_DATA_LIMIT);
}
