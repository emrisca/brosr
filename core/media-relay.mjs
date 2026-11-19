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

import { bufferedAround, mediaKey } from './media.mjs';
import { adPlayingFrom, hostOf, isYouTubeMusic, playerKey } from './youtube.mjs';

// The room samples its own media at the host tick rate. A tab uses the same
// rate, so one hop never adds more than one tick of lag.
export const RELAY_TICK_MS = 250;
// A gap this large is a seek. A smaller gap is a rate nudge.
export const RELAY_DRIFT_SECONDS = 1;
export const RELAY_NUDGE_SECONDS = 0.25;
// A seek takes a moment to land. Another one before it lands fights the first.
export const RELAY_SEEK_SETTLE_MS = 700;
// A seek into data the player has not fetched can wedge the element. Wait for
// the range to arrive, then seek anyway so a big gap is never held forever.
export const RELAY_BUFFER_WAIT_MS = 2500;
// A paused or unbuffered element can hold a seek open. The drift then stays
// large, so the seek branch would win every tick and the film would sit at the
// old point for the whole room. A fresh seek is what frees it.
export const RELAY_SEEK_TIMEOUT_MS = 8000;
export const RELAY_NUDGE_RATE = 1.05;
// The report keeps the recent shape of a stall without growing for a long
// session. Five entries are enough to see whether a problem is repeating; the
// full session totals stay in stats.
const RELAY_HISTORY_LIMIT = 8;

// This covers `youtube.com`, `www.youtube.com` and `music.youtube.com`. The
// music host keeps its track in the same `v` parameter, so one checker serves
// both and the key stays a video id.
const YT_HOST = /(^|\.)(youtube\.com|youtu\.be)$/i;
const VIDEO_SELECTOR = 'video.html5-main-video, video';
const AD_ROOT = '#movie_player';

export function isYouTubeHost(value = '') {
  return YT_HOST.test(hostOf(value));
}

// Cinecat plays a normal HTML5 player, but its title page can put that player
// inside a provider frame. The frame URL names the provider, while the title
// page names the film. A Cinecat watch page is the film key when the browser
// sends it as the frame's referrer.
export const CINECAT_HOST = 'cinecat.eu';
export const CINECAT_WATCH_PATH = /^\/(?:media|tv\/watch)\/[^/]+(?:\/[^/]+\/[^/]+)?\/?$/;

export function isCinecatHost(value = '') {
  return /(^|\.)cinecat\.eu$/i.test(hostOf(value));
}

// The panel reads one film tab. A browser can hold several copies, so pick one
// owner before asking: the focused film first, then the most recently active
// one. One request and one answer, not a race between every tab.
export function chooseFilmOwner(entries = [], key = '', focusTabId = null) {
  const candidates = [...entries].filter(([, entry]) => entry && entry.key === key);
  if (!candidates.length) return null;
  const focused = candidates.find(
    ([id]) => focusTabId !== null && String(id) === String(focusTabId)
  );
  if (focused) return focused;
  return candidates.sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))[0];
}

export function isCinecatWatchPage(value = '') {
  try {
    const url = new URL(String(value || ''));
    return isCinecatHost(url.hostname) && CINECAT_WATCH_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

// A Cinecat player frame reports the title page that owns it, not the provider
// URL inside the frame. A missing or non-watch referrer keeps the frame URL,
// so a normal embedded player still works the way it did before.
export function framePageHref({ href = '', referrer = '', embedded = false } = {}) {
  if (!embedded) return href;
  return isCinecatWatchPage(referrer) ? referrer : href;
}

// A site player often hides its film behind a blob URL, a media source or an
// HLS manifest. Both viewers load the same page, so the page names the film.
export const PAGE_KEY_PREFIX = 'page:';

const PAGE_BOUND_SOURCE = /^(blob:|data:|mediasource:)/i;
const MANIFEST_SOURCE = /\.(m3u8|mpd)(?:[?#]|$)/i;

// A source that cannot name a film on its own still needs a stable key.
export function isPageBoundSource(raw) {
  const text = String(raw || '');
  return !text || PAGE_BOUND_SOURCE.test(text) || MANIFEST_SOURCE.test(text);
}

// The key names the page and drops the query and the fragment, so a time stamp
// or a token in the address does not split one film into two keys.
export function pageKey(href) {
  const text = String(href || '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return PAGE_KEY_PREFIX + url.origin + url.pathname;
  } catch {
    return '';
  }
}

// A plain file URL names its own film, so two pages that share a clip stay on
// that clip. Everything else falls back to the page that holds the player.
export function mediaKeyFor(element, { pageUrl = '' } = {}) {
  const raw = element ? element.currentSrc || element.src || '' : '';
  if (isPageBoundSource(raw)) {
    const named = pageKey(pageUrl);
    if (named) return named;
  }
  return mediaKey(element) || pageKey(pageUrl);
}

// A player page names its own track. The media session carries the cleanest
// copy, and the document title is the fallback. YouTube appends its own name to
// that title, so the tail is dropped before it reaches a room.
const TITLE_TAIL = /\s*[-|·]\s*YouTube( Music)?\s*$/i;

export function mediaTitle(doc) {
  if (!doc) return '';
  let raw = '';
  try {
    const meta = doc.mediaSession && doc.mediaSession.metadata;
    if (meta && meta.title) {
      raw = meta.artist ? String(meta.title) + ' · ' + String(meta.artist) : String(meta.title);
    }
  } catch {
    raw = '';
  }
  if (!raw) raw = String(doc.title || '');
  return raw.replace(TITLE_TAIL, '').trim().slice(0, 120);
}

// A tab reads the element the site already plays. YouTube marks an ad on the
// player container, and the element itself carries no field for one.
export function mediaStateFromDocument(
  doc = typeof document === 'undefined' ? null : document,
  href = '',
  hostname = '',
  { rate = null } = {}
) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  const video = doc.querySelector(VIDEO_SELECTOR);
  if (!video) return null;
  const yt = isYouTubeHost(hostname || href);
  const music = yt && isYouTubeMusic(hostname || href);
  const key = yt ? playerKey(href) : mediaKeyFor(video, { pageUrl: href });
  if (!key) return null;
  return {
    key,
    position: Number(video.currentTime || 0),
    duration: Number(video.duration || 0),
    playing: !video.paused && !video.ended,
    // A tab that follows the room runs a temporary nudge. The report names the
    // room rate when the caller knows it, or every hop divides that nudge
    // again and the film sinks into slow motion for the rest of the session.
    rate:
      Number.isFinite(Number(rate)) && Number(rate) > 0
        ? Number(rate)
        : Number(video.playbackRate || 1),
    volume: Number(video.volume ?? 1),
    buffering: Number(video.readyState ?? 0) < 2,
    ad: yt ? adPlayingFrom(doc.querySelector(AD_ROOT)) : false,
    // A music host reports the track name and the host kind, so a room tile can
    // say what is playing instead of showing a fixed label.
    music,
    title: yt ? mediaTitle(doc) : '',
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

// A hold is carried by a single frame, and that frame can be lost. The source
// that stuttered normally sends the release, but a peer that just lost control
// cannot send anything, and a room tab that restarted forgot the hold it was
// carrying. A tab that waits forever for a release freezes the film for the
// rest of the session, so a hold also expires on its own.
export const RELAY_HOLD_MAX_MS = 15000;

// A frame this tab applies changes its player, and the player then emits the
// action it was told to perform. Only that action is an echo. A blanket window
// around every correction swallowed a real pause or seek made just after the
// room moved the film.
export const MEDIA_ECHO_MS = 600;

export function remoteMediaEcho(result, previous, frame, at = Date.now()) {
  if (!result || !frame) return null;
  const actions = new Set();
  if (result.skipped === 'buffer' || result.action === 'hold') actions.add('pause');
  if (result.action === 'seek' || result.action === 'seek-retry') actions.add('seek');
  if (result.ok && !result.skipped) {
    const changed =
      !previous ||
      previous.key !== frame.key ||
      Boolean(previous.playing) !== Boolean(frame.playing);
    if (changed) actions.add(frame.playing ? 'play' : 'pause');
  }
  return actions.size ? { actions: [...actions], at } : null;
}

export function mediaEchoMatches(echo, action, now = Date.now()) {
  if (!echo || !Array.isArray(echo.actions) || !echo.actions.includes(action)) return false;
  return now - echo.at < MEDIA_ECHO_MS;
}

export function freshState(state, now = Date.now(), staleMs = RELAY_STALE_MS) {
  if (!state || typeof state !== 'object') return null;
  const at = Number(state.at);
  if (!Number.isFinite(at)) return null;
  return now - at > staleMs ? null : state;
}

function clamp(value, max) {
  return Math.max(0, Number.isFinite(max) && max > 0 ? Math.min(value, max) : value);
}

// A tab the room opened has no gesture of its own, so the browser can refuse an
// unmuted start. Muting is the retry that works, and the viewer can raise the
// volume again.
function startPlayback(video) {
  const started = video.play();
  if (started && typeof started.catch === 'function') {
    started.catch(() => {
      video.muted = true;
      const retry = video.play();
      if (retry && typeof retry.catch === 'function') retry.catch(() => {});
    });
  }
}

// A room names a film by key. The panel opens a page for it, so the key turns
// back into a URL. A YouTube key carries the id, and a site key is the page.
export function filmUrl(key) {
  const text = String(key || '');
  if (!text) return '';
  if (text.startsWith(PAGE_KEY_PREFIX)) {
    const rest = text.slice(PAGE_KEY_PREFIX.length);
    try {
      const url = new URL(rest);
      return url.protocol === 'http:' || url.protocol === 'https:' ? rest : '';
    } catch {
      return '';
    }
  }
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
    title: String(room.title || ''),
    music: Boolean(room.music),
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
      title: String(latest.title || ''),
      music: Boolean(latest.music),
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
    pageHref = null,
    now = () => Date.now(),
  } = {}) {
    this.doc = doc;
    this.href = href;
    this.hostname = hostname;
    this.pageHrefFn = typeof pageHref === 'function' ? pageHref : null;
    this.now = now;
    this.lastSeekAt = -Infinity;
    this.seekIssuedAt = -Infinity;
    this.lastSeekTarget = null;
    // The first tick that wanted a seek outside the buffered range. The wait
    // has a deadline, so a player that never fetches still catches up.
    this.waitingSince = null;
    // The film is paused while it waits. Without this flag the next room tick
    // would start it again and the tab would play and pause on every tick.
    this.bufferHeld = false;
    // The target last checked against the buffered ranges. The room moves on
    // while the tab waits, so this follows the current expected point.
    this.waitingTarget = null;
    // A hold can outlive the buffer deadline. The wait then reports recovery so
    // the room releases, and this flag makes the release frame seek at once
    // instead of starting another wait.
    this.bufferReady = false;
    // A tab that has never applied a frame has no position of its own. Its
    // first frame seeds the player, so it seeks rather than nudges.
    this.primed = false;
    // The rate the room asked for. A nudge is this tab's own correction, so it
    // never becomes the rate this tab reports back to the room.
    this.roomRate = null;
    // A room hold pauses the film until the source that stuttered is ready.
    // Without this flag a routine host tick would start it again underneath
    // the hold.
    this.held = false;
    this.heldAt = 0;
    this.stats = {
      applied: 0,
      seeks: 0,
      skips: 0,
      stuckSeeks: 0,
      bufferWaits: 0,
      bufferHolds: 0,
      holds: 0,
      expiredHolds: 0,
      last: null,
    };
    // The report needs the path, not only the totals: which point was wanted,
    // how long the wait lasted, and whether the hold released or expired.
    this.history = { seeks: [], buffers: [], holds: [] };
    this.bufferWait = null;
    this.holdEvent = null;
  }

  recordEvent(kind, event) {
    const list = this.history[kind];
    if (!list) return event;
    list.push(event);
    if (list.length > RELAY_HISTORY_LIMIT) list.shift();
    return event;
  }

  // The room rate this tab follows, or null before the first frame. A report
  // built from the element would carry a nudge back out, and each hop would
  // divide it again, which is the slow motion that grew with the session.
  reportedRate() {
    return this.roomRate;
  }

  historyView() {
    const copy = (list) => list.map((event) => ({ ...event }));
    return {
      seeks: copy(this.history.seeks),
      buffers: copy(this.history.buffers),
      holds: copy(this.history.holds),
    };
  }

  beginBufferWait(now, target) {
    this.waitingSince = now;
    this.stats.bufferWaits += 1;
    this.bufferWait = this.recordEvent('buffers', {
      at: now,
      target: Math.round(Number(target || 0) * 1000) / 1000,
      resolvedAt: null,
      outcome: null,
    });
  }

  finishBufferWait(now, outcome) {
    if (!this.bufferWait) return;
    const event = this.bufferWait;
    event.resolvedAt = now;
    event.outcome = outcome;
    event.durationMs = Math.max(0, Math.round(now - Number(event.at || now)));
    this.bufferWait = null;
  }

  beginHold(now, frame) {
    this.holdEvent = this.recordEvent('holds', {
      at: now,
      position: Math.round(Number(frame.position || 0) * 1000) / 1000,
      playing: Boolean(frame.playing),
      releasedAt: null,
      outcome: null,
    });
  }

  finishHold(now, outcome) {
    if (!this.holdEvent) return;
    const event = this.holdEvent;
    event.releasedAt = now;
    event.outcome = outcome;
    event.durationMs = Math.max(0, Math.round(now - Number(event.at || now)));
    this.holdEvent = null;
  }

  recordSeek(now, target, kind) {
    this.recordEvent('seeks', {
      at: now,
      target: Math.round(Number(target || 0) * 1000) / 1000,
      kind,
    });
  }

  video() {
    if (!this.doc || typeof this.doc.querySelector !== 'function') return null;
    return this.doc.querySelector(VIDEO_SELECTOR);
  }

  // A video site swaps the film without a reload. The address the caller
  // passed is the one it started on, so the live document wins when it has one.
  // Otherwise the tab announces a new key and then refuses every frame for it.
  pageHref() {
    if (this.pageHrefFn) return this.pageHrefFn();
    const live = this.doc && this.doc.location ? this.doc.location.href : '';
    return live || this.href;
  }

  pageHostname() {
    const live = this.doc && this.doc.location ? this.doc.location.hostname : '';
    return live || this.hostname;
  }

  // A report asks whether the film is still waiting for data. The answer
  // clears the wait when the range arrives or the deadline passes, so a room
  // hold can release even when the film tab receives no further frames. The
  // player stays paused until the release frame carries the seek.
  bufferWaitActive(now = this.now()) {
    if (this.waitingSince === null) return false;
    const video = this.video();
    const target = Number(this.waitingTarget);
    const ready =
      Number.isFinite(target) && video ? bufferedAround(video, target) : false;
    if (ready || now - this.waitingSince >= RELAY_BUFFER_WAIT_MS) {
      this.finishBufferWait(now, ready ? 'ready' : 'deadline');
      this.waitingSince = null;
      this.waitingTarget = null;
      this.bufferReady = true;
      return false;
    }
    return true;
  }

  handle(frame) {
    const now = this.now();
    const video = this.video();
    if (!video || !frame || !frame.key) return { ok: false, reason: 'no-video' };
    const yt = isYouTubeHost(this.pageHostname());
    const ownKey = yt ? playerKey(this.pageHref()) : mediaKeyFor(video, { pageUrl: this.pageHref() });
    if (frame.key !== ownKey) return { ok: false, reason: 'key' };
    // The rate the room asked this tab to follow. Everything below corrects
    // against that rate and never against the corrected element.
    const roomRate = Number(frame.rate || 1);
    if (Number.isFinite(roomRate) && roomRate > 0) this.roomRate = roomRate;
    // A hold is not a playhead correction. It pauses this tab and keeps it
    // paused until the room sends the release that carries the source's
    // position. A normal tick during that window must not resume the film.
    if (frame.hold === true) {
      if (!video.paused) video.pause();
      // A hold can be the room's answer to this very buffer wait. Keep the
      // wait, or the release starts the film at the old point and the hold
      // begins again. A hold that came from another source also keeps the
      // wait; the film stays paused until the range arrives either way.
      this.bufferWaitActive(now);
      if (!this.held) this.beginHold(now, frame);
      else if (this.holdEvent) {
        this.holdEvent.position = Math.round(Number(frame.position || 0) * 1000) / 1000;
        this.holdEvent.playing = Boolean(frame.playing);
      }
      this.held = true;
      this.heldAt = now;
      this.stats.holds += 1;
      this.stats.last = 'hold';
      return { ok: true, action: 'hold' };
    }
    if (this.held && frame.hold !== false) {
      if (now - this.heldAt < RELAY_HOLD_MAX_MS) {
        if (!video.paused) video.pause();
        // The room hold may be the answer to this buffer wait. Once the range
        // arrives or the wait deadline passes, stop reporting buffering so the
        // room can release; the release frame then seeks instead of waiting.
        this.bufferWaitActive(now);
        this.stats.skips += 1;
        this.stats.last = 'held';
        return { ok: true, skipped: 'held' };
      }
      // The release never came. Honour the hold for its lifetime and then
      // follow the room again rather than stay paused until a page reload.
      this.finishHold(now, 'expired');
      this.held = false;
      this.stats.expiredHolds += 1;
    }
    if (frame.hold === false) {
      if (this.held) this.finishHold(now, 'released');
      this.held = false;
    }
    // The host sits in an ad, so its frame names the ad clock and not the film.
    // Applying it would drag this tab off the film and back again on every
    // tick. The ad lasts seconds, so the tab waits it out and the room resumes.
    if (frame.ad) {
      this.stats.skips += 1;
      this.stats.last = 'host-ad';
      return { ok: true, skipped: 'host-ad' };
    }
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

    // The room's play or pause comes before any correction. A seek branch that
    // returns first skips this on every tick, and that is two failures in one:
    // a paused room left the video moving, and a seek that never landed left
    // the film paused for the whole room, because the drift stayed large and
    // every tick returned from the seek. So the room change lands first, and
    // the seek follows it.
    if (!frame.playing) {
      if (!video.paused) video.pause();
    } else if (video.paused && !this.bufferHeld) {
      startPlayback(video);
    }

    // A paused room has no clock to nudge against. A small gap there is a seek,
    // because a rate change on a paused video only leaves a slow rate behind
    // for the moment the room resumes.
    // A tab that just joined is the same case. It has no playhead to correct,
    // only a place to start from, and a one percent nudge would spend a minute
    // closing a gap the guest can see. The first frame seeks, and every frame
    // after it keeps the room's own policy.
    const paused = !frame.playing;
    const seed = !this.primed;
    this.primed = true;
    const seekLimit = paused || seed ? RELAY_NUDGE_SECONDS : RELAY_DRIFT_SECONDS;
    // The guest may catch up on its own. A gap that no longer needs a seek
    // must not keep the next one inside the old buffer deadline.
    if (Math.abs(drift) <= seekLimit) {
      if (this.waitingSince !== null) this.finishBufferWait(now, 'settled');
      this.waitingSince = null;
      this.waitingTarget = null;
      this.bufferReady = false;
      if (this.bufferHeld) {
        this.bufferHeld = false;
        if (frame.playing && video.paused) startPlayback(video);
      }
    }
    // A seek that never lands keeps the drift large, and this branch would win
    // every tick, so the film would never catch up. The retry is the one write
    // that frees the element, and the count says it happened.
    if (
      video.seeking &&
      this.lastSeekTarget !== null &&
      now - this.seekIssuedAt > RELAY_SEEK_TIMEOUT_MS
    ) {
      this.finishBufferWait(now, 'retry');
      this.waitingSince = null;
      this.waitingTarget = null;
      this.bufferHeld = false;
      this.bufferReady = false;
      video.currentTime = expected;
      this.lastSeekAt = now;
      this.seekIssuedAt = now;
      this.lastSeekTarget = expected;
      this.recordSeek(now, expected, 'retry');
      this.stats.stuckSeeks += 1;
      this.stats.applied += 1;
      this.stats.last = 'seek-retry';
      if (frame.playing && video.paused) startPlayback(video);
      return { ok: true, action: 'seek', retry: true, drift: Math.round(drift * 1000) / 1000 };
    }
    if (
      Math.abs(drift) > seekLimit &&
      !video.seeking &&
      now - this.lastSeekAt > RELAY_SEEK_SETTLE_MS
    ) {
      // The range check belongs on the element that owns the player. A seek
      // outside the fetched data is the long stall this path used to take.
      const rangeReady = this.bufferReady || bufferedAround(video, expected);
      if (!this.bufferReady && !rangeReady) {
        if (this.waitingSince === null) {
          this.beginBufferWait(now, expected);
        } else if (this.bufferWait) {
          this.bufferWait.target = Math.round(expected * 1000) / 1000;
        }
        this.waitingTarget = expected;
        if (now - this.waitingSince < RELAY_BUFFER_WAIT_MS) {
          const roomRate = Number(frame.rate || 1);
          if (Math.abs(Number(video.playbackRate || 1) - roomRate) > 0.001) {
            video.playbackRate = roomRate;
          }
          // Stop the film while it waits, or it keeps moving away from the
          // target and the seek has to cover a larger gap when data arrives.
          if (frame.playing && !video.paused) {
            video.pause();
            this.bufferHeld = true;
            this.stats.bufferHolds += 1;
          }
          this.stats.skips += 1;
          this.stats.last = 'buffer';
          return { ok: true, skipped: 'buffer', drift: Math.round(drift * 1000) / 1000 };
        }
      }
      this.finishBufferWait(now, rangeReady ? 'ready' : 'deadline');
      this.waitingSince = null;
      this.waitingTarget = null;
      this.bufferHeld = false;
      this.bufferReady = false;
      video.currentTime = expected;
      this.lastSeekAt = now;
      this.seekIssuedAt = now;
      this.lastSeekTarget = expected;
      this.recordSeek(now, expected, 'seek');
      this.stats.seeks += 1;
      this.stats.applied += 1;
      this.stats.last = 'seek';
      if (frame.playing && video.paused) startPlayback(video);
      return { ok: true, action: 'seek', drift: Math.round(drift * 1000) / 1000 };
    }

    if (!paused && Math.abs(drift) > RELAY_NUDGE_SECONDS) {
      const nudge = drift < 0 ? roomRate * RELAY_NUDGE_RATE : roomRate / RELAY_NUDGE_RATE;
      if (Math.abs(Number(video.playbackRate || 1) - nudge) > 0.001) video.playbackRate = nudge;
    } else if (Math.abs(Number(video.playbackRate || 1) - roomRate) > 0.001) {
      video.playbackRate = roomRate;
    }

    // The room leaves the viewer volume alone. A shared playhead does not need
    // a shared volume, and one viewer's headphones are not another's.
    this.stats.applied += 1;
    this.stats.last = 'tick';
    return { ok: true, action: 'tick', drift: Math.round(drift * 1000) / 1000 };
  }
}
