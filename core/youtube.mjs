// The YouTube adapter for layer 3. The IFrame API player holds no element that
// querySelectorAll can find, so the adapter talks to the player object itself.
// The interface matches MediaAdapter, and the room does not know which one runs.
//
// The room reads element fields on whatever pick returns, and a player object
// has none of them. So pick returns a view with those fields, and every method
// takes the player, the view, or nothing.
//
// An ad has no field in the IFrame API. The player page marks it with a class
// on the player container, so the adapter reads that class and nothing else.

export const AD_CLASS = 'ad-showing';
export const YT_ORIGIN = 'https://www.youtube.com';

// A key survives a re-render and names the film, not the page.
export function videoIdOf(url) {
  if (!url) return '';
  const raw = String(url);
  try {
    const parsed = new URL(raw, YT_ORIGIN);
    if (parsed.hostname.endsWith('youtu.be')) {
      return parsed.pathname.split('/').filter(Boolean)[0] || '';
    }
    const fromQuery = parsed.searchParams.get('v');
    if (fromQuery) return fromQuery;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') {
      return parts[1] || '';
    }
    return '';
  } catch {
    return '';
  }
}

export function playerKey(url) {
  const id = videoIdOf(url);
  return id ? `youtube:${id}` : '';
}

// Ads run inside the same player, so the container class is the only signal.
export function adPlayingFrom(root) {
  if (!root || !root.classList || typeof root.classList.contains !== 'function') return false;
  return root.classList.contains(AD_CLASS);
}

export class YouTubeAdapter {
  constructor({ player = null, root = null, key = '' } = {}) {
    this.player = player;
    this.root = root;
    this.key = key;
    this.handle = null;
  }

  // A call may pass the player, the view, or nothing. All three name the same
  // player, so the tests and the room can each use the shape they have.
  playerOf(handle) {
    if (handle && handle.adapter === this) return this.player;
    return handle || this.player;
  }

  elements() {
    return this.player ? [this.view()] : [];
  }

  pick(key) {
    if (!this.player) return null;
    if (key && this.key && key !== this.key) return null;
    return this.view();
  }

  // The room reads currentTime, duration, paused, seeking, readyState and
  // playbackRate, and it writes currentTime and calls play and pause. The view
  // gives the player that shape, so one peer path serves both adapters.
  view() {
    if (this.handle) return this.handle;
    const adapter = this;
    const read = () => adapter.state(null);
    this.handle = {
      adapter,
      player: this.player,
      get currentTime() {
        const state = read();
        return state ? state.position : 0;
      },
      set currentTime(seconds) {
        adapter.apply(null, { action: 'seek', position: Number(seconds) || 0 });
      },
      get duration() {
        const state = read();
        return state ? state.duration : 0;
      },
      get paused() {
        // A player that is buffering is not paused, so the room has to pause it.
        return adapter.player ? adapter.player.getPlayerState() === 2 : true;
      },
      // The IFrame API reports no seek flag, so a seek here never wedges.
      seeking: false,
      get readyState() {
        return adapter.flags(null).buffering ? 1 : 4;
      },
      get playbackRate() {
        const state = read();
        return state ? state.rate : 1;
      },
      set playbackRate(rate) {
        adapter.apply(null, { action: 'tick', rate: Number(rate) || 1 });
      },
      play() {
        return adapter.apply(null, { action: 'play' });
      },
      pause() {
        return adapter.apply(null, { action: 'pause' });
      },
    };
    return this.handle;
  }

  state(handle = this.player) {
    const player = this.playerOf(handle);
    if (!player) return null;
    const status = player.getPlayerState();
    return {
      key: this.key,
      position: Number(player.getCurrentTime() || 0),
      duration: Number(player.getDuration() || 0),
      playing: status === 1,
      rate: Number(player.getPlaybackRate() || 1),
      // The IFrame API reports volume from 0 to 100, and the room uses 0 to 1.
      volume: Number(player.getVolume() ?? 100) / 100,
      // The API reports no seek, so this adapter never wedges on one. A
      // buffering player reads as starved, so the room waits instead of
      // chasing a position that cannot move.
      seeking: false,
      readyState: status === 3 || status === 5 ? 1 : 4,
    };
  }

  // A player fetches the data it needs, so no seek can land outside a buffer.
  bufferedAround() {
    return true;
  }

  // State 3 is buffering. State 5 is a queued video that has not started.
  flags(handle = this.player, { root = this.root } = {}) {
    const player = this.playerOf(handle);
    const state = player ? player.getPlayerState() : -1;
    return {
      buffering: state === 3 || state === 5,
      adPlaying: adPlayingFrom(root),
    };
  }

  apply(handle = this.player, { action, position, rate, volume } = {}) {
    const player = this.playerOf(handle);
    if (!player) return 'missing';
    if (typeof position === 'number' && action !== 'tick') {
      const time = Number(player.getCurrentTime() || 0);
      if (Math.abs(time - position) > 0.05) player.seekTo(position, true);
    }
    if (action === 'play' && player.getPlayerState() !== 1) player.playVideo();
    // A buffering player (state 3) is not paused, so a pause has to stop it.
    const state = player.getPlayerState();
    if (action === 'pause' && (state === 1 || state === 3)) player.pauseVideo();
    if (typeof rate === 'number' && rate > 0 && Math.abs(player.getPlaybackRate() - rate) > 0.001) {
      player.setPlaybackRate(rate);
    }
    if (typeof volume === 'number') {
      player.setVolume(Math.round(Math.max(0, Math.min(1, volume)) * 100));
    }
    return 'applied';
  }
}
