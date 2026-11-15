// Playback relay. A room tab usually shows the room page, not the film. The
// tab that does show it samples its own player and hands the state here, so
// the room can drive every other tab without a page script.
//
// Three small pieces live here:
//   mediaStateFromDocument  reads the element a tab already has
//   RelayMediaAdapter       gives the room a player shape over the latest state
//   RemoteMediaSync         applies the room anchor to a tab's own element
//
// The room keeps its own drift policy. This file uses a plain tolerance, so a
// tab that shows the film stays near the host without a second seek loop.

import { mediaKey } from './media.mjs';
import { adPlayingFrom, playerKey } from './youtube.mjs';

// The room samples its own media at the host tick rate. A tab uses the same
// rate, so one hop never adds more than one tick of lag.
export const RELAY_TICK_MS = 250;
// A gap this large is a seek. A smaller gap is a rate nudge.
export const RELAY_DRIFT_SECONDS = 1;
export const RELAY_NUDGE_SECONDS = 0.25;
// A seek takes a moment to land. Another one before it lands fights the first.
export const RELAY_SEEK_SETTLE_MS = 700;
export const RELAY_NUDGE_RATE = 1.05;

const YT_HOST = /(^|\.)(youtube\.com|youtu\.be)$/i;
const VIDEO_SELECTOR = 'video.html5-main-video, video';
const AD_ROOT = '#movie_player';

export function isYouTubeHost(hostname = '') {
  return YT_HOST.test(String(hostname));
}

// A tab reads the element the site already plays. YouTube marks an ad on the
// player container, and the element itself carries no field for one.
export function mediaStateFromDocument(
  doc = typeof document === 'undefined' ? null : document,
  href = '',
  hostname = ''
) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  const video = doc.querySelector(VIDEO_SELECTOR);
  if (!video) return null;
  const yt = isYouTubeHost(hostname || href);
  const key = yt ? playerKey(href) : mediaKey(video);
  if (!key) return null;
  return {
    key,
    position: Number(video.currentTime || 0),
    duration: Number(video.duration || 0),
    playing: !video.paused && !video.ended,
    rate: Number(video.playbackRate || 1),
    volume: Number(video.volume ?? 1),
    buffering: Number(video.readyState ?? 0) < 2,
    ad: yt ? adPlayingFrom(doc.querySelector(AD_ROOT)) : false,
    at: Date.now(),
  };
}

// A state that is playing moves on its own. A paused, starved or ad state
// stays where it was written.
export function projectPosition(state, now = Date.now()) {
  if (!state) return 0;
  if (!state.playing || state.buffering || state.ad) return Number(state.position || 0);
  const age = Math.max(0, Number(now) - Number(state.at || now)) / 1000;
  return Number(state.position || 0) + age * Number(state.rate || 1);
}

// A tab reports its own film every tick. A report that stopped is a closed tab
// or a paused sampler, and projecting from it would invent a gap that grows on
// its own. A stale copy reads as no copy.
export const RELAY_STALE_MS = 8000;

export function freshState(state, now = Date.now(), staleMs = RELAY_STALE_MS) {
  if (!state || typeof state !== 'object') return null;
  const at = Number(state.at);
  if (!Number.isFinite(at)) return null;
  return now - at > staleMs ? null : state;
}

function clamp(value, max) {
  return Math.max(0, Number.isFinite(max) && max > 0 ? Math.min(value, max) : value);
}

// A room names a film by key. The panel opens a page for it, so the key turns
// back into a URL. A YouTube key carries the id, and a site key is the page.
export function filmUrl(key) {
  const text = String(key || '');
  if (!text) return '';
  if (text.startsWith('youtube:')) {
    const id = text.slice('youtube:'.length);
    return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : '';
  }
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : '';
  } catch {
    return '';
  }
}

// The panel reads one film state: where the room says the film is, where this
// browser's own tab has it, and the gap between the two. A viewer with no tab
// on that film still sees the room position, and the panel offers to open it.
export function viewerState(room, local, now = Date.now()) {
  if (!room || !room.key) return null;
  const position = projectPosition(room, now);
  const open = Boolean(local && local.key === room.key);
  const localPosition = open ? projectPosition(local, now) : null;
  const behind = open ? Math.round((position - localPosition) * 1000) / 1000 : null;
  return {
    key: room.key,
    position,
    playing: Boolean(room.playing),
    buffering: Boolean(room.buffering || (open && local.buffering)),
    ad: Boolean(room.ad || (open && local.ad)),
    open,
    localPosition,
    behind,
    inSync: open ? Math.abs(behind) <= 1 : null,
  };
}

// The room reads and writes a player through this shape. On the host side it
// only reads, because the room sends the state out and never seeks its source.
export class RelayMediaAdapter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.latest = null;
    this.handle = null;
  }

  set(state) {
    if (!state || typeof state !== 'object' || !state.key) return false;
    this.latest = { ...state, at: Number(state.at || this.now()) };
    return true;
  }

  clear() {
    this.latest = null;
  }

  get key() {
    return this.latest ? this.latest.key : '';
  }

  elements() {
    return this.latest ? [this.view()] : [];
  }

  pick(key) {
    if (!this.latest) return null;
    if (key && key !== this.latest.key) return null;
    return this.view();
  }

  state() {
    const latest = this.latest;
    if (!latest) return null;
    return {
      key: latest.key,
      position: projectPosition(latest, this.now()),
      duration: Number(latest.duration || 0),
      playing: Boolean(latest.playing),
      rate: Number(latest.rate || 1),
      volume: Number(latest.volume ?? 1),
    };
  }

  flags() {
    const latest = this.latest;
    return {
      buffering: Boolean(latest && latest.buffering),
      adPlaying: Boolean(latest && latest.ad),
    };
  }

  // A view gives the room the element fields it reads. A write updates the
  // relayed state, so the next host tick carries it out.
  view() {
    if (this.handle) return this.handle;
    const adapter = this;
    const read = () => adapter.state();
    const spot = () => adapter.latest;
    this.handle = {
      adapter,
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
        const state = read();
        return state ? !state.playing : true;
      },
      seeking: false,
      get readyState() {
        return adapter.flags().buffering ? 1 : 4;
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

  apply(handle, { action, position, rate, volume } = {}) {
    const latest = this.latest;
    if (!latest) return 'missing';
    if (typeof position === 'number' && action !== 'tick') {
      latest.position = Number(position) || 0;
      latest.at = this.now();
    }
    if (action === 'play') {
      latest.playing = true;
      latest.at = this.now();
    }
    if (action === 'pause') {
      latest.playing = false;
      latest.at = this.now();
    }
    if (typeof rate === 'number' && rate > 0) latest.rate = rate;
    if (typeof volume === 'number') latest.volume = Math.max(0, Math.min(1, volume));
    return 'applied';
  }
}

// A tab that shows the film applies the room anchor to its own element. The
// anchor is the expected position at the moment the room forwarded it, so the
// tab only adds the time since then.
export class RemoteMediaSync {
  constructor({
    document: doc = typeof document === 'undefined' ? null : document,
    href = typeof location === 'undefined' ? '' : location.href,
    hostname = typeof location === 'undefined' ? '' : location.hostname,
    now = () => Date.now(),
  } = {}) {
    this.doc = doc;
    this.href = href;
    this.hostname = hostname;
    this.now = now;
    this.lastSeekAt = -Infinity;
    this.stats = { applied: 0, seeks: 0, skips: 0, last: null };
  }

  video() {
    if (!this.doc || typeof this.doc.querySelector !== 'function') return null;
    return this.doc.querySelector(VIDEO_SELECTOR);
  }

  // A video site swaps the film without a reload. The address the caller
  // passed is the one it started on, so the live document wins when it has one.
  // Otherwise the tab announces a new key and then refuses every frame for it.
  pageHref() {
    const live = this.doc && this.doc.location ? this.doc.location.href : '';
    return live || this.href;
  }

  pageHostname() {
    const live = this.doc && this.doc.location ? this.doc.location.hostname : '';
    return live || this.hostname;
  }

  handle(frame) {
    const now = this.now();
    const video = this.video();
    if (!video || !frame || !frame.key) return { ok: false, reason: 'no-video' };
    const yt = isYouTubeHost(this.pageHostname());
    const ownKey = yt ? playerKey(this.pageHref()) : mediaKey(video);
    if (frame.key !== ownKey) return { ok: false, reason: 'key' };
    const ad = yt ? adPlayingFrom(this.doc.querySelector(AD_ROOT)) : false;
    if (ad || Number(video.readyState ?? 0) < 2) {
      this.stats.skips += 1;
      const skipped = ad ? 'ad' : 'buffering';
      this.stats.last = skipped;
      return { ok: true, skipped };
    }

    const age = Math.max(0, now - Number(frame.at || now)) / 1000;
    const ahead = frame.playing ? age * Number(frame.rate || 1) : 0;
    const expected = clamp(
      Number(frame.position || 0) + ahead,
      Number(video.duration)
    );
    const actual = Number(video.currentTime || 0);
    const drift = actual - expected;

    if (Math.abs(drift) > RELAY_DRIFT_SECONDS && now - this.lastSeekAt > RELAY_SEEK_SETTLE_MS) {
      video.currentTime = expected;
      this.lastSeekAt = now;
      this.stats.seeks += 1;
      this.stats.applied += 1;
      this.stats.last = 'seek';
      return { ok: true, action: 'seek', drift: Math.round(drift * 1000) / 1000 };
    }

    const rate = Number(frame.rate || 1);
    if (Math.abs(drift) > RELAY_NUDGE_SECONDS) {
      const nudge = drift < 0 ? rate * RELAY_NUDGE_RATE : rate / RELAY_NUDGE_RATE;
      if (Math.abs(Number(video.playbackRate || 1) - nudge) > 0.001) video.playbackRate = nudge;
    } else if (Math.abs(Number(video.playbackRate || 1) - rate) > 0.001) {
      video.playbackRate = rate;
    }

    // The room leaves the viewer volume alone. A shared playhead does not need
    // a shared volume, and one viewer's headphones are not another's.
    if (frame.playing && video.paused) {
      const started = video.play();
      if (started && typeof started.catch === 'function') {
        // A tab the room opened has no gesture of its own, so the browser can
        // refuse an unmuted start. Muting is the retry that works, and the
        // viewer can raise the volume again.
        started.catch(() => {
          video.muted = true;
          const retry = video.play();
          if (retry && typeof retry.catch === 'function') retry.catch(() => {});
        });
      }
    }
    if (!frame.playing && !video.paused) video.pause();

    this.stats.applied += 1;
    this.stats.last = 'tick';
    return { ok: true, action: 'tick', drift: Math.round(drift * 1000) / 1000 };
  }
}
