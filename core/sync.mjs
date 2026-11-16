// The sync client: protocol, clock, drift policy, media adapter, overlay and
// the navigation and view layers wired together. It holds no socket and no
// timers, so the browser entry and a Node test drive the same code.

import { decode, encode } from './protocol.mjs';
import { ClockEstimator } from './clock.mjs';
import { DriftController } from './drift.mjs';
import { MediaAdapter, bufferedAround } from './media.mjs';
import { CursorOverlay, actionText, mediaAction } from './overlay.mjs';
import { Room } from './room.mjs';
import {
  GrantBook,
  InputBatcher,
  POINTER_INTERVAL_MS,
  cssPath,
  isSensitiveField,
  originAllowed,
  replayInput,
} from './input.mjs';

export const HOST_TICK_MS = 250;
// The plan asks for 30 Hz presence, coalesced. Each frame gives the overlay a
// fresh target, and the overlay eases between them.
export const PRESENCE_TICK_MS = 33;
export const SAMPLE_AFTER_MS = 4000;
// A seek takes time to land. Deciding again during that window stacks seeks
// and the player never reaches any of the targets.
export const SEEK_SETTLE_MS = 1000;
// A seek that never lands would hold the peer behind for the whole run, so the
// pending state expires and a later message decides afresh.
export const SEEK_TIMEOUT_MS = 8000;
// A seek that lands outside the buffered data makes the element fetch in the
// middle of the seek, which is where it wedges here. The peer waits this long
// for data, then seeks anyway so a big gap is never held forever.
export const SEEK_BUFFER_WAIT_MS = 2500;
// The range check lives on the adapter now, and these names stay exported so a
// caller that imported them from here keeps working.
export { bufferedAround, SEEK_BUFFER_MARGIN_S } from './media.mjs';
export const VIEW_TICK_MS = 50;
export const SCROLL_EPSILON = 0.002;
export const LATENCY_LIMIT = 5000;

export function createRoomClient({
  role = 'peer',
  room = 'room',
  peerId = 'me',
  hostId = 'host',
  name = 'peer',
  colour = '#e2603f',
  send = () => {},
  document: doc = null,
  mediaRoot = null,
  // A site with its own player hands its adapter in here. The room then calls
  // the same four methods either way.
  mediaAdapter = null,
  input = null,
  viewport = null,
  navigate = null,
  scrollTo = null,
  // A page-level message from another peer. The room does not interpret it.
  onApp = null,
  // A cursor from another peer. The room tab hands each one to its browser,
  // so every other tab can draw it.
  onPresence = null,
  // A media frame for a film this tab does not hold. The room hands it to the
  // tab that does, and a false reply keeps the frame unhandled.
  onMedia = null,
  // The page this tab shows. Presence carries it, and a cursor draws only on
  // the tab that shows the same page.
  pageUrl = null,
  now = () => Date.now(),
  overlay = true,
  sampleLimit = 200,
  latencyLimit = 200,
} = {}) {
  const clock = new ClockEstimator({ now });
  // The controller holds a seek on the same clock and window as the settle
  // check below, so the two never disagree about when a seek may land.
  const drift = new DriftController({ now });
  let media = mediaAdapter || new MediaAdapter({ root: mediaRoot });
  const state = new Room({ role, peerId, now });
  const cursor = doc && overlay ? new CursorOverlay({ document: doc }).attach() : null;
  const samples = [];
  const latencies = [];
  // The merged list cannot say which sender owns a slow frame, so each sender
  // keeps its own window next to the clock estimate taken at the same time.
  const presenceByPeer = new Map();
  const stats = {
    role,
    peerId,
    rtt: null,
    position: 0,
    playing: false,
    key: null,
    cursors: 0,
    seeks: 0,
    nudges: 0,
    corrections: 0,
    stuckSeeks: 0,
    relayed: 0,
    mediaEcho: 0,
    mediaSent: 0,
    firstDrift: null,
    convergedAt: null,
    scroll: 0,
    layoutMismatch: false,
    layoutNotice: null,
    inputApplied: 0,
    inputDropped: 0,
    inputReasons: {},
    capture: false,
    controlSent: 0,
    controlReceived: 0,
    lastControl: null,
    controls: [],
    sentControls: [],
    appSent: 0,
    appReceived: 0,
    appDropped: 0,
    lastApp: null,
    lastMediaAction: null,
    hostId,
    hostMigrations: 0,
  };
  let firstSeen = false;
  let firstAt = 0;
  let lastHostTick = -Infinity;
  let lastSeekAt = -Infinity;
  let waitingSince = null;
  let lastSeekTarget = null;
  let lastViewTick = -Infinity;
  let lastUrl = null;
  const grants = new GrantBook({ now });
  let remoteGrant = false;
  let batcher = null;
  // Trusted batches reach the browser one at a time. The last send has to land
  // before the next begins, or a slow one lets its letters interleave.
  let trustedQueue = Promise.resolve();
  let lastInputFlush = -Infinity;
  // The last trusted pointer position as a share of the viewport. Presence
  // reuses it so a peer sees the mouse, not a placeholder at the origin.
  let lastPointer = null;
  // The same pointer in raw client pixels. A share of an old window goes stale
  // the moment that window changes size, so the pixels are kept to work the
  // share out again.
  let lastPointerClient = null;
  // The last point of every peer on this page, as a share. A resize places each
  // cursor again from these, because the pixels it drew at are gone.
  const peerPoints = new Map();
  // The page that point belongs to. A cursor shows only on that page.
  let lastPointerUrl = null;
  // The last frame that reached this tab, so a change can be named once.
  let lastMediaFrame = null;

  // The host can change. A room elects a successor when the host leaves, so
  // both the role and the host id stay mutable inside the client.
  let currentRole = role;
  let currentHost = hostId;
  const isHost = () => currentRole === 'host';
  // The host owns the room clock. Its own local time is room time, and a peer
  // converts its local time with the offset it measured from the host.
  const roomTimeOf = (local = now()) => (isHost() ? local : clock.roomTime(local));

  if (viewport) {
    const view = viewport();
    if (view && view.fingerprint) state.fingerprint = view.fingerprint;
    if (view && view.url) state.url = view.url;
  }

  function sendMessage(message) {
    send(encode(message));
  }

  function hello() {
    sendMessage({ type: 'hello', peerId, name, colour, roomTime: roomTimeOf() });
  }

  // A page names its own messages. An empty name or a non-object payload is
  // refused here, so the wire never carries a message no handler can use.
  function sendApp(appName, data = {}) {
    if (typeof appName !== 'string' || !appName) return false;
    const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    sendMessage({ type: 'app', peerId, name: appName, data: payload, roomTime: roomTimeOf() });
    stats.appSent += 1;
    return true;
  }

  function sendSnapshot() {
    sendMessage(state.snapshot());
  }

  // The host left. Every peer holds the same list of live ids, so they all name
  // the same successor without a vote. The successor takes over the room clock
  // and answers a hello with the snapshot it already holds.
  function migrateHost(gone) {
    if (!gone || gone !== currentHost) return null;
    const next = state.electNextHost(gone);
    stats.hostMigrations += 1;
    if (!next) {
      currentHost = '';
      stats.hostId = '';
      return null;
    }
    currentHost = next;
    stats.hostId = next;
    if (next === peerId) {
      currentRole = 'host';
      stats.role = 'host';
      state.role = 'host';
      sendSnapshot();
    }
    return next;
  }

  function setGrant(peer, allowed) {
    if (!isHost()) return false;
    const tabId = (input && input.tabId) || 'tab';
    const origin = (input && input.origin) || (doc && doc.location ? doc.location.origin : '');
    if (allowed) grants.grant(peer, { tabId, origin });
    else grants.revoke(peer, tabId);
    sendMessage({ type: 'control', peerId: peer, allowed, tabId, origin, roomTime: roomTimeOf() });
    stats.controlSent += 1;
    stats.sentControls.push({
      peerId: peer,
      allowed: Boolean(allowed),
      roomTime: Math.round(roomTimeOf()),
    });
    if (stats.sentControls.length > 8) stats.sentControls.shift();
    return true;
  }

  // A peer that holds control drives the room's playhead. Its room tab has no
  // player, so the state arrives from the tab that does. The background has
  // already dropped that report when playback sync is off. The frame carries
  // this peer's id, and the host checks that id against its grants before it
  // moves its own film.
  function sendMedia(state) {
    if (isHost() || !remoteGrant) return false;
    if (!state || typeof state !== 'object' || !state.key) return false;
    sendMessage({
      type: 'media',
      peerId,
      key: state.key,
      action: 'tick',
      position: Number(state.position || 0),
      playing: Boolean(state.playing),
      rate: Number(state.rate || 1),
      volume: Number(state.volume ?? 1),
      buffering: Boolean(state.buffering),
      ad: Boolean(state.ad),
      roomTime: roomTimeOf(),
    });
    stats.mediaSent += 1;
    return true;
  }

  function canvasFraction(element, event) {
    if (!element || String(element.tagName || '').toLowerCase() !== 'canvas') return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function handleInput(message) {
    if (!message.peerId) return { ok: false, reason: 'no-peer' };
    if (!doc) return { ok: false, reason: 'no-document' };
    const here = doc.location ? doc.location.href : '';
    if (here && !originAllowed(here)) {
      stats.inputDropped += message.records.length;
      stats.inputReasons.origin = (stats.inputReasons.origin || 0) + message.records.length;
      return { ok: false, reason: 'origin' };
    }
    if (!state.allowInput(message.peerId)) return { ok: false, reason: 'rate' };
    const accepted = state.acceptInput({
      peerId: message.peerId,
      seq: message.seq,
      records: message.records,
    });
    if (!accepted.accepted) return { ok: false, reason: accepted.reason };

    const tabId = (input && input.tabId) || 'tab';
    const origin = doc.location ? doc.location.origin : (input && input.origin) || '';
    const allowed = (record) => grants.allows(message.peerId, { tabId, origin, kind: record.kind });
    const replay = () => {
      const applied = replayInput(message.records, {
        root: doc,
        // A peer that laid out the page differently sends a point that lands
        // elsewhere here. Drop the record and say so.
        layoutMatches: !stats.layoutMismatch,
        allowed,
        onDrop: (reason) => {
          stats.inputReasons[reason] = (stats.inputReasons[reason] || 0) + 1;
        },
      });
      if (applied.reasons.layout) {
        stats.layoutNotice = {
          at: Math.round(now()),
          peerId: message.peerId,
          dropped: applied.reasons.layout,
        };
      }
      stats.inputApplied += applied.applied;
      stats.inputDropped += applied.dropped;
      return { ok: true, ...applied };
    };

    // A trusted room applies the batch in the browser's own input pipeline.
    // The records arrive already placed against this layout, so the synthetic
    // path is the fallback and not the first choice. A refusal replays, so a
    // closed agent or a stale token never swallows a click silently.
    if (input && typeof input.trusted === 'function') {
      const sendable = message.records.filter(allowed);
      if (!sendable.length) {
        stats.inputDropped += message.records.length;
        stats.inputReasons.grant = (stats.inputReasons.grant || 0) + message.records.length;
        return { ok: true, applied: 0, dropped: message.records.length, trusted: true };
      }
      // Two batches used to be in flight at once, and a slow one let the next
      // overtake it, so a word arrived with its letters swapped. Each send now
      // waits for the browser to apply the batch before it.
      const dispatch = async () => {
        try {
          const answer = await input.trusted(sendable);
          if (!answer || !answer.ok) {
            replay();
            return;
          }
          stats.inputApplied += Number(answer.applied) || sendable.length;
          const skipped = Number(answer.skipped) || 0;
          if (skipped) {
            stats.inputDropped += skipped;
            stats.inputReasons.kind = (stats.inputReasons.kind || 0) + skipped;
          }
        } catch {
          replay();
        }
      };
      trustedQueue = trustedQueue.then(dispatch);
      return { ok: true, trusted: true, sent: sendable.length };
    }
    return replay();
  }

  function setupInput() {
    if (!input || !input.capture || !doc) return;
    batcher = new InputBatcher({ now, send, peerId });
    stats.capture = true;

    // Synthetic events never travel back. That is the first loop guard, and
    // the second is that only a granted peer captures at all.
    const skip = (event) =>
      !event.isTrusted ||
      (event.target &&
        typeof event.target.closest === 'function' &&
        event.target.closest('[data-brosr-overlay]'));

    doc.addEventListener(
      'click',
      (event) => {
        if (skip(event) || !remoteGrant) return;
        if (isSensitiveField(event.target)) return;
        batcher.push({
          kind: 'click',
          path: cssPath(event.target),
          button: event.button,
          canvas: canvasFraction(event.target, event),
        });
        // A click is a whole act, and a click on a link unloads this page. A
        // queued record would leave with the page still holding it, so the
        // click goes out now instead of on the next tick.
        batcher.flush();
      },
      true
    );

    // A page can leave without a click, and the last keys still belong to the
    // room. One flush on the way out keeps the tail of the input.
    const flushOut = () => batcher.flush();
    if (typeof doc.defaultView?.addEventListener === 'function') {
      doc.defaultView.addEventListener('pagehide', flushOut, { passive: true });
    }

    doc.addEventListener(
      'keydown',
      (event) => {
        if (skip(event) || !remoteGrant) return;
        if (isSensitiveField(event.target)) return;
        batcher.push({
          kind: 'key',
          key: event.key,
          code: event.code,
          path: cssPath(event.target),
          ctrl: event.ctrlKey,
          alt: event.altKey,
          shift: event.shiftKey,
        });
      },
      true
    );

    doc.addEventListener(
      'wheel',
      (event) => {
        if (skip(event) || !remoteGrant) return;
        batcher.push({
          kind: 'wheel',
          path: cssPath(event.target),
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        });
      },
      { passive: true, capture: true }
    );

    // A synthetic key event inserts no character, so typing travels as the
    // field value instead. The receiver writes it through the native setter,
    // which is what React and Vue read. A password or credential field never
    // reaches this record.
    doc.addEventListener(
      'input',
      (event) => {
        if (skip(event) || !remoteGrant) return;
        const target = event.target;
        const tag = String((target && target.tagName) || '').toLowerCase();
        if (!['input', 'textarea', 'select'].includes(tag)) return;
        if (isSensitiveField(target)) return;
        batcher.push({
          kind: 'text',
          path: cssPath(target),
          value: String(target.value ?? ''),
        });
      },
      true
    );
  }

  // Presence travels as a share of the viewport, so two window sizes put a
  // cursor on the same part of the page. The overlay eases and jumps in pixels,
  // so the share becomes pixels once, here, and the overlay never reads the
  // wire form. One unit at the edge keeps the rest of the file honest.
  function viewSize() {
    const view = doc && doc.defaultView;
    return {
      width: Math.max(1, Number(view && view.innerWidth) || 1),
      height: Math.max(1, Number(view && view.innerHeight) || 1),
    };
  }

  function sharePoint(point) {
    const x = Number(point && point.x);
    const y = Number(point && point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
    return {
      x: Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000,
      y: Math.round(Math.max(0, Math.min(1, y)) * 10000) / 10000,
    };
  }

  function pointPixels(point) {
    const size = viewSize();
    return { x: point.x * size.width, y: point.y * size.height };
  }

  function applyPeers() {
    if (!cursor) return;
    // Presence is what places a cursor, because it carries the page and the
    // point. A roster entry carries neither, so it draws nothing.
    stats.cursors = cursor.stats().peers;
  }

  function applyPresence(message, local) {
    if (message.peerId === peerId) return;
    if (typeof message.roomTime === 'number') {
      const latency = Math.round(roomTimeOf(local) - message.roomTime);
      if (latency >= 0 && latency < LATENCY_LIMIT) {
        latencies.push(latency);
        if (latencies.length > latencyLimit) latencies.shift();
        const bucket = presenceByPeer.get(message.peerId) || [];
        bucket.push(latency);
        if (bucket.length > latencyLimit) bucket.shift();
        presenceByPeer.set(message.peerId, bucket);
      }
    }
    state.join({ id: message.peerId, name: message.name, colour: message.colour });
    const point = sharePoint(message.point);
    const position = {
      id: message.peerId,
      name: message.name,
      colour: message.colour,
      // The share, because a tab that hands the cursor on needs the wire form.
      point,
      url: message.url,
    };
    // Only the room tab holds a socket, so it is the one that shares a cursor
    // with the rest of this browser.
    if (onPresence) {
      try {
        onPresence(position);
      } catch {
        // A listener cannot break the room.
      }
    }
    if (!cursor) return;
    // A cursor belongs to one page. A tab shows it only while the peer is on
    // that same page, so a pointer never lands on an unrelated tab.
    const here = pageUrl ? pageUrl() : '';
    if (!message.url || !here || message.url !== here) {
      peerPoints.delete(message.peerId);
      cursor.removePeer(message.peerId);
    } else {
      peerPoints.set(message.peerId, position);
      cursor.setPeer({ ...position, point: pointPixels(point) });
    }
    stats.cursors = cursor.stats().peers;
  }

  function applyMedia(message, local) {
    // The relay fans out to every socket, so a frame also comes back to the tab
    // that sent it. A tab that applied its own anchor would chase itself, and a
    // page player answers that chase with an error overlay.
    if (message.peerId && message.peerId === peerId) {
      stats.mediaEcho += 1;
      return { ok: true, ignored: 'self' };
    }
    // A host follows only a peer it granted control to. Without this check a
    // viewer could pull the host's film around, and a grant would change
    // nothing about playback.
    if (isHost() && !grants.active().some((grant) => grant.peerId === message.peerId)) {
      return { ok: true, ignored: 'no-grant' };
    }
    // The adapter owns every read and write. A player object and a media
    // element meet one interface, so the peer path never touches a field.
    const picked = media.pick(message.key);
    const read = picked ? media.state(picked) : null;
    if (read) {
      stats.key = read.key;
      stats.position = Math.round(read.position * 1000) / 1000;
      stats.playing = read.playing;
    }
    const expected =
      message.position + (message.playing ? (roomTimeOf(local) - message.roomTime) / 1000 : 0);
    // The notice names a person, not a socket id. The room knows the name the
    // peer chose when it joined.
    const actor =
      (state.peers.get(message.peerId) || {}).name || message.name || message.peerId;
    // The panel and the film tab share one reading of the change. The expected
    // position is what this tab assumes the frame means, so a seek is measured
    // against the frame that came before it.
    const action = mediaAction(lastMediaFrame, { ...message, position: expected }, local);
    lastMediaFrame = {
      key: message.key,
      position: expected,
      playing: Boolean(message.playing),
      rate: Number(message.rate || 1),
      at: local,
    };
    if (action) {
      stats.lastMediaAction = {
        name: actor,
        action,
        text: actionText({ name: actor, action, position: expected, rate: message.rate }),
        at: Math.round(local),
      };
    }
    // The host's room tab holds no player. A granted peer drives the film
    // through the tab that does, and the host keeps sending its own anchor.
    if (isHost()) {
      if (!onMedia) return { ok: false, reason: 'no-media' };
      try {
        if (onMedia({ ...message, name: actor, action: action || null, expected, at: local }) === false) {
          return { ok: false, reason: 'no-media' };
        }
        stats.relayed += 1;
        return { ok: true, relayed: true };
      } catch (error) {
        return { ok: false, reason: 'handler', error: error.message };
      }
    }
    // A room tab with no player of its own hands the frame to the tab that
    // shows the film. The expected position is anchored on this tab's clock,
    // so the tab needs no clock estimate of its own.
    if (!read) {
      if (!onMedia) return { ok: false, reason: 'no-media' };
      try {
        if (onMedia({ ...message, name: actor, action: action || null, expected, at: local }) === false) {
          return { ok: false, reason: 'no-media' };
        }
        stats.relayed += 1;
        return { ok: true, relayed: true };
      } catch (error) {
        return { ok: false, reason: 'handler', error: error.message };
      }
    }

    const actual = read.position;
    const driftMs = (actual - expected) * 1000;

    if (!firstSeen) {
      firstSeen = true;
      firstAt = local;
      stats.firstDrift = Math.round(driftMs);
    }

    // Wait for a seek to land before judging the next one.
    // The controller holds a seek for its own cooldown, so the settle window
    // never ends before the controller would allow another one.
    const settleMs = Math.max(SEEK_SETTLE_MS, drift.cooldownMs || 0);
    // The element can report a seek that never finishes. Waiting on it forever
    // leaves the peer behind by the whole gap, so the wait has a limit.
    if (read.seeking && Number.isFinite(lastSeekAt) && local - lastSeekAt > SEEK_TIMEOUT_MS) {
      // A fresh seek is what frees this element, so the retry is issued here.
      // Counting it alone would leave the peer behind.
      stats.stuckSeeks += 1;
      const limit = Number.isFinite(read.duration) && read.duration > 0 ? read.duration : expected;
      media.apply(picked, { action: 'seek', position: Math.max(0, Math.min(expected, limit)) });
      lastSeekAt = local;
      if (read.rate !== 1) media.apply(picked, { action: 'tick', rate: 1 });
      if (message.playing && !read.playing) media.apply(picked, { action: 'play' });
      return { ok: true, pending: 'seek-retry', stuckSeeks: stats.stuckSeeks };
    }
    if (read.seeking || local - lastSeekAt < settleMs) {
      if (read.rate !== 1) media.apply(picked, { action: 'tick', rate: 1 });
      stats.position = Math.round(actual * 1000) / 1000;
      stats.playing = read.playing;
      return { ok: true, pending: 'seek' };
    }

    // The adapter owns the flags. A starved element and a site ad reach the
    // policy through one call, so neither site can forget one of them.
    const step = drift.tick(driftMs, media.flags(picked));

    if (step.action === 'seek') {
      const max = Number.isFinite(read.duration) && read.duration > 0 ? read.duration : expected;
      const target = Math.max(0, Math.min(expected, max));
      // A site player fetches on seek, so only an element needs the range check.
      const buffered = media.bufferedAround
        ? media.bufferedAround(picked, target)
        : bufferedAround(picked, target);
      if (!buffered) {
        if (waitingSince === null) waitingSince = local;
        if (local - waitingSince < SEEK_BUFFER_WAIT_MS) {
          if (read.rate !== 1) media.apply(picked, { action: 'tick', rate: 1 });
          return { ok: true, pending: 'buffer' };
        }
      }
      waitingSince = null;
      media.apply(picked, { action: 'seek', position: target });
      lastSeekAt = local;
      lastSeekTarget = Math.round(target * 1000) / 1000;
      stats.corrections += 1;
      if (read.rate !== 1) media.apply(picked, { action: 'tick', rate: 1 });
      // A seek can leave the player paused. The room is playing, so play.
      if (message.playing && !read.playing) media.apply(picked, { action: 'play' });
    } else if (step.action === 'pause') {
      // The adapter knows whether a buffering player needs a pause, so the
      // decision passes through rather than being second-guessed here.
      media.apply(picked, { action: 'pause' });
      if (read.rate !== 1) media.apply(picked, { action: 'tick', rate: 1 });
    } else {
      if (message.playing && !read.playing) media.apply(picked, { action: 'play' });
      if (read.rate !== drift.rate) media.apply(picked, { action: 'tick', rate: drift.rate });
    }
    stats.seeks = drift.seeks;
    stats.nudges = drift.nudges;

    const elapsed = local - firstAt;
    if (step.action !== 'seek' && elapsed > SAMPLE_AFTER_MS) {
      samples.push(Math.round(driftMs));
      if (samples.length > sampleLimit) samples.shift();
      if (stats.convergedAt === null && Math.abs(driftMs) < 20) {
        stats.convergedAt = Math.round(elapsed);
      }
    }
    // Read once more, so the panel shows what the writes above produced.
    const after = media.state(picked) || read;
    stats.position = Math.round(after.position * 1000) / 1000;
    stats.playing = after.playing;
    stats.debug = {
      local: Math.round(local),
      offset: Math.round(clock.offset()),
      roomNow: Math.round(roomTimeOf(local)),
      messageRoomTime: Math.round(message.roomTime),
      expected: Math.round(expected * 1000) / 1000,
      actual: Math.round(actual * 1000) / 1000,
      driftMs: Math.round(driftMs),
      seeking: Boolean(after.seeking),
      paused: !after.playing,
      readyState: after.readyState,
      lastSeekTarget,
    };
    return { ok: true, driftMs: Math.round(driftMs), step };
  }

  // A page that hands its player in after the core starts swaps the adapter
  // here. A missing value goes back to the element adapter.
  function setMediaAdapter(next) {
    media = next || new MediaAdapter({ root: mediaRoot });
    return media;
  }

  function followSnapshot(message) {
    if (message.url) {
      state.url = message.url;
      const here = viewport ? viewport().url : null;
      if (!isHost() && navigate && here && here !== message.url) navigate(message.url);
    }
    if (typeof message.scroll === 'number') {
      state.scroll = message.scroll;
      if (!isHost() && scrollTo) scrollTo(message.scroll);
    }
  }

  function receive(frame, local = now()) {
    let message;
    try {
      message = decode(frame);
    } catch (error) {
      return { ok: false, reason: 'bad-frame', error: error.message };
    }
    switch (message.type) {
      case 'ping': {
        if (message.to && message.to !== peerId) return { ok: true, ignored: 'not-me' };
        sendMessage({ ...clock.answer(message, local, now()), from: peerId });
        return { ok: true };
      }
      case 'pong':
        if (message.from && message.from !== currentHost) return { ok: true, ignored: 'not-host' };
        clock.onPong(message, local);
        stats.rtt = clock.roundTrip();
        return { ok: true };
      case 'hello':
        state.join({ id: message.peerId, name: message.name, colour: message.colour });
        if (isHost()) {
          sendSnapshot();
          // A peer that follows a navigation reloads and says hello again. Send
          // the grant again, or the new page never learns it holds control.
          const held = grants.active().find((grant) => grant.peerId === message.peerId);
          if (held) {
            sendMessage({
              type: 'control',
              peerId: message.peerId,
              allowed: true,
              tabId: held.tabId,
              origin: held.origin,
              roomTime: roomTimeOf(),
            });
          }
          if (input && input.grantTo === message.peerId) setGrant(message.peerId, true);
        }
        return { ok: true };
      case 'control':
        stats.controlReceived += 1;
        stats.controls.push({ peerId: message.peerId, allowed: Boolean(message.allowed) });
        if (stats.controls.length > 8) stats.controls.shift();
        stats.lastControl = {
          peerId: message.peerId,
          allowed: Boolean(message.allowed),
          mine: message.peerId === peerId,
        };
        if (message.peerId === peerId) {
          remoteGrant = Boolean(message.allowed);
          stats.granted = remoteGrant;
        }
        return { ok: true };
      case 'input':
        return handleInput(message);
      case 'snapshot':
        state.applySnapshot(message);
        applyPeers();
        followSnapshot(message);
        return { ok: true };
      case 'nav':
        state.applyNav({ url: message.url });
        if (!isHost() && navigate) navigate(message.url);
        return { ok: true, url: message.url };
      case 'view': {
        const applied = state.applyView({ scroll: message.scroll, fingerprint: message.fingerprint });
        stats.scroll = applied.scroll;
        stats.layoutMismatch = applied.mismatch;
        // The notice belongs to the mismatch that caused it. Once the pages
        // line up again the banner has nothing to say.
        if (!applied.mismatch) stats.layoutNotice = null;
        if (!isHost() && scrollTo) scrollTo(applied.scroll);
        return { ok: true, ...applied };
      }
      case 'presence':
        applyPresence(message, local);
        return { ok: true };
      case 'media':
        return applyMedia(message, local);
      case 'app': {
        // The relay fans out to every socket including our own; a page handler
        // should not see its own message come back.
        if (message.peerId === peerId) return { ok: true, ignored: 'self' };
        stats.appReceived += 1;
        stats.lastApp = { peerId: message.peerId, name: message.name, data: message.data };
        if (!onApp) return { ok: true };
        try {
          onApp({
            from: message.peerId,
            name: message.name,
            data: message.data,
            roomTime: message.roomTime,
          });
        } catch (error) {
          stats.appDropped += 1;
          return { ok: false, reason: 'handler', error: error.message };
        }
        return { ok: true };
      }
      case 'bye':
        // A host that says goodbye hands the room to the smallest live id. A
        // peer that leaves only leaves.
        if (message.peerId === currentHost) {
          state.leave(message.peerId);
          migrateHost(message.peerId);
        }
        return { ok: true, host: currentHost };
      default:
        return { ok: true };
    }
  }

  function presence(peer = {}) {
    const message = {
      type: 'presence',
      peerId: peer.id || peerId,
      name: peer.name || name,
      colour: peer.colour || colour,
      point: peer.point || lastPointer || { x: 0, y: 0 },
      roomTime: roomTimeOf(),
    };
    // The page this cursor is on. Another tab draws it only when it shows that
    // same page.
    const here = peer.url || lastPointerUrl || (pageUrl ? pageUrl() : null);
    if (here) message.url = here;
    sendMessage(message);
  }

  // Layer 1 and 2 on the host: it is the only side that publishes a URL or a
  // scroll ratio, so a relayed view cannot fight the host's page.
  function pollViewport(local) {
    if (!viewport || local - lastViewTick < VIEW_TICK_MS) return;
    lastViewTick = local;
    const view = viewport();
    if (!view) return;
    if (view.url && view.url !== lastUrl) {
      lastUrl = view.url;
      state.applyNav({ url: view.url });
      sendMessage({ type: 'nav', url: view.url, roomTime: local });
    }
    if (typeof view.scroll !== 'number') return;
    if (Math.abs(view.scroll - state.scroll) <= SCROLL_EPSILON) return;
    // This tab is the reference the peer follows. Its own resize is not a
    // mismatch with a peer, and treating it as one would drop every click the
    // peer sends from then on.
    state.applyView({ scroll: view.scroll });
    stats.scroll = state.scroll;
    sendMessage({
      type: 'view',
      scroll: state.scroll,
      fingerprint: view.fingerprint,
      roomTime: local,
    });
  }

  // A resize changes what a share means in pixels. This page's pointer keeps
  // its place in the window, so its share is worked out again, and every peer
  // cursor is placed again from the share that peer last sent. Without this a
  // cursor sits where the old window size put it.
  function resizePointers() {
    if (lastPointerClient) {
      const size = viewSize();
      lastPointer = sharePoint({
        x: lastPointerClient.x / size.width,
        y: lastPointerClient.y / size.height,
      });
    }
    if (!cursor) return;
    const here = pageUrl ? pageUrl() : '';
    for (const [id, entry] of peerPoints) {
      if (entry.url && here && entry.url !== here) continue;
      cursor.setPeer({ ...entry, id, point: pointPixels(entry.point) });
    }
  }

  function setupResize() {
    const view = doc && doc.defaultView;
    if (!view || typeof view.addEventListener !== 'function') return;
    view.addEventListener('resize', resizePointers, { passive: true });
  }

  function setupPointer() {
    if (!doc || typeof doc.addEventListener !== 'function') return;
    doc.addEventListener(
      'pointermove',
      (event) => {
        // Replayed remote input is synthetic, so it is not this page's pointer.
        if (!event.isTrusted) return;
        const x = Number(event.clientX);
        const y = Number(event.clientY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const size = viewSize();
        lastPointerClient = { x, y };
        lastPointer = sharePoint({ x: x / size.width, y: y / size.height });
        lastPointerUrl = pageUrl ? pageUrl() : null;
      },
      { passive: true, capture: true }
    );
  }

  // A cursor that lives on another tab of this browser reports here. Presence
  // publishes the newest point either way, so the room follows that tab.
  function setPointer(point, url) {
    if (!point) return false;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    lastPointer = sharePoint({ x, y });
    if (url) lastPointerUrl = String(url);
    return true;
  }

  function tick(local = now()) {
    // A dropped socket leaves its entry behind. The count only means live peers
    // once the map forgets a peer that stopped sending presence.
    const gone = state.prune({ at: local });
    // A host that stops sending presence has left, and the room elects again.
    if (currentHost && currentHost !== peerId && gone.includes(currentHost)) {
      migrateHost(currentHost);
    }
    if (batcher && local - lastInputFlush >= POINTER_INTERVAL_MS) {
      lastInputFlush = local;
      batcher.flush();
    }
    if (!isHost() && clock.due(local)) {
      sendMessage({ ...clock.ping(local), to: currentHost });
    }
    if (!isHost()) return stats;
    if (local - lastHostTick >= HOST_TICK_MS) {
      lastHostTick = local;
      const element = media.pick(null);
      const nowState = media.state(element);
      // A starved or ad state travels with the anchor, so a peer panel can say
      // why the film is not moving yet.
      const flags = media.flags(element);
      if (nowState) {
        stats.key = nowState.key;
        stats.position = Math.round(nowState.position * 1000) / 1000;
        stats.playing = nowState.playing;
        sendMessage({
          type: 'media',
          peerId,
          key: nowState.key,
          action: 'tick',
          position: nowState.position,
          playing: nowState.playing,
          rate: nowState.rate,
          volume: nowState.volume,
          buffering: Boolean(flags.buffering),
          ad: Boolean(flags.adPlaying),
          // The host owns the room clock, so its local time is room time.
          roomTime: local,
        });
      }
    }
    pollViewport(local);
    return stats;
  }

  function summarize(list) {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
  }

  function latencyStats() {
    return summarize(latencies);
  }

  function publish() {
    const grantedPeers = new Set(grants.active().map((grant) => grant.peerId));
    return {
      role: currentRole,
      peerId,
      hostId: currentHost,
      hostMigrations: stats.hostMigrations,
      rtt: stats.rtt,
      position: stats.position,
      pos: stats.position,
      playing: stats.playing,
      key: stats.key,
      cursors: stats.cursors,
      seeks: stats.seeks,
      nudges: stats.nudges,
      corrections: stats.corrections,
      stuckSeeks: stats.stuckSeeks,
      relayed: stats.relayed,
      mediaEcho: stats.mediaEcho,
      firstDrift: stats.firstDrift,
      convergedAt: stats.convergedAt,
      sampleCount: samples.length,
      samples: samples.slice(-sampleLimit),
      clockOffset: Math.round(clock.offset()),
      driftRate: drift.rate,
      peers: state.peers.size,
      // The panel needs names and who holds control. The count stays a number so
      // the harness assertions do not change.
      peerList: [...state.peers.values()].map((peer) => ({
        id: peer.id,
        name: peer.name || peer.id,
        colour: peer.colour || null,
        self: peer.id === peerId,
        granted: peer.id === peerId ? remoteGrant : grantedPeers.has(peer.id),
      })),
      url: state.url,
      scroll: Math.round(state.scroll * 1000) / 1000,
      layoutMismatch: stats.layoutMismatch,
      layoutNotice: stats.layoutNotice,
      latency: latencyStats(),
      latencies: latencies.slice(-latencyLimit),
      presenceByPeer: Object.fromEntries(
        [...presenceByPeer].map(([id, list]) => [id, summarize(list)])
      ),
      granted: remoteGrant,
      controlSent: stats.controlSent,
      controlReceived: stats.controlReceived,
      lastControl: stats.lastControl,
      controls: stats.controls,
      controlHistory: stats.sentControls,
      lastMediaAction: stats.lastMediaAction,
      capture: Boolean(batcher),
      inputApplied: stats.inputApplied,
      inputDropped: stats.inputDropped,
      inputReasons: stats.inputReasons,
      input: batcher ? batcher.stats() : null,
      app: {
        sent: stats.appSent,
        received: stats.appReceived,
        dropped: stats.appDropped,
        last: stats.lastApp,
      },
      debug: stats.debug || null,
    };
  }

  setupPointer();
  setupResize();
  setupInput();

  // A room opened with a grant names the peer it trusts. The peer needs the
  // same frame the panel sends, or it never starts capturing, so this grant
  // goes out on the wire through the one path that also grants here.
  if (isHost() && input && input.grantTo) setGrant(input.grantTo, true);

  return {
    role: currentRole,
    room,
    peerId,
    receive,
    sendApp,
    grants,
    setGrant,
    sendMedia,
    isGranted: () => remoteGrant,
    tick,
    presence,
    setPointer,
    hello,
    publish,
    roomState: state,
    clock,
    drift,
    // A getter, so a page that swaps in a player sees the current adapter.
    get media() {
      return media;
    },
    setMediaAdapter,
    cursor,
    stats,
  };
}
