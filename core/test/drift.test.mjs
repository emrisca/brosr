import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftController, decideDrift, NUDGE_MS, SEEK_MS, MAX_RATE_DELTA } from '../drift.mjs';

test('a small drift does nothing', () => {
  assert.deepEqual(decideDrift(0), { action: 'none', rate: 1 });
  assert.deepEqual(decideDrift(-39), { action: 'none', rate: 1 });
});

test('a drift between the thresholds slows the ahead side', () => {
  assert.deepEqual(decideDrift(100), { action: 'nudge', rate: 1 - MAX_RATE_DELTA });
});

test('a drift behind the host speeds this side up', () => {
  assert.deepEqual(decideDrift(-100), { action: 'nudge', rate: 1 + MAX_RATE_DELTA });
});

test('the boundaries follow the plan, not a guess', () => {
  assert.equal(decideDrift(NUDGE_MS).action, 'none');
  assert.equal(decideDrift(NUDGE_MS + 1).action, 'nudge');
  assert.equal(decideDrift(SEEK_MS).action, 'nudge');
  assert.equal(decideDrift(SEEK_MS + 1).action, 'seek');
});

test('a buffering peer pauses the room', () => {
  assert.equal(decideDrift(10, { buffering: true }).action, 'pause');
});

test('an ad pauses a shared playhead before anything else', () => {
  assert.equal(decideDrift(900, { adPlaying: true, buffering: true }).action, 'pause');
});

test('the controller counts a seek and restores the rate', () => {
  const controller = new DriftController();
  assert.equal(controller.tick(1000).action, 'seek');
  assert.equal(controller.rate, 1);
  assert.equal(controller.seeks, 1);
  assert.equal(controller.tick(120).action, 'nudge');
  assert.equal(controller.rate, 0.95);
  assert.equal(controller.tick(10).action, 'none');
  assert.equal(controller.rate, 1);
  assert.deepEqual(controller.stats(), { seeks: 1, nudges: 1, rate: 1, lastAction: 'none' });
});
