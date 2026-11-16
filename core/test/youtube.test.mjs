import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AD_CLASS,
  YT_MUSIC_HOST,
  YouTubeAdapter,
  adPlayingFrom,
  hostOf,
  isYouTubeMusic,
  playerKey,
  videoIdOf,
} from '../youtube.mjs';
import { isYouTubeHost, mediaStateFromDocument } from '../media-relay.mjs';

function fakePlayer({
  time = 0,
  duration = 600,
  state = 1,
  rate = 1,
  volume = 100,
} = {}) {
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

test('the key reads a video id from every common URL shape', () => {
  assert.equal(videoIdOf('https://www.youtube.com/watch?v=abc123'), 'abc123');
  assert.equal(videoIdOf('https://youtu.be/xyz789'), 'xyz789');
  assert.equal(videoIdOf('https://www.youtube.com/embed/q1w2'), 'q1w2');
  assert.equal(videoIdOf('https://www.youtube.com/shorts/s9k8'), 's9k8');
  assert.equal(videoIdOf('https://www.youtube.com/feed/subscriptions'), '');
  assert.equal(videoIdOf(''), '');
  assert.equal(playerKey('https://youtu.be/xyz789'), 'youtube:xyz789');
  assert.equal(playerKey('about:blank'), '');
});

test('a YouTube Music track keys on its video id, not the queue', () => {
  const first = 'https://music.youtube.com/watch?v=abc123&list=RDAMVMabc123';
  const second = 'https://music.youtube.com/watch?v=abc123&list=RDAMVMother';
  assert.equal(playerKey(first), 'youtube:abc123');
  assert.equal(playerKey(first), playerKey(second), 'the queue in the address does not split the track');
  assert.equal(playerKey('https://music.youtube.com/watch?v=abc123&t=42'), 'youtube:abc123');
  assert.equal(playerKey('https://music.youtube.com/browse/MPREb'), '', 'a browse page names no track');
});

test('the music host is its own name, and both forms of address agree', () => {
  assert.equal(YT_MUSIC_HOST, 'music.youtube.com');
  assert.equal(isYouTubeMusic('music.youtube.com'), true);
  assert.equal(isYouTubeMusic('https://music.youtube.com/watch?v=abc123'), true);
  assert.equal(isYouTubeMusic('https://www.youtube.com/watch?v=abc123'), false);
  assert.equal(isYouTubeMusic(''), false);
  assert.equal(hostOf('https://music.youtube.com:443/watch'), 'music.youtube.com');
  assert.equal(hostOf('Music.YouTube.com.'), 'music.youtube.com');
  assert.equal(isYouTubeHost('https://music.youtube.com/watch?v=abc123'), true);
  assert.equal(isYouTubeHost('https://notyoutube.com/watch?v=abc123'), false);
});

test('the music host reads a track and its ad from the page element', () => {
  const video = {
    currentSrc: 'blob:https://music.youtube.com/9d0f',
    currentTime: 12.5,
    duration: 210,
    paused: false,
    ended: false,
    playbackRate: 1,
    volume: 0.8,
    readyState: 4,
  };
  const doc = {
    querySelector(selector) {
      if (selector === '#movie_player') return fakeRoot([AD_CLASS]);
      if (selector === 'video.html5-main-video, video') return video;
      return null;
    },
  };
  const state = mediaStateFromDocument(
    doc,
    'https://music.youtube.com/watch?v=abc123&list=RDAMVMabc123',
    'music.youtube.com'
  );
  assert.equal(state.key, 'youtube:abc123', 'the queue and the blob source never name the track');
  assert.equal(state.ad, true, 'the ad class on the player container reaches the room');
  assert.equal(state.playing, true);
  assert.equal(state.position, 12.5);
  assert.equal(state.duration, 210);
});

test('an ad is the player container class and nothing else', () => {
  assert.equal(adPlayingFrom(fakeRoot([AD_CLASS])), true);
  assert.equal(adPlayingFrom(fakeRoot([])), false);
  assert.equal(adPlayingFrom(null), false);
  assert.equal(adPlayingFrom({}), false);
});

test('a state read maps the player scale to the room scale', () => {
  const player = fakePlayer({ time: 91.5, duration: 600, volume: 40 });
  const adapter = new YouTubeAdapter({ player, key: 'youtube:abc123' });
  assert.deepEqual(adapter.state(), {
    key: 'youtube:abc123',
    position: 91.5,
    duration: 600,
    playing: true,
    rate: 1,
    volume: 0.4,
    seeking: false,
    readyState: 4,
  });
  assert.equal(new YouTubeAdapter().state(), null);
  assert.equal(adapter.bufferedAround(), true, 'a player never needs the buffer wait');
});

test('buffering is player state 3, and a queued video is state 5', () => {
  const adapter = new YouTubeAdapter({ player: fakePlayer({ state: 3 }), root: fakeRoot() });
  assert.deepEqual(adapter.flags(), { buffering: true, adPlaying: false });
  adapter.player.state = 5;
  assert.equal(adapter.flags().buffering, true);
  adapter.player.state = 1;
  assert.equal(adapter.flags().buffering, false);
  assert.deepEqual(new YouTubeAdapter().flags(), { buffering: false, adPlaying: false });
});

test('the ad class reaches the flags, so the policy can pause', () => {
  const adapter = new YouTubeAdapter({
    player: fakePlayer(),
    root: fakeRoot([AD_CLASS]),
  });
  assert.deepEqual(adapter.flags(), { buffering: false, adPlaying: true });
});

test('apply seeks, plays, pauses and nudges through the player API', () => {
  const player = fakePlayer({ state: 2 });
  const adapter = new YouTubeAdapter({ player });
  adapter.apply(player, { action: 'seek', position: 42 });
  assert.deepEqual(player.seeks, [42]);
  adapter.apply(player, { action: 'play' });
  assert.equal(player.plays, 1);
  assert.equal(player.state, 1);
  adapter.apply(player, { action: 'pause' });
  assert.equal(player.pauses, 1);
  adapter.apply(player, { action: 'tick', rate: 0.95, volume: 0.5 });
  assert.equal(player.rate, 0.95);
  assert.equal(player.volume, 50, 'volume goes back on the 0 to 100 scale');
  assert.deepEqual(player.seeks, [42], 'a tick never seeks');
  assert.equal(new YouTubeAdapter().apply(null, { action: 'play' }), 'missing');
});

test('a key that names another video is refused', () => {
  const player = fakePlayer();
  const adapter = new YouTubeAdapter({ player, key: 'youtube:abc123' });
  assert.equal(adapter.pick('youtube:abc123').player, player, 'the view names the player');
  assert.equal(adapter.pick('youtube:other'), null);
  assert.equal(new YouTubeAdapter().pick('youtube:abc123'), null);
});
