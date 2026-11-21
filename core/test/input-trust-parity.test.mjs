// Boundary tests for pointer-lock refusal policy (Guardrail #5) and BiDi/CDP
// action parity across core/input.mjs, core/trust.mjs, and host/chrome-cdp.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inputCaptureDecision,
  originDecision,
  pointerLockDecision,
  wheelRecord,
} from '../input.mjs';
import {
  BIDI_KEYS,
  actionsForRecord,
  createTrustClient,
  prepareRecords,
  trustDecision,
} from '../trust.mjs';
import { cdpEvents, keyFor } from '../../host/chrome-cdp.mjs';

function makeRoot({ elements = {}, activeElement = null, pointerLockElement = null } = {}) {
  const dispatched = [];
  const defaultView = {
    Event: class {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    MouseEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    KeyboardEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    WheelEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
  };
  const root = {
    activeElement,
    pointerLockElement,
    defaultView,
    dispatched,
    querySelectorAll: (path) => (elements[path] ? [elements[path]] : []),
    elementFromPoint: (x, y) => elements[`@${x},${y}`] || null,
    dispatchEvent: (event) => {
      dispatched.push({ target: root, event });
      return true;
    },
  };
  return root;
}

function makeElement({
  tagName = 'DIV',
  rect = { left: 100, top: 50, width: 200, height: 100 },
  attrs = {},
  type = '',
} = {}) {
  const events = [];
  return {
    tagName,
    type,
    events,
    focused: false,
    focus() {
      this.focused = true;
    },
    getAttribute: (name) => attrs[name] || '',
    getBoundingClientRect: () => rect,
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
}

test('wheelRecord refuses to serialize wheel events because scrolling is strictly local', () => {
  assert.equal(
    wheelRecord(
      {
        clientX: 145,
        clientY: 88,
        deltaX: 12.5,
        deltaY: -120,
        deltaMode: 1,
        ctrlKey: true,
        shiftKey: true,
      },
      { path: '#canvas', canvas: { x: 0.25, y: 0.5 } }
    ),
    null
  );
  assert.equal(wheelRecord({ deltaX: Number.NaN, deltaY: 10 }), null);
  assert.equal(wheelRecord({ deltaX: 0, deltaY: Number.POSITIVE_INFINITY }), null);
});

test('pointerLockDecision always returns structured { allow, reason } (Guardrail #5)', () => {
  const unlocked = pointerLockDecision({ doc: { pointerLockElement: null } });
  assert.equal(unlocked.allow, true);
  assert.equal(unlocked.reason, 'ok');

  const requested = pointerLockDecision({ requested: true });
  assert.equal(requested.allow, false);
  assert.equal(requested.reason, 'pointer-lock-local');
  assert.ok(requested.message);

  const byKind = pointerLockDecision({ record: { kind: 'pointerlock' } });
  assert.equal(byKind.allow, false);
  assert.equal(byKind.reason, 'pointer-lock-local');

  const activeDoc = pointerLockDecision({ doc: { pointerLockElement: { tagName: 'CANVAS' } } });
  assert.equal(activeDoc.allow, false);
  assert.equal(activeDoc.reason, 'pointer-lock-active');
  assert.ok(activeDoc.message);

  const activeRecord = pointerLockDecision({ record: { kind: 'click', pointerLock: true } });
  assert.equal(activeRecord.allow, false);
  assert.equal(activeRecord.reason, 'pointer-lock-active');
});

test('originDecision and inputCaptureDecision return structured allow + reason', () => {
  assert.equal(originDecision('https://www.paypal.com/checkout').allow, false);
  assert.equal(originDecision('https://www.paypal.com/checkout').reason, 'blocked-origin');
  assert.equal(originDecision('not-a-url').reason, 'invalid-origin');
  assert.equal(originDecision('https://example.test/page').allow, true);

  const capLocked = inputCaptureDecision({ doc: { pointerLockElement: {} } });
  assert.equal(capLocked.allow, false);
  assert.equal(capLocked.reason, 'pointer-lock-active');
  assert.equal(inputCaptureDecision({ event: { isTrusted: false } }).reason, 'untrusted');
});

test('trustDecision, prepareRecords and createTrustClient preserve refusal reasons', async () => {
  const password = makeElement({ tagName: 'INPUT', type: 'password' });
  const search = makeElement({ tagName: 'INPUT', type: 'text', attrs: { name: 'q' } });
  const openDoc = makeRoot({ elements: { '#pw': password, '#q': search } });
  const lockedDoc = makeRoot({ elements: { '#q': search }, pointerLockElement: search });

  assert.equal(trustDecision({ kind: 'pointerlock' }, openDoc).reason, 'pointer-lock-local');
  assert.equal(trustDecision({ kind: 'click', path: '#q' }, lockedDoc).reason, 'pointer-lock-active');
  assert.equal(trustDecision({ kind: 'text', path: '#pw', value: 'secret' }, openDoc).reason, 'sensitive');
  assert.equal(trustDecision({ kind: 'key', key: 'Dead' }, openDoc).reason, 'key');
  assert.equal(
    trustDecision({ kind: 'wheel', path: '#q', deltaY: Number.NaN }, openDoc).reason,
    'scroll'
  );
  assert.equal(trustDecision({ kind: 'wheel', path: '#q', deltaY: 120 }, openDoc).allow, false);
  assert.equal(
    trustDecision({ kind: 'scroll', path: '#q', deltaY: 120 }, openDoc).reason,
    'scroll'
  );

  assert.deepEqual(prepareRecords([{ kind: 'click', path: '#q' }], lockedDoc), []);
  const prepared = prepareRecords(
    [
      { kind: 'text', path: '#pw', value: 'secret' },
      { kind: 'pointerlock' },
      { kind: 'wheel', path: '#q', deltaX: 10.4, deltaY: -120.6, ctrl: true },
      { kind: 'scroll', path: '#q', deltaY: 120 },
      { kind: 'click', path: '#q', ctrl: true },
    ],
    openDoc
  );
  assert.equal(password.focused, false);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].kind, 'click');
  assert.deepEqual(prepared[0].point, { x: 200, y: 100 });

  const client = createTrustClient({
    url: 'http://127.0.0.1:9999',
    token: 'tok',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async json() {
        return { ok: false, allow: false, reason: 'pointer-lock-local' };
      },
    }),
  });
  const reply = await client.send([{ kind: 'pointerlock' }]);
  assert.deepEqual(reply, { ok: false, allow: false, reason: 'pointer-lock-local' });
});

test('scroll records are refused while pointer, special keys and modifiers maintain full BiDi <-> CDP parity', () => {
  assert.equal(
    actionsForRecord({ kind: 'wheel', point: { x: 10.4, y: 20.6 }, deltaX: 3.2, deltaY: -120.8 }),
    null
  );
  assert.equal(
    actionsForRecord({ kind: 'scroll', point: { x: 50, y: 60 }, deltaX: 0, deltaY: 120 }),
    null
  );

  const clickActions = actionsForRecord({
    kind: 'click',
    point: { x: 120, y: 240 },
    button: 0,
    ctrl: true,
  });
  assert.equal(clickActions.length, 2);
  assert.equal(clickActions[0].type, 'key');
  assert.equal(clickActions[1].type, 'pointer');
  const clickCdp = cdpEvents(clickActions);
  assert.equal(clickCdp[0].params.key, 'Control');
  assert.equal(clickCdp[0].params.modifiers, 2);
  const pressed = clickCdp.find((event) => event.params.type === 'mousePressed');
  assert.ok(pressed);
  assert.equal(pressed.params.modifiers, 2);

  const enterActions = actionsForRecord({ kind: 'key', key: 'Enter' });
  assert.equal(enterActions[0].actions[0].value, BIDI_KEYS.Enter);
  assert.equal(Array.from(enterActions[0].actions[0].value).length, 1);
  const enterCdp = cdpEvents(enterActions);
  assert.equal(enterCdp[0].params.key, 'Enter');
  assert.equal(enterCdp[0].params.code, 'Enter');
  assert.equal(enterCdp[0].params.windowsVirtualKeyCode, 13);
  assert.equal(enterCdp[0].params.text, '\r');

  const chordActions = actionsForRecord({ kind: 'key', key: 'a', ctrl: true });
  const chordCdp = cdpEvents(chordActions);
  assert.equal(chordCdp.length, 4);
  assert.equal(chordCdp[1].params.type, 'rawKeyDown');
  assert.equal(chordCdp[1].params.key, 'a');
  assert.equal(chordCdp[1].params.modifiers, 2);
  assert.equal(chordCdp[1].params.text, undefined);

  const selfMod = actionsForRecord({ kind: 'key', key: 'Control', ctrl: true });
  assert.equal(selfMod[0].actions.length, 2);

  assert.deepEqual(keyFor(' '), { key: ' ', code: 'Space', keyCode: 32, text: ' ' });
  assert.equal(actionsForRecord({ kind: 'key', key: 'Dead' }), null);

  assert.equal(
    actionsForRecord({ kind: 'wheel', point: { x: Number.NaN, y: 10 }, deltaY: 120 }),
    null
  );
  assert.equal(
    actionsForRecord({ kind: 'wheel', point: { x: 10, y: 20 }, deltaY: Number.POSITIVE_INFINITY }),
    null
  );
  assert.equal(actionsForRecord({ kind: 'pointerlock' }), null);
});
