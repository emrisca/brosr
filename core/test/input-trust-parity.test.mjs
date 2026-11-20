// Boundary tests for wheel events, pointer-lock refusal policy (Guardrail #5),
// and BiDi/CDP action parity across core/input.mjs, core/trust.mjs, and host/chrome-cdp.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GrantBook,
  InputBatcher,
  inputCaptureDecision,
  originDecision,
  pointerLockDecision,
  replayInput,
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

test('wheelRecord captures deltas, coordinates, deltaMode and modifiers, and rejects non-finite deltas', () => {
  const rec = wheelRecord(
    {
      clientX: 145,
      clientY: 88,
      deltaX: 12.5,
      deltaY: -120,
      deltaMode: 1,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    },
    { path: '#canvas', canvas: { x: 0.25, y: 0.5 } }
  );
  assert.deepEqual(rec, {
    kind: 'wheel',
    path: '#canvas',
    point: { x: 145, y: 88 },
    canvas: { x: 0.25, y: 0.5 },
    deltaX: 12.5,
    deltaY: -120,
    deltaMode: 1,
    ctrl: true,
    alt: false,
    shift: true,
    meta: false,
  });

  assert.equal(wheelRecord({ deltaX: Number.NaN, deltaY: 10 }), null);
  assert.equal(wheelRecord({ deltaX: 0, deltaY: Number.POSITIVE_INFINITY }), null);
});

test('replayInput delivers wheel coordinates, deltas, deltaMode and modifiers, and drops non-finite deltas', () => {
  const canvas = makeElement({
    tagName: 'CANVAS',
    rect: { left: 100, top: 40, width: 400, height: 200 },
  });
  const box = makeElement({
    tagName: 'DIV',
    rect: { left: 20, top: 30, width: 100, height: 60 },
  });
  const root = makeRoot({ elements: { '#canvas': canvas, '#box': box, '@50,60': box } });

  const result = replayInput(
    [
      {
        kind: 'wheel',
        path: '#canvas',
        canvas: { x: 0.5, y: 0.25 },
        deltaX: 15,
        deltaY: -120,
        deltaMode: 0,
        ctrl: true,
        shift: true,
      },
      {
        kind: 'wheel',
        point: { x: 50, y: 60 },
        deltaX: 0,
        deltaY: 40,
        alt: true,
      },
      {
        kind: 'wheel',
        path: '#box',
        deltaX: Number.NaN,
        deltaY: 120,
      },
      {
        kind: 'key',
        path: '#box',
        key: 'z',
        code: 'KeyZ',
        meta: true,
        shift: true,
      },
      {
        kind: 'click',
        path: '#box',
        ctrl: true,
      },
    ],
    { root }
  );

  assert.equal(result.applied, 4);
  assert.equal(result.dropped, 1);
  assert.equal(result.reasons.delta, 1);

  assert.equal(canvas.events.length, 1);
  assert.equal(canvas.events[0].clientX, 300);
  assert.equal(canvas.events[0].clientY, 90);
  assert.equal(canvas.events[0].deltaX, 15);
  assert.equal(canvas.events[0].deltaY, -120);
  assert.equal(canvas.events[0].ctrlKey, true);
  assert.equal(canvas.events[0].shiftKey, true);
  assert.equal(canvas.events[0].altKey, false);

  const [wheelEv, keyDownEv, keyUpEv, mouseDownEv] = box.events;
  assert.equal(wheelEv.clientX, 50);
  assert.equal(wheelEv.clientY, 60);
  assert.equal(wheelEv.deltaY, 40);
  assert.equal(wheelEv.altKey, true);
  assert.equal(keyDownEv.metaKey, true);
  assert.equal(keyDownEv.shiftKey, true);
  assert.equal(keyUpEv.metaKey, true);
  assert.equal(mouseDownEv.ctrlKey, true);
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

test('GrantBook.decide, originDecision and inputCaptureDecision return structured allow + reason', () => {
  let now = 0;
  const book = new GrantBook({ now: () => now });
  assert.deepEqual(book.decide('peer', { kind: 'move' }), { allow: true, reason: 'free-kind' });
  assert.deepEqual(book.decide('peer', { kind: 'click' }), { allow: false, reason: 'no-grant' });

  book.grant('peer', { tabId: 'tab-1', origin: 'https://a.test', ttlMs: 100 });
  assert.deepEqual(
    book.decide('peer', { tabId: 'tab-1', origin: 'https://a.test', kind: 'click' }),
    { allow: true, reason: 'ok' }
  );
  assert.deepEqual(
    book.decide('peer', { tabId: 'tab-1', origin: 'https://b.test', kind: 'click' }),
    { allow: false, reason: 'origin-mismatch' }
  );
  const lockGrant = book.decide('peer', {
    tabId: 'tab-1',
    origin: 'https://a.test',
    kind: 'pointerlock',
  });
  assert.equal(lockGrant.allow, false);
  assert.equal(lockGrant.reason, 'pointer-lock-local');

  now = 200;
  assert.deepEqual(
    book.decide('peer', { tabId: 'tab-1', origin: 'https://a.test', kind: 'click' }),
    { allow: false, reason: 'expired' }
  );

  assert.equal(originDecision('https://www.paypal.com/checkout').allow, false);
  assert.equal(originDecision('https://www.paypal.com/checkout').reason, 'blocked-origin');
  assert.equal(originDecision('not-a-url').reason, 'invalid-origin');
  assert.equal(originDecision('https://example.test/page').allow, true);

  const capLocked = inputCaptureDecision({ doc: { pointerLockElement: {} } });
  assert.equal(capLocked.allow, false);
  assert.equal(capLocked.reason, 'pointer-lock-active');
  assert.equal(inputCaptureDecision({ event: { isTrusted: false } }).reason, 'untrusted');
});

test('InputBatcher and replayInput refuse remote input cleanly under pointer lock', () => {
  const lockedDoc = { pointerLockElement: { tagName: 'CANVAS' } };
  const refused = [];
  const batcher = new InputBatcher({
    doc: lockedDoc,
    onRefuse: (decision) => refused.push(decision),
  });

  const pushRes = batcher.push({ kind: 'click', path: '#go' });
  const moveRes = batcher.move({ kind: 'move', x: 10, y: 20 });
  assert.equal(pushRes.allow, false);
  assert.equal(pushRes.reason, 'pointer-lock-active');
  assert.equal(moveRes.allow, false);
  assert.equal(moveRes.reason, 'pointer-lock-active');
  assert.equal(batcher.flush(), 0);
  assert.equal(refused.length, 2);

  // Even without an active doc lock, a pointer-lock request is refused.
  const freeBatcher = new InputBatcher();
  const reqRes = freeBatcher.push({ kind: 'pointerlock' });
  assert.equal(reqRes.allow, false);
  assert.equal(reqRes.reason, 'pointer-lock-local');
  assert.equal(freeBatcher.flush(), 0);

  // Replay refuses both active local pointer lock and explicit pointer-lock requests.
  const button = makeElement({ tagName: 'BUTTON' });
  const lockedRoot = makeRoot({ elements: { '#go': button }, pointerLockElement: button });
  const drops = [];
  const lockedReplay = replayInput(
    [
      { kind: 'click', path: '#go' },
      { kind: 'wheel', path: '#go', deltaY: 120 },
      { kind: 'move', x: 1, y: 2 },
    ],
    { root: lockedRoot, onDrop: (reason) => drops.push(reason) }
  );
  assert.equal(lockedReplay.applied, 0);
  assert.equal(lockedReplay.dropped, 3);
  assert.equal(lockedReplay.reasons['pointer-lock-active'], 3);
  assert.deepEqual(drops, ['pointer-lock-active', 'pointer-lock-active', 'pointer-lock-active']);

  const openRoot = makeRoot({ elements: { '#go': button } });
  const reqReplay = replayInput([{ kind: 'pointerlock', path: '#go' }], { root: openRoot });
  assert.equal(reqReplay.applied, 0);
  assert.equal(reqReplay.reasons['pointer-lock-local'], 1);
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
    'delta'
  );
  assert.equal(
    trustDecision({ kind: 'wheel', path: '#q', deltaY: 120 }, openDoc).allow,
    true
  );

  assert.deepEqual(prepareRecords([{ kind: 'click', path: '#q' }], lockedDoc), []);
  const prepared = prepareRecords(
    [
      { kind: 'text', path: '#pw', value: 'secret' },
      { kind: 'pointerlock' },
      { kind: 'wheel', path: '#q', deltaX: 10.4, deltaY: -120.6, ctrl: true },
    ],
    openDoc
  );
  assert.equal(password.focused, false);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].kind, 'wheel');
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

test('wheel, special keys and modifiers maintain full BiDi <-> CDP parity', () => {
  // 1. Plain wheel -> BiDi source type "wheel" with integer coords/deltas -> CDP mouseWheel.
  const wheelActions = actionsForRecord({
    kind: 'wheel',
    point: { x: 10.4, y: 20.6 },
    deltaX: 3.2,
    deltaY: -120.8,
  });
  assert.equal(wheelActions.length, 1);
  assert.equal(wheelActions[0].type, 'wheel');
  assert.deepEqual(wheelActions[0].actions[0], {
    type: 'scroll',
    x: 10,
    y: 21,
    deltaX: 3,
    deltaY: -121,
    duration: 0,
    origin: 'viewport',
  });
  const wheelCdp = cdpEvents(wheelActions);
  assert.deepEqual(wheelCdp, [
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 10, y: 21, deltaX: 3, deltaY: -121 },
    },
  ]);

  // 2. Line-mode wheel (Firefox deltaMode=1) converts to pixels consistently.
  const lineWheel = actionsForRecord({
    kind: 'wheel',
    point: { x: 50, y: 60 },
    deltaX: 0,
    deltaY: 3,
    deltaMode: 1,
  });
  assert.equal(lineWheel[0].actions[0].deltaY, 120);
  assert.equal(cdpEvents(lineWheel)[0].params.deltaY, 120);

  // 3. Ctrl+Wheel (pinch zoom) produces tick-aligned BiDi key+wheel and CDP modifiers: 2.
  const zoomActions = actionsForRecord({
    kind: 'wheel',
    point: { x: 120, y: 240 },
    deltaX: 0,
    deltaY: -100,
    ctrl: true,
  });
  assert.equal(zoomActions.length, 2);
  assert.equal(zoomActions[0].type, 'key');
  assert.equal(zoomActions[1].type, 'wheel');
  const zoomCdp = cdpEvents(zoomActions);
  assert.equal(zoomCdp.length, 3);
  assert.equal(zoomCdp[0].params.key, 'Control');
  assert.equal(zoomCdp[0].params.modifiers, 2);
  assert.deepEqual(zoomCdp[1], {
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseWheel', x: 120, y: 240, deltaX: 0, deltaY: -100, modifiers: 2 },
  });
  assert.equal(zoomCdp[2].params.type, 'keyUp');
  assert.equal(zoomCdp[2].params.modifiers, undefined);

  // 4. Special keys encode as WebDriver BiDi single code points and map cleanly in CDP.
  const enterActions = actionsForRecord({ kind: 'key', key: 'Enter' });
  assert.equal(enterActions[0].actions[0].value, BIDI_KEYS.Enter);
  assert.equal(Array.from(enterActions[0].actions[0].value).length, 1);
  const enterCdp = cdpEvents(enterActions);
  assert.equal(enterCdp[0].params.key, 'Enter');
  assert.equal(enterCdp[0].params.code, 'Enter');
  assert.equal(enterCdp[0].params.windowsVirtualKeyCode, 13);
  assert.equal(enterCdp[0].params.text, '\r');

  // 5. Modifier chord Ctrl+a sends rawKeyDown with modifiers: 2 (no literal text insertion).
  const chordActions = actionsForRecord({ kind: 'key', key: 'a', ctrl: true });
  const chordCdp = cdpEvents(chordActions);
  assert.equal(chordCdp.length, 4);
  assert.equal(chordCdp[1].params.type, 'rawKeyDown');
  assert.equal(chordCdp[1].params.key, 'a');
  assert.equal(chordCdp[1].params.modifiers, 2);
  assert.equal(chordCdp[1].params.text, undefined);

  // 6. Pressing Control itself with ctrl: true does not duplicate Control keyDown.
  const selfMod = actionsForRecord({ kind: 'key', key: 'Control', ctrl: true });
  assert.equal(selfMod[0].actions.length, 2);

  // 7. Space character inside text gets code: 'Space' in CDP, and unmapped multi-char keys return null.
  assert.deepEqual(keyFor(' '), { key: ' ', code: 'Space', keyCode: 32, text: ' ' });
  assert.equal(actionsForRecord({ kind: 'key', key: 'Dead' }), null);

  // 8. Invalid wheel deltas or non-finite points never produce NaN payloads.
  assert.equal(actionsForRecord({ kind: 'wheel', point: { x: Number.NaN, y: 10 }, deltaY: 120 }), null);
  assert.equal(actionsForRecord({ kind: 'wheel', point: { x: 10, y: 20 }, deltaY: Number.POSITIVE_INFINITY }), null);
  assert.equal(actionsForRecord({ kind: 'pointerlock' }), null);
});
