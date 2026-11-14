// The pause path through the real adapter. A starved element and a site ad both
// reach the policy through media.flags, so this file drives the adapter itself
// rather than a stub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClient } from '../sync.mjs';
import { MediaAdapter } from '../media.mjs';
import { encode } from '../protocol.mjs';

const KEY = 'http://127.0.0.1:8787/media/clip.webm';

function fakeVideo() {
  return {
    src: KEY,
    currentSrc: KEY,
    duration: 120,
    currentTime: 0,
    paused: false,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    volume: 1,
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    getAttribute(name) {
      return name === 'src' ? this.src : null;
    },
  };
}

function makeClient(video, probe = null) {
  let local = 0;
  const adapter = new MediaAdapter({ root: { querySelectorAll: () => [video] } });
  if (probe) adapter.watchAds(probe);
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
    frame(position, roomTime, playing = true) {
      return encode({ type: 'media', key: KEY, action: 'tick', position, roomTime, playing });
    },
  };
}

test('an ad pauses the peer, and clearing it lets the peer play again', () => {
  const video = fakeVideo();
  let ad = true;
  const { client, at, frame } = makeClient(video, () => ad);

  at(5000);
  const paused = client.receive(frame(0, 5000), 5000);
  assert.equal(paused.step.action, 'pause');
  assert.equal(paused.step.reason, 'ad');
  assert.equal(video.paused, true);

  ad = false;
  at(6000);
  const resumed = client.receive(frame(0, 6000), 6000);
  assert.notEqual(resumed.step.action, 'pause');
  assert.equal(video.paused, false, 'the room is playing, so the peer plays');
});

test('a starved element pauses the peer without an ad', () => {
  const video = fakeVideo();
  video.readyState = 1;
  const { client, at, frame } = makeClient(video);

  at(5000);
  const step = client.receive(frame(0, 5000), 5000);
  assert.equal(step.step.action, 'pause');
  assert.equal(step.step.reason, 'buffering');
  assert.equal(video.paused, true);
});

test('a ready element with no ad is left alone', () => {
  const video = fakeVideo();
  const { client, at, frame } = makeClient(video);

  at(5000);
  const step = client.receive(frame(0, 5000), 5000);
  assert.notEqual(step.step.action, 'pause');
  assert.equal(video.paused, false);
});

test('the adapter is the only source of the flags', () => {
  const video = fakeVideo();
  const { adapter } = makeClient(video);
  assert.deepEqual(adapter.flags(video), { buffering: false, adPlaying: false });
  adapter.watchAds(() => true);
  assert.deepEqual(adapter.flags(video), { buffering: false, adPlaying: true });
});
