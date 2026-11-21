import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_KINDS,
  GrantBook,
  InputBatcher,
  inputCaptureDecision,
  replayInput,
  scrollPolicyDecision,
  wheelRecord,
} from '../input.mjs';
import { actionsForRecord, prepareRecords, trustDecision } from '../trust.mjs';
import { createRoomClient } from '../sync.mjs';
import { decode, encode } from '../protocol.mjs';

function makeLandingDoc({ href = 'http://127.0.0.1:8787/', origin = 'http://127.0.0.1:8787' } = {}) {
  const listeners = new Map();
  const dispatched = [];
  const target = {
    tagName: 'BUTTON',
    id: 'go',
    parentElement: null,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 30 }),
    dispatchEvent(event) {
      dispatched.push(event);
      return true;
    },
    click() {
      dispatched.push({ type: 'click' });
    },
  };
  const body = { tagName: 'BODY', children: [target] };
  target.parentElement = body;

  const doc = {
    location: { href, origin },
    defaultView: {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      MouseEvent: class MouseEvent {
        constructor(type, init = {}) {
          this.type = type;
          Object.assign(this, init);
        }
      },
      WheelEvent: class WheelEvent {
        constructor(type, init = {}) {
          this.type = type;
          Object.assign(this, init);
        }
      },
    },
    body,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    querySelector(selector) {
      return selector === '#go' ? target : null;
    },
  };
  return { doc, listeners, target, dispatched };
}

test('granted peer scrolling on the landing page is never captured or sent over the wire', () => {
  const { doc, listeners, target } = makeLandingDoc();
  const sent = [];
  let now = 1000;
  const peer = createRoomClient({
    role: 'peer',
    peerId: 'peer-1',
    hostId: 'host-1',
    now: () => now,
    document: doc,
    overlay: false,
    send: (frame) => sent.push(decode(frame)),
    input: { capture: true },
  });

  peer.receive(encode({ type: 'control', from: 'host-1', peerId: 'peer-1', allowed: true }));
  assert.equal(listeners.has('wheel'), false, 'setupInput must not register a wheel listener');

  // Verify normal click capture still works when granted.
  const clickListener = listeners.get('click');
  assert.equal(typeof clickListener, 'function');
  clickListener({ isTrusted: true, target, button: 0, clientX: 20, clientY: 25 });
  const inputFrames = sent.filter((frame) => frame.type === 'input');
  assert.equal(inputFrames.length, 1);
  assert.equal(inputFrames[0].records[0].kind, 'click');
});

test('host drops incoming wheel and scroll records before trusted actuation and synthetic replay', async () => {
  const { doc, dispatched } = makeLandingDoc();
  const trustedCalls = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    document: doc,
    overlay: false,
    send: () => {},
    input: {
      trusted: async (records) => {
        trustedCalls.push(records);
        return { ok: true, applied: records.length };
      },
    },
  });
  host.setGrant('peer-1', true);

  // Legacy bridge sends wheel + scroll only -> completely dropped before trusted actuator.
  const wheelOnly = host.receive(
    encode({
      type: 'input',
      peerId: 'peer-1',
      seq: 1,
      records: [
        { kind: 'wheel', path: '#go', deltaX: 0, deltaY: 240 },
        { kind: 'scroll', path: '#go', deltaX: 0, deltaY: 120 },
      ],
    })
  );
  assert.equal(wheelOnly.ok, true);
  assert.equal(wheelOnly.applied, 0);
  assert.equal(wheelOnly.dropped, 2);
  assert.equal(wheelOnly.reason, 'scroll');

  // Mixed batch with wheel + click -> wheel dropped, click still delivered to trusted actuator.
  const mixed = host.receive(
    encode({
      type: 'input',
      peerId: 'peer-1',
      seq: 2,
      records: [
        { kind: 'wheel', path: '#go', deltaX: 0, deltaY: 180 },
        { kind: 'click', path: '#go', button: 0 },
      ],
    })
  );
  assert.equal(mixed.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(trustedCalls.length, 1);
  assert.deepEqual(
    trustedCalls[0].map((r) => r.kind),
    ['click']
  );
  assert.equal(host.stats.inputReasons.scroll, 3);
  assert.equal(host.stats.inputDropped, 3);

  // Without trusted actuator, synthetic replay also drops wheel/scroll and dispatches no WheelEvent.
  const hostSynthetic = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    document: doc,
    overlay: false,
    send: () => {},
  });
  hostSynthetic.setGrant('peer-1', true);
  const syn = hostSynthetic.receive(
    encode({
      type: 'input',
      peerId: 'peer-1',
      seq: 1,
      records: [
        { kind: 'wheel', path: '#go', deltaX: 0, deltaY: 240 },
        { kind: 'click', path: '#go', button: 0 },
      ],
    })
  );
  assert.equal(syn.ok, true);
  assert.equal(hostSynthetic.stats.inputReasons.scroll, 1);
  assert.equal(
    dispatched.some((event) => event.type === 'wheel'),
    false,
    'synthetic replay must never dispatch a wheel event'
  );
});

test('wheel and scroll are rejected defense-in-depth across input.mjs, trust.mjs, and sync.mjs', async () => {
  const { doc, dispatched } = makeLandingDoc();
  doc.querySelectorAll = (sel) => (sel === '#go' ? [doc.querySelector('#go')] : []);

  // 1. FREE_KINDS excludes scroll/wheel; scrollPolicyDecision returns structured reason.
  assert.equal(FREE_KINDS.has('move'), true);
  assert.equal(FREE_KINDS.has('scroll'), false);
  assert.equal(FREE_KINDS.has('wheel'), false);
  assert.equal(scrollPolicyDecision({ kind: 'wheel' }).allow, false);
  assert.equal(scrollPolicyDecision({ kind: 'wheel' }).reason, 'scroll');
  assert.equal(scrollPolicyDecision({ kind: 'scroll' }).reason, 'scroll');
  assert.deepEqual(scrollPolicyDecision({ kind: 'click' }), { allow: true, reason: 'ok' });

  // 2. GrantBook, inputCaptureDecision, wheelRecord, and InputBatcher all refuse scroll/wheel.
  const grants = new GrantBook();
  grants.grant('peer-1', { tabId: '*' });
  assert.equal(grants.decide('peer-1', { kind: 'wheel' }).reason, 'scroll');
  assert.equal(grants.decide('peer-1', { kind: 'scroll' }).reason, 'scroll');
  assert.equal(grants.decide('peer-1', { kind: 'click' }).allow, true);

  assert.equal(inputCaptureDecision({ event: { type: 'wheel', isTrusted: true } }).reason, 'scroll');
  assert.equal(inputCaptureDecision({ record: { kind: 'scroll' } }).reason, 'scroll');
  assert.equal(wheelRecord({ clientX: 10, clientY: 20, deltaY: 120 }, { path: '#go' }), null);

  const sent = [];
  const batcher = new InputBatcher({ send: (frame) => sent.push(frame) });
  assert.equal(batcher.push({ kind: 'wheel', path: '#go', deltaY: 120 }).reason, 'scroll');
  assert.equal(batcher.push({ kind: 'scroll', path: '#go', deltaY: 120 }).reason, 'scroll');
  assert.equal(batcher.flush(), 0);
  assert.equal(sent.length, 0);

  // 3. Direct replayInput drops wheel/scroll with reason "scroll" and dispatches zero WheelEvents.
  const directReplay = replayInput(
    [
      { kind: 'wheel', path: '#go', deltaY: 240 },
      { kind: 'scroll', path: '#go', deltaY: 120 },
      { kind: 'click', path: '#go', button: 0 },
    ],
    { root: doc }
  );
  assert.equal(directReplay.applied, 1);
  assert.equal(directReplay.dropped, 2);
  assert.equal(directReplay.reasons.scroll, 2);
  assert.equal(dispatched.some((ev) => ev.type === 'wheel'), false);

  // 4. trust.mjs refuses wheel/scroll at decision, preparation, and BiDi action generation.
  assert.equal(trustDecision({ kind: 'wheel', path: '#go', deltaY: 120 }, doc).reason, 'scroll');
  assert.equal(trustDecision({ kind: 'scroll', path: '#go', deltaY: 120 }, doc).reason, 'scroll');
  const prepared = prepareRecords(
    [
      { kind: 'wheel', path: '#go', deltaY: 120 },
      { kind: 'scroll', path: '#go', deltaY: 120 },
      { kind: 'click', path: '#go', button: 0 },
    ],
    doc
  );
  assert.deepEqual(
    prepared.map((r) => r.kind),
    ['click']
  );
  assert.equal(actionsForRecord({ kind: 'wheel', point: { x: 10, y: 20 }, deltaY: 120 }), null);
  assert.equal(actionsForRecord({ kind: 'scroll', point: { x: 10, y: 20 }, deltaY: 120 }), null);

  // 5. sync.mjs never falls back to synthetic replay on trusted scroll refusal.
  const beforeClicks = dispatched.length;
  const host = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    document: doc,
    overlay: false,
    send: () => {},
    input: {
      trusted: async () => ({ ok: false, allow: false, reason: 'scroll' }),
    },
  });
  host.setGrant('peer-1', true);
  host.receive(
    encode({
      type: 'input',
      peerId: 'peer-1',
      seq: 1,
      records: [{ kind: 'click', path: '#go', button: 0 }],
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dispatched.length, beforeClicks);
  assert.equal(host.stats.inputReasons.scroll, 1);
});
