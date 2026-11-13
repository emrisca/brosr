// The sync client: protocol, clock, drift policy, media adapter, overlay and
// the navigation and view layers wired together. It holds no socket and no
// timers, so the browser entry and a Node test drive the same code.

import { decode, encode } from './protocol.mjs';
import { ClockEstimator } from './clock.mjs';
import { DriftController } from './drift.mjs';
import { MediaAdapter } from './media.mjs';
import { CursorOverlay } from './overlay.mjs';
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
export const PRESENCE_TICK_MS = 100;
export const SAMPLE_AFTER_MS = 4000;
// A seek takes time to land. Deciding again during that window stacks seeks
// and the player never reaches any of the targets.
export const SEEK_SETTLE_MS = 1000;
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
  input = null,
  viewport = null,
  navigate = null,
  scrollTo = null,
  now = () => Date.now(),
  overlay = true,
  sampleLimit = 200,
  latencyLimit = 200,
} = {}) {
  const clock = new ClockEstimator({ now });
  const drift = new DriftController();
  const media = new MediaAdapter({ root: mediaRoot });
  const state = new Room({ role, peerId, now });
  const cursor = doc && overlay ? new CursorOverlay({ document: doc }).attach() : null;
  const samples = [];
  const latencies = [];
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
    firstDrift: null,
    convergedAt: null,
    scroll: 0,
    layoutMismatch: false,
    inputApplied: 0,
    inputDropped: 0,
    inputReasons: {},
    capture: false,
  };
  let firstSeen = false;
  let firstAt = 0;
  let lastHostTick = -Infinity;
  let lastSeekAt = -Infinity;
  let lastSeekTarget = null;
  let lastViewTick = -Infinity;
  let lastUrl = null;
  const grants = new GrantBook({ now });
  let remoteGrant = false;
  let batcher = null;
  let lastInputFlush = -Infinity;

  const isHost = () => role === 'host';
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

  function sendSnapshot() {
    sendMessage(state.snapshot());
  }

  function setGrant(peer, allowed) {
    if (!isHost()) return false;
    const tabId = (input && input.tabId) || 'tab';
    const origin = (input && input.origin) || (doc && doc.location ? doc.location.origin : '');
    if (allowed) grants.grant(peer, { tabId, origin });
    else grants.revoke(peer, tabId);
    sendMessage({ type: 'control', peerId: peer, allowed, tabId, origin, roomTime: roomTimeOf() });
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
    const applied = replayInput(message.records, {
      root: doc,
      allowed: (record) => grants.allows(message.peerId, { tabId, origin, kind: record.kind }),
      onDrop: (reason) => {
        stats.inputReasons[reason] = (stats.inputReasons[reason] || 0) + 1;
      },
    });
    stats.inputApplied += applied.applied;
    stats.inputDropped += applied.dropped;
    return { ok: true, ...applied };
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
      },
      true
    );

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
  }

  function applyPeers() {
    if (!cursor) return;
    for (const peer of state.peers.values()) {
      if (peer.id === peerId) continue;
      cursor.setPeer(peer);
    }
    stats.cursors = cursor.stats().peers;
  }

  function applyPresence(message, local) {
    if (message.peerId === peerId) return;
    if (typeof message.roomTime === 'number') {
      const latency = Math.round(roomTimeOf(local) - message.roomTime);
      if (latency >= 0 && latency < LATENCY_LIMIT) {
        latencies.push(latency);
        if (latencies.length > latencyLimit) latencies.shift();
      }
    }
    state.join({ id: message.peerId, name: message.name, colour: message.colour });
    if (!cursor) return;
    cursor.setPeer({
      id: message.peerId,
      name: message.name,
      colour: message.colour,
      point: message.point,
    });
    stats.cursors = cursor.stats().peers;
  }

  function applyMedia(message, local) {
    const element = media.pick(message.key);
    const nowState = media.state(element);
    if (nowState) {
      stats.key = nowState.key;
      stats.position = Math.round(nowState.position * 1000) / 1000;
      stats.playing = nowState.playing;
    }
    if (role === 'host') return { ok: true };
    if (!element) return { ok: false, reason: 'no-media' };

    const expected =
      message.position + (message.playing ? (roomTimeOf(local) - message.roomTime) / 1000 : 0);
    const actual = Number(element.currentTime || 0);
    const driftMs = (actual - expected) * 1000;

    if (!firstSeen) {
      firstSeen = true;
      firstAt = local;
      stats.firstDrift = Math.round(driftMs);
    }

    // Wait for a seek to land before judging the next one.
    if (element.seeking || local - lastSeekAt < SEEK_SETTLE_MS) {
      if (element.playbackRate !== 1) element.playbackRate = 1;
      stats.position = Math.round(actual * 1000) / 1000;
      stats.playing = !element.paused;
      return { ok: true, pending: 'seek' };
    }

    const step = drift.tick(driftMs, {
      buffering: Number(element.readyState) < 2,
      adPlaying: false,
    });

    if (step.action === 'seek') {
      const max = Number.isFinite(element.duration) ? element.duration : expected;
      const target = Math.max(0, Math.min(expected, max));
      element.currentTime = target;
      lastSeekAt = local;
      lastSeekTarget = Math.round(target * 1000) / 1000;
      stats.corrections += 1;
      element.playbackRate = 1;
      // A seek can leave the element paused. The room is playing, so play.
      if (message.playing && element.paused) {
        const started = element.play();
        if (started && typeof started.catch === 'function') started.catch(() => {});
      }
    } else if (step.action === 'pause') {
      if (!element.paused) element.pause();
      element.playbackRate = 1;
    } else {
      if (message.playing && element.paused) {
        const started = element.play();
        if (started && typeof started.catch === 'function') started.catch(() => {});
      }
      if (element.playbackRate !== drift.rate) element.playbackRate = drift.rate;
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
    stats.position = Math.round(actual * 1000) / 1000;
    stats.playing = !element.paused;
    stats.debug = {
      local: Math.round(local),
      offset: Math.round(clock.offset()),
      roomNow: Math.round(roomTimeOf(local)),
      messageRoomTime: Math.round(message.roomTime),
      expected: Math.round(expected * 1000) / 1000,
      actual: Math.round(actual * 1000) / 1000,
      driftMs: Math.round(driftMs),
      seeking: Boolean(element.seeking),
      paused: element.paused,
      readyState: element.readyState,
      lastSeekTarget,
    };
    return { ok: true, driftMs: Math.round(driftMs), step };
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
        if (message.from && message.from !== hostId) return { ok: true, ignored: 'not-host' };
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
        if (!isHost() && scrollTo) scrollTo(applied.scroll);
        return { ok: true, ...applied };
      }
      case 'presence':
        applyPresence(message, local);
        return { ok: true };
      case 'media':
        return applyMedia(message, local);
      case 'bye':
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  function presence(peer = {}) {
    sendMessage({
      type: 'presence',
      peerId: peer.id || peerId,
      name: peer.name || name,
      colour: peer.colour || colour,
      point: peer.point || { x: 0, y: 0 },
      roomTime: roomTimeOf(),
    });
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
    state.applyView({ scroll: view.scroll, fingerprint: view.fingerprint });
    stats.scroll = state.scroll;
    sendMessage({
      type: 'view',
      scroll: state.scroll,
      fingerprint: view.fingerprint,
      roomTime: local,
    });
  }

  function tick(local = now()) {
    if (batcher && local - lastInputFlush >= POINTER_INTERVAL_MS) {
      lastInputFlush = local;
      batcher.flush();
    }
    if (!isHost() && clock.due(local)) {
      sendMessage({ ...clock.ping(local), to: hostId });
    }
    if (!isHost()) return stats;
    if (local - lastHostTick >= HOST_TICK_MS) {
      lastHostTick = local;
      const element = media.pick(null);
      const nowState = media.state(element);
      if (nowState) {
        stats.key = nowState.key;
        stats.position = Math.round(nowState.position * 1000) / 1000;
        stats.playing = nowState.playing;
        sendMessage({
          type: 'media',
          key: nowState.key,
          action: 'tick',
          position: nowState.position,
          playing: nowState.playing,
          rate: nowState.rate,
          volume: nowState.volume,
          // The host owns the room clock, so its local time is room time.
          roomTime: local,
        });
      }
    }
    pollViewport(local);
    return stats;
  }

  function latencyStats() {
    if (!latencies.length) return null;
    const sorted = [...latencies].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
  }

  function publish() {
    const grantedPeers = new Set(grants.active().map((grant) => grant.peerId));
    return {
      role,
      peerId,
      rtt: stats.rtt,
      position: stats.position,
      pos: stats.position,
      playing: stats.playing,
      key: stats.key,
      cursors: stats.cursors,
      seeks: stats.seeks,
      nudges: stats.nudges,
      corrections: stats.corrections,
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
      latency: latencyStats(),
      latencies: latencies.slice(-latencyLimit),
      granted: remoteGrant,
      capture: Boolean(batcher),
      inputApplied: stats.inputApplied,
      inputDropped: stats.inputDropped,
      inputReasons: stats.inputReasons,
      input: batcher ? batcher.stats() : null,
      debug: stats.debug || null,
    };
  }

  setupInput();

  if (isHost() && input && input.grantTo) {
    grants.grant(input.grantTo, { tabId: input.tabId || 'tab', origin: input.origin || '' });
  }

  return {
    role,
    room,
    peerId,
    receive,
    grants,
    setGrant,
    tick,
    presence,
    hello,
    publish,
    roomState: state,
    clock,
    drift,
    media,
    cursor,
    stats,
  };
}
