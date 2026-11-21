// Receiver-side input guards. The room no longer relays DOM input between
// peers, so this module holds only the policy helpers shared by the trusted
// actuator and the tests.

const POINTER_LOCK_KINDS = new Set(['pointerlock', 'pointer-lock', 'requestpointerlock']);
const SCROLL_KINDS = new Set(['wheel', 'scroll']);

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
