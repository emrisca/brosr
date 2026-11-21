// Layer 4: input relay, control grants and the receiver-side guards.
// Section 8 and Section 10 of ../docs/plan.md are the specification.

import { encode, splitInput } from './protocol.mjs';

export const POINTER_HZ = 30;
export const POINTER_INTERVAL_MS = Math.round(1000 / POINTER_HZ);
export const MAX_QUEUE = 512;

// Moving a cursor is free. Scrolling is strictly local and never relayed.
// Everything that acts needs a grant.
export const FREE_KINDS = new Set(['move']);

const POINTER_LOCK_KINDS = new Set(['pointerlock', 'pointer-lock', 'requestpointerlock']);
const SCROLL_KINDS = new Set(['wheel', 'scroll']);

const isPoint = (point) =>
  Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

function modifiersOf(record) {
  return {
    ctrlKey: Boolean(record && (record.ctrl || record.ctrlKey)),
    altKey: Boolean(record && (record.alt || record.altKey)),
    shiftKey: Boolean(record && (record.shift || record.shiftKey)),
    metaKey: Boolean(record && (record.meta || record.metaKey)),
  };
}

// Pointer lock is local by design and never crosses the room. Any active local
// lock or remote pointer-lock request is refused with a named reason.
export function pointerLockDecision({
  doc = null,
  record = null,
  requested = false,
  pointerLockElement = undefined,
} = {}) {
  const kind = String((record && record.kind) || '').toLowerCase();
  if (
    requested === true ||
    POINTER_LOCK_KINDS.has(kind) ||
    Boolean(record && record.requestPointerLock)
  ) {
    return {
      allow: false,
      reason: 'pointer-lock-local',
      message: 'Pointer lock is local by design and cannot be relayed remotely.',
    };
  }
  const lockEl =
    pointerLockElement !== undefined
      ? pointerLockElement
      : doc && doc.pointerLockElement;
  if (Boolean(lockEl) || Boolean(record && record.pointerLock)) {
    return {
      allow: false,
      reason: 'pointer-lock-active',
      message: 'Remote input is refused while local pointer lock is active.',
    };
  }
  return { allow: true, reason: 'ok' };
}

// Guardrail #5: scrolling stays local in both directions and is never relayed.
export function scrollPolicyDecision(record = null) {
  const kind = String((record && (record.kind || record.type)) || '').toLowerCase();
  if (SCROLL_KINDS.has(kind)) {
    return {
      allow: false,
      reason: 'scroll',
      message: 'Scrolling is local by design and cannot be relayed remotely.',
    };
  }
  return { allow: true, reason: 'ok' };
}

export class GrantBook {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.grants = new Map();
  }

  key(peerId, tabId) {
    return `${peerId}|${tabId}`;
  }

  grant(peerId, { tabId = 'tab', origin = '', ttlMs = 30 * 60 * 1000 } = {}) {
    const grant = { peerId, tabId, origin, expiresAt: this.now() + ttlMs };
    this.grants.set(this.key(peerId, tabId), grant);
    return grant;
  }

  revoke(peerId, tabId = 'tab') {
    return this.grants.delete(this.key(peerId, tabId));
  }

  revokeAll() {
    this.grants.clear();
  }

  // A grant ends when its tab closes, so the tab has to be able to say so.
  endTab(tabId) {
    for (const [key, grant] of this.grants) {
      if (grant.tabId === tabId) this.grants.delete(key);
    }
  }

  active(local = this.now()) {
    return [...this.grants.values()].filter((grant) => grant.expiresAt > local);
  }

  decide(
    peerId,
    { tabId = 'tab', origin = '', kind = 'click', doc = null, pointerLockElement = undefined } = {}
  ) {
    const lock = pointerLockDecision({ doc, pointerLockElement, record: { kind } });
    if (!lock.allow) return lock;
    const scroll = scrollPolicyDecision({ kind });
    if (!scroll.allow) return scroll;
    if (FREE_KINDS.has(kind)) return { allow: true, reason: 'free-kind' };
    // A browser-wide grant names every tab with '*'. An exact tab entry wins,
    // then the wildcard, so a per-tab grant keeps the meaning it had.
    const exactKey = this.key(peerId, tabId);
    const wildKey = this.key(peerId, '*');
    const exact = this.grants.get(exactKey);
    const grant = exact || this.grants.get(wildKey);
    if (!grant) return { allow: false, reason: 'no-grant' };
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(exact ? exactKey : wildKey);
      return { allow: false, reason: 'expired' };
    }
    if (grant.origin && origin && grant.origin !== origin) {
      return { allow: false, reason: 'origin-mismatch' };
    }
    return { allow: true, reason: 'ok' };
  }

  allows(peerId, options = {}) {
    return this.decide(peerId, options).allow;
  }
}

// A test list, not a security boundary on its own. The receiver enforces it.
export const BLOCKED_ORIGINS = [
  'https://www.paypal.com',
  'https://paypal.com',
  'https://www.bankofamerica.com',
  'https://www.chase.com',
  'https://www.wellsfargo.com',
  'https://www.coinbase.com',
  'https://www.binance.com',
];

export function normalizeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function originDecision(url, { blocked = BLOCKED_ORIGINS } = {}) {
  const origin = normalizeOrigin(url);
  if (!origin) return { allow: false, reason: 'invalid-origin', origin: '' };
  if (blocked.includes(origin)) return { allow: false, reason: 'blocked-origin', origin };
  return { allow: true, reason: 'ok', origin };
}

export function originAllowed(url, { blocked = BLOCKED_ORIGINS } = {}) {
  return originDecision(url, { blocked }).allow;
}

function attribute(element, name) {
  if (!element) return '';
  if (typeof element.getAttribute === 'function') return String(element.getAttribute(name) || '');
  return String(element[name] || '');
}

// Local browser controls (overlays, Live Tabs Open/Stop rows, host takeover,
// panel button) belong strictly to the local reader and never cross the room.
export function isLocalControl(element) {
  if (!element || typeof element !== 'object') return false;
  if (typeof element.closest === 'function') {
    if (
      element.closest('[data-brosr-overlay]') ||
      element.closest('[data-brosr-local]') ||
      element.closest('#live-tabs') ||
      element.closest('#tiles') ||
      element.closest('#brosr-panel-button') ||
      element.closest('#host-takeover')
    ) {
      return true;
    }
  }
  const id = attribute(element, 'id');
  if (
    id === 'live-tabs' ||
    id === 'tiles' ||
    id === 'brosr-panel-button' ||
    id === 'host-takeover'
  ) {
    return true;
  }
  return Boolean(attribute(element, 'data-brosr-overlay') || attribute(element, 'data-brosr-local'));
}

function nonSelfTarget(raw) {
  const target = String(raw || '')
    .trim()
    .toLowerCase();
  return Boolean(target && target !== '_self');
}

function baseTarget(element) {
  const doc = element && element.ownerDocument;
  if (!doc || typeof doc.querySelector !== 'function') return '';
  const base = doc.querySelector('base[target]');
  return base ? attribute(base, 'target') : '';
}

// A link or form interaction that opens a new tab or window (target="_blank",
// named target, <base target>, formtarget, middle-click, or Cmd/Ctrl/Shift-click)
// is local only; tabs never relay open across peers.
export function isTabOpeningClick(element, record = {}) {
  if (!element || typeof element !== 'object') return false;
  const link =
    typeof element.closest === 'function'
      ? element.closest('a[href]') || element.closest('area[href]')
      : null;
  const anchor =
    link ||
    (['a', 'area'].includes(String(element.tagName || '').toLowerCase()) &&
    (element.href || attribute(element, 'href'))
      ? element
      : null);
  if (anchor) {
    const explicitTarget = anchor.target || attribute(anchor, 'target');
    if (nonSelfTarget(explicitTarget)) return true;
    if (!explicitTarget && nonSelfTarget(baseTarget(anchor))) return true;
    const button = Number(record && record.button);
    if (button === 1) return true;
    if (
      Boolean(record && (record.ctrl || record.ctrlKey)) ||
      Boolean(record && (record.meta || record.metaKey)) ||
      Boolean(record && (record.shift || record.shiftKey))
    ) {
      return true;
    }
    return false;
  }
  const submitControl =
    typeof element.closest === 'function'
      ? element.closest('button, input[type="submit"], input[type="image"]')
      : ['button', 'input'].includes(String(element.tagName || '').toLowerCase())
        ? element
        : null;
  if (submitControl) {
    const formTarget = submitControl.formTarget || attribute(submitControl, 'formtarget');
    if (nonSelfTarget(formTarget)) return true;
    const form =
      submitControl.form ||
      (typeof submitControl.closest === 'function' ? submitControl.closest('form') : null);
    if (form && nonSelfTarget(form.target || attribute(form, 'target'))) return true;
  }
  return false;
}

export function isTabOpeningKey(element, record = {}) {
  const key = String((record && record.key) || '');
  if (!key) return false;
  const hasAccel =
    Boolean(record && (record.ctrl || record.ctrlKey)) ||
    Boolean(record && (record.meta || record.metaKey));
  if (hasAccel && (key.toLowerCase() === 't' || key.toLowerCase() === 'n')) {
    return true;
  }
  if (!element || typeof element !== 'object') return false;
  if (key !== 'Enter' && key !== 'Return' && key !== 'NumpadEnter') return false;
  return isTabOpeningClick(element, record);
}

// Password fields, credential hints and payment fields never receive relayed
// input, whatever the sender asks for.
export function isSensitiveField(element) {
  if (!element) return true;
  const tag = String(element.tagName || '').toLowerCase();
  if (!['input', 'textarea', 'select'].includes(tag)) return false;
  const type = String(element.type || '').toLowerCase();
  if (type === 'password') return true;
  const autocomplete = attribute(element, 'autocomplete').toLowerCase();
  if (/(current-password|new-password|one-time-code|cc-|credit-card)/.test(autocomplete)) return true;
  const names = `${attribute(element, 'name')} ${attribute(element, 'id')}`.toLowerCase();
  if (!names.trim()) return false;
  return /(pass|secret|token|card|cvv|cvc|ssn|iban)/.test(names);
}

// Guardrail #5: input capture policy returns allow plus a reason, never a bare
// boolean. Local pointer lock, untrusted events and sensitive fields are named.
export function inputCaptureDecision({
  doc = null,
  event = null,
  record = null,
  requested = false,
  pointerLockElement = undefined,
} = {}) {
  const lock = pointerLockDecision({ doc, record, requested, pointerLockElement });
  if (!lock.allow) return lock;
  const scroll = scrollPolicyDecision(record || (event ? { kind: event.type } : null));
  if (!scroll.allow) return scroll;
  if (event && event.isTrusted === false) {
    return { allow: false, reason: 'untrusted' };
  }
  if (event && event.target && isLocalControl(event.target)) {
    return { allow: false, reason: 'local-control' };
  }
  if (event && event.target && isSensitiveField(event.target)) {
    return { allow: false, reason: 'sensitive' };
  }
  if (
    (event && event.target && isTabOpeningClick(event.target, event)) ||
    (event && isTabOpeningKey(event.target || null, event)) ||
    (record && record.kind === 'key' && isTabOpeningKey((event && event.target) || null, record))
  ) {
    return { allow: false, reason: 'new-tab' };
  }
  return { allow: true, reason: 'ok' };
}

// Scrolling stays strictly local; wheel events are never serialized for relay.
export function wheelRecord() {
  return null;
}

// A stable path a peer can resolve on its own copy of the page.
export function cssPath(element) {
  if (!element) return '';
  const parts = [];
  let node = element;
  while (node && node.nodeType === 1 && node.ownerDocument && node !== node.ownerDocument.documentElement) {
    const tag = String(node.tagName || '').toLowerCase();
    const parent = node.parentNode;
    if (!parent || !parent.children) break;
    let index = 0;
    for (const sibling of parent.children) {
      if (sibling === node) {
        index += 1;
        break;
      }
      if (sibling.tagName === node.tagName) index += 1;
    }
    parts.unshift(`${tag}:nth-of-type(${Math.max(1, index)})`);
    node = parent;
  }
  parts.unshift('html');
  return parts.join(' > ');
}

// A path that names two elements is not a target. A dropped click beats a
// wrong one.
export function resolvePath(root, path) {
  if (!root || !path || typeof root.querySelectorAll !== 'function') return null;
  try {
    const hits = root.querySelectorAll(path);
    return hits && hits.length === 1 ? hits[0] : null;
  } catch {
    return null;
  }
}

export function canvasPoint(canvas, fraction = { x: 0.5, y: 0.5 }) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.left + Math.max(0, Math.min(1, fraction.x)) * rect.width,
    y: rect.top + Math.max(0, Math.min(1, fraction.y)) * rect.height,
  };
}

// Coalesces pointer moves to 30 Hz and keeps down, up and keys in order.
export class InputBatcher {
  constructor({
    send = () => {},
    now = () => Date.now(),
    maxQueue = MAX_QUEUE,
    peerId = 'me',
    doc = null,
    onRefuse = () => {},
  } = {}) {
    this.send = send;
    this.peerId = peerId;
    this.now = now;
    this.maxQueue = maxQueue;
    this.doc = doc;
    this.onRefuse = onRefuse;
    this.queue = [];
    this.pendingMove = null;
    this.seq = 0;
    this.movesDropped = 0;
    this.recordsDropped = 0;
    this.refused = 0;
    this.reasons = {};
    this.sent = 0;
  }

  _checkPolicy(record) {
    const lock = pointerLockDecision({ doc: this.doc, record });
    const decision = lock.allow ? scrollPolicyDecision(record) : lock;
    if (!decision.allow) {
      this.refused += 1;
      this.reasons[decision.reason] = (this.reasons[decision.reason] || 0) + 1;
      this.onRefuse(decision, record);
    }
    return decision;
  }

  move(record) {
    const decision = this._checkPolicy(record);
    if (!decision.allow) return decision;
    if (this.pendingMove) this.movesDropped += 1;
    this.pendingMove = record;
    return decision;
  }

  push(record) {
    const decision = this._checkPolicy(record);
    if (!decision.allow) return decision;
    this.queue.push(record);
    if (this.queue.length > this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue);
      this.recordsDropped += 1;
    }
    return decision;
  }

  // A site can leave the mirror list between two events. The queued records
  // belong to the old rule, so they go instead of crossing the new one.
  clear() {
    this.pendingMove = null;
    this.queue = [];
  }

  flush() {
    const records = [];
    if (this.pendingMove) records.push(this.pendingMove);
    this.pendingMove = null;
    records.push(...this.queue);
    this.queue = [];
    if (!records.length) return 0;

    const frames = splitInput({ type: 'input', peerId: this.peerId, seq: this.seq + 1, records });
    for (const frame of frames) {
      this.seq += 1;
      this.send(encode({ ...frame, seq: this.seq }));
    }
    this.sent += records.length;
    return records.length;
  }

  stats() {
    return {
      sent: this.sent,
      queued: this.queue.length + (this.pendingMove ? 1 : 0),
      movesDropped: this.movesDropped,
      recordsDropped: this.recordsDropped,
      refused: this.refused,
      reasons: { ...this.reasons },
      seq: this.seq,
    };
  }
}

function dispatch(root, element, event) {
  const target = element || root;
  if (target && typeof target.dispatchEvent === 'function') return target.dispatchEvent(event);
  return true;
}

// A real click follows a same-tab link. A dispatched click does not, because a
// browser never runs an untrusted event's default action. Links that ask for a
// new tab or window (target="_blank", named targets, middle/modifier clicks)
// are never relayed open across peers.
function activateLink(target, root, record = {}) {
  if (record.button) return false;
  if (isTabOpeningClick(target, record)) return false;
  const link =
    target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
  if (!link) return false;
  if (isLocalControl(target) || isLocalControl(link)) return false;
  if (link.hasAttribute && link.hasAttribute('download')) return false;
  const href = String(link.href || '');
  if (!href || /^\s*javascript:/i.test(href)) return false;
  const targetName = String(link.target || '').toLowerCase();
  if (targetName && targetName !== '_self') return false;
  const doc = root && root.location ? root : link.ownerDocument;
  const location = doc && doc.location;
  if (!location || typeof location.assign !== 'function') return false;
  location.assign(href);
  return true;
}

function setFieldValue(element, value) {
  const view = element.ownerDocument && element.ownerDocument.defaultView;
  const proto =
    element.tagName === 'TEXTAREA'
      ? view && view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype
        : null
      : view && view.HTMLInputElement
        ? view.HTMLInputElement.prototype
        : null;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(element, value);
  else element.value = value;
  dispatch(
    element.ownerDocument || element,
    element,
    new (view && view.Event ? view.Event : Event)('input', { bubbles: true })
  );
}

// Replay one batch. Every record passes the pointer-lock, scroll, grant,
// target, local-control, new-tab and sensitive-field guards before anything
// reaches the page.
export function replayInput(
  records,
  {
    root,
    allowed = () => true,
    onDrop = () => {},
    layoutMatches = true,
  } = {}
) {
  const view = root && root.defaultView ? root.defaultView : globalThis;
  const result = { applied: 0, dropped: 0, reasons: {} };
  const drop = (reason) => {
    result.dropped += 1;
    result.reasons[reason] = (result.reasons[reason] || 0) + 1;
    onDrop(reason);
  };

  for (const record of records) {
    const lock = pointerLockDecision({ doc: root, record });
    if (!lock.allow) {
      drop(lock.reason);
      continue;
    }
    const scroll = scrollPolicyDecision(record);
    if (!scroll.allow) {
      drop(scroll.reason);
      continue;
    }
    if (!allowed(record)) {
      drop('grant');
      continue;
    }
    if (record.kind === 'move') continue;

    // A click travels as a selector, not as a point, so a window of another
    // size cannot misplace it. Only a record with no address at all has to be
    // placed by coordinates, and that is the record this guard protects.
    if (!layoutMatches && !FREE_KINDS.has(record.kind) && !record.path) {
      drop('layout');
      continue;
    }

    const target = record.path ? resolvePath(root, record.path) : null;
    const mods = modifiersOf(record);

    if (record.kind === 'click' || record.kind === 'down' || record.kind === 'up') {
      if (!target) {
        drop('target');
        continue;
      }
      if (isLocalControl(target)) {
        drop('local-control');
        continue;
      }
      if (isTabOpeningClick(target, record)) {
        drop('new-tab');
        continue;
      }
      if (isSensitiveField(target)) {
        drop('sensitive');
        continue;
      }
      const point =
        record.canvas && String(target.tagName).toLowerCase() === 'canvas'
          ? canvasPoint(target, record.canvas)
          : target.getBoundingClientRect();
      const options = {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        button: record.button || 0,
        ...mods,
      };
      const kind = record.kind === 'click' ? ['mousedown', 'mouseup', 'click'] : [record.kind];
      let canceled = false;
      for (const name of kind) {
        const event = new view.MouseEvent(name, options);
        const sent = dispatch(root, target, event);
        if (name === 'click' && sent === false) canceled = true;
      }
      // The page saw the click first, so a handler that cancels it keeps its
      // say. Only an unhandled click on a same-tab link follows the link.
      if (record.kind === 'click' && !canceled) activateLink(target, root, record);
      result.applied += 1;
      continue;
    }

    if (record.kind === 'key') {
      if (target && isSensitiveField(target)) {
        drop('sensitive');
        continue;
      }
      const node = target || (root && root.activeElement);
      if (!node) {
        drop('target');
        continue;
      }
      if (isLocalControl(node)) {
        drop('local-control');
        continue;
      }
      if (isTabOpeningKey(node, record)) {
        drop('new-tab');
        continue;
      }
      const options = {
        bubbles: true,
        cancelable: true,
        key: record.key,
        code: record.code || '',
        ...mods,
      };
      dispatch(root, node, new view.KeyboardEvent('keydown', options));
      dispatch(root, node, new view.KeyboardEvent('keyup', options));
      result.applied += 1;
      continue;
    }

    if (record.kind === 'text') {
      if (!target) {
        drop('target');
        continue;
      }
      if (isLocalControl(target)) {
        drop('local-control');
        continue;
      }
      if (isSensitiveField(target)) {
        drop('sensitive');
        continue;
      }
      setFieldValue(target, record.value);
      result.applied += 1;
      continue;
    }

    drop('kind');
  }

  return result;
}
