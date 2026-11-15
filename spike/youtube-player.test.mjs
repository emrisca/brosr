// The fixture player through the real room client. This is the same object the
// browser fixture page publishes, so the test covers what the page supplies.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AD_CLASS, createPlayer } from './fixtures/youtube-player.js';
import { YouTubeAdapter } from '../core/youtube.mjs';
import { createRoomClient } from '../core/sync.mjs';
import { encode } from '../core/protocol.mjs';

const KEY = 'youtube:abc123';

function makeClient(player, { ad = false } = {}) {
  let local = 0;
  const adapter = new YouTubeAdapter({
    player,
    key: KEY,
    root: { classList: { contains: (name) => ad && name === AD_CLASS } },
  });
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    now: () => local,
    mediaAdapter: adapter,
    send: () => {},
  });
  return {
    client,
    at(ms) {
      local = ms;
    },
    frame(position, roomTime, playing = false) {
      return encode({ type: 'media', key: KEY, action: 'tick', position, roomTime, playing });
    },
  };
}

test('the fixture player answers every read the room makes', () => {
  const player = createPlayer({ time: 30 });
  const room = makeClient(player);
  room.at(5000);

  const step = room.client.receive(room.frame(30, 0), 5000);
  assert.equal(step.ok, true);
  assert.equal(room.client.publish().key, KEY);
  assert.equal(player.seeks.length, 0);
});

test('a large drift seeks the fixture player through seekTo', () => {
  const player = createPlayer({ time: 30 });
  const room = makeClient(player);
  room.at(5000);

  const step = room.client.receive(room.frame(90, 0), 5000);
  assert.equal(step.step.action, 'seek');
  assert.deepEqual(player.seeks, [90]);
  assert.equal(player.time, 90);
});

test('the ad class on the fixture container pauses the player', () => {
  const player = createPlayer({ time: 30 });
  const room = makeClient(player, { ad: true });
  room.at(5000);

  const step = room.client.receive(room.frame(30, 0, true), 5000);
  assert.equal(step.step.action, 'pause');
  assert.equal(step.step.reason, 'ad');
  assert.equal(player.state, 2, 'the pause reaches the player');
});
