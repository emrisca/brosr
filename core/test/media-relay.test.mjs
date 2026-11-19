import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_ECHO_MS,
  RELAY_BUFFER_WAIT_MS,
  RELAY_SEEK_TIMEOUT_MS,
  RELAY_TICK_MS,
  RelayMediaAdapter,
  RemoteMediaSync,
  filmUrl,
  freshState,
  isYouTubeHost,
  mediaEchoMatches,
  mediaStateFromDocument,
  projectPosition,
  remoteMediaEcho,
  viewerState,
} from '../media-relay.mjs';

function fakeVideo({
  src = 'https://www.youtube.com/watch?v=abc123',
  duration = 300,
  currentTime = 0,
  paused = true,
  readyState = 4,
  playbackRate = 1,
  volume = 1,
  buffered = null,
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
    buffered: buffered || {
      length: 1,
      start: () => 0,
      end: () => duration,
    },
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

function fakeDoc(video, root = null) {
  return {
    querySelector(selector) {
      if (selector === '#movie_player') return root;
      if (selector === 'video.html5-main-video, video') return video;
      return null;
    },
  };
}

const ytHref = 'https://www.youtube.com/watch?v=abc123';
const ytHost = 'www.youtube.com';
const ytKey = 'youtube:abc123';

const adRoot = { classList: { contains: (name) => name === 'ad-showing' } };
const cleanRoot = { classList: { contains: () => false } };

function echoFrame(playing = true) {
  return { key: ytKey, position: 130, playing, rate: 1, at: 10100 };
}

function echoPrevious(playing = true) {
  return { key: ytKey, position: 100, playing, rate: 1, at: 10000 };
}

test('a remote seek keeps only the seek event home, not a pause after it', () => {
  const echo = remoteMediaEcho(
    { ok: true, action: 'seek' },
    echoPrevious(),
    echoFrame(),
    10100
  );
  assert.deepEqual(echo.actions, ['seek']);
  assert.equal(mediaEchoMatches(echo, 'seek', 10150), true);
  assert.equal(mediaEchoMatches(echo, 'pause', 10150), false);
  assert.equal(mediaEchoMatches(echo, 'play', 10150), false);
  assert.equal(mediaEchoMatches(echo, 'seek', 10100 + MEDIA_ECHO_MS), false);
});

test('a buffer hold keeps its pause home without hiding a later act', () => {
  const echo = remoteMediaEcho(
    { ok: true, skipped: 'buffer' },
    echoPrevious(),
    echoFrame(),
    10100
  );
  assert.deepEqual(echo.actions, ['pause']);
  assert.equal(mediaEchoMatches(echo, 'pause', 10150), true);
  assert.equal(mediaEchoMatches(echo, 'seek', 10150), false);
});

test('a routine tick opens no echo window', () => {
  assert.equal(
    remoteMediaEcho({ ok: true, action: 'tick' }, echoPrevious(), echoFrame(), 10100),
    null
  );
});

test('a playing room starts a paused film even when the seek cannot land', () => {
  const video = fakeVideo({ currentTime: 0, paused: true });
  const now = 10000;
  const sync = new RemoteMediaSync({
    document: fakeDoc(video, cleanRoot),
    href: ytHref,
    hostname: ytHost,
    now: () => now,
  });
  // The anchor is 120 s away, so this tick takes the seek branch. The play has
  // to land first, or a seek that never settles keeps the film paused and the
  // room never hears from it again.
  const result = sync.handle({ key: ytKey, position: 120, playing: true, rate: 1, at: now });
  assert.equal(result.action, 'seek');
  assert.equal(video.paused, false);
  assert.equal(video.plays, 1);
});

test('a seek that never lands is retried, not stacked, and not left holding the film', () => {
  const video = fakeVideo({ currentTime: 0, paused: false });
  let now = 10000;
  const sync = new RemoteMediaSync({
    document: fakeDoc(video, cleanRoot),
    href: ytHref,
    hostname: ytHost,
    now: () => now,
  });
  const first = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(first.action, 'seek');
  // The element takes the seek and never finishes it. A second write inside
  // the timeout would fight the first, so the tick leaves it alone.
  video.seeking = true;
  now += 500;
  const held = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(held.action, 'tick');
  assert.equal(sync.stats.seeks, 1);
  // Past the timeout the seek is stuck, and one fresh seek frees it.
  now += RELAY_SEEK_TIMEOUT_MS;
  const retry = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(retry.action, 'seek');
  assert.equal(retry.retry, true);
  assert.equal(sync.stats.stuckSeeks, 1);
  assert.equal(video.currentTime, 100);
});

test('a YouTube tab reads its own player and names the film', () => {
  const video = fakeVideo({ currentTime: 12.5, paused: false, volume: 0.8 });
  const state = mediaStateFromDocument(fakeDoc(video, cleanRoot), ytHref, ytHost);
  assert.equal(state.key, ytKey);
  assert.equal(state.position, 12.5);
  assert.equal(state.duration, 300);
  assert.equal(state.playing, true);
  assert.equal(state.rate, 1);
  assert.equal(state.volume, 0.8);
  assert.equal(state.buffering, false);
  assert.equal(state.ad, false);
});

test('the player container marks an ad, and a missing player means no state', () => {
  const video = fakeVideo();
  const state = mediaStateFromDocument(fakeDoc(video, adRoot), ytHref, ytHost);
  assert.equal(state.ad, true);
  assert.equal(mediaStateFromDocument(fakeDoc(null), ytHref, ytHost), null);
  assert.deepEqual(mediaStateFromDocument(null), null);
});

test('a music host names its track and a watch page does not claim one', () => {
  const video = fakeVideo({ paused: false });
  const music = fakeDoc(video, cleanRoot);
  music.title = 'Night Drive - Artist - YouTube Music';
  music.mediaSession = { metadata: { title: 'Night Drive', artist: 'Artist' } };
  const state = mediaStateFromDocument(
    music,
    'https://music.youtube.com/watch?v=abc123',
    'music.youtube.com'
  );
  assert.equal(state.music, true);
  assert.equal(state.title, 'Night Drive · Artist');
  const seen = viewerState({ ...state, at: 1000 }, null, 1000);
  assert.equal(seen.music, true);
  assert.equal(seen.title, 'Night Drive · Artist');

  // A page with no media session falls back to its title, minus the site name,
  // and a watch page is not reported as music.
  const plain = fakeDoc(fakeVideo(), cleanRoot);
  plain.title = 'Some Video - YouTube';
  const watch = mediaStateFromDocument(plain, ytHref, ytHost);
  assert.equal(watch.music, false);
  assert.equal(watch.title, 'Some Video');
});

test('the YouTube host check covers the watch, embed and short hosts', () => {
  assert.equal(isYouTubeHost('www.youtube.com'), true);
  assert.equal(isYouTubeHost('youtube.com'), true);
  assert.equal(isYouTubeHost('youtu.be'), true);
  assert.equal(isYouTubeHost('notyoutube.com'), false);
  assert.equal(isYouTubeHost('example.com'), false);
});

test('a playing state moves with the clock, and a paused one does not', () => {
  const at = 1000;
  const playing = { position: 10, rate: 1, playing: true, buffering: false, ad: false, at };
  assert.equal(projectPosition(playing, at + 2000), 12);
  const paused = { ...playing, playing: false };
  assert.equal(projectPosition(paused, at + 2000), 10);
  const ad = { ...playing, ad: true };
  assert.equal(projectPosition(ad, at + 2000), 10);
  const starved = { ...playing, buffering: true };
  assert.equal(projectPosition(starved, at + 2000), 10);
  assert.equal(projectPosition(null), 0);
});

test('the room adapter gives the relayed state a player shape', () => {
  let now = 5000;
  const adapter = new RelayMediaAdapter({ now: () => now });
  assert.equal(adapter.pick(null), null);
  assert.equal(adapter.set(null), false);
  assert.equal(
    adapter.set({
      key: ytKey,
      position: 30,
      duration: 300,
      playing: false,
      rate: 1,
      volume: 1,
      buffering: false,
      ad: false,
      at: now,
    }),
    true
  );

  const view = adapter.pick(null);
  assert.equal(view.currentTime, 30);
  assert.equal(view.duration, 300);
  assert.equal(view.paused, true);
  assert.equal(view.seeking, false);
  assert.equal(view.readyState, 4);
  assert.equal(adapter.pick('youtube:other'), null);
  assert.equal(adapter.pick(ytKey), view);

  adapter.apply(view, { action: 'play' });
  now = 7000;
  assert.equal(adapter.state().position, 32);
  assert.equal(adapter.state().playing, true);
  assert.equal(view.paused, false);

  adapter.apply(view, { action: 'pause', position: 90 });
  assert.equal(adapter.state().position, 90);
  assert.equal(adapter.state().playing, false);
  assert.equal(view.currentTime, 90);
});

test('the adapter reports a starved or ad state as a flag, not a position jump', () => {
  const adapter = new RelayMediaAdapter({ now: () => 1000 });
  adapter.set({ key: ytKey, position: 40, playing: true, buffering: true, ad: true, at: 1000 });
  assert.deepEqual(adapter.flags(), { buffering: true, adPlaying: true });
  assert.equal(adapter.state().position, 40);
  assert.equal(adapter.view().readyState, 1);
});

test('a tab that shows the film seeks when the room is far ahead', () => {
  const video = fakeVideo({ currentTime: 50 });
  let now = 10000;
  const sync = new RemoteMediaSync({ document: fakeDoc(video, cleanRoot), href: ytHref, hostname: ytHost, now: () => now });
  const result = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(result.action, 'seek');
  assert.equal(video.currentTime, 100);
  assert.equal(sync.stats.seeks, 1);

  // A second seek inside the settle window waits, so two writes cannot fight.
  now += 100;
  const again = sync.handle({ key: ytKey, position: 130, playing: true, rate: 1, at: now });
  assert.equal(again.action, 'tick');
  assert.equal(video.currentTime, 100);
});

test('a seek outside the buffered range waits, then lands when data arrives', () => {
  let end = 60;
  const buffered = { length: 1, start: () => 0, end: () => end };
  const video = fakeVideo({ currentTime: 50, duration: 300, paused: false, buffered });
  let now = 10000;
  const sync = new RemoteMediaSync({ document: fakeDoc(video, cleanRoot), href: ytHref, hostname: ytHost, now: () => now });

  const first = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(first.skipped, 'buffer');
  assert.equal(video.currentTime, 50);
  assert.equal(video.paused, true, 'the film stops instead of running away from the target');
  assert.equal(sync.stats.seeks, 0);
  assert.equal(sync.stats.bufferWaits, 1);
  assert.equal(sync.stats.bufferHolds, 1);

  // A second tick keeps waiting, does not start the film again, and does not
  // count a second wait.
  now += 500;
  const held = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(held.skipped, 'buffer');
  assert.equal(video.currentTime, 50);
  assert.equal(video.paused, true);
  assert.equal(sync.stats.bufferWaits, 1);

  // The player fetched the range, so the next tick can land the seek and
  // resume the room's playback.
  end = 200;
  const landed = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(landed.action, 'seek');
  assert.equal(video.currentTime, 100);
  assert.equal(video.paused, false);
  assert.equal(sync.stats.seeks, 1);
});

test('a buffer wait reports recovery after the deadline without another frame', () => {
  const video = fakeVideo({
    currentTime: 50,
    duration: 300,
    paused: false,
    buffered: { length: 1, start: () => 0, end: () => 60 },
  });
  let now = 10000;
  const sync = new RemoteMediaSync({
    document: fakeDoc(video, cleanRoot),
    href: ytHref,
    hostname: ytHost,
    now: () => now,
  });

  sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(sync.bufferWaitActive(now), true);

  // The report timer is what releases a room hold when the film tab receives
  // no further frames. It must expire the wait and leave the film paused until
  // the release frame carries the seek.
  now += RELAY_BUFFER_WAIT_MS + 1;
  assert.equal(sync.bufferWaitActive(now), false);
  assert.equal(sync.waitingSince, null);
  assert.equal(sync.bufferReady, true);
  assert.equal(video.paused, true);

  const landed = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  assert.equal(landed.action, 'seek');
  assert.equal(video.currentTime, 100);
  assert.equal(video.paused, false);
});

test('a buffer that never arrives still seeks after the wait deadline', () => {
  const video = fakeVideo({ currentTime: 50, duration: 300, paused: false, buffered: { length: 1, start: () => 0, end: () => 60 } });
  let now = 10000;
  const sync = new RemoteMediaSync({ document: fakeDoc(video, cleanRoot), href: ytHref, hostname: ytHost, now: () => now });

  sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });
  now += RELAY_BUFFER_WAIT_MS + 1;
  const result = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: now });

  assert.equal(result.action, 'seek');
  assert.equal(video.currentTime, 100);
  assert.equal(video.paused, false);
  assert.equal(sync.stats.seeks, 1);
});

test('a small gap gets a rate nudge instead of a seek', () => {
  const video = fakeVideo({ currentTime: 100 });
  const sync = new RemoteMediaSync({ document: fakeDoc(video, cleanRoot), href: ytHref, hostname: ytHost, now: () => 10000 });
  // The first frame seeds the tab, and a seeded tab keeps the room policy. The
  // nudge below is the second frame, which is the case this test is about.
  sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: 10000 });
  video.currentTime = 100.5;
  const result = sync.handle({ key: ytKey, position: 100, playing: true, rate: 1, at: 10000 });
  assert.equal(result.action, 'tick');
  assert.ok(Math.abs(video.playbackRate - 1 / 1.05) < 1e-9);
  assert.equal(sync.stats.seeks, 0);
});

test('a paused room stops a moving video before a drift seek', () => {
  const video = fakeVideo({ currentTime: 100, paused: false });
  const sync = new RemoteMediaSync({
    document: fakeDoc(video, cleanRoot),
    href: ytHref,
    hostname: ytHost,
    now: () => 10000,
  });
  const result = sync.handle({ key: ytKey, position: 50, playing: false, rate: 1, at: 10000 });
  assert.equal(video.paused, true);
  assert.equal(video.pauses, 1);
  assert.equal(video.currentTime, 50);
  assert.equal(result.action, 'seek');
});

test('a tab near the anchor keeps the room rate and follows play and pause', () => {
  const video = fakeVideo({ currentTime: 100.05, paused: false, playbackRate: 1.25 });
  const sync = new RemoteMediaSync({ document: fakeDoc(video, cleanRoot), href: ytHref, hostname: ytHost, now: () => 10000 });
  sync.handle({ key: ytKey, position: 100, playing: true, rate: 1.25, at: 10000 });
  assert.equal(video.playbackRate, 1.25);

  sync.handle({ key: ytKey, position: 100, playing: false, rate: 1.25, at: 10000 });
  assert.equal(video.paused, true);
  assert.equal(video.pauses, 1);

  sync.handle({ key: ytKey, position: 100, playing: true, rate: 1.25, at: 10000 });
  assert.equal(video.paused, false);
  assert.equal(video.plays, 1);
});

test('a tab on another film, an ad or a starved element ignores the frame', () => {
  const video = fakeVideo({ currentTime: 10 });
  const sync = new RemoteMediaSync({ document: fakeDoc(video, cleanRoot), href: ytHref, hostname: ytHost, now: () => 10000 });
  assert.equal(sync.handle({ key: 'youtube:other', position: 100, playing: true, at: 10000 }).reason, 'key');
  video.readyState = 1;
  assert.equal(sync.handle({ key: ytKey, position: 100, playing: true, at: 10000 }).skipped, 'buffering');
  video.readyState = 4;
  const adSync = new RemoteMediaSync({ document: fakeDoc(video, adRoot), href: ytHref, hostname: ytHost, now: () => 10000 });
  assert.equal(adSync.handle({ key: ytKey, position: 100, playing: true, at: 10000 }).skipped, 'ad');
  assert.equal(sync.stats.seeks, 0);
});

test('a host ad frame waits instead of moving the film', () => {
  const video = fakeVideo({ currentTime: 50 });
  const sync = new RemoteMediaSync({
    document: fakeDoc(video, cleanRoot),
    href: ytHref,
    hostname: ytHost,
    now: () => 10000,
  });
  const result = sync.handle({ key: ytKey, position: 0, playing: true, ad: true, at: 10000 });
  assert.equal(result.skipped, 'host-ad');
  assert.equal(video.currentTime, 50);
  assert.equal(sync.stats.seeks, 0);
  assert.equal(sync.stats.last, 'host-ad');
});

test('a non-YouTube page names its film by source and skips the ad probe', () => {
  const video = fakeVideo({
    src: 'http://127.0.0.1:8787/media/clip.webm',
    currentTime: 5,
    duration: 60,
  });
  const state = mediaStateFromDocument(fakeDoc(video, adRoot), 'http://127.0.0.1:8787/room.html', '127.0.0.1');
  assert.equal(state.key, 'http://127.0.0.1:8787/media/clip.webm');
  assert.equal(state.ad, false);
});

test('a film key turns back into a page the panel can open', () => {
  assert.equal(filmUrl('youtube:abc123'), 'https://www.youtube.com/watch?v=abc123');
  assert.equal(filmUrl('youtube:'), '');
  assert.equal(
    filmUrl('http://127.0.0.1:8788/media/clip.webm'),
    'http://127.0.0.1:8788/media/clip.webm'
  );
  assert.equal(filmUrl('javascript:alert(1)'), '');
  assert.equal(filmUrl('not a url'), '');
  assert.equal(filmUrl(''), '');
  assert.equal(filmUrl(null), '');
});

test('a viewer state names the gap between the room and this tab', () => {
  const at = 1000;
  const room = {
    key: ytKey,
    position: 20,
    playing: true,
    rate: 1,
    buffering: false,
    ad: false,
    at,
  };
  const local = { ...room, position: 19.5 };
  const near = viewerState(room, local, at);
  assert.equal(near.open, true);
  assert.equal(near.position, 20);
  assert.equal(near.localPosition, 19.5);
  assert.equal(near.behind, 0.5);
  assert.equal(near.inSync, true);

  const far = viewerState(room, { ...local, position: 15 }, at);
  assert.equal(far.behind, 5);
  assert.equal(far.inSync, false);

  // A tab on another film is not a viewer of this one.
  const away = viewerState(room, { ...local, key: 'youtube:other' }, at);
  assert.equal(away.open, false);
  assert.equal(away.localPosition, null);
  assert.equal(away.behind, null);
  assert.equal(away.inSync, null);

  assert.equal(viewerState(room, null, at).open, false);
  assert.equal(viewerState(null, local, at), null);
  assert.equal(viewerState({ key: '' }, local, at), null);
});

test('a starved or ad film shows as a flag on either side of the room', () => {
  const at = 1000;
  const base = { key: ytKey, position: 10, playing: true, buffering: false, ad: false, at };
  assert.equal(viewerState({ ...base, buffering: true }, null, at).buffering, true);
  assert.equal(viewerState({ ...base, ad: true }, null, at).ad, true);
  const local = { ...base, ad: true };
  assert.equal(viewerState(base, local, at).ad, true);
  assert.equal(viewerState(base, local, at).buffering, false);
});

test('the relay cadence matches the host tick', () => {
  assert.equal(RELAY_TICK_MS, 250);
});

test('a page that swaps films in place accepts the new key and refuses the old one', () => {
  const video = fakeVideo({ currentTime: 0, paused: false });
  const doc = fakeDoc(video, cleanRoot);
  doc.location = { href: ytHref, hostname: ytHost };
  const sync = new RemoteMediaSync({
    document: doc,
    href: ytHref,
    hostname: ytHost,
    now: () => 10000,
  });

  // A click on a related video changes the address without a reload. The
  // constructor argument still names the film the tab opened.
  doc.location.href = 'https://www.youtube.com/watch?v=next99';

  const frame = { key: 'youtube:next99', position: 0, playing: true, rate: 1, at: 10000 };
  const accepted = sync.handle(frame);
  assert.equal(accepted.ok, true);
  assert.notEqual(accepted.reason, 'key');

  const stale = sync.handle({ ...frame, key: ytKey });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'key');
});

test('a refused start is retried muted, so a gesture-less tab still plays', async () => {
  const video = fakeVideo({ currentTime: 0, paused: true });
  video.muted = false;
  video.play = function play() {
    if (!this.muted) return Promise.reject(new Error('blocked'));
    this.paused = false;
    this.plays += 1;
    return Promise.resolve();
  };
  const sync = new RemoteMediaSync({
    document: fakeDoc(video, cleanRoot),
    href: ytHref,
    hostname: ytHost,
    now: () => 10000,
  });

  const reply = sync.handle({ key: ytKey, position: 0, playing: true, rate: 1, at: 10000 });
  assert.equal(reply.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(video.muted, true);
  assert.equal(video.paused, false);
  assert.equal(video.plays, 1);
});

test('a local report that stopped stops counting as this tab', () => {
  const live = { key: ytKey, at: 1000 };
  assert.equal(freshState(live, 1000), live);
  assert.equal(freshState(live, 9000), live);
  assert.equal(freshState(live, 9001), null);
  assert.equal(freshState(null, 1000), null);
  assert.equal(freshState({ key: ytKey }, 1000), null);
});

test('the room leaves the viewer volume alone', () => {
  const video = fakeVideo({ currentTime: 0, paused: false, volume: 0.35 });
  const sync = new RemoteMediaSync({
    document: fakeDoc(video, cleanRoot),
    href: ytHref,
    hostname: ytHost,
    now: () => 10000,
  });

  const reply = sync.handle({
    key: ytKey,
    position: 0,
    playing: true,
    rate: 1,
    volume: 0.9,
    at: 10000,
  });

  assert.equal(reply.ok, true);
  assert.equal(video.volume, 0.35, 'the local volume stays where the viewer left it');
});

test('a tab that just joined seeks to the room instead of nudging', () => {
  // A guest that opens the film lands wherever the room is. A gap under one
  // second is a rate nudge for a tab that has been playing, but a fresh tab
  // has no playhead to correct, only a place to start from.
  const video = fakeVideo({ currentTime: 29.4, paused: false });
  const sync = new RemoteMediaSync({
    document: fakeDoc(video, cleanRoot),
    href: ytHref,
    hostname: ytHost,
    now: () => 10000,
  });

  const reply = sync.handle({ key: ytKey, position: 30, playing: true, rate: 1, at: 10000 });
  assert.equal(reply.action, 'seek');
  assert.equal(video.currentTime, 30);
  assert.equal(sync.primed, true);

  // The next frame keeps the room policy, so the same small gap only nudges.
  video.currentTime = 30.6;
  const next = sync.handle({ key: ytKey, position: 30, playing: true, rate: 1, at: 10000 });
  assert.equal(next.action, 'tick');
  assert.ok(video.playbackRate < 1, 'a tab that is ahead slows down instead of seeking');
});
