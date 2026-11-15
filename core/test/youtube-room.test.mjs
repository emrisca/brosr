// The YouTube adapter through the real room client. The peer path reads element
// fields on whatever the adapter picks, so this file proves a player object
// reaches the same drift decisions as a media element.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClient } from '../sync.mjs';
import { AD_CLASS, YouTubeAdapter } from '../youtube.mjs';
import { encode } from '../protocol.mjs';

const KEY = 'youtube:abc123';

function fakePlayer({ time = 0, duration = 2400, state = 1, rate = 1, volume = 100 } = {}) {
  return {
    time,
    duration,
    state,
    rate,
    volume,
    seeks: [],
    plays: 0,
    pauses: 0,
    getCurrentTime() {
      return this.time;
    },
    getDuration() {
      return this.duration;
    },
    getPlayerState() {
      return this.state;
    },
    getPlaybackRate() {
      return this.rate;
    },
    getVolume() {
      return this.volume;
    },
    seekTo(seconds) {
      this.time = seconds;
      this.seeks.push(seconds);
    },
    playVideo() {
      this.state = 1;
      this.plays += 1;
    },
    pauseVideo() {
      this.state = 2;
      this.pauses += 1;
    },
    setPlaybackRate(next) {
      this.rate = next;
    },
    setVolume(next) {
      this.volume = next;
    },
  };
}

function fakeRoot(classes = []) {
  return { classList: { contains: (name) => classes.includes(name) } };
}

function makeClient(player, { classes = [] } = {}) {
  let local = 0;
  const adapter = new YouTubeAdapter({ player, root: fakeRoot(classes), key: KEY });
  const client = createRoomClient({
    role: 'peer',
    peerId: 'peer',
    now: () => local,
    mediaAdapter: adapter,
    send: () => {},
  });
  return {
    client,
    adapter,
    at(ms) {
      local = ms;
    },
    frame(position, roomTime, playing = false) {
      return encode({ type: 'media', key: KEY, action: 'tick', position, roomTime, playing });
    },
  };
}

test('the peer reads the player through the view, so the key and position land', () => {
  const player = fakePlayer({ time: 100 });
  const { client, at, frame } = makeClient(player);

  at(5000);
  const step = client.receive(frame(100, 0), 5000);
  assert.equal(step.ok, true);
  const status = client.publish();
  assert.equal(status.key, KEY, 'the key reaches the room');
  assert.equal(status.position, 100, 'the position comes from the player');
  assert.equal(status.playing, true);
  assert.deepEqual(player.seeks, [], 'a peer that matches the host never seeks');
});

test('a drift beyond 300 ms seeks through the player API', () => {
  const player = fakePlayer({ time: 80 });
  const { client, at, frame } = makeClient(player);

  at(5000);
  const step = client.receive(frame(100, 0), 5000);
  assert.equal(step.step.action, 'seek');
  assert.deepEqual(player.seeks, [100], 'the seek goes through seekTo');
  assert.equal(player.time, 100);
  assert.equal(client.publish().corrections, 1);
});

test('a drift inside the seek threshold nudges the rate instead', () => {
  const player = fakePlayer({ time: 100.2 });
  const { client, at, frame } = makeClient(player);

  at(5000);
  const step = client.receive(frame(100, 0), 5000);
  assert.equal(step.step.action, 'nudge');
  assert.equal(player.rate, 0.95, 'a rate the player owns, not a field write');
  assert.deepEqual(player.seeks, []);
});

test('a buffering player pauses the peer, and the room starts it again', () => {
  const player = fakePlayer({ time: 100, state: 3 });
  const { client, at, frame } = makeClient(player);

  at(5000);
  const paused = client.receive(frame(100, 0, true), 5000);
  assert.equal(paused.step.action, 'pause');
  assert.equal(paused.step.reason, 'buffering');
  assert.equal(player.pauses, 1, 'a buffering player is not paused, so the room pauses it');

  player.state = 2;
  at(6000);
  const resumed = client.receive(frame(106, 6000, true), 6000);
  assert.notEqual(resumed.step.action, 'pause');
  assert.equal(player.plays, 1, 'the room is playing, so the player plays');
});

test('the ad class on the player container pauses the peer', () => {
  const player = fakePlayer({ time: 100 });
  const { client, at, frame } = makeClient(player, { classes: [AD_CLASS] });

  at(5000);
  const step = client.receive(frame(100, 0, true), 5000);
  assert.equal(step.step.action, 'pause');
  assert.equal(step.step.reason, 'ad');
  assert.equal(player.pauses, 1);
});

test('a key that names another video leaves the peer without media', () => {
  const player = fakePlayer({ time: 100 });
  const { client, at } = makeClient(player);

  at(5000);
  const step = client.receive(
    encode({ type: 'media', key: 'youtube:other', action: 'tick', position: 10, roomTime: 0 }),
    5000
  );
  assert.equal(step.ok, false);
  assert.equal(step.reason, 'no-media');
  assert.deepEqual(player.seeks, []);
});

test('the view reports the fields the peer path reads', () => {
  const player = fakePlayer({ time: 42, duration: 600 });
  const adapter = new YouTubeAdapter({ player, key: KEY });
  const view = adapter.pick(KEY);
  assert.equal(view.currentTime, 42);
  assert.equal(view.duration, 600);
  assert.equal(view.paused, false);
  assert.equal(view.seeking, false);
  assert.equal(view.readyState, 4);
  assert.equal(view.playbackRate, 1);
  assert.equal(adapter.state(view).key, KEY, 'the view resolves back to the player');
  assert.deepEqual(adapter.state(undefined), adapter.state(player), 'a missing handle uses the player');
});
