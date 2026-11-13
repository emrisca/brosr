// The HTMLMediaElement adapter for layer 3. It identifies a player by a key
// derived from its source, so a re-render does not detach the room from it,
// and it never wraps the element in a node of its own.

export const MEDIA_SELECTOR = 'video, audio';

export function mediaKey(element) {
  if (!element) return '';
  const raw = element.currentSrc || element.src || element.getAttribute('src') || '';
  if (!raw) return '';
  try {
    const url = new URL(raw, 'http://localhost/');
    return url.origin + url.pathname;
  } catch {
    return raw;
  }
}

export class MediaAdapter {
  constructor({ root = null, selector = MEDIA_SELECTOR } = {}) {
    this.root = root;
    this.selector = selector;
  }

  elements() {
    const root = this.root || (typeof document === 'undefined' ? null : document);
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return Array.from(root.querySelectorAll(this.selector));
  }

  // A player that carries a duration is the film. A short clip or a hidden
  // element is not.
  pick(key) {
    const all = this.elements();
    if (key) {
      const hit = all.find((element) => mediaKey(element) === key);
      if (hit) return hit;
    }
    return all.find((element) => Number(element.duration) > 1) || all[0] || null;
  }

  state(element) {
    if (!element) return null;
    return {
      key: mediaKey(element),
      position: Number(element.currentTime || 0),
      duration: Number(element.duration || 0),
      playing: !element.paused,
      rate: Number(element.playbackRate || 1),
      volume: Number(element.volume ?? 1),
    };
  }

  apply(element, { action, position, rate, volume } = {}) {
    if (!element) return 'missing';
    if (typeof position === 'number' && action !== 'tick') {
      const max = Number.isFinite(element.duration) ? element.duration : position;
      const target = Math.max(0, Math.min(position, max));
      if (Math.abs(element.currentTime - target) > 0.001) element.currentTime = target;
    }
    if (action === 'play') {
      const started = element.play();
      if (started && typeof started.catch === 'function') started.catch(() => {});
    }
    if (action === 'pause') element.pause();
    if (typeof rate === 'number' && rate > 0 && Math.abs(element.playbackRate - rate) > 0.001) {
      element.playbackRate = rate;
    }
    if (typeof volume === 'number') {
      element.volume = Math.max(0, Math.min(1, volume));
    }
    return 'applied';
  }
}
