import test from 'node:test';
import assert from 'node:assert/strict';
import { inputCaptureDecision, scrollPolicyDecision, wheelRecord } from '../input.mjs';
import { actionsForRecord, prepareRecords, trustDecision } from '../trust.mjs';
import { createRoomClient } from '../sync.mjs';
import { encode } from '../protocol.mjs';

function makeDoc() {
  const listeners = new Map();
  const target = {
    tagName: 'BUTTON',
    id: 'go',
    getAttribute: () => '',
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 30 }),
    dispatchEvent: () => true,
  };
  const doc = {
    location: { href: 'http://127.0.0.1:8787/', origin: 'http://127.0.0.1:8787' },
    defaultView: { innerWidth: 1280, innerHeight: 800, addEventListener() {} },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    querySelector: (selector) => (selector === '#go' ? target : null),
    querySelectorAll: (selector) => (selector === '#go' ? [target] : []),
    dispatchEvent: () => true,
  };
  return { doc, listeners, target };
}

test('scroll and wheel are refused at capture, preparation and action generation', () => {
  const { doc } = makeDoc();
  assert.equal(scrollPolicyDecision({ kind: 'wheel' }).allow, false);
  assert.equal(scrollPolicyDecision({ kind: 'wheel' }).reason, 'scroll');
  assert.equal(scrollPolicyDecision({ kind: 'scroll' }).reason, 'scroll');
  assert.equal(
    inputCaptureDecision({ event: { type: 'wheel', isTrusted: true } }).reason,
    'scroll'
  );
  assert.equal(inputCaptureDecision({ record: { kind: 'scroll' } }).reason, 'scroll');
  assert.equal(wheelRecord({ clientX: 10, clientY: 20, deltaY: 120 }, { path: '#go' }), null);

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
    prepared.map((record) => record.kind),
    ['click']
  );
  assert.equal(actionsForRecord({ kind: 'wheel', point: { x: 10, y: 20 }, deltaY: 120 }), null);
  assert.equal(actionsForRecord({ kind: 'scroll', point: { x: 10, y: 20 }, deltaY: 120 }), null);
});

test('a room client installs no scroll capture and refuses input frames', () => {
  const { doc, listeners } = makeDoc();
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer-1',
    hostId: 'host-1',
    now: () => 1000,
    document: doc,
    overlay: false,
    send: () => {},
  });

  assert.equal(listeners.has('wheel'), false, 'no wheel listener is installed');
  assert.equal(listeners.has('scroll'), false, 'no scroll listener is installed');
  assert.equal(listeners.has('click'), false, 'no raw DOM click is captured');

  const reply = client.receive(
    encode({
      type: 'input',
      peerId: 'peer-1',
      seq: 1,
      records: [{ kind: 'click', path: '#go' }],
    }),
    1000
  );
  assert.deepEqual(reply, { ok: false, reason: 'input-disabled' });
  assert.equal(client.publish().capture, false);
  assert.equal(client.publish().input, null);
});
