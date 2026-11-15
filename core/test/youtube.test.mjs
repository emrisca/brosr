import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AD_CLASS,
  YouTubeAdapter,
  adPlayingFrom,
  playerKey,
  videoIdOf,
} from '../youtube.mjs';

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
