import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_KEY_PREFIX,
  RemoteMediaSync,
  filmUrl,
  framePageHref,
  isCinecatHost,
  isCinecatWatchPage,
  mediaStateFromDocument,
  pageKey,
} from '../media-relay.mjs';

const TITLE = 'https://cinecat.eu/media/155';
const EPISODE = 'https://cinecat.eu/media/1396/1/2?server=zcdn';
const TV_EPISODE = 'https://cinecat.eu/tv/watch/1396/1/2';
const FRAME = 'https://player.example/embed/abc?token=1';

function fakeVideo({
  src = 'blob:https://cinecat.eu/8f2c',
  currentTime = 0,
  duration = 300,
  paused = true,
  readyState = 4,
  playbackRate = 1,
  volume = 1,
} = {}) {
  return {
    src,
    currentSrc: src,
    duration,
    currentTime,
    paused,
    ended: false,
    seeking: false,
    readyState,
    playbackRate,
    volume,
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

function fakeDoc(video) {
  return {
    querySelector(selector) {
      return selector === 'video.html5-main-video, video' ? video : null;
    },
  };
}

test('Cinecat hosts and watch routes are named explicitly', () => {
  assert.equal(isCinecatHost('cinecat.eu'), true);
  assert.equal(isCinecatHost('www.cinecat.eu'), true);
  assert.equal(isCinecatHost('notcinecat.eu'), false);
  assert.equal(isCinecatWatchPage(TITLE), true);
  assert.equal(isCinecatWatchPage('https://www.cinecat.eu/media/155/'), true);
  assert.equal(isCinecatWatchPage(TV_EPISODE), true);
  assert.equal(isCinecatWatchPage('https://cinecat.eu/'), false);
  assert.equal(isCinecatWatchPage('https://notcinecat.eu/media/155'), false);
});

test('a Cinecat player frame takes its title page as the film page', () => {
  assert.equal(framePageHref({ href: FRAME, referrer: TITLE, embedded: true }), TITLE);
  assert.equal(framePageHref({ href: FRAME, referrer: EPISODE, embedded: true }), EPISODE);
  assert.equal(framePageHref({ href: FRAME, referrer: TV_EPISODE, embedded: true }), TV_EPISODE);
  assert.equal(
    framePageHref({ href: FRAME, referrer: 'https://cinecat.eu/', embedded: true }),
    FRAME
  );
  assert.equal(framePageHref({ href: FRAME, referrer: TITLE, embedded: false }), FRAME);
  assert.equal(
    framePageHref({ href: FRAME, referrer: 'https://example.com/media/155', embedded: true }),
    FRAME
  );
});

test('a Cinecat HLS player names the film by the title page', () => {
  const video = fakeVideo({ currentTime: 12.5 });
  const state = mediaStateFromDocument(fakeDoc(video), TITLE, 'player.example');
  assert.equal(state.key, `${PAGE_KEY_PREFIX}${TITLE}`);
  assert.equal(state.position, 12.5);
  assert.equal(state.playing, false);
  assert.equal(state.ad, false);
  assert.equal(filmUrl(state.key), TITLE);
});

test('a Cinecat episode keeps its season and episode in the key', () => {
  assert.equal(pageKey(EPISODE), `${PAGE_KEY_PREFIX}https://cinecat.eu/media/1396/1/2`);
  assert.equal(filmUrl(pageKey(EPISODE)), 'https://cinecat.eu/media/1396/1/2');
});

test('a Cinecat frame seeks its own HLS player to the room key', () => {
  const video = fakeVideo({ currentTime: 0 });
  const sync = new RemoteMediaSync({
    document: fakeDoc(video),
    href: FRAME,
    hostname: 'player.example',
    pageHref: () => TITLE,
    now: () => 10000,
  });

  const result = sync.handle({
    key: pageKey(TITLE),
    position: 100,
    playing: true,
    rate: 1,
    at: 10000,
  });

  assert.equal(result.action, 'seek');
  assert.equal(video.currentTime, 100);
  assert.equal(video.paused, false);
  assert.equal(sync.stats.seeks, 1);
});
