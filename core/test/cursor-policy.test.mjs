import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorDecision } from '../cursor.mjs';
import { createRoomClient } from '../sync.mjs';
import { encode } from '../protocol.mjs';

function cursorDocument() {
  const make = () => ({
    style: {},
    children: [],
    parentNode: null,
    textContent: '',
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parentNode = null;
      return child;
    },
    attachShadow() {
      this.shadowRoot = make();
      return this.shadowRoot;
    },
  });
  return { documentElement: make(), createElement: make, createElementNS: make };
}

test('a cursor decision names the rule that hid the pointer', () => {
  const here = 'https://example.com/watch';
  assert.equal(cursorDecision({ peerUrl: here, here }).reason, 'ok');
  assert.equal(
    cursorDecision({ peerUrl: 'https://www.example.com/watch', here }).reason,
    'ok'
  );
  assert.equal(
    cursorDecision({ peerUrl: 'https://youtube.com/watch', here }).reason,
    'other-site'
  );
  assert.equal(
    cursorDecision({ peerUrl: here, here, sites: ['https://example.com/canvas'] }).reason,
    'site-off'
  );
  assert.equal(
    cursorDecision({ peerUrl: here, here, sharePointer: false }).reason,
    'pointer-off'
  );
  assert.equal(cursorDecision({ peerUrl: '', here }).reason, 'unknown-site');
});

test('the room publishes the last cursor reason instead of failing silently', () => {
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    now: () => 0,
    document: cursorDocument(),
    pageUrl: () => 'https://example.com/watch',
    send: () => {},
  });
  client.receive(
    encode({
      type: 'presence',
      peerId: 'p2',
      name: 'P',
      point: { x: 0.2, y: 0.2 },
      url: 'https://youtube.com/watch',
      sharePointer: true,
      roomTime: 0,
    }),
    0
  );
  const published = client.publish();
  assert.equal(published.cursors, 0);
  assert.equal(published.lastCursorDrop.peerId, 'p2');
  assert.equal(published.lastCursorDrop.reason, 'other-site');
  assert.equal(published.cursorDrops['other-site'], 1);

  // The same peer on this site is drawn, so the reason is not sticky.
  client.receive(
    encode({
      type: 'presence',
      peerId: 'p2',
      name: 'P',
      point: { x: 0.2, y: 0.2 },
      url: 'https://example.com/watch',
      roomTime: 1,
    }),
    1
  );
  assert.equal(client.publish().cursors, 1);
});
