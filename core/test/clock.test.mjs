import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockEstimator, PING_INTERVAL_MS } from '../clock.mjs';

test('a symmetric path measures an offset of zero', () => {
  const clock = new ClockEstimator();
  const ping = clock.ping(1000);
  const pong = clock.answer(ping, 1050, 1051);
  const sample = clock.onPong(pong, 1101);
  assert.equal(sample.rtt, 100);
  assert.equal(sample.offset, 0);
});

test('an offset path reports the midpoint of the two clocks', () => {
  const clock = new ClockEstimator();
  const ping = clock.ping(5000);
  const pong = clock.answer(ping, 1000, 1005);
  const sample = clock.onPong(pong, 5015);
  assert.equal(sample.rtt, 10);
  assert.equal(sample.offset, -4005);
  assert.equal(clock.roomTime(5000), 995);
});

test('the sample with the smallest round trip wins', () => {
  const clock = new ClockEstimator();
  const slow = clock.answer(clock.ping(1000), 1100, 1101);
  clock.onPong(slow, 1300);
  // 30 ms out, 1 ms to reply, 30 ms back: 61 ms in total.
  const fast = clock.answer(clock.ping(2000), 2030, 2031);
  clock.onPong(fast, 2062);
  assert.equal(clock.roundTrip(), 61);
  const slower = clock.answer(clock.ping(3000), 3100, 3101);
  clock.onPong(slower, 3300);
  assert.equal(clock.roundTrip(), 61);
  assert.equal(clock.samples, 3);
});

test('an impossible sample is dropped', () => {
  const clock = new ClockEstimator();
  // The reply left 200 ms after it arrived but reached this side 50 ms after
  // the ping left, so the round trip is negative and the sample is garbage.
  const pong = clock.answer(clock.ping(1000), 1100, 1200);
  assert.equal(clock.onPong(pong, 1050), null);
  assert.equal(clock.offset(), 0);
});

test('a pong with no start stamp is dropped', () => {
  const clock = new ClockEstimator();
  // A reply that lost t0 reads as a round trip of the whole wall clock. The Lan
  // journals hold one such sample, at 1794594601870 ms.
  assert.equal(clock.onPong({ type: 'pong', t0: 0, t1: 1, t2: 2 }, 1794594601871), null);
  assert.equal(clock.samples, 0);
  assert.equal(clock.offset(), 0);
});

test('a pong with no reply stamps is dropped', () => {
  const clock = new ClockEstimator();
  // The host reply carries t1 and t2 as zero. The round trip then looks tiny
  // while the offset shifts by the whole wall clock, which is a broken sample.
  assert.equal(clock.onPong({ type: 'pong', t0: 1000, t1: 0, t2: 0 }, 1005), null);
  assert.equal(clock.samples, 0);
  assert.equal(clock.offset(), 0);
});

test('a new measurement is due after the interval only', () => {
  // The fake clock starts at a real wall-clock value, because a start stamp of
  // zero means the reply lost it and the estimator drops that sample.
  let now = 1000;
  const clock = new ClockEstimator({ now: () => now });
  assert.equal(clock.due(), true);
  clock.ping();
  assert.equal(clock.due(), false, 'a ping in flight holds the next one');
  clock.onPong(clock.answer({ type: 'ping', t0: 1000 }, 1001, 1002), 1010);
  assert.equal(clock.due(), false);
  now = 1000 + PING_INTERVAL_MS - 1;
  assert.equal(clock.due(), false);
  now = 1000 + PING_INTERVAL_MS + 10;
  assert.equal(clock.due(), true);
});
