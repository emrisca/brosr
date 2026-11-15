import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELAY_TICK_MS,
  RelayMediaAdapter,
  RemoteMediaSync,
  filmUrl,
  freshState,
  isYouTubeHost,
  mediaStateFromDocument,
  projectPosition,
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
} = {}) {
  return {
    src,
    currentSrc: src,
    duration,
    currentTime,
    paused,
    ended: false,
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

test('a small gap gets a rate nudge instead of a seek', () => {
  const video = fakeVideo({ currentTime: 100.5 });
  const sync = new RemoteMediaSync({ document: fakeDoc(video, cleanRoot), href: ytHref, hostname: ytHost, now: () => 10000 });
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
