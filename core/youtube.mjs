// The YouTube adapter for layer 3. The IFrame API player holds no element that
// querySelectorAll can find, so the adapter talks to the player object itself.
// The interface matches MediaAdapter, and the room does not know which one runs.
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
  }

  elements() {
    return this.player ? [this.player] : [];
  }

  pick(key) {
    if (!this.player) return null;
    if (key && this.key && key !== this.key) return null;
    return this.player;
  }

  state(player = this.player) {
    if (!player) return null;
    return {
      key: this.key,
      position: Number(player.getCurrentTime() || 0),
      duration: Number(player.getDuration() || 0),
      playing: player.getPlayerState() === 1,
      rate: Number(player.getPlaybackRate() || 1),
      // The IFrame API reports volume from 0 to 100, and the room uses 0 to 1.
      volume: Number(player.getVolume() ?? 100) / 100,
    };
  }

  // State 3 is buffering. State 5 is a queued video that has not started.
  flags(player = this.player, { root = this.root } = {}) {
    const state = player ? player.getPlayerState() : -1;
    return {
      buffering: state === 3 || state === 5,
      adPlaying: adPlayingFrom(root),
    };
  }

  apply(player = this.player, { action, position, rate, volume } = {}) {
    if (!player) return 'missing';
    if (typeof position === 'number' && action !== 'tick') {
      const time = Number(player.getCurrentTime() || 0);
      if (Math.abs(time - position) > 0.05) player.seekTo(position, true);
    }
    if (action === 'play' && player.getPlayerState() !== 1) player.playVideo();
    if (action === 'pause' && player.getPlayerState() === 1) player.pauseVideo();
    if (typeof rate === 'number' && rate > 0 && Math.abs(player.getPlaybackRate() - rate) > 0.001) {
      player.setPlaybackRate(rate);
    }
    if (typeof volume === 'number') {
      player.setVolume(Math.round(Math.max(0, Math.min(1, volume)) * 100));
    }
    return 'applied';
  }
}
