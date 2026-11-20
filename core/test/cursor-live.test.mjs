// Cursor identity rules that need no browser: who may pick a colour, and which
// sites the host's pickers offer.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoomClient } from '../sync.mjs';
import { encode } from '../protocol.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeClient(role, id, colour, sent = []) {
  return createRoomClient({
    role,
    peerId: id,
    colour,
    now: () => 0,
    mediaRoot: { querySelectorAll: () => [] },
    send: (frame) => sent.push(frame),
  });
}

test('a colour another person holds is refused, with control or without', () => {
  const sent = [];
  const room = makeClient('host', 'host', '#e2603f', sent);
  room.receive(encode({ type: 'hello', peerId: 'guest', name: 'Guest', colour: '#3f86e2' }), 0);
  assert.equal(room.publish().peerList.find((entry) => entry.id === 'guest').colour, '#3f86e2');

  // The host holds orange and the guest holds blue. Neither can take the other.
  assert.equal(room.setColour('#3f86e2'), false);
  assert.equal(room.publish().colour, '#e2603f');

  const guest = makeClient('peer', 'guest', '#3f86e2');
  guest.receive(encode({ type: 'hello', peerId: 'host', name: 'Host', colour: '#e2603f' }), 0);
  guest.receive(encode({ type: 'hello', peerId: 'other', name: 'Other', colour: '#d94f8a' }), 0);
  assert.equal(guest.setColour('#e2603f'), false);
  assert.equal(guest.setColour('#d94f8a'), false);
  assert.equal(guest.setColour('#2f9e6b'), true);
  assert.equal(guest.publish().colour, '#2f9e6b');
});

test('a joiner is never given a colour the room already uses', () => {
  const room = makeClient('host', 'host', '#e2603f');
  room.receive(encode({ type: 'hello', peerId: 'guest', name: 'Guest', colour: '#e2603f' }), 0);
  const assigned = room.publish().peerList.find((entry) => entry.id === 'guest');
  assert.ok(assigned.colour);
  assert.notEqual(assigned.colour.toLowerCase(), '#e2603f');
});

test('a site leaves the cursor list when its tab does', () => {
  const room = makeClient('host', 'host', '#e2603f');
  room.receive(encode({ type: 'hello', peerId: 'guest', name: 'Guest', colour: '#3f86e2' }), 0);
  const presence = (url, roomTime) =>
    encode({
      type: 'presence',
      peerId: 'guest',
      name: 'Guest',
      colour: '#3f86e2',
      point: { x: 0.2, y: 0.2 },
      url,
      roomTime,
    });
  room.receive(presence('https://www.w3schools.com/js/', 10), 10);
  assert.ok(room.publish().cursorSeen.includes('https://w3schools.com'));
  room.receive(presence('https://example.com/', 20), 20);
  assert.ok(!room.publish().cursorSeen.includes('https://w3schools.com'));
});

test('the panel disables a colour another person holds', () => {
  const source = fs.readFileSync(path.join(root, 'bridge', 'panel', 'room.js'), 'utf8');
  assert.match(source, /const taken = new Set/);
  assert.match(source, /!peer\.self/);
  assert.match(source, /button\.disabled = !data \|\| custom \|\| inUse/);
});
