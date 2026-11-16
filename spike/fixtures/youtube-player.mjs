// A fake IFrame API player for the YouTube fixture.
//
// The real player is a YouTube object with none of the element fields an
// HTMLMediaElement has. This file gives a page that object, so the adapter path
// in core/youtube.mjs can run in a browser with no network and no YouTube.
//
// The page loads this file as a module. Node imports the same file from
// spike/youtube-player.test.mjs, so one player drives both.

export const AD_CLASS = 'ad-showing';

export function createPlayer({ time = 0, duration = 2400, volume = 100 } = {}) {
  return {
    time,
    duration,
    rate: 1,
    volume,
    // 2 is paused, so the room starts the player rather than the reverse.
    state: 2,
    seeks: [],
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
      this.time = Math.max(0, Math.min(Number(seconds) || 0, this.duration));
      this.seeks.push(this.time);
    },
    playVideo() {
      this.state = 1;
    },
    pauseVideo() {
      this.state = 2;
    },
    setPlaybackRate(next) {
      this.rate = Number(next) || 1;
    },
    setVolume(next) {
      this.volume = Math.max(0, Math.min(100, Number(next) || 0));
    },
  };
}

const LABELS = ['paused', 'playing', 'paused', 'buffering', 'cued', 'cued'];

function wire() {
  const root = document.getElementById('movie_player');
  const status = document.getElementById('state');
  const player = createPlayer();
  window.__brosrYouTubePlayer = player;

  // The playhead advances while the player plays, so the room has real drift.
  setInterval(() => {
    if (player.state !== 1) return;
    player.time = Math.min(player.duration, player.time + 1);
    if (player.time >= player.duration) player.state = 2;
  }, 1000);

  setInterval(() => {
    const raw = document.documentElement.dataset.brosr;
    const room = raw ? JSON.parse(raw) : null;
    const roomPosition = room ? Number(room.position) : null;
    status.textContent =
      'player time: ' + player.time.toFixed(1) + ' s\n' +
      'duration: ' + player.duration.toFixed(0) + ' s\n' +
      'player state: ' + LABELS[player.state] + '\n' +
      'seeks: ' + player.seeks.length +
      (player.seeks.length ? ' to ' + player.seeks[player.seeks.length - 1].toFixed(1) : '') + '\n' +
      'ad: ' + (root.classList.contains(AD_CLASS) ? 'on' : 'off') + '\n' +
      '--- room ---\n' +
      'source: ' + (room ? room.source : 'none') + '\n' +
      'key: ' + (room ? room.key || 'none' : 'none') + '\n' +
      'room position: ' + (roomPosition === null ? 'none' : roomPosition.toFixed(1) + ' s') + '\n' +
      'drift samples: ' + (room ? room.samples.length : 0) + '\n' +
      'seeks by the room: ' + (room ? room.seeks : 0) + ', nudges: ' + (room ? room.nudges : 0) + '\n' +
      'corrections: ' + (room ? room.corrections : 0) + ', stuck: ' + (room ? room.stuckSeeks : 0);
  }, 250);

  document.getElementById('play').addEventListener('click', () => player.playVideo());
  document.getElementById('pause').addEventListener('click', () => player.pauseVideo());
  document.getElementById('seek').addEventListener('click', () => player.seekTo(1200));
  document.getElementById('ad').addEventListener('click', () => {
    root.classList.toggle(AD_CLASS);
  });
}

if (typeof document !== 'undefined') wire();
