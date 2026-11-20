import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteMediaSync } from '../media-relay.mjs';

const HREF = 'https://www.youtube.com/watch?v=abc123';
const HOST = 'www.youtube.com';
const KEY = 'youtube:abc123';

function fakeVideo({ currentTime = 0, paused = false, duration = 300 } = {}) {
  return {
    src: HREF,
    currentSrc: HREF,
    duration,
    currentTime,
    paused,
    ended: false,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    volume: 1,
    buffered: {
      length: 1,
      start: () => 0,
      end: () => duration,
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    getAttribute(name) {
      return name === 'src' ? HREF : null;
    },
  };
}

function fakeDoc(video) {
  return {
    querySelector(selector) {
      if (selector === '#movie_player') return { classList: { contains: () => false } };
      if (selector === 'video.html5-main-video, video') return video;
      return null;
    },
  };
}

function createSync(video, now) {
  return new RemoteMediaSync({
    document: fakeDoc(video),
    href: HREF,
    hostname: HOST,
    now: () => now.value,
  });
}

test('a jump clears the rate correction and follows the room rate', () => {
  const video = fakeVideo({ currentTime: 100 });
  const now = { value: 10000 };
  const sync = createSync(video, now);

  // The first frame seeds the tab, so the playhead starts where the room is.
  sync.handle({ key: KEY, position: 100, playing: true, rate: 1, at: now.value });
  assert.equal(video.playbackRate, 1);

  // A gap just over the nudge threshold starts the five percent correction.
  video.currentTime = 100.5;
  sync.handle({ key: KEY, position: 100, playing: true, rate: 1, at: now.value });
  assert.ok(Math.abs(video.playbackRate - 1 / 1.05) < 1e-9, 'the element runs the nudge');

  // The person with control jumps the film. The gap is a seek, and the
  // correction must end with it. A film left on the nudge after a jump keeps
  // drifting, which is the slow motion that grew with the session.
  const jumped = sync.handle({ key: KEY, position: 200, playing: true, rate: 1, at: now.value });
  assert.equal(jumped.action, 'seek');
  assert.equal(video.currentTime, 200);
  assert.equal(video.playbackRate, 1, 'the jump drops the nudge');
  assert.equal(sync.reportedRate(), 1, 'the report never carries the nudge out');

  const rate = sync.rateView();
  assert.equal(rate.roomRate, 1);
  assert.ok(rate.changes >= 2, 'the nudge and the reset are both recorded');
  const nudge = rate.trace.find((entry) => entry.kind === 'nudge');
  assert.ok(nudge, 'the trace names the nudge');
  assert.equal(nudge.roomRate, 1);
  assert.ok(Math.abs(nudge.elementRate - 0.952) < 0.001);
  const reset = rate.trace.find((entry) => entry.kind === 'seek-reset');
  assert.ok(reset, 'the trace names the reset');
  assert.equal(reset.elementRate, 1);
});

test('a nudge is a correction on the room rate, not on the element rate', () => {
  const video = fakeVideo({ currentTime: 100 });
  const now = { value: 10000 };
  const sync = createSync(video, now);

  sync.handle({ key: KEY, position: 100, playing: true, rate: 1.25, at: now.value });
  assert.equal(video.playbackRate, 1.25);

  video.currentTime = 100.5;
  sync.handle({ key: KEY, position: 100, playing: true, rate: 1.25, at: now.value });
  assert.ok(
    Math.abs(video.playbackRate - 1.25 / 1.05) < 1e-9,
    'the nudge divides the room rate, not a previous correction'
  );

  // The jump arrives at the room rate the person with control chose.
  const jumped = sync.handle({ key: KEY, position: 220, playing: true, rate: 1.25, at: now.value });
  assert.equal(jumped.action, 'seek');
  assert.equal(video.currentTime, 220);
  assert.equal(video.playbackRate, 1.25);
  assert.equal(sync.reportedRate(), 1.25);
});
