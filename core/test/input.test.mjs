import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_ORIGINS,
  canvasPoint,
  inputCaptureDecision,
  isLocalControl,
  isSensitiveField,
  isTabOpeningClick,
  isTabOpeningKey,
  originAllowed,
  pointerLockDecision,
  resolvePath,
  scrollPolicyDecision,
  wheelRecord,
} from '../input.mjs';

function field(props = {}) {
  return {
    tagName: 'INPUT',
    type: 'text',
    getAttribute(name) {
      return props[name] || '';
    },
  };
}

test('a password field, a credential hint and a card field count as sensitive', () => {
  assert.equal(isSensitiveField(field({ autocomplete: 'current-password' })), true);
  assert.equal(isSensitiveField({ ...field(), type: 'password' }), true);
  assert.equal(isSensitiveField(field({ autocomplete: 'cc-number' })), true);
  assert.equal(isSensitiveField(field({ name: 'cardNumber' })), true);
  assert.equal(isSensitiveField(field({ id: 'cvv' })), true);
  assert.equal(isSensitiveField(field({ name: 'search' })), false);
  assert.equal(isSensitiveField({ tagName: 'DIV' }), false);
  assert.equal(isSensitiveField(null), true);
});

test('the origin allowlist refuses a payment site and an unparsable URL', () => {
  assert.equal(originAllowed('https://example.test/page'), true);
  assert.equal(originAllowed('https://www.paypal.com/checkout'), false);
  assert.ok(BLOCKED_ORIGINS.includes('https://www.paypal.com'));
  assert.equal(originAllowed('not a url'), false);
});

test('a path resolves only when it names exactly one element', () => {
  const one = { id: 'one' };
  const root = {
    querySelectorAll: (path) => {
      if (path === '#one') return [one];
      if (path === '#none') return [];
      return [one, { id: 'two' }];
    },
  };
  assert.equal(resolvePath(root, '#one'), one);
  assert.equal(resolvePath(root, '#none'), null);
  assert.equal(resolvePath(root, '#many'), null);
  assert.equal(resolvePath(root, ''), null);
});

test('a canvas fraction maps to a point inside the canvas', () => {
  const canvas = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 200 }),
  };
  assert.deepEqual(canvasPoint(canvas, { x: 0.5, y: 0.25 }), { x: 300, y: 100 });
  assert.deepEqual(canvasPoint(canvas, { x: 4, y: -1 }), { x: 500, y: 50 });
});

test('pointer lock is local and always returns a named decision', () => {
  assert.deepEqual(pointerLockDecision({ doc: { pointerLockElement: null } }), {
    allow: true,
    reason: 'ok',
  });
  assert.equal(pointerLockDecision({ requested: true }).reason, 'pointer-lock-local');
  assert.equal(
    pointerLockDecision({ record: { kind: 'pointerlock' } }).reason,
    'pointer-lock-local'
  );
  assert.equal(
    pointerLockDecision({ doc: { pointerLockElement: { tagName: 'CANVAS' } } }).reason,
    'pointer-lock-active'
  );
  assert.equal(
    pointerLockDecision({ record: { kind: 'click', pointerLock: true } }).reason,
    'pointer-lock-active'
  );
});

test('scroll and wheel are refused with a named reason', () => {
  assert.equal(scrollPolicyDecision({ kind: 'wheel' }).allow, false);
  assert.equal(scrollPolicyDecision({ kind: 'wheel' }).reason, 'scroll');
  assert.equal(scrollPolicyDecision({ kind: 'scroll' }).reason, 'scroll');
  assert.deepEqual(scrollPolicyDecision({ kind: 'click' }), { allow: true, reason: 'ok' });
  assert.equal(wheelRecord({ clientX: 1, clientY: 2, deltaY: 120 }), null);
});

test('local controls and tab-opening clicks are refused before capture', () => {
  const local = {
    getAttribute: (name) => (name === 'data-brosr-local' ? '1' : ''),
    closest: () => null,
  };
  assert.equal(isLocalControl(local), true);

  const blank = {
    tagName: 'A',
    href: 'https://example.test/',
    target: '_blank',
    getAttribute: (name) =>
      name === 'target' ? '_blank' : name === 'href' ? 'https://example.test/' : '',
    closest: (selector) => (selector === 'a[href]' ? blank : null),
  };
  assert.equal(isTabOpeningClick(blank, { button: 0 }), true);
  assert.equal(isTabOpeningClick(blank, { button: 1 }), true);
  assert.equal(isTabOpeningKey(null, { key: 't', meta: true }), true);
  assert.equal(
    inputCaptureDecision({ event: { isTrusted: false } }).reason,
    'untrusted'
  );
  assert.equal(
    inputCaptureDecision({ event: { isTrusted: true, target: blank, button: 0 } }).reason,
    'new-tab'
  );
  assert.equal(
    inputCaptureDecision({ event: { isTrusted: true, target: local } }).reason,
    'local-control'
  );
});
