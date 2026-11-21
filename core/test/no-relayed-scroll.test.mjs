import test from 'node:test';
import assert from 'node:assert/strict';
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
