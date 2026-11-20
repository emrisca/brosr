import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLogLines } from '../../host/panel.mjs';

test('a rate correction leaves a line with both rates', () => {
  const lines = rateLogLines({
    room: 'room-1',
    peerId: 'guest-1',
    role: 'peer',
    reading: {
      rate: {
        roomRate: 1,
        changes: 2,
        trace: [
          { at: 1000, kind: 'nudge', roomRate: 1, elementRate: 0.95, drift: -0.4 },
          { at: 2000, kind: 'seek-reset', roomRate: 1, elementRate: 1, drift: -40 },
        ],
      },
    },
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    at: 1000,
    room: 'room-1',
    peer: 'guest-1',
    role: 'peer',
    kind: 'nudge',
    roomRate: 1,
    elementRate: 0.95,
    drift: -0.4,
  });
});

test('a reading with no rate trace writes nothing', () => {
  assert.deepEqual(rateLogLines({ reading: { relay: { stats: {} } } }), []);
  assert.deepEqual(rateLogLines(null), []);
  assert.deepEqual(
    rateLogLines({ reading: { rate: { trace: [{ kind: 'nudge' }] } } }),
    [],
    'an entry with no clock cannot be ordered against the file'
  );
});
