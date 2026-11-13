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

test('a new measurement is due after the interval only', () => {
  let now = 0;
  const clock = new ClockEstimator({ now: () => now });
  assert.equal(clock.due(), true);
  clock.ping();
  assert.equal(clock.due(), false, 'a ping in flight holds the next one');
  clock.onPong(clock.answer({ type: 'ping', t0: 0 }, 1, 2), 10);
  assert.equal(clock.due(), false);
  now = PING_INTERVAL_MS - 1;
  assert.equal(clock.due(), false);
  now = PING_INTERVAL_MS + 10;
  assert.equal(clock.due(), true);
});
