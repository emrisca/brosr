// The trusted actuator. A relayed record becomes one browser input action, so
// the page sees isTrusted true and a form receives real typing. The page cannot
// open this channel alone: the loopback agent needs a token and an active
// grant, and the start path owns both.
//
// A point travels as a selector plus a canvas fraction, because a record made on
// another window has no viewport point here. The receiver resolves it against
// its own layout, then sends the number.

import { isSensitiveField, pointerLockDecision, resolvePath } from './input.mjs';

export { pointerLockDecision };

const isPoint = (point) =>
  Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

const LINE_PIXELS = 40;
const PAGE_PIXELS = 800;

// W3C WebDriver BiDi key values for non-printable/special keys. Firefox 131+
// strictly requires a single Unicode code point per keyDown/keyUp action.
export const BIDI_KEYS = {
  Cancel: '\uE001',
  Help: '\uE002',
  Backspace: '\uE003',
  Tab: '\uE004',
  Clear: '\uE005',
  Return: '\uE006',
  Enter: '\uE006',
  NumpadEnter: '\uE007',
  Shift: '\uE008',
  Control: '\uE009',
  Alt: '\uE00A',
  Pause: '\uE00B',
  Escape: '\uE00C',
  Esc: '\uE00C',
  Space: ' ',
  Spacebar: ' ',
  ' ': ' ',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
  End: '\uE010',
  Home: '\uE011',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
  Insert: '\uE016',
  Delete: '\uE017',
  F1: '\uE031',
  F2: '\uE032',
  F3: '\uE033',
  F4: '\uE034',
  F5: '\uE035',
  F6: '\uE036',
  F7: '\uE037',
  F8: '\uE038',
  F9: '\uE039',
  F10: '\uE03A',
  F11: '\uE03B',
  F12: '\uE03C',
  Meta: '\uE03D',
};

function wheelDeltas(record) {
  const rawX = record && record.deltaX !== undefined ? Number(record.deltaX) : 0;
  const rawY = record && record.deltaY !== undefined ? Number(record.deltaY) : 0;
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
  const mode = Number(record && record.deltaMode);
  const scale = mode === 1 ? LINE_PIXELS : mode === 2 ? PAGE_PIXELS : 1;
  return {
    deltaX: Math.round(rawX * scale),
    deltaY: Math.round(rawY * scale),
  };
}

function keyValue(record) {
  const key = String((record && record.key) || '');
  if (!key) return '';
  if (Object.prototype.hasOwnProperty.call(BIDI_KEYS, key)) return BIDI_KEYS[key];
  const chars = Array.from(key);
  return chars.length === 1 ? chars[0] : '';
}

function modifierKeys(record, skipValue = '') {
  const mods = [];
  if (record && (record.ctrl || record.ctrlKey)) mods.push(BIDI_KEYS.Control);
  if (record && (record.alt || record.altKey)) mods.push(BIDI_KEYS.Alt);
  if (record && (record.shift || record.shiftKey)) mods.push(BIDI_KEYS.Shift);
  if (record && (record.meta || record.metaKey)) mods.push(BIDI_KEYS.Meta);
  return skipValue ? mods.filter((value) => value !== skipValue) : mods;
}

// Wrap a non-key input source (pointer or wheel) with a tick-aligned key
// source when keyboard modifiers are active, matching WebDriver BiDi ticks.
function withModifiers(source, mods) {
  if (!mods.length) return [source];
  const keyActions = [];
  const primaryActions = [];
  for (const mod of mods) {
    keyActions.push({ type: 'keyDown', value: mod });
    primaryActions.push({ type: 'pause', duration: 0 });
  }
  for (const action of source.actions) {
    keyActions.push({ type: 'pause', duration: 0 });
    primaryActions.push(action);
  }
  for (let i = mods.length - 1; i >= 0; i -= 1) {
    keyActions.push({ type: 'keyUp', value: mods[i] });
    primaryActions.push({ type: 'pause', duration: 0 });
  }
  return [
    { type: 'key', id: 'brosr-keys', actions: keyActions },
    { ...source, actions: primaryActions },
  ];
}

// The viewport point a record addresses, from its own point or from its path.
// A record with neither cannot be placed by the browser's input pipeline.
export function pointFor(record, doc) {
  if (isPoint(record && record.point)) return { x: record.point.x, y: record.point.y };
  if (!doc || !record || !record.path) return null;
  const node = resolvePath(doc, record.path);
  if (!node || typeof node.getBoundingClientRect !== 'function') return null;
  const rect = node.getBoundingClientRect();
  if (
    !rect ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !rect.width ||
    !rect.height
  ) {
    return null;
  }
  const rawFx = record.canvas && Number.isFinite(record.canvas.x) ? record.canvas.x : 0.5;
  const rawFy = record.canvas && Number.isFinite(record.canvas.y) ? record.canvas.y : 0.5;
  const fx = Math.max(0, Math.min(1, rawFx));
  const fy = Math.max(0, Math.min(1, rawFy));
  return {
    x: rect.left + fx * rect.width,
    y: rect.top + fy * rect.height,
  };
}

// Guardrail #5: explicit trusted-record policy returning allow plus a reason.
export function trustDecision(record, doc = null) {
  if (!record || typeof record !== 'object') {
    return { allow: false, reason: 'invalid-record' };
  }
  const lock = pointerLockDecision({ doc, record });
  if (!lock.allow) return lock;

  const targetNode = doc && record.path ? resolvePath(doc, record.path) : null;
  if (['click', 'down', 'up'].includes(record.kind)) {
    if (targetNode && isSensitiveField(targetNode)) {
      return { allow: false, reason: 'sensitive' };
    }
    if (record.kind === 'click' && !pointFor(record, doc)) {
      return { allow: false, reason: 'target' };
    }
    return { allow: true, reason: 'ok' };
  }
  if (record.kind === 'move') {
    return pointFor(record, doc)
      ? { allow: true, reason: 'ok' }
      : { allow: false, reason: 'target' };
  }
  if (record.kind === 'wheel') {
    if (!wheelDeltas(record)) return { allow: false, reason: 'delta' };
    return pointFor(record, doc)
      ? { allow: true, reason: 'ok' }
      : { allow: false, reason: 'target' };
  }
  if (record.kind === 'key') {
    const node = targetNode || (doc && doc.activeElement);
    if (node && isSensitiveField(node)) return { allow: false, reason: 'sensitive' };
    return keyValue(record) ? { allow: true, reason: 'ok' } : { allow: false, reason: 'key' };
  }
  if (record.kind === 'text') {
    const node = targetNode || (doc && doc.activeElement);
    if (node && isSensitiveField(node)) return { allow: false, reason: 'sensitive' };
    return String(record.value || '')
      ? { allow: true, reason: 'ok' }
      : { allow: false, reason: 'text' };
  }
  return { allow: false, reason: 'kind' };
}

// The page side of the channel. It resolves each record and focuses the field
// before the keys arrive. Records refused by pointer lock, sensitive-field
// guards, invalid deltas, or missing layout points are dropped.
export function prepareRecords(records, doc) {
  if (!pointerLockDecision({ doc }).allow) return [];
  const out = [];
  for (const record of records || []) {
    if (!record || typeof record !== 'object') continue;
    if (!pointerLockDecision({ doc, record }).allow) continue;
    const next = { ...record };
    const targetNode = doc && record.path ? resolvePath(doc, record.path) : null;
    if (['click', 'down', 'up'].includes(record.kind) && targetNode && isSensitiveField(targetNode)) {
      continue;
    }
    if (record.kind === 'wheel' && !wheelDeltas(record)) continue;
    if (['move', 'click', 'down', 'up', 'wheel'].includes(record.kind)) {
      const point = pointFor(record, doc);
      if (!point) continue;
      next.point = point;
    }
    if (record.kind === 'key' || record.kind === 'text') {
      const node = targetNode || (doc && doc.activeElement);
      if (node && isSensitiveField(node)) continue;
      if (node && typeof node.focus === 'function') {
        try {
          node.focus({ preventScroll: true });
        } catch {
          // A field that refuses focus keeps the current one.
        }
      }
    }
    out.push(next);
  }
  return out;
}

const mouseSource = (actions) => ({
  type: 'pointer',
  id: 'brosr-mouse',
  parameters: { pointerType: 'mouse' },
  actions,
});

function validButton(raw) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 4 ? value : 0;
}

// One record, one action list. The agent sends each list in order, so a click
// never lands after the key that followed it.
export function actionsForRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (!pointerLockDecision({ record }).allow) return null;
  const point = record.point;
  switch (record.kind) {
    case 'move':
      if (!isPoint(point)) return null;
      return [
        mouseSource([{ type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport' }]),
      ];
    case 'click': {
      if (!isPoint(point)) return null;
      const button = validButton(record.button);
      const source = mouseSource([
        { type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport' },
        { type: 'pointerDown', button },
        { type: 'pointerUp', button },
      ]);
      return withModifiers(source, modifierKeys(record));
    }
    case 'down':
    case 'up': {
      const button = validButton(record.button);
      const actions = [];
      if (isPoint(point)) {
        actions.push({ type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport' });
      }
      actions.push({ type: record.kind === 'down' ? 'pointerDown' : 'pointerUp', button });
      return withModifiers(mouseSource(actions), modifierKeys(record));
    }
    case 'key': {
      const value = keyValue(record);
      if (!value) return null;
      const mods = modifierKeys(record, value);
      const actions = [];
      for (const mod of mods) actions.push({ type: 'keyDown', value: mod });
      actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
      for (let i = mods.length - 1; i >= 0; i -= 1) {
        actions.push({ type: 'keyUp', value: mods[i] });
      }
      return [{ type: 'key', id: 'brosr-keys', actions }];
    }
    case 'text': {
      const text = String(record.value || '');
      if (!text) return null;
      const actions = [];
      for (const char of Array.from(text)) {
        actions.push({ type: 'keyDown', value: char }, { type: 'keyUp', value: char });
      }
      return [{ type: 'key', id: 'brosr-keys', actions }];
    }
    case 'wheel': {
      if (!isPoint(point)) return null;
      const deltas = wheelDeltas(record);
      if (!deltas) return null;
      // WebDriver BiDi requires source type "wheel" with integer coords/deltas.
      const source = {
        type: 'wheel',
        id: 'brosr-wheel',
        actions: [
          {
            type: 'scroll',
            x: Math.round(point.x),
            y: Math.round(point.y),
            deltaX: deltas.deltaX,
            deltaY: deltas.deltaY,
            duration: 0,
            origin: 'viewport',
          },
        ],
      };
      return withModifiers(source, modifierKeys(record));
    }
    default:
      return null;
  }
}

// The room page holds this client. The token is in the fragment, which the
// relay never sees and another origin cannot read.
export function createTrustClient({ url, token, fetchImpl } = {}) {
  const call = fetchImpl || ((...args) => fetch(...args));
  const stats = { sent: 0, applied: 0, failed: 0, records: 0, reason: null };
  const endpoint = String(url || '').replace(/\/$/, '');
  return {
    url: endpoint,
    stats,
    async send(records) {
      if (!Array.isArray(records) || !records.length) return { ok: true, applied: 0 };
      stats.sent += 1;
      stats.records += records.length;
      try {
        const res = await call(`${endpoint}/action`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ records }),
        });
        let body = null;
        try {
          body = await res.json();
        } catch {
          // A refusal with no body still has a status.
        }
        if (res.ok && body && body.ok) {
          stats.applied += Number(body.applied) || 0;
          return body;
        }
        stats.failed += 1;
        stats.reason = (body && body.reason) || `status ${res.status}`;
        return {
          ok: false,
          ...(body && body.allow === false ? { allow: false } : {}),
          reason: stats.reason,
        };
      } catch (error) {
        stats.failed += 1;
        stats.reason = String((error && error.message) || error);
        return { ok: false, reason: stats.reason };
      }
    },
  };
}
