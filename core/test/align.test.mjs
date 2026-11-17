import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGN_GAP_MS,
  APP_NAME,
  MAX_OFFSET_MS,
  MIN_CONFIDENCE,
  acceptOffset,
  clampOffset,
  formatOffset,
  localPosition,
} from '../align.mjs';

test('an offset of zero leaves room time exactly as it was', () => {
  for (const position of [0, 12.5, 3600, -3]) {
    assert.equal(localPosition(position, 0), position);
  }
});

test('a positive offset moves this peer forward on its own timeline', () => {
  // B's copy carries 4.1 s of extra titles, so room time 10 is B's 14.1.
  assert.equal(localPosition(10, 4100), 14.1);
  assert.equal(localPosition(0, 4100), 4.1);
});

test('a trimmed copy moves this peer back', () => {
  assert.equal(localPosition(10, -4100), 5.9);
});

test('a broken offset or position is passed through, never invented', () => {
  assert.equal(localPosition(10, Number.NaN), 10);
  assert.equal(localPosition(10, Number.POSITIVE_INFINITY), 10);
  assert.equal(localPosition(Number.NaN, 1000), Number.NaN);
  assert.equal(localPosition(10, undefined), 10);
});

test('clamping keeps an offset inside a film and rounds to whole ms', () => {
  assert.equal(clampOffset(4100.6), 4101);
  assert.equal(clampOffset(10 * MAX_OFFSET_MS), MAX_OFFSET_MS);
  assert.equal(clampOffset(-10 * MAX_OFFSET_MS), -MAX_OFFSET_MS);
  assert.equal(clampOffset(Number.NaN), null);
  assert.equal(clampOffset(Number.POSITIVE_INFINITY), null);
});

test('a good payload is accepted and rounded', () => {
  const accepted = acceptOffset({ offsetMs: 4100.4, confidence: 0.93, fingerprint: 'a1b2' });
  assert.deepEqual(accepted, { offsetMs: 4100, confidence: 0.93, fingerprint: 'a1b2' });
});

test('a payload without a fingerprint is still a payload', () => {
  assert.deepEqual(acceptOffset({ offsetMs: -820, confidence: 1 }), {
    offsetMs: -820,
    confidence: 1,
    fingerprint: null,
  });
});

test('a weak match is refused, because a seek on a guess is worse than none', () => {
  assert.equal(acceptOffset({ offsetMs: 4100, confidence: MIN_CONFIDENCE - 0.01 }), null);
  assert.equal(acceptOffset({ offsetMs: 4100, confidence: 0 }), null);
  assert.equal(acceptOffset({ offsetMs: 4100, confidence: 0.5 }).offsetMs, 4100);
});

test('an offset beyond half an hour is refused rather than clamped', () => {
  assert.equal(acceptOffset({ offsetMs: MAX_OFFSET_MS + 1, confidence: 1 }), null);
  assert.equal(acceptOffset({ offsetMs: -MAX_OFFSET_MS - 1, confidence: 1 }), null);
  assert.equal(acceptOffset({ offsetMs: MAX_OFFSET_MS, confidence: 1 }).offsetMs, MAX_OFFSET_MS);
});

test('every malformed shape is refused', () => {
  const good = { offsetMs: 1000, confidence: 0.9 };
  for (const bad of [
    null,
    undefined,
    'x',
    42,
    [],
    {},
    { ...good, offsetMs: '4100' },
    { ...good, offsetMs: Number.NaN },
    { ...good, confidence: 'high' },
    { ...good, confidence: 1.5 },
    { ...good, confidence: -0.1 },
    { ...good, fingerprint: 7 },
    { ...good, fingerprint: 'not hex' },
  ]) {
    assert.equal(acceptOffset(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('the panel wording keeps the sign and the unit honest', () => {
  assert.equal(formatOffset(0), '0 s');
  assert.equal(formatOffset(4100), '+4.1 s');
  assert.equal(formatOffset(-4100), '-4.1 s');
  assert.equal(formatOffset(820), '+820 ms');
  assert.equal(formatOffset(-40), '-40 ms');
  assert.equal(formatOffset(Number.NaN), 'unknown');
});

test('the lane names its message and its gaps', () => {
  assert.equal(APP_NAME, 'align.offset');
  assert.equal(ALIGN_GAP_MS, 1000);
});
