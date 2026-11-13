// Layer 4: input relay, control grants and the receiver-side guards.
// Section 8 and Section 10 of ../plan.md are the specification.

import { encode, splitInput } from './protocol.mjs';

export const POINTER_HZ = 30;
export const POINTER_INTERVAL_MS = Math.round(1000 / POINTER_HZ);
export const MAX_QUEUE = 512;

// Moving a cursor and scrolling are free. Everything that acts needs a grant.
export const FREE_KINDS = new Set(['move', 'scroll']);

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

  allows(peerId, { tabId = 'tab', origin = '', kind = 'click' } = {}) {
    if (FREE_KINDS.has(kind)) return true;
    const key = this.key(peerId, tabId);
    const grant = this.grants.get(key);
    if (!grant) return false;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(key);
      return false;
    }
    if (grant.origin && origin && grant.origin !== origin) return false;
    return true;
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

export function originAllowed(url, { blocked = BLOCKED_ORIGINS } = {}) {
  const origin = normalizeOrigin(url);
  if (!origin) return false;
  return !blocked.includes(origin);
}

function attribute(element, name) {
  if (!element) return '';
  if (typeof element.getAttribute === 'function') return String(element.getAttribute(name) || '');
  return String(element[name] || '');
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
  constructor({ send = () => {}, now = () => Date.now(), maxQueue = MAX_QUEUE, peerId = 'me' } = {}) {
    this.send = send;
    this.peerId = peerId;
    this.now = now;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.pendingMove = null;
    this.seq = 0;
    this.movesDropped = 0;
    this.recordsDropped = 0;
    this.sent = 0;
  }

  move(record) {
    if (this.pendingMove) this.movesDropped += 1;
    this.pendingMove = record;
  }

  push(record) {
    this.queue.push(record);
    if (this.queue.length > this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue);
      this.recordsDropped += 1;
    }
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
      seq: this.seq,
    };
  }
}

function dispatch(root, element, event) {
  const target = element || root;
  if (target && typeof target.dispatchEvent === 'function') target.dispatchEvent(event);
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

// Replay one batch. Every record passes the grant, the target and the field
// guards before anything reaches the page.
export function replayInput(records, { root, allowed = () => true, onDrop = () => {} } = {}) {
  const view = root && root.defaultView ? root.defaultView : globalThis;
  const result = { applied: 0, dropped: 0, reasons: {} };
  const drop = (reason) => {
    result.dropped += 1;
    result.reasons[reason] = (result.reasons[reason] || 0) + 1;
    onDrop(reason);
  };

  for (const record of records) {
    if (!allowed(record)) {
      drop('grant');
      continue;
    }
    if (record.kind === 'move') continue;

    const target = record.path ? resolvePath(root, record.path) : null;

    if (record.kind === 'click' || record.kind === 'down' || record.kind === 'up') {
      if (!target) {
        drop('target');
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
      };
      const kind = record.kind === 'click' ? ['mousedown', 'mouseup', 'click'] : [record.kind];
      for (const name of kind) dispatch(root, target, new view.MouseEvent(name, options));
      result.applied += 1;
      continue;
    }

    if (record.kind === 'key') {
      if (target && isSensitiveField(target)) {
        drop('sensitive');
        continue;
      }
      const node = target || root.activeElement;
      if (!node) {
        drop('target');
        continue;
      }
      const options = { bubbles: true, cancelable: true, key: record.key, code: record.code || '' };
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
      if (isSensitiveField(target)) {
        drop('sensitive');
        continue;
      }
      setFieldValue(target, record.value);
      result.applied += 1;
      continue;
    }

    if (record.kind === 'wheel') {
      if (!target) {
        drop('target');
        continue;
      }
      dispatch(
        root,
        target,
        new view.WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaX: record.deltaX || 0,
          deltaY: record.deltaY || 0,
        })
      );
      result.applied += 1;
      continue;
    }

    drop('kind');
  }

  return result;
}
