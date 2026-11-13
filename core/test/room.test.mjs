import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, MAX_INPUT_PER_SECOND } from '../room.mjs';

function fixedClock(value = 0) {
  let now = value;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
  };
  clock.set = (ms) => {
    now = ms;
  };
  return clock;
}

test('a peer that joins twice keeps one entry and its start time', () => {
  const now = fixedClock(100);
  const room = new Room({ role: 'host', peerId: 'host', now });
  room.join({ id: 'bob', name: 'Bob' });
  now.advance(50);
  room.join({ id: 'bob', name: 'Robert' });
  assert.equal(room.peers.size, 1);
  assert.equal(room.peers.get('bob').name, 'Robert');
  assert.equal(room.peers.get('bob').joinedAt, 100);
});

test('a duplicate or stale input batch is dropped', () => {
  const room = new Room();
  assert.equal(room.acceptInput({ peerId: 'bob', seq: 2, records: [{ kind: 'key' }] }).accepted, true);
  assert.deepEqual(room.acceptInput({ peerId: 'bob', seq: 2, records: [{ kind: 'key' }] }), {
    accepted: false,
    reason: 'stale',
  });
  assert.equal(room.acceptInput({ peerId: 'bob', seq: 1, records: [{ kind: 'key' }] }).accepted, false);
  assert.equal(room.acceptInput({ peerId: 'bob', seq: 3, records: [{ kind: 'key' }] }).accepted, true);
});

test('an empty batch is not accepted', () => {
  const room = new Room();
  assert.equal(room.acceptInput({ peerId: 'bob', seq: 1, records: [] }).accepted, false);
});

test('the input rate limit holds at 120 batches a second', () => {
  const now = fixedClock(0);
  const room = new Room({ now });
  let accepted = 0;
  for (let index = 0; index < MAX_INPUT_PER_SECOND + 30; index += 1) {
    if (room.allowInput('bob')) accepted += 1;
  }
  assert.equal(accepted, MAX_INPUT_PER_SECOND);
  now.advance(1000);
  assert.equal(room.allowInput('bob'), true, 'a fresh window starts again');
});

test('navigation is limited to one a second', () => {
  const now = fixedClock(0);
  const room = new Room({ now });
  assert.equal(room.allowNav(), true);
  assert.equal(room.allowNav(), false);
  now.advance(999);
  assert.equal(room.allowNav(), false);
  now.advance(2);
  assert.equal(room.allowNav(), true);
});

test('a snapshot carries the sequence and the peers, and a joiner adopts both', () => {
  const host = new Room({ role: 'host', peerId: 'host' });
  host.join({ id: 'host', name: 'Host', colour: '#e2603f' });
  host.join({ id: 'bob', name: 'Bob', colour: '#3f86e2' });
  host.nextSequence();
  host.nextSequence();
  const snapshot = host.snapshot({ url: 'http://example.test/', scroll: 0.4 });

  const joiner = new Room({ role: 'peer', peerId: 'carol' });
  joiner.applySnapshot(snapshot);
  assert.equal(joiner.sequence, 2);
  assert.equal(joiner.peers.size, 2);
  assert.equal(snapshot.url, 'http://example.test/');
  assert.equal(joiner.nextSequence(), 3);
});

test('a navigation resets the scroll ratio', () => {
  const room = new Room();
  room.applyView({ scroll: 0.8 });
  assert.equal(room.scroll, 0.8);
  room.applyNav({ url: 'https://example.test/b' });
  assert.equal(room.url, 'https://example.test/b');
  assert.equal(room.scroll, 0);
  assert.throws(() => room.applyNav({}), /needs a url/);
});

test('a scroll ratio is clamped and a different window size is flagged', () => {
  const room = new Room();
  room.fingerprint = { innerWidth: 1000, innerHeight: 800, scrollWidth: 1200 };
  const same = room.applyView({
    scroll: 1.4,
    fingerprint: { innerWidth: 1010, innerHeight: 800, scrollWidth: 1200 },
  });
  assert.equal(same.scroll, 1);
  assert.equal(same.mismatch, false);

  const different = room.applyView({
    scroll: 0.3,
    fingerprint: { innerWidth: 1600, innerHeight: 800, scrollWidth: 1200 },
  });
  assert.equal(different.scroll, 0.3);
  assert.equal(different.mismatch, true);
});

test('a snapshot carries the page, and a joiner adopts it', () => {
  const host = new Room({ role: 'host', peerId: 'host' });
  host.applyNav({ url: 'https://example.test/page' });
  host.applyView({ scroll: 0.42 });
  const joiner = new Room({ role: 'peer', peerId: 'carol' });
  joiner.applySnapshot(host.snapshot());
  assert.equal(joiner.url, 'https://example.test/page');
  assert.equal(joiner.scroll, 0.42);
});
