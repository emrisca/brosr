import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaAdapter, mediaKey } from '../media.mjs';

function fakeVideo({
  src = 'http://127.0.0.1:8787/media/clip.webm',
  duration = 120,
  currentTime = 0,
  paused = true,
} = {}) {
  return {
    src,
    currentSrc: src,
    duration,
    currentTime,
    paused,
    readyState: 4,
    playbackRate: 1,
    volume: 1,
    plays: 0,
    pauses: 0,
    play() {
      this.paused = false;
      this.plays += 1;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.pauses += 1;
    },
    getAttribute(name) {
      return name === 'src' ? this.src : null;
    },
  };
}

test('the key drops the query string but keeps the origin and path', () => {
  const element = fakeVideo({ src: 'http://127.0.0.1:8787/media/clip.webm?token=abc' });
  assert.equal(mediaKey(element), 'http://127.0.0.1:8787/media/clip.webm');
  assert.equal(mediaKey(null), '');
});

test('the adapter picks the element whose key matches, across a re-render', () => {
  const first = fakeVideo({ src: 'http://127.0.0.1/a.webm' });
  const second = fakeVideo({ src: 'http://127.0.0.1/b.webm' });
  const adapter = new MediaAdapter({ root: { querySelectorAll: () => [first, second] } });
  assert.equal(adapter.pick('http://127.0.0.1/b.webm'), second);
  assert.equal(adapter.pick('http://127.0.0.1/missing.webm'), first, 'a missing key falls back');
});

test('a short or hidden element does not win the fallback', () => {
  const poster = fakeVideo({ src: 'http://127.0.0.1/poster.webm', duration: 0.4 });
  const film = fakeVideo({ src: 'http://127.0.0.1/film.webm', duration: 600 });
  const adapter = new MediaAdapter({ root: { querySelectorAll: () => [poster, film] } });
  assert.equal(adapter.pick(null), film);
});

test('a state read reports what the room needs', () => {
  const element = fakeVideo({ currentTime: 12.5, paused: false });
  const adapter = new MediaAdapter({ root: { querySelectorAll: () => [element] } });
  assert.deepEqual(adapter.state(element), {
    key: 'http://127.0.0.1:8787/media/clip.webm',
    position: 12.5,
    duration: 120,
    playing: true,
    rate: 1,
    volume: 1,
  });
});

test('a seek clamps to the clip and a play starts it', () => {
  const element = fakeVideo();
  const adapter = new MediaAdapter();
  adapter.apply(element, { action: 'seek', position: 500 });
  assert.equal(element.currentTime, 120);
  adapter.apply(element, { action: 'play' });
  assert.equal(element.paused, false);
  assert.equal(element.plays, 1);
  adapter.apply(element, { action: 'pause' });
  assert.equal(element.pauses, 1);
});

test('a rate nudge and a volume set reach the element', () => {
  const element = fakeVideo();
  const adapter = new MediaAdapter();
  adapter.apply(element, { action: 'tick', rate: 0.95, volume: 0.4 });
  assert.equal(element.playbackRate, 0.95);
  assert.equal(element.volume, 0.4);
  assert.equal(element.currentTime, 0, 'a tick never seeks');
});

test('the adapter reports a missing element instead of throwing', () => {
  const adapter = new MediaAdapter();
  assert.equal(adapter.apply(null, { action: 'play' }), 'missing');
  assert.equal(adapter.state(null), null);
  assert.equal(adapter.pick(null), null);
});
