import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decode,
  encode,
  splitInput,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
} from '../protocol.mjs';

const presence = {
  type: 'presence',
  peerId: 'alice',
  name: 'Alice',
  colour: '#e2603f',
  point: { x: 120, y: 80 },
  roomTime: 1000,
};

test('a presence message survives a round trip', () => {
  const message = decode(encode(presence));
  assert.equal(message.type, 'presence');
  assert.equal(message.v, PROTOCOL_VERSION);
  assert.deepEqual(message.point, { x: 120, y: 80 });
});

test('an unknown type is rejected on the way out', () => {
  assert.throws(() => encode({ type: 'shrug' }), /unknown message type/);
});

test('an unknown version is rejected on the way in', () => {
  const frame = JSON.stringify({ v: 99, ...presence });
  assert.throws(() => decode(frame), /protocol version 99/);
});

test('a presence message without a point is rejected', () => {
  assert.throws(() => encode({ type: 'presence', peerId: 'a' }), /presence needs a point/);
});

test('a media message needs an action the plan defines', () => {
  assert.throws(
    () => encode({ type: 'media', action: 'rewind', position: 1, roomTime: 1 }),
    /media action rewind is unknown/
  );
});

test('a frame over the limit is refused', () => {
  const big = 'x'.repeat(MAX_FRAME_BYTES);
  assert.throws(() => encode({ ...presence, name: big }), /over the 16384 byte limit/);
});

test('a large input batch splits into frames that fit', () => {
  const records = Array.from({ length: 400 }, (_, index) => ({
    kind: 'pointer',
    x: index,
    y: index % 50,
    t: index,
  }));
  const frames = splitInput({ type: 'input', seq: 1, records });
  assert.ok(frames.length > 1, 'the batch needed more than one frame');
  const rebuilt = frames.flatMap((frame) => frame.records);
  assert.equal(rebuilt.length, records.length);
  assert.deepEqual(rebuilt[0], records[0]);
  assert.deepEqual(rebuilt[rebuilt.length - 1], records[records.length - 1]);
  for (const frame of frames) {
    assert.ok(new TextEncoder().encode(encode(frame)).length <= MAX_FRAME_BYTES);
  }
});

test('a single record over the limit fails instead of splitting forever', () => {
  const record = { kind: 'text', text: 'x'.repeat(MAX_FRAME_BYTES) };
  assert.throws(() => splitInput({ type: 'input', seq: 1, records: [record] }), /over the frame limit/);
});
