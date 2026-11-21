// The sync client: protocol, clock, drift policy, media adapter, overlay and
// the navigation and view layers wired together. It holds no socket and no
// timers, so the browser entry and a Node test drive the same code.

import { decode, encode } from './protocol.mjs';
import { ClockEstimator } from './clock.mjs';
import { DriftController, decideDrift } from './drift.mjs';
import { MediaAdapter, bufferedAround } from './media.mjs';
import { CursorOverlay, actionText, mediaAction } from './overlay.mjs';
import {
  ROOM_COLOURS,
  cleanCursor,
  cleanCursorSites,
  cleanRoomName,
  cursorDecision,
  cursorSiteOf,
  isColour,
  nextColour,
} from './cursor.mjs';
import { Room } from './room.mjs';
import { APP_NAME, acceptOffset, localPosition } from './align.mjs';

// A pointer is sampled at 30 Hz. Fast enough to look live, slow enough to
// keep presence small.
export const HOST_TICK_MS = 250;
// A local act by the host wins briefly. A peer's own pause or play can
// arrive just after it, and without this window the host's pause looked like it
// did nothing. Half a second covers the frame that was already in flight; a
// longer window swallowed a deliberate peer act.
export const HOST_MEDIA_PRIORITY_MS = 500;
// A peer's local seek/play/pause needs a short guard against already
// in-flight routine host ticks before the host acknowledges or supersedes it.
export const PEER_ACT_GUARD_MS = 1500;
// While the host's film tab is still executing an accepted peer seek/pause/play,
// suppress stale pre-seek ticks from the host film tab so they do not snap the
// peer back to the old playhead.
export const HOST_PEER_APPLY_MS = 2500;
// When the host joins a peer-owned tab that has not finished loading its player
// yet, hold the peer anchor longer so the new tab catches up instead of
// broadcasting 0:00 back over the peer.
export const HOST_PEER_JOIN_APPLY_MS = 12000;
// Freshness window for host playhead state reported via sendHostMedia when
// media.pick() is null on the host room tab (separate film tab).
export const HOST_KNOWN_MEDIA_MS = 8000;
// The plan asks for 30 Hz presence, coalesced. Each frame gives the overlay a
// fresh target, and the overlay eases between them.
export const PRESENCE_TICK_MS = 33;
// Presence arrives many times a second while a person is in the room. A peer
// whose frames stop has closed its tab or lost the relay, so its cursor leaves
// this page instead of sitting at the last point it sent.
export const PEER_IDLE_MS = 4000;
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

// A bridge build is the manifest version plus the protocol it speaks. A guest
// that runs an older bridge can now be named instead of looking like a sync bug.
export function cleanBuild(value) {
  if (!value || typeof value !== 'object') return null;
  const version = typeof value.version === 'string' && value.version.trim()
    ? value.version.trim().slice(0, 40)
    : null;
  const rawProtocol = value.protocol;
  const protocol =
    rawProtocol === null || rawProtocol === undefined || !Number.isFinite(Number(rawProtocol))
      ? null
      : Number(rawProtocol);
  return version || protocol !== null ? { version, protocol } : null;
}

export function createRoomClient({
  role = 'peer',
  room = 'room',
  peerId = 'me',
  hostId = 'host',
  name = 'peer',
  colour = '#e2603f',
  roomName = 'Room',
  // The bridge manifest version and protocol this tab runs. It travels in the
  // hello once, not in every pointer frame.
  build = null,
  customCursor = null,
  sharePointer = true,
  // The host names the sites that show pointers. Null keeps the old same-site
  // rule, which a peer holds until the host sends its list.
  cursorSites = null,
  // The host names the sites the room mirrors: scroll, clicks and typing.
  // Null allows every site, and an empty list allows none.
  scrollSites = null,
  // A viewer can hide every pointer name without hiding the pointers.
  showNames = true,
  // The host can make the room wait when any peer's player is starved.
  // A copy offset measured offline. A number is treated as a confident
  // measurement. An object is accepted only when it passes the same rules as
  // a wire payload. Zero is the default and changes nothing.
  alignOffset: initialAlignOffset = 0,
  // Sites the host took off the list stay off, so a visit does not bring the
  // row back.
  cursorForgot = null,
  // A peer that learns a new site list reports it here, so every tab of this
  // browser follows the host at once.
  onPolicy = null,
  // A peer that learns a new scroll rule reports it here, so the room tab can
  // keep the rule across a navigation.
  onScrollPolicy = null,
  send = () => {},
  document: doc = null,
  mediaRoot = null,
  // A site with its own player hands its adapter in here. The room then calls
  // the same four methods either way.
  mediaAdapter = null,
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
  // The page this tab shows. Presence carries it so another tab knows where
  // the pointer is.
  pageUrl = null,
  now = () => Date.now(),
  overlay = true,
  sampleLimit = 200,
  latencyLimit = 200,
} = {}) {
  const clientBuild = cleanBuild(build);
  const clock = new ClockEstimator({ now });
  // The drift logic holds a seek on the same clock and window as the settle
  // check below, so the two never disagree about when a seek may land.
  const drift = new DriftController({ now });
  let media = mediaAdapter || new MediaAdapter({ root: mediaRoot });
  const initialRoomName = cleanRoomName(roomName);
  const state = new Room({ role, peerId, roomName: initialRoomName, now });
  // The measured gap between this peer's own copy and the room's, in ms. Zero
  // until this peer learns one, so a room that never measured a copy runs
  // exactly as it did before this lane existed.
  const bootAccepted =
    initialAlignOffset && typeof initialAlignOffset === 'object'
      ? acceptOffset(initialAlignOffset)
      : acceptOffset({ offsetMs: Number(initialAlignOffset), confidence: 1 });
  const bootAlign = bootAccepted && bootAccepted.offsetMs !== 0 ? bootAccepted : null;
  let alignOffset = bootAlign ? bootAlign.offsetMs : 0;
  let alignState = bootAlign;
  // Claims from other peers are kept for the room record, never applied to
  // this peer. A copy offset belongs to the person holding that copy.
  const alignPeers = new Map();
  let currentColour = isColour(colour) ? colour : '#e2603f';
  let currentRoomName = initialRoomName;
  let currentCursor = cleanCursor(customCursor);
  let sharingPointer = Boolean(sharePointer);
  let allowedSites = cleanCursorSites(cursorSites);
  let allowedScrollSites = cleanCursorSites(scrollSites);
  let showingNames = showNames !== false;
  // The sites the room can see right now: the page this tab names and the page
  // every live peer reports. A site leaves the list when its tab does, so a
  // closed tab stops leaving a row behind in the host's picker.
  function liveSites() {
    const live = new Set();
    const add = (href) => {
      const key = cursorSiteOf(href);
      if (key) live.add(key);
    };
    if (pageUrl) add(pageUrl());
    add(lastPointerUrl);
    for (const peer of state.peers.values()) add(peer.url);
    return live;
  }
  // Sites the host removed from the list. The panel leaves them out even while
  // people are on them, so a removal holds until the site is switched on again.
  const forgottenSites = new Set(cleanCursorSites(cursorForgot) || []);
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
    holds: 0,
    appSent: 0,
    appReceived: 0,
    appDropped: 0,
    lastApp: null,
    lastMediaAction: null,
    lastLocalMediaAction: null,
    mediaDrops: {},
    mediaDropTicks: {},
    lastMediaDrop: null,
    mediaDropHistory: [],
    hostId,
    hostMigrations: 0,
  };
  let firstSeen = false;
  let firstAt = 0;
  let lastHostTick = -Infinity;
  let lastHostActAt = -Infinity;
  let lastHostActKey = null;
  let mediaRev = 0;
  let lastSentRev = 0;
  let lastMediaActor = null;
  let lastMediaKey = null;
  let pendingLocalAct = null;
  let pendingPeerApply = null;
  // Fresh playhead per film key reported by the host film tab via sendHostMedia.
  // Needed when media.pick(key) is null on the host room tab so non-seek peer
  // acts still anchor to the host playhead and use HOST_PEER_APPLY_MS.
  const hostKnownMedia = new Map();
  let lastSeekAt = -Infinity;
  let waitingSince = null;
  let lastSeekTarget = null;
  let lastViewTick = -Infinity;
  let lastUrl = null;
  // Trusted batches reach the browser one at a time. The last send has to land
  // before the next begins, or a slow one lets its letters interleave.
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
  // When each of those points arrived. Presence ends without a goodbye when a
  // tab closes, so the tick uses this to expire a silent cursor.
  const peerSeen = new Map();
  // The page that point belongs to.
  let lastPointerUrl = null;
  // The last frame that reached this tab, so a change can be named once.
  let lastMediaFrame = null;
  // Why a remote pointer did not land. A silent filter looks like a broken
  // cursor, so the panel reads the last reason and the counts.
  const cursorDropCounts = {};
  let lastCursorDrop = null;
  let hostBuild = null;

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

  // Every colour another person holds. A person's own colour only counts when
  // the question is about someone else, so the roster can refuse a colour
  // without taking it away from the person who already has it.
  function usedColours(exceptId = '') {
    const used = new Set();
    if (exceptId !== peerId) used.add(currentColour.toLowerCase());
    for (const peer of state.peers.values()) {
      if (peer.id === exceptId || !isColour(peer.colour)) continue;
      used.add(peer.colour.toLowerCase());
    }
    return used;
  }

  function reconcileColour(id, wanted) {
    if (!isHost() || !id || id === peerId) return;
    const wantedColour = isColour(wanted) ? wanted : '';
    const used = usedColours(id);
    let next = wantedColour;
    if (!next || used.has(next.toLowerCase())) next = nextColour(used);
    const peer = state.peers.get(id);
    if (peer) peer.colour = next;
    if (next.toLowerCase() !== wantedColour.toLowerCase()) {
      sendMessage({ type: 'colour', peerId: id, colour: next, roomTime: roomTimeOf() });
    }
  }

  function setColour(value) {
    if (!isColour(value)) return false;
    const wanted = value.trim();
    // A colour another person holds is not a choice, with control or without.
    // Taking it would either move that person off their colour or leave two
    // people the same, so the room refuses it and the picker marks the swatch.
    if (usedColours(peerId).has(wanted.toLowerCase())) return false;
    currentColour = wanted;
    presence();
    return true;
  }

  function setRoomName(value) {
    const next = cleanRoomName(value);
    currentRoomName = next;
    state.roomName = next;
    sendMessage({
      type: 'roomname',
      peerId,
      roomName: next,
      roomTime: roomTimeOf(),
    });
    return next;
  }

  function setCursor(value) {
    currentCursor = cleanCursor(value);
    sendMessage({
      type: 'cursor',
      peerId,
      cursor: currentCursor,
      roomTime: roomTimeOf(),
    });
    return currentCursor;
  }

  function setSharePointer(on) {
    sharingPointer = Boolean(on);
    presence();
    return sharingPointer;
  }

  function noteSite(href) {
    return cursorSiteOf(href);
  }

  function sitesAllowed(url) {
    const key = cursorSiteOf(url);
    if (!key) return false;
    return allowedSites === null || allowedSites.includes(key);
  }

  function scrollAllowed(url) {
    const key = cursorSiteOf(url);
    if (!key) return false;
    return allowedScrollSites === null || allowedScrollSites.includes(key);
  }

  // A site the host just turned off loses its pointers at once, instead of
  // waiting for the next presence frame to drop each one.
  function dropDisallowed() {
    if (!cursor) return;
    let dropped = false;
    for (const [id, entry] of peerPoints) {
      if (sitesAllowed(entry.url)) continue;
      peerPoints.delete(id);
      peerSeen.delete(id);
      cursor.removePeer(id);
      dropped = true;
    }
    if (dropped) stats.cursors = cursor.stats().peers;
  }

  // The host owns the site list, and a change names every site at once. The
  // peers and the panel never read two half-updated rules.
  function setCursorSites(value) {
    if (!isHost()) return null;
    const next = cleanCursorSites(value) || [];
    allowedSites = next;
    sendMessage({ type: 'cursorpolicy', peerId, sites: next, roomTime: roomTimeOf() });
    dropDisallowed();
    if (onPolicy) {
      try {
        onPolicy(next);
      } catch {
        // A listener cannot break the room.
      }
    }
    return [...next];
  }

  // The mirror site list is separate from the pointer list and gates which
  // pages accept a shared cursor. Scrolling is never mirrored. A null list
  // means every site, and an empty list means none.
  function setScrollSites(value) {
    if (!isHost()) return null;
    const next = value === null ? null : cleanCursorSites(value) || [];
    allowedScrollSites = next;
    // A record queued before the change must not cross a site just switched off.
    sendMessage({ type: 'scrollpolicy', peerId, sites: next, roomTime: roomTimeOf() });
    return next === null ? null : [...next];
  }

  // Taking a site off the list also switches it off, so the list and the rule
  // never disagree about a site the host removed.
  function forgetSite(key, on) {
    if (!isHost()) return null;
    const clean = cursorSiteOf(key);
    if (!clean) return null;
    if (on === false) {
      forgottenSites.delete(clean);
    } else {
      forgottenSites.add(clean);
      if (Array.isArray(allowedSites) && allowedSites.includes(clean)) {
        setCursorSites(allowedSites.filter((site) => site !== clean));
      }
    }
    return [...forgottenSites];
  }

  function sendPolicy() {
    if (!isHost()) return false;
    sendMessage({
      type: 'cursorpolicy',
      peerId,
      // No list means every site, and the peer has to hear that rule as it
      // is. An empty array is the host switching every site off instead.
      sites: allowedSites === null ? null : [...allowedSites],
      roomTime: roomTimeOf(),
    });
    // The scroll rule travels beside the pointer rule. A guest that joins late
    // gets both from this answer, and a policy change reaches the room at once.
    sendMessage({
      type: 'scrollpolicy',
      peerId,
      sites: allowedScrollSites === null ? null : [...allowedScrollSites],
      roomTime: roomTimeOf(),
    });
    return true;
  }

  // Names are a local view, so this never changes what reaches the room.
  function setShowNames(on) {
    showingNames = Boolean(on);
    if (cursor) {
      for (const [id, entry] of peerPoints) {
        cursor.setPeer({
          ...entry,
          id,
          point: pointPixels(entry.point),
          showName: showingNames,
        });
      }
    }
    return showingNames;
  }

  function hello() {
    sendMessage({
      type: 'hello',
      peerId,
      name,
      colour: currentColour,
      roomName: currentRoomName,
      cursor: currentCursor,
      ...(clientBuild ? { build: clientBuild } : {}),
      roomTime: roomTimeOf(),
    });
  }

  // A late guest needs the list as well as the roster, so every hello answers
  // with the host's current policy.
  function helloAnswer() {
    return sendPolicy();
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
    // A cursor image is close to the frame ceiling on its own. Sending every
    // peer's image inside one snapshot would overflow the frame, so the roster
    // travels first and each image follows in its own frame.
    const snapshot = state.snapshot({
      from: peerId,
      ...(clientBuild ? { build: clientBuild } : {}),
      scrollSites: allowedScrollSites === null ? null : [...allowedScrollSites],
      mediaRev,
    });
    snapshot.peers = snapshot.peers.map(({ cursor: _cursor, ...peer }) => peer);
    sendMessage(snapshot);
    if (!isHost()) return;
    // The host is not in its own roster, so a late guest would otherwise miss
    // the host's cursor until it changed.
    if (currentCursor) {
      sendMessage({
        type: 'cursor',
        peerId,
        cursor: currentCursor,
        roomTime: roomTimeOf(),
      });
    }
    for (const peer of state.peers.values()) {
      if (!peer.cursor) continue;
      sendMessage({
        type: 'cursor',
        peerId: peer.id,
        cursor: peer.cursor,
        roomTime: roomTimeOf(),
      });
    }
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

  // Any peer in the room can drive the shared playhead. Its room tab has no
  // player, so the state arrives from the tab that does. The background has
  // already dropped that report when playback sync is off.
  function pendingPeerMedia(key, local = now()) {
    if (!pendingPeerApply) return null;
    if (local >= pendingPeerApply.until) {
      pendingPeerApply = null;
      return null;
    }
    if (key && key !== pendingPeerApply.key) return null;
    const age = Math.max(0, (local - pendingPeerApply.at) / 1000);
    const position =
      pendingPeerApply.position +
      (pendingPeerApply.playing ? age * pendingPeerApply.rate : 0);
    return {
      key: pendingPeerApply.key,
      action: pendingPeerApply.action,
      position,
      playing: pendingPeerApply.playing,
      rate: pendingPeerApply.rate,
      volume: pendingPeerApply.volume,
      rev: pendingPeerApply.rev,
      from: pendingPeerApply.from,
      name: pendingPeerApply.name,
      at: local,
    };
  }

  function peerApplyStillPending(key, position, playing, rate, local) {
    if (!pendingPeerApply) return false;
    if (local >= pendingPeerApply.until) {
      pendingPeerApply = null;
      return false;
    }
    // A routine tick from another film (e.g. a periodic greet for an earlier
    // tab) must not wipe out the pending peer sync for a newly joined tab.
    if (key !== pendingPeerApply.key) return false;
    const age = Math.max(0, (local - pendingPeerApply.at) / 1000);
    const targetPos =
      pendingPeerApply.position +
      (pendingPeerApply.playing ? age * pendingPeerApply.rate : 0);
    const caughtUp =
      pendingPeerApply.action === 'seek'
        ? Math.abs(position - targetPos) <= 2.0 && playing === pendingPeerApply.playing
        : pendingPeerApply.action === 'play' || pendingPeerApply.action === 'pause'
          ? playing === pendingPeerApply.playing
          : pendingPeerApply.action === 'rate'
            ? Math.abs(rate - pendingPeerApply.rate) < 0.02
            : true;
    if (caughtUp) {
      pendingPeerApply = null;
      return false;
    }
    return true;
  }

  function knownHostMedia(key, local = now()) {
    if (!key) return null;
    const entry = hostKnownMedia.get(key);
    if (!entry) return null;
    if (local - entry.at > HOST_KNOWN_MEDIA_MS) {
      hostKnownMedia.delete(key);
      return null;
    }
    const age = Math.max(0, (local - entry.at) / 1000);
    const raw = entry.position + (entry.playing ? age * entry.rate : 0);
    const position = entry.duration > 0 ? Math.min(raw, entry.duration) : raw;
    return { ...entry, position };
  }

  function sendHostAnchor(anchor, local = now()) {
    if (!isHost() || !anchor || !anchor.key) return false;
    const rate = Number(anchor.rate || 1);
    sendMessage({
      type: 'media',
      peerId,
      key: anchor.key,
      title: String(anchor.title || '').slice(0, 120),
      music: Boolean(anchor.music),
      action: 'tick',
      position: Number(anchor.position || 0),
      playing: Boolean(anchor.playing),
      rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
      volume: Number(anchor.volume ?? 1),
      buffering: false,
      ad: false,
      rev: mediaRev,
      roomTime: local,
    });
    return true;
  }

  function sendMedia(state) {
    if (isHost()) return false;
    if (!state || typeof state !== 'object' || !state.key) return false;
    const action =
      typeof state.action === 'string' && state.action ? state.action : 'tick';
    const pos = localPosition(Number(state.position || 0), -alignOffset);
    const playing = Boolean(state.playing);
    const local = now();
    const actRev =
      action !== 'tick'
        ? Math.max(mediaRev, lastSentRev, pendingLocalAct ? pendingLocalAct.rev : 0) + 1
        : Math.max(mediaRev, lastSentRev);
    if (action !== 'tick') {
      lastSentRev = actRev;
      pendingLocalAct = {
        key: state.key,
        rev: actRev,
        action,
        position: pos,
        playing,
        at: local,
      };
    }
    sendMessage({
      type: 'media',
      peerId,
      key: state.key,
      action,
      // This peer's copy may sit seconds from the room's, and its tab reports
      // a position in that file, so the frame carries room time.
      position: pos,
      playing,
      rate: Number(state.rate || 1),
      volume: Number(state.volume ?? 1),
      buffering: Boolean(state.buffering),
      ad: Boolean(state.ad),
      rev: actRev,
      roomTime: roomTimeOf(local),
    });
    stats.mediaSent += 1;
    return true;
  }

  // A film tab's own report is fresher than the poll. The host sends it at
  // once, and the tick below remains the fallback when no report arrives.
  function sendHostMedia(state, local = now()) {
    if (!isHost()) return false;
    if (!state || typeof state !== 'object' || !state.key) return false;
    // A room frame names one instant. The film tab reads a position, and the
    // room sends it a moment later, so a report that carries the instant it was
    // read is carried forward to the send. A report with no such instant is
    // taken as current, which is what a tab from an older build sends. Without
    // this every guest extrapolates from a stamp later than the position, and
    // the gap is the age of the report, up to a whole tick of a hidden tab.
    const rate = Number(state.rate || 1);
    const playing = Boolean(state.playing);
    const sampledAt = Number(state.at);
    const sampled =
      Number.isFinite(sampledAt) && sampledAt > 0 && sampledAt <= local ? sampledAt : local;
    const read = Number(state.position || 0);
    const ahead = playing && sampled < local ? ((local - sampled) / 1000) * rate : 0;
    const limit = Number(state.duration || 0);
    const position = limit > 0 ? Math.min(read + ahead, limit) : read + ahead;
    // Only a report that carries a local act starts the host-priority window.
    // A report that merely repeats the peer's pause is not a host act, and
    // treating it as one dropped the peer's next seek. Keep the act itself, so
    // a dropped peer frame can name what the host did just before it.
    const act =
      state.action && state.action !== 'tick'
        ? typeof state.action === 'string'
          ? state.action
          : 'act'
        : null;
    if (act) {
      pendingPeerApply = null;
      mediaRev += 1;
      lastHostActAt = local;
      lastHostActKey = state.key;
      lastMediaActor = peerId;
      lastMediaKey = state.key;
      stats.lastLocalMediaAction = {
        name: name || peerId,
        peerId,
        action: act,
        position: Math.round(position * 1000) / 1000,
        rate,
        at: Math.round(local),
      };
    } else if (peerApplyStillPending(state.key, position, playing, rate, local)) {
      return false;
    }
    hostKnownMedia.set(state.key, {
      key: state.key,
      position,
      duration: limit > 0 ? limit : 0,
      playing,
      rate,
      volume: Number(state.volume ?? 1),
      title: String(state.title || '').slice(0, 120),
      music: Boolean(state.music),
      at: local,
    });
    if (hostKnownMedia.size > 16) {
      const oldest = hostKnownMedia.keys().next().value;
      if (oldest !== undefined) hostKnownMedia.delete(oldest);
    }
    const wireAction = ['play', 'pause', 'seek', 'rate'].includes(act) ? act : 'tick';
    stats.key = state.key;
    stats.position = Math.round(position * 1000) / 1000;
    stats.playing = playing;
    lastHostTick = local;
    sendMessage({
      type: 'media',
      peerId,
      key: state.key,
      title: String(state.title || '').slice(0, 120),
      music: Boolean(state.music),
      action: wireAction,
      position,
      playing,
      rate,
      volume: Number(state.volume ?? 1),
      buffering: Boolean(state.buffering),
      ad: Boolean(state.ad),
      rev: mediaRev,
      // The host owns the room clock, so its local time is room time.
      roomTime: local,
    });
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
    const peerBuild = cleanBuild(message.build);
    state.join({
      id: message.peerId,
      name: message.name,
      colour: message.colour,
      // The site list reads this, so a peer's page has to live on the roster.
      url: message.url,
      ...(peerBuild ? { build: peerBuild } : {}),
    });
    const point = sharePoint(message.point);
    const position = {
      id: message.peerId,
      name: message.name,
      colour: message.colour,
      // The share, because a tab that hands the cursor on needs the wire form.
      point,
      url: message.url,
      // The image travels in the roster, not in every frame. A viewer without
      // a custom cursor of its own still draws the sender's pick.
      cursor: (state.peers.get(message.peerId) || {}).cursor || null,
      showName: showingNames,
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
    // A pointer belongs to the site it was sent from. Two people reading
    // different sites never see each other's mouse, and the share keeps the
    // point honest when the two windows differ in size.
    const here = pageUrl ? pageUrl() : null;
    noteSite(here);
    noteSite(message.url);
    // The host names the sites that show pointers. A peer on any other site
    // is not a cursor here, even when the two pages share an origin.
    const decision = cursorDecision({
      peerUrl: message.url,
      here,
      sites: allowedSites,
      sharePointer: message.sharePointer !== false,
    });
    if (!decision.allow) {
      // The peer moved to another site, turned its pointer off, or the host
      // switched that site off. Keep the reason for the panel.
      cursorDropCounts[decision.reason] = (cursorDropCounts[decision.reason] || 0) + 1;
      lastCursorDrop = {
        peerId: message.peerId,
        reason: decision.reason,
        site: decision.site || null,
        at: local,
      };
      peerPoints.delete(message.peerId);
      peerSeen.delete(message.peerId);
      cursor.removePeer(message.peerId);
      stats.cursors = cursor.stats().peers;
      return;
    }
    peerPoints.set(message.peerId, position);
    peerSeen.set(message.peerId, local);
    cursor.setPeer({ ...position, point: pointPixels(point) });
    stats.cursors = cursor.stats().peers;
  }

  // A media act that reaches this tab can be refused before it reaches a
  // player. The panel names both the count and the reason, so a report says
  // why a pause or seek did not travel instead of leaving a gap.
  function noteMediaDrop(reason, message, local) {
    const action =
      typeof message.action === 'string' && message.action !== 'tick'
        ? message.action
        : null;
    // A routine tick is not an act a person made. Count it apart, or a hold
    // looks like it swallowed a dozen pause or seek commands when it only
    // stopped the clock from moving the film.
    if (!action) {
      stats.mediaDropTicks[reason] = (stats.mediaDropTicks[reason] || 0) + 1;
      return;
    }
    stats.mediaDrops[reason] = (stats.mediaDrops[reason] || 0) + 1;
    stats.lastMediaDrop = {
      at: Math.round(local),
      reason,
      action,
      peerId: message.peerId || null,
      name: (state.peers.get(message.peerId) || {}).name || message.name || null,
      position: Number.isFinite(Number(message.position))
        ? Math.round(Number(message.position) * 1000) / 1000
        : null,
      playing: Boolean(message.playing),
    };
    if (reason === 'host-priority' && Number.isFinite(lastHostActAt)) {
      stats.lastMediaDrop.hostActAt = Math.round(lastHostActAt);
      stats.lastMediaDrop.hostAct = stats.lastLocalMediaAction
        ? { ...stats.lastLocalMediaAction }
        : null;
    }
    const entry = { ...stats.lastMediaDrop };
    if (stats.lastMediaDrop.hostAct) entry.hostAct = { ...stats.lastMediaDrop.hostAct };
    stats.mediaDropHistory.push(entry);
    if (stats.mediaDropHistory.length > 8) stats.mediaDropHistory.shift();
  }

  function applyMedia(message, local) {
    // The relay fans out to every socket, so a frame also comes back to the tab
    // that sent it. A tab that applied its own anchor would chase itself, and a
    // page player answers that chase with an error overlay.
    if (message.peerId && message.peerId === peerId) {
      stats.mediaEcho += 1;
      return { ok: true, ignored: 'self' };
    }
    const explicit =
      typeof message.action === 'string' && message.action !== 'tick'
        ? message.action
        : null;
    const incomingRev =
      message.rev !== undefined && message.rev !== null && Number.isFinite(Number(message.rev))
        ? Number(message.rev)
        : null;
    // The adapter owns every read and write. A player object and a media
    // element meet one interface, so the peer path never touches a field.
    const picked = media.pick(message.key);
    const read = picked ? media.state(picked) : null;
    const known = isHost() ? knownHostMedia(message.key, local) : null;
    const hostRead = read || known;
    // A host's own play, pause or seek wins for a short window on that film.
    // A host act on a different film (e.g. pausing YouTube before joining a
    // peer's Anidap tab) must not block the joined film's sync reply.
    if (
      isHost() &&
      local - lastHostActAt < HOST_MEDIA_PRIORITY_MS &&
      (!lastHostActKey || message.key === lastHostActKey)
    ) {
      noteMediaDrop('host-priority', message, local);
      return { ok: true, ignored: 'host-priority' };
    }
    // Reject stale-revision peer acts on the same film that arrived after a
    // newer host or same-peer media act. When a different peer acts concurrently
    // at an equal peer-created rev (multi-peer hand-off), or on a different film
    // key the host is not actively playing, accept it as the latest explicit act
    // and bump mediaRev.
    let multiActorBump = false;
    if (isHost() && incomingRev !== null) {
      const sameFilm = !lastMediaKey || message.key === lastMediaKey || Boolean(hostRead);
      if (explicit === null) {
        if (sameFilm && incomingRev < mediaRev) {
          noteMediaDrop('stale-rev', message, local);
          return { ok: true, ignored: 'stale-rev' };
        }
      } else if (sameFilm && incomingRev < mediaRev) {
        noteMediaDrop('stale-rev', message, local);
        if (hostRead) sendHostAnchor(hostRead, local);
        return { ok: true, ignored: 'stale-rev' };
      } else if (sameFilm && incomingRev === mediaRev) {
        const peerHandOff =
          lastMediaActor !== null &&
          lastMediaActor !== peerId &&
          message.peerId &&
          message.peerId !== lastMediaActor;
        if (peerHandOff) {
          multiActorBump = true;
        } else {
          noteMediaDrop('stale-rev', message, local);
          if (hostRead) sendHostAnchor(hostRead, local);
          return { ok: true, ignored: 'stale-rev' };
        }
      } else if (!sameFilm && incomingRev <= mediaRev) {
        multiActorBump = true;
      }
    }
    // Protect a peer's just-issued local act from already-in-flight
    // routine host ticks (or older rev frames) until the host acknowledges or
    // supersedes it on that film.
    if (!isHost() && pendingLocalAct) {
      if (local - pendingLocalAct.at >= PEER_ACT_GUARD_MS) {
        pendingLocalAct = null;
      } else if (!pendingLocalAct.key || pendingLocalAct.key === message.key) {
        if (
          (incomingRev !== null && incomingRev >= pendingLocalAct.rev) ||
          (incomingRev === null && explicit !== null)
        ) {
          pendingLocalAct = null;
        } else {
          noteMediaDrop('local-act-pending', message, local);
          return { ok: true, ignored: 'local-act-pending' };
        }
      }
    }
    if (!isHost() && incomingRev !== null) {
      if (incomingRev < mediaRev && lastMediaFrame && message.key === lastMediaFrame.key) {
        noteMediaDrop('stale-rev', message, local);
        return { ok: true, ignored: 'stale-rev' };
      }
      if (incomingRev > mediaRev) {
        mediaRev = incomingRev;
      }
    }
    if (read) {
      stats.key = read.key;
      stats.position = Math.round(read.position * 1000) / 1000;
      stats.playing = read.playing;
    }
    // A peer's play, pause or rate change says what the room should do, not
    // where the host's copy is. Its own playhead can sit behind the host, so
    // only a seek carries a new position and uses the peer's timestamp.
    const derived = explicit
      ? null
      : mediaAction(lastMediaFrame, { ...message, position: message.position }, local);
    const action = explicit || derived || null;
    // The host is the timekeeper, so only an explicit seek may move its
    // playhead. Even when media.pick() is null on the host room tab, anchor
    // non-seek peer acts to the host's fresh known playhead for this film.
    const hostAnchor = isHost() && Boolean(hostRead) && explicit !== 'seek';
    const base = hostAnchor ? hostRead.position : localPosition(message.position, alignOffset);
    const frameRate = Number(message.rate);
    const rate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 1;
    const rawExpected = hostAnchor
      ? base
      : base + (message.playing ? ((roomTimeOf(local) - message.roomTime) / 1000) * rate : 0);
    // A seek past the end is clamped by every player. Name the point that will
    // actually land, not the request, or the report looks like a jump to a
    // position neither copy ever held.
    const duration = Number(hostRead && hostRead.duration);
    const expected =
      duration > 0
        ? Math.max(0, Math.min(rawExpected, duration))
        : Math.max(0, rawExpected);
    // The notice names a person, not a socket id. The room knows the name the
    // peer chose when it joined.
    const actor =
      (state.peers.get(message.peerId) || {}).name || message.name || message.peerId;
    // The panel and the film tab share one reading of the change. The expected
    // position is what this tab assumes the frame means, so a seek is measured
    // against the frame that came before it.
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
        peerId: message.peerId || null,
        action,
        position: expected,
        rate: Number(message.rate || 1),
        text: actionText({ name: actor, action, position: expected, rate: message.rate }),
        at: Math.round(local),
      };
    }
    // The host's room tab holds no player. Any peer drives the film
    // through the tab that does, and the host keeps sending its own anchor.
    if (isHost()) {
      if (!onMedia) {
        noteMediaDrop('no-media', message, local);
        return { ok: false, reason: 'no-media' };
      }
      const nextRev = multiActorBump
        ? Math.max(mediaRev, incomingRev || 0) + 1
        : incomingRev !== null && incomingRev > mediaRev
          ? incomingRev
          : explicit
            ? mediaRev + 1
            : mediaRev;
      try {
        if (
          onMedia({
            ...message,
            name: actor,
            action: action || null,
            expected,
            rev: nextRev,
            at: local,
          }) === false
        ) {
          noteMediaDrop('no-media', message, local);
          return { ok: false, reason: 'no-media' };
        }
        mediaRev = nextRev;
        if (explicit) {
          lastMediaActor = message.peerId || null;
          lastMediaKey = message.key;
        }
        if (picked && explicit) {
          if (explicit === 'seek') {
            media.apply(picked, { action: 'seek', position: expected, rate });
            media.apply(picked, { action: message.playing ? 'play' : 'pause' });
          } else if (explicit === 'play' || explicit === 'pause') {
            media.apply(picked, { action: message.playing ? 'play' : 'pause' });
          } else if (explicit === 'rate') {
            media.apply(picked, { action: 'tick', rate });
          }
        }
        if (known && explicit) {
          hostKnownMedia.set(message.key, {
            ...known,
            position: expected,
            playing: Boolean(message.playing),
            rate,
            volume: Number(message.volume ?? known.volume),
            at: local,
          });
        }
        if (explicit && ['seek', 'play', 'pause', 'rate'].includes(explicit)) {
          const activeHostTab = Boolean(picked || known);
          const applyWindow = activeHostTab ? HOST_PEER_APPLY_MS : HOST_PEER_JOIN_APPLY_MS;
          pendingPeerApply = {
            key: message.key,
            action: explicit,
            position: expected,
            playing: Boolean(message.playing),
            rate,
            volume: Number(message.volume ?? (hostRead ? hostRead.volume : 1)),
            rev: mediaRev,
            from: message.peerId || null,
            name: actor || null,
            at: local,
            until: local + applyWindow,
          };
          stats.key = message.key;
          stats.position = Math.round(expected * 1000) / 1000;
          stats.playing = Boolean(message.playing);
          lastHostTick = local;
          sendMessage({
            type: 'media',
            peerId,
            key: message.key,
            title: String((hostRead && hostRead.title) || message.title || '').slice(0, 120),
            music: Boolean((hostRead && hostRead.music) || message.music),
            action: explicit,
            position: expected,
            playing: Boolean(message.playing),
            rate,
            volume: Number(message.volume ?? (hostRead ? hostRead.volume : 1)),
            buffering: false,
            ad: false,
            rev: mediaRev,
            roomTime: local,
          });
        }
        stats.relayed += 1;
        return { ok: true, relayed: true };
      } catch (error) {
        noteMediaDrop('handler', message, local);
        return { ok: false, reason: 'handler', error: error.message };
      }
    }
    // A room tab with no player of its own hands the frame to the tab that
    // shows the film. The expected position is anchored on this tab's clock,
    // so the tab needs no clock estimate of its own.
    if (!read) {
      if (!onMedia) {
        noteMediaDrop('no-media', message, local);
        return { ok: false, reason: 'no-media' };
      }
      try {
        if (
          onMedia({
            ...message,
            name: actor,
            action: action || null,
            expected,
            ...(incomingRev !== null ? { rev: incomingRev } : {}),
            at: local,
          }) === false
        ) {
          noteMediaDrop('no-media', message, local);
          return { ok: false, reason: 'no-media' };
        }
        stats.relayed += 1;
        return { ok: true, relayed: true };
      } catch (error) {
        noteMediaDrop('handler', message, local);
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
    // The drift logic holds a seek for its own cooldown, so the settle window
    // never ends before another correction would be allowed.
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
    const flags = media.flags(picked);
    // Check the buffered range before committing a seek into DriftController;
    // otherwise a buffer wait consumes the seek cooldown and double-counts seeks.
    const preview = decideDrift(driftMs, flags);
    if (preview.action === 'seek' && !drift.coolingDown()) {
      const max = Number.isFinite(read.duration) && read.duration > 0 ? read.duration : expected;
      const target = Math.max(0, Math.min(expected, max));
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
    }
    const step = drift.tick(driftMs, flags);

    if (step.action === 'seek') {
      const max = Number.isFinite(read.duration) && read.duration > 0 ? read.duration : expected;
      const target = Math.max(0, Math.min(expected, max));
      waitingSince = null;
      media.apply(picked, { action: 'seek', position: target });
      lastSeekAt = local;
      lastSeekTarget = Math.round(target * 1000) / 1000;
      stats.corrections += 1;
      if (read.rate !== 1) media.apply(picked, { action: 'tick', rate: 1 });
      // A seek can leave the player paused. The room is playing, so play.
      if (message.playing && !read.playing) media.apply(picked, { action: 'play' });
    } else if (step.action === 'pause') {
      waitingSince = null;
      // The adapter knows whether a buffering player needs a pause, so the
      // decision passes through rather than being second-guessed here.
      media.apply(picked, { action: 'pause' });
      if (read.rate !== 1) media.apply(picked, { action: 'tick', rate: 1 });
    } else {
      waitingSince = null;
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
  // A page that measured this copy offline can set the offset without a wire
  // round trip. A number is a confident local measurement. The same rules
  // apply to an object, and null clears it. This is the local-file path: a
  // caller reads the JSON from disk and hands the object here.
  function setAlignOffset(value) {
    const payload =
      value && typeof value === 'object'
        ? value
        : { offsetMs: Number(value), confidence: 1 };
    const accepted = value === null || value === undefined ? null : acceptOffset(payload);
    alignOffset = accepted ? accepted.offsetMs : 0;
    alignState = accepted;
    return accepted;
  }

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
    // Host scroll is never mirrored to guests, even if an older host sends a
    // non-zero scroll ratio in its snapshot.
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
      case 'hello': {
        const joined = { id: message.peerId, name: message.name, colour: message.colour };
        if (message.cursor !== undefined) joined.cursor = cleanCursor(message.cursor);
        const peerBuild = cleanBuild(message.build);
        if (peerBuild) joined.build = peerBuild;
        state.join(joined);
        if (!isHost() && message.roomName) {
          currentRoomName = cleanRoomName(message.roomName);
          state.roomName = currentRoomName;
        }
        if (isHost()) {
          reconcileColour(message.peerId, message.colour);
          // A peer that joins or reloads says hello; send the current roster
          // and site policy.
          sendSnapshot();
          helloAnswer();
        }
        return { ok: true };
      }
      case 'input':
        // Remote DOM input is not relayed. Room apps sync their own state
        // through app messages, so an input frame is refused here.
        return { ok: false, reason: 'input-disabled' };
      case 'snapshot':
        if (isHost()) return { ok: true, ignored: 'host' };
        if (!message.from || message.from !== currentHost) {
          return { ok: true, ignored: 'not-host' };
        }
        if (message.build) hostBuild = cleanBuild(message.build);
        state.applySnapshot(message);
        if (
          message.mediaRev !== undefined &&
          message.mediaRev !== null &&
          Number.isFinite(Number(message.mediaRev)) &&
          Number(message.mediaRev) >= 0
        ) {
          mediaRev = Number(message.mediaRev);
          lastSentRev = mediaRev;
          pendingLocalAct = null;
        }

        if (message.scrollSites !== undefined) {
          allowedScrollSites =
            message.scrollSites === null ? null : cleanCursorSites(message.scrollSites) || [];
          if (onScrollPolicy) {
            try {
              onScrollPolicy(allowedScrollSites);
            } catch {
              // A listener cannot break the room.
            }
          }
        }
        if (!isHost() && message.roomName) {
          currentRoomName = cleanRoomName(message.roomName);
          state.roomName = currentRoomName;
        }
        applyPeers();
        followSnapshot(message);
        return { ok: true };
      case 'nav':
        if (isHost()) return { ok: true, ignored: 'host' };
        if (!message.from || message.from !== currentHost) {
          return { ok: true, ignored: 'not-host' };
        }
        state.applyNav({ url: message.url });
        if (navigate) navigate(message.url);
        return { ok: true, url: message.url };
      case 'view': {
        // A view names the page it came from. Without that identity a host
        // scroll could land on a guest that had moved to another page, which
        // looks like the room scrolling a site the host never meant to drive.
        const here = viewport ? viewport() : null;
        if (message.url && here && here.url && message.url !== here.url) {
          return { ok: true, ignored: 'other-page' };
        }
        if (message.url && !scrollAllowed(message.url)) {
          return { ok: true, ignored: 'site-off' };
        }
        const applied = state.applyView({ scroll: message.scroll, fingerprint: message.fingerprint });
        stats.layoutMismatch = applied.mismatch;
        // The notice belongs to the mismatch that caused it. Once the pages
        // line up again the banner has nothing to say.
        if (!applied.mismatch) stats.layoutNotice = null;
        // Host scroll is never mirrored to guests; view frames only update
        // layout-mismatch checks for relayed clicks.
        return { ok: true, ...applied };
      }
      case 'presence':
        applyPresence(message, local);
        if (isHost() && message.peerId !== peerId) {
          reconcileColour(message.peerId, message.colour);
        }
        return { ok: true };
      case 'colour':
        if (message.peerId && isColour(message.colour)) {
          state.join({ id: message.peerId, colour: message.colour });
          if (message.peerId === peerId) currentColour = message.colour;
        }
        return { ok: true };
      case 'roomname': {
        const next = cleanRoomName(message.roomName);
        currentRoomName = next;
        state.roomName = next;
        // A guest can rename too. The host repeats the name so every other
        // guest hears it, not only the host.
        if (isHost() && message.peerId && message.peerId !== peerId) {
          sendMessage({ ...message, roomTime: roomTimeOf() });
        }
        return { ok: true, roomName: next };
      }
      case 'cursor':
        if (message.peerId && message.peerId !== peerId) {
          state.join({ id: message.peerId, cursor: cleanCursor(message.cursor) });
        }
        return { ok: true };
      case 'cursorpolicy': {
        // The host is the authority. A frame that echoes its own list back is
        // not a change.
        if (isHost()) return { ok: true, ignored: 'host' };
        if (message.sites !== null && !Array.isArray(message.sites)) {
          return { ok: false, reason: 'bad-sites' };
        }
        const next = message.sites === null ? null : cleanCursorSites(message.sites) || [];
        allowedSites = next;
        dropDisallowed();
        if (onPolicy) {
          try {
            onPolicy(next);
          } catch {
            // A listener cannot break the room.
          }
        }
        return { ok: true, sites: next };
      }
      case 'scrollpolicy': {
        // The host is the authority. A frame that echoes its own list back is
        // not a change. Null means every site; an empty list means none.
        if (isHost()) return { ok: true, ignored: 'host' };
        if (message.sites !== null && !Array.isArray(message.sites)) {
          return { ok: false, reason: 'bad-sites' };
        }
        const next = message.sites === null ? null : cleanCursorSites(message.sites) || [];
        allowedScrollSites = next;
            if (onScrollPolicy) {
          try {
            onScrollPolicy(next);
          } catch {
            // A listener cannot break the room.
          }
        }
        return { ok: true, sites: next };
      }
      case 'media':
        return applyMedia(message, local);
      case 'app': {
        // The relay fans out to every socket including our own; a page handler
        // should not see its own message come back.
        if (message.peerId === peerId) return { ok: true, ignored: 'self' };
        // An alignment measurement is the one app message the room reads
        // itself. A peer may not push one faster than once a second, and a
        // payload with a bad field is dropped rather than repaired. This is
        // a claim about the sender's copy, so it is recorded but never applied
        // to the receiver's player. One peer's offset must not move another's.
        if (message.name === APP_NAME) {
          if (!state.allowAlign(message.peerId)) return { ok: true, ignored: 'align-rate' };
          const accepted = acceptOffset(message.data);
          if (!accepted) return { ok: true, ignored: 'align-payload' };
          alignPeers.set(message.peerId, { ...accepted, at: Math.round(local) });
          stats.appReceived += 1;
          stats.lastApp = { peerId: message.peerId, name: message.name, data: message.data };
          return { ok: true, align: true, peerId: message.peerId };
        }
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
      case 'bye': {
        // A host that says goodbye hands the room to the smallest live id. A
        // peer that leaves only leaves.
        const departed = message.peerId;
        if (departed && departed !== peerId) {
          state.leave(departed);
        }
        if (departed === currentHost) {
          migrateHost(departed);
        }
        return { ok: true, host: currentHost };
      }
      default:
        return { ok: true };
    }
  }

  function presence(peer = {}) {
    const message = {
      type: 'presence',
      peerId: peer.id || peerId,
      name: peer.name || name,
      colour: peer.colour || currentColour,
      // A person can keep their pointer off every other screen. Presence still
      // carries the identity and clock; a zero point only hides the cursor.
      point: sharingPointer
        ? peer.point || lastPointer || { x: 0, y: 0 }
        : { x: 0, y: 0 },
      roomTime: roomTimeOf(),
    };
    // The page this cursor is on. The room tab forwards the frame, so the
    // pointer can land on any site this browser has open.
    const here = peer.url || lastPointerUrl || (pageUrl ? pageUrl() : null);
    if (here) message.url = here;
    message.sharePointer = sharingPointer;
    if (clientBuild) message.build = clientBuild;
    noteSite(here);
    sendMessage(message);
  }

  // Layer 1 on the host: publishes URL changes and tracks visited sites.
  // Host scroll position is kept local and never broadcast to guests.
  function pollViewport(local) {
    if (!viewport || local - lastViewTick < VIEW_TICK_MS) return;
    lastViewTick = local;
    const view = viewport();
    if (!view) return;
    if (view.url) noteSite(view.url);
    if (view.url && view.url !== lastUrl) {
      lastUrl = view.url;
      state.applyNav({ url: view.url });
      sendMessage({ type: 'nav', from: peerId, url: view.url, roomTime: local });
    }
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
    for (const [id, entry] of peerPoints) {
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

  // The page this browser is looking at. A tab that holds the film names the
  // page with a pointer move, but a browser sitting still still has an active
  // tab. The host needs that site for its list and its policy, or the room tab
  // keeps naming its own relay page for the whole session.
  function setPageUrl(url) {
    lastPointerUrl = url ? String(url) : null;
    noteSite(lastPointerUrl);
    return true;
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
    // A cursor is only as live as its last frame. A peer that closed its tab
    // sends no goodbye, so silence is what removes its pointer here.
    if (cursor && peerPoints.size) {
      let dropped = false;
      for (const id of peerPoints.keys()) {
        const seen = peerSeen.get(id) ?? -Infinity;
        if (local - seen < PEER_IDLE_MS) continue;
        peerPoints.delete(id);
        peerSeen.delete(id);
        cursor.removePeer(id);
        dropped = true;
      }
      if (dropped) stats.cursors = cursor.stats().peers;
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
        if (
          !peerApplyStillPending(
            nowState.key,
            nowState.position,
            nowState.playing,
            nowState.rate,
            local
          )
        ) {
          stats.key = nowState.key;
          stats.position = Math.round(nowState.position * 1000) / 1000;
          stats.playing = nowState.playing;
          sendMessage({
            type: 'media',
            peerId,
            key: nowState.key,
            title: String(nowState.title || '').slice(0, 120),
            music: Boolean(nowState.music),
            action: 'tick',
            position: nowState.position,
            playing: nowState.playing,
            rate: nowState.rate,
            volume: nowState.volume,
            buffering: Boolean(flags.buffering),
            ad: Boolean(flags.adPlaying),
            rev: mediaRev,
            // The host owns the room clock, so its local time is room time.
            roomTime: local,
          });
        }
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
    return {
      role: currentRole,
      peerId,
      name: name || peerId,
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
      align: alignState,
      peers: state.peers.size,
      // The panel needs live peer details. The count stays a number so
      // the harness assertions do not change.
      peerList: [...state.peers.values()].map((peer) => ({
        id: peer.id,
        name: peer.name || peer.id,
        colour: peer.colour || null,
        cursor: peer.cursor || null,
        build: peer.build || null,
        self: peer.id === peerId,
      })),
      roomName: currentRoomName,
      hostPriority: {
        lastActAt: Number.isFinite(lastHostActAt) ? Math.round(lastHostActAt) : null,
        remainingMs: Number.isFinite(lastHostActAt)
          ? Math.max(0, Math.round(HOST_MEDIA_PRIORITY_MS - (now() - lastHostActAt)))
          : 0,
      },
      lastMediaFrame: lastMediaFrame
        ? {
            ...lastMediaFrame,
            ageMs: Math.max(0, Math.round(now() - Number(lastMediaFrame.at || now()))),
          }
        : null,
      lastSeek: {
        at: Number.isFinite(lastSeekAt) ? Math.round(lastSeekAt) : null,
        target: Number.isFinite(lastSeekTarget) ? lastSeekTarget : null,
        waitingSince: Number.isFinite(waitingSince) ? Math.round(waitingSince) : null,
      },
      colour: currentColour,
      cursor: currentCursor,
      sharePointer: sharingPointer,
      cursorSites: allowedSites === null ? null : [...allowedSites],
      cursorSeen: [...liveSites()],
      scrollSites: allowedScrollSites === null ? null : [...allowedScrollSites],
      scrollSeen: [...liveSites()],
      cursorForgot: [...forgottenSites],
      cursorNames: showingNames,
      cursorDrops: { ...cursorDropCounts },
      lastCursorDrop,
      build: clientBuild,
      hostBuild,
      colours: ROOM_COLOURS,
      url: state.url,
      scroll: Math.round(state.scroll * 1000) / 1000,
      layoutMismatch: stats.layoutMismatch,
      layoutNotice: stats.layoutNotice,
      latency: latencyStats(),
      latencies: latencies.slice(-latencyLimit),
      presenceByPeer: Object.fromEntries(
        [...presenceByPeer].map(([id, list]) => [id, summarize(list)])
      ),

      lastMediaAction: stats.lastMediaAction,
      lastLocalMediaAction: stats.lastLocalMediaAction
        ? { ...stats.lastLocalMediaAction }
        : null,
      mediaDrops: { ...stats.mediaDrops },
      mediaDropTicks: { ...stats.mediaDropTicks },
      lastMediaDrop: stats.lastMediaDrop,
      mediaDropHistory: stats.mediaDropHistory.map((entry) => ({
        ...entry,
        hostAct: entry.hostAct ? { ...entry.hostAct } : null,
      })),
      capture: false,
      inputApplied: stats.inputApplied,
      inputDropped: stats.inputDropped,
      inputReasons: stats.inputReasons,
      input: null,
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

  return {
    role: currentRole,
    room,
    peerId,
    receive,
    sendApp,
    sendMedia,
    sendHostMedia,
    pendingPeerMedia,
    hostId: () => currentHost,
    tick,
    presence,
    setPointer,
    setPageUrl,
    setColour,
    setRoomName,
    setCursor,
    setSharePointer,
    setCursorSites,
    setScrollSites,
    forgetSite,
    setShowNames,
    sendPolicy,
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
    setAlignOffset,
    cursor,
    stats,
  };
}
