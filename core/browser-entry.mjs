// Content-script entry. The bridge loads this file, and it starts the sync
// client against the relay. Everything it reports lands in
// document.documentElement.dataset.brosr, so the harness can read the same
// numbers whether the core runs in the content script or in the page.

import { createRoomClient, PEER_IDLE_MS, PRESENCE_TICK_MS } from './sync.mjs';
import { PROTOCOL_VERSION } from './protocol.mjs';
import { TAB_APP, tabClose, tabOpen } from './tabs.mjs';
import { PANEL_APP } from './panel.mjs';
import { YouTubeAdapter, playerKey } from './youtube.mjs';
import {
  RELAY_TICK_MS,
  RelayMediaAdapter,
  RemoteMediaSync,
  filmUrl,
  framePageHref,
  freshState,
  mediaEchoMatches,
  mediaStateFromDocument,
  remoteMediaEcho,
  viewerState,
} from './media-relay.mjs';
import { openFrame, sealFrame, roomKey } from './seal.mjs';
import { ActionNotice, CursorOverlay, mediaAction } from './overlay.mjs';
import {
  cleanCursor,
  cleanCursorSites,
  cleanRoomName,
  cursorSiteOf,
  isColour,
  randomColour,
  siteOf,
} from './cursor.mjs';
import { createTrustClient, prepareRecords } from './trust.mjs';

// Gecko exposes browser, Chrome exposes chrome. The core runs in both.
const api = globalThis.browser || globalThis.chrome || null;
// The manifest is the one build number both engines expose to a content
// script. The protocol travels beside it, so a stale bridge has a name.
const bridgeBuild = (() => {
  try {
    const manifest = api && api.runtime && api.runtime.getManifest ? api.runtime.getManifest() : null;
    return manifest ? { version: manifest.version || null, protocol: PROTOCOL_VERSION } : null;
  } catch {
    return null;
  }
})();

// A setting survives a navigation and a browser restart. The page path reads
// these keys before the room path starts, so they belong to the module.
function readSetting(key) {
  try {
    return globalThis.localStorage ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function writeSetting(key, value) {
  try {
    if (!globalThis.localStorage) return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // A refused store costs this room only.
  }
}

// The person who picked a cursor sees it on their own screen too. The image
// goes on the document, so every site this browser opens carries it.
const CURSOR_HOTSPOT = 0.12;
function applyOwnCursor(cursor) {
  const root = document.documentElement;
  if (!root) return;
  if (cursor && cursor.src) {
    const hotspot = Math.max(0, Math.round((Number(cursor.w) || 32) * CURSOR_HOTSPOT));
    root.style.setProperty('cursor', `url("${cursor.src}") ${hotspot} ${hotspot}, auto`);
  } else {
    root.style.removeProperty('cursor');
  }
}

// The panel button stays off unrelated pages. A room page is the landing page
// opened with room params, or a fixture whose name starts with one of the room
// words. This stays in step with isRoomPage() in bridge/background.js.
const ROOM_FIXTURE = /^https?:\/\/[^/]+\/(room|media|board|form|ad|sync|layout)[^/]*\.html/;
// Canvas, Notes and Chess hold their own room socket for their own content.
// The core must not open a second room client there under the same peer id,
// because two clients fight over presence and navigation. It still relays the
// pointer and the film from such a page, which is what the room tab draws from.
const ownsRoom = () => Boolean(document.querySelector('meta[name="brosr-own-room"]'));
function isRoomPage(href) {
  try {
    const url = new URL(href);
    if (url.searchParams.has('room') && url.searchParams.has('peer')) return true;
  } catch {
    return false;
  }
  return ROOM_FIXTURE.test(href);
}

// A viewer report rides the room's app channel. Each one says where this
// browser's own tab has the film, so every panel can show who is in sync.
const VIEWER_APP = 'media-viewer';
const VIEWER_TICK_MS = 2000;
// A tab that stops reporting is gone. Presence prunes the peer, and this expiry
// covers a peer that is still present but has no panel open.
const VIEWER_STALE_MS = 8000;

// A cursor belongs to the page it is on. The room params name the tab, not the
// page, so two people in one room still share one page key.
const TAB_PARAMS = [
  'role',
  'peer',
  'host',
  'room',
  'rname',
  'name',
  'bias',
  'relay',
  'panel',
  'selftest',
  'capture',
  'grant',
];
function cursorKey(href) {
  try {
    const url = new URL(href);
    for (const key of TAB_PARAMS) url.searchParams.delete(key);
    url.hash = '';
    return url.toString();
  } catch {
    return href;
  }
}

// A tab outside the room can still hold the film, and the room tab holds the
// socket. Media and pointers cross that gap: the room tab forwards every
// cursor, so a peer pointer shows on whatever site this person reads.
async function startPageMedia() {
  const runtime = api && api.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function' || !runtime.onMessage) {
    return { started: false, reason: 'no-runtime' };
  }
  const send = (message) => {
    try {
      return Promise.resolve(runtime.sendMessage(message)).catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  };

  // The page that holds the player names the film when the source is a blob or
  // a manifest. A Cinecat player frame names the title page that embedded it,
  // because the frame URL alone names a provider and not the film. Any other
  // frame keeps its own address, so an embedded player still works as before.
  const embedded = window.top !== window;
  const pageHref = () =>
    framePageHref({
      href: location.href,
      referrer: document.referrer,
      embedded,
    });

  // A page with a player tells the room where the film is. The room tab has
  // the socket, so this page only relays. A page without a player takes the
  // room anchor instead, and the tab that shows the film applies it.
  const remote = new RemoteMediaSync({
    document,
    href: pageHref(),
    hostname: location.hostname,
    pageHref,
  });
  const relay = {
    key: '',
    position: 0,
    playing: false,
    ad: false,
    sends: 0,
    applies: 0,
    last: null,
    localDrops: {},
    lastLocalDrop: null,
  };
  const publishRelay = () => {
    document.documentElement.dataset.brosrRelay = JSON.stringify(relay);
  };
  // A frame that reaches this tab is remote by contract: the room tab drops
  // this browser's own report before it relays anything. The notice names the
  // person behind the change, and a skipped frame resets the baseline so the
  // end of an ad never reads as a person seeking.
  // Cursors reach every tab of this browser, and each tab draws only the
  // peers on its own site. The room tab owns the socket and forwards each
  // frame here.
  // A page that owns its room draws its own pointers, so a second layer here
  // would put a duplicate dot beside every one of them.
  const cursorLayer =
    window.top === window && !ownsRoom() ? new CursorOverlay({ document }).attach() : null;
  const cursorPoints = new Map();
  // The host names the sites that show pointers, and every tab keeps its own
  // copy. A host that never edited the list allows every site, which null says.
  let allowedSites = null;
  let showNames = readSetting('brosr-cursor-names') !== '0';
  // The harness reads this the same way it reads the cursor count.
  document.documentElement.dataset.brosrCursorSites = JSON.stringify(allowedSites);
  const siteAllowed = (href) => {
    const key = cursorSiteOf(href);
    if (!key) return false;
    return allowedSites === null || allowedSites.includes(key);
  };
  const pixelPoint = (point) => ({
    x: Math.max(0, Math.min(1, Number(point && point.x) || 0)) * window.innerWidth,
    y: Math.max(0, Math.min(1, Number(point && point.y) || 0)) * window.innerHeight,
  });
  const placeCursor = (entry) => {
    if (!cursorLayer || !entry || !entry.id) return;
    // A peer pointer belongs to the site it was sent from, and the host names
    // the sites that show pointers. A tab on another site, or on a site the
    // host turned off, draws nothing.
    if (
      !entry.url ||
      !siteAllowed(entry.url) ||
      cursorSiteOf(entry.url) !== cursorSiteOf(location.href)
    ) {
      if (cursorPoints.delete(entry.id)) {
        cursorLayer.removePeer(entry.id);
        document.documentElement.dataset.brosrCursors = String(cursorPoints.size);
      }
      return;
    }
    const share = entry.point || { x: 0, y: 0 };
    cursorPoints.set(entry.id, { ...entry, point: share, at: Date.now() });
    cursorLayer.setPeer({
      id: entry.id,
      name: entry.name,
      colour: entry.colour,
      cursor: entry.cursor || null,
      showName: showNames,
      point: pixelPoint(share),
    });
    // The overlay lives in a closed shadow root, so this count is the only
    // readable proof that a peer pointer reached this page.
    document.documentElement.dataset.brosrCursors = String(cursorPoints.size);
  };
  if (window.top === window && typeof window.addEventListener === 'function') {
    window.addEventListener(
      'resize',
      () => {
        for (const [id, entry] of cursorPoints) placeCursor({ ...entry, id });
      },
      { passive: true }
    );
    // A peer that closes its tab stops forwarding frames. Its last point then
    // has no owner, so the layer forgets it rather than drawing a ghost mouse
    // until this page reloads.
    setInterval(() => {
      if (!cursorPoints.size) return;
      const at = Date.now();
      let dropped = false;
      for (const [id, entry] of cursorPoints) {
        if (at - entry.at < PEER_IDLE_MS) continue;
        cursorPoints.delete(id);
        cursorLayer.removePeer(id);
        dropped = true;
      }
      if (dropped) {
        document.documentElement.dataset.brosrCursors = String(cursorPoints.size);
      }
    }, 1000);
  }

  // A pointer on any site tells the room tab where this person is, so a peer
  // sees the cursor move here and not only on the room page. Replayed input is
  // skipped, because that pointer belongs to the other person.
  if (window.top === window && typeof document.addEventListener === 'function') {
    let lastPointAt = 0;
    document.addEventListener(
      'pointermove',
      (event) => {
        if (!event.isTrusted) return;
        const at = Date.now();
        if (at - lastPointAt < 50) return;
        lastPointAt = at;
        const width = Math.max(1, window.innerWidth);
        const height = Math.max(1, window.innerHeight);
        send({
          type: 'brosr:presence-point',
          point: { x: event.clientX / width, y: event.clientY / height },
          url: location.href,
        });
      },
      { passive: true, capture: true }
    );
  }

  const notice = new ActionNotice({ document });
  let lastApplied = null;
  // A frame this tab applies moves its own player, and that player answers
  // with the action it was told to perform. Only that action is an echo; a
  // person's pause after a remote seek is a new act and must travel.
  let remoteEcho = null;
  // A hidden tab throttles its own report timer. The room still sends applies,
  // so the frame that owns the player answers one with its current state.
  let lastHiddenReportAt = 0;
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'brosr:presence-draw') {
      placeCursor(message.position);
      return undefined;
    }
    if (message.type === 'brosr:cursor-image') {
      applyOwnCursor(message.cursor || null);
      return undefined;
    }
    if (message.type === 'brosr:cursor-settings') {
      if (Array.isArray(message.sites)) {
        allowedSites = cleanCursorSites(message.sites) || [];
      }
      if (typeof message.names === 'boolean') showNames = message.names;
      document.documentElement.dataset.brosrCursorSites = JSON.stringify(allowedSites);
      // Apply the new rule to pointers already on screen, so a site turned off
      // loses its cursors now and not on the next frame.
      for (const [id, entry] of cursorPoints) placeCursor({ ...entry, id });
      return undefined;
    }
    // The panel asks the tab that holds the film what it has done with it. The
    // room status cannot carry these counts, because the room tab is a separate
    // page, so the panel reads them here through the background page.
    if (message.type === 'brosr:relay-reading') {
      const video = remote.video();
      // Every frame has a listener. An ad or player frame with no video must
      // stay silent, or Chrome returns that empty answer before the top frame
      // can report the film it holds.
      if (!video) return undefined;
      const reading = {
        ok: true,
        requestId: message.requestId || null,
        // The panel needs the relay's own counts, not only the room's. A film
        // tab can wait on a buffer and retry a stuck seek without either one
        // showing up in the room counters.
        relay: { ...relay, stats: { ...remote.stats }, history: remote.historyView() },
        position: Number(video.currentTime || 0),
        duration: Number(video.duration || 0),
        paused: Boolean(video.paused),
      };
      // Chrome does not guarantee that a listener may return a promise. The
      // callback form works in both Chrome and Firefox, so the reading uses it
      // instead of looking like a silent timeout on the host.
      if (typeof sendResponse === 'function') {
        sendResponse(reading);
        return undefined;
      }
      return Promise.resolve(reading);
    }
    if (message.type !== 'brosr:media-apply') return undefined;
    relay.applies += 1;
    const previous = lastApplied;
    const result = remote.handle(message);
    relay.last = result;
    publishRelay();
    // A buffer hold or a room hold pauses the film from inside the relay. That
    // pause is not a person's act. A seek correction is the same: the seeked
    // event belongs to the correction. Keep only those actions home, so a real
    // pause or seek made just after the correction still reaches the room.
    const echo = remoteMediaEcho(result, previous, message);
    if (echo) remoteEcho = echo;
    if (!result || !result.ok || result.skipped) {
      lastApplied = null;
      return undefined;
    }
    const action = message.action || mediaAction(lastApplied, message);
    if (action && message.notices !== false) {
      notice.show({
        action,
        name: message.name || message.from,
        position: message.position,
        rate: message.rate,
      });
    }
    lastApplied = {
      key: message.key,
      position: Number(message.position || 0),
      playing: Boolean(message.playing),
      rate: Number(message.rate || 1),
      at: Date.now(),
    };
    // A hidden tab throttles its report timer to once a minute. The room still
    // sends applies, so answer one with the state the player now holds. This
    // keeps the host's local position fresh while the app is in front.
    if (document.visibilityState === 'hidden' && Date.now() - lastHiddenReportAt >= 1000) {
      lastHiddenReportAt = Date.now();
      queueMicrotask(reportMedia);
    }
    return undefined;
  });

  let relayKey = '';
  // The background holds the host's site list and the name view, so a tab that
  // opens later starts with the same rule as the rest of this browser.
  send({ type: 'brosr:cursor-settings' }).then((reply) => {
    if (!reply || !reply.ok) return;
    if (Array.isArray(reply.sites)) allowedSites = cleanCursorSites(reply.sites) || [];
    if (typeof reply.names === 'boolean') showNames = reply.names;
    document.documentElement.dataset.brosrCursorSites = JSON.stringify(allowedSites);
  });
  function reportMedia(userAction = false) {
    const state = mediaStateFromDocument(document, pageHref(), location.hostname);
    if (!state) return;
    // The position belongs to this instant, so the report names it. The room
    // sends the report a moment later, and a frame that stamped the send would
    // put every guest the age of the report past the film.
    state.at = Date.now();
    // A film paused for an unbuffered seek is not a starved element, but the
    // room should see the wait. Same fate can then hold every player instead
    // of letting this one run away from its target. The check also expires the
    // wait, so a room hold releases when the range arrives or the deadline
    // passes even while no frame reaches this tab.
    if (remote.bufferWaitActive()) state.buffering = true;
    // A person's play, pause, seek or rate change is an act. The four-a-second
    // tick only reads the clock, and a granted peer that sent its own lag as
    // an anchor pulled the host's playhead back and beat the host's own play
    // and pause. An act crosses the room, a tick stays home. The action keeps
    // its name so the host can apply a pause at the host's own playhead.
    state.action = typeof userAction === 'string' ? userAction : Boolean(userAction);
    if (state.key !== relayKey) {
      relayKey = state.key;
      send({ type: 'brosr:media-hello', key: state.key }).catch(() => {});
    }
    relay.key = state.key;
    relay.position = Math.round(state.position * 1000) / 1000;
    relay.playing = state.playing;
    relay.ad = state.ad;
    relay.sends += 1;
    publishRelay();
    send({ type: 'brosr:media-out', state }).catch(() => {});
  }
  setInterval(reportMedia, RELAY_TICK_MS);

  // A play, pause, seek or rate change is a whole act. It goes out at once,
  // while the interval above catches the rest of the clock. An act this tab
  // just applied from the room is skipped, or two browsers answer each
  // other's corrections forever. A different act is this person's, even when
  // it comes just after a correction.
  const act = (action) => {
    if (mediaEchoMatches(remoteEcho, action)) {
      relay.localDrops.echo = (relay.localDrops.echo || 0) + 1;
      relay.lastLocalDrop = { at: Date.now(), action, reason: 'echo' };
      publishRelay();
      return;
    }
    reportMedia(action);
  };
  for (const [type, action] of [
    ['play', 'play'],
    ['pause', 'pause'],
    ['seeked', 'seek'],
    ['ratechange', 'rate'],
  ]) {
    document.addEventListener(type, () => act(action), true);
  }

  return { started: true, role: 'media', room: null, peerId: null };
}

export async function start() {
  if (window.__brosrStarted) return { started: false, reason: 'already-running' };
  window.__brosrStarted = true;

  // A player can sit in a cross-origin frame, and the bridge now runs in every
  // frame. A frame is never a room tab, so it carries the film it holds and
  // nothing else.
  if (window.top !== window) return startPageMedia();

  // Canvas, Notes and Chess hold their own room socket. The core relays their
  // pointer and film to the room tab and starts no client of its own there.
  if (ownsRoom()) return startPageMedia();

  const params = new URLSearchParams(location.search);
  // The invite key rides in the fragment, so the search params alone would
  // drop it on the first navigation and turn a sealed room back into text.
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  // Identity survives a navigation. A room tab follows the host's URL, and the
  // new page has no room params, so the tab remembers which room and peer it is.
  const stored = (() => {
    try {
      return JSON.parse(sessionStorage.getItem('brosr-room') || 'null');
    } catch {
      return null;
    }
  })();
  const fresh = params.has('room') || params.has('peer');
  const config = fresh || !stored
    ? {
        role: params.get('role') === 'host' ? 'host' : 'peer',
        room: params.get('room') || 'spike',
        peerId: params.get('peer') || (params.get('role') === 'host' ? 'host' : 'peer'),
        hostId: params.get('host') || 'host',
        name: params.get('name') || params.get('peer') || 'peer',
        roomName: params.get('rname') || 'Room',
        bias: Number(params.get('bias') || 0),
        relayPort: params.get('relay') || '8787',
        grant: params.get('grant') || null,
        // The key travels in the fragment. sessionStorage keeps it across the
        // navigation a peer follows, so the next page stays sealed.
        key: params.get('k') || hashParams.get('k') || null,
        // The trusted token is the fragment's other half. It belongs to this
        // browser's helper, so a peer link never carries it.
        trustToken: hashParams.get('t') || null,
        trustPort: hashParams.get('tp') || params.get('tp') || null,
        openPanel: params.get('panel') === '1',
        // The app panel token is a random string, not the old '1' marker. A
        // guest invite never carries it.
        panelToken: params.get('panel') && params.get('panel') !== '1' ? params.get('panel') : null,
        selftest: params.get('selftest') === '1',
      }
    : stored;
  if (fresh) {
    try {
      sessionStorage.setItem('brosr-room', JSON.stringify(config));
    } catch {
      // Storage can be off. The page still works without a navigation.
    }
  }
  // A tab with no room of its own is a plain tab. It carries a film to the room
  // and nothing else, so the mouse never follows anyone to another tab.
  if (!fresh && !stored && !isRoomPage(location.href)) return startPageMedia();
  const role = config.role === 'host' ? 'host' : 'peer';
  const panelToken = config.panelToken || null;
  const room = config.room || 'spike';
  const peerId = config.peerId;
  const hostId = config.hostId || 'host';
  const name = config.name || peerId;
  const roomName = cleanRoomName(config.roomName || 'Room');
  // A measurement written for this room is local to this browser. A null or
  // malformed value means no offset, which is the same room as before.
  const savedAlign = (() => {
    try {
      return JSON.parse(readSetting(`brosr-align:${room}`) || 'null');
    } catch {
      return null;
    }
  })();
  const savedColour = readSetting('brosr-colour');
  const colour = isColour(savedColour) ? savedColour : randomColour();
  const savedCursor = cleanCursor((() => {
    try {
      return JSON.parse(readSetting(`brosr-cursor:${room}`) || 'null');
    } catch {
      return null;
    }
  })());
  let ownCursor = savedCursor;
  // A cursor chosen for the room is also the cursor this person uses, unless
  // they turned the local view off. Apply it before the socket opens, so no
  // page flickers back to the system arrow.
  let showOwnCursor = readSetting('brosr-show-own-cursor') !== '0';
  applyOwnCursor(showOwnCursor ? ownCursor : null);
  const sharePointer = readSetting('brosr-share-pointer') !== '0';
  let showNames = readSetting('brosr-cursor-names') !== '0';
  // A host keeps its choice between rooms. A guest starts off and takes the
  // host's setting from the room snapshot or a fate frame.
  const sameFate = role === 'host' && readSetting('brosr-same-fate') === '1';
  // A host names the sites that show pointers. A peer keeps the last list it
  // learned, or the two brosr apps until the host sends its own.
  const savedSites = cleanCursorSites((() => {
    try {
      return JSON.parse(readSetting('brosr-cursor-sites') || 'null');
    } catch {
      return null;
    }
  })());
  let cursorSites = savedSites;
  // Scroll follows its own list, so switching pointers off on a site does not
  // also stop the room from following the host's reading place there.
  const savedScrollSites = cleanCursorSites((() => {
    try {
      return JSON.parse(readSetting('brosr-scroll-sites') || 'null');
    } catch {
      return null;
    }
  })());
  let scrollSites = savedScrollSites;
  // Sites the host removed from the panel list. The list belongs to the host,
  // so only the room tab of the host browser ever writes this.
  const savedForgot = cleanCursorSites((() => {
    try {
      return JSON.parse(readSetting('brosr-cursor-forgot') || 'null');
    } catch {
      return null;
    }
  })());
  let cursorForgot = savedForgot || [];
  const bias = Number(config.bias || 0);
  const relayPort = config.relayPort || '8787';
  const source =
    api && api.runtime && api.runtime.id ? 'content-script' : 'page';
  const started = performance.now();
  // A room started with a trusted channel holds the client in memory. The
  // token stays out of the page's own URLs and out of the relay.
  const trust =
    config.trustToken && config.trustPort
      ? createTrustClient({
          url: `http://127.0.0.1:${config.trustPort}`,
          token: config.trustToken,
        })
      : null;
  let socket = null;
  let panelState = null;
  let lastCommand = null;
  // The panel reads one film view. The room anchor is the host's relay for the
  // host and the last arriving frame for a peer. The local copy is what this
  // browser's own film tab last reported.
  let localMedia = null;
  let roomMedia = null;
  // A host frame for the host's own film comes back from the relay. Counting
  // that echo is what proves the guard below is doing its work.
  let echoMedia = 0;
  const viewers = new Map();
  // A room that arrives with a key seals every frame it sends. The key stays in
  // the fragment, so the relay never receives it in a request line.
  let sealKey = null;
  let sealState = 'off';
  let sealError = null;
  // The tab the room panel chose for trusted typing. The helper reads this
  // from the status this page publishes, so the choice travels beside the
  // grant without another channel.
  let trustTarget = null;
  let sealedOut = 0;
  let sealedIn = 0;
  // A forwarded pointer runs at most twenty times a second, which is enough
  // for a cursor and cheap for every tab in this browser.
  let lastPresenceSent = 0;
  // When the tab that shows the film last reported. A room tab that holds the
  // film itself reads its own player only while that report is stale.
  let lastFilmReportAt = 0;

  // The room parameters describe this tab, not the page. A peer that follows
  // the host's URL must not inherit the host's role, so the announced URL is
  // the page alone.
  const roomParams = ['role', 'peer', 'host', 'room', 'rname', 'name', 'bias', 'relay', 'panel'];
  const cleanUrl = (href) => {
    try {
      const url = new URL(href);
      for (const key of roomParams) url.searchParams.delete(key);
      if (new URLSearchParams(url.hash.replace(/^#/, '')).has('k')) url.hash = '';
      return url.toString();
    } catch {
      return href;
    }
  };

  // A join link keeps the room and the relay port, because a guest has to
  // reach the same relay. Identity params are dropped, because the panel gives
  // the guest its own role, peer id and name.
  const joinParams = ['role', 'peer', 'host', 'name', 'bias', 'panel', 'selftest', 'grant', 'capture'];
  const joinUrl = (href) => {
    try {
      const url = new URL(href);
      for (const key of joinParams) url.searchParams.delete(key);
      url.hash = '';
      return url.toString();
    } catch {
      return href;
    }
  };

  const viewport = () => {
    const root = document.documentElement;
    const max = Math.max(1, root.scrollHeight - window.innerHeight);
    return {
      url: cleanUrl(location.href),
      scroll: Math.max(0, Math.min(1, window.scrollY / max)),
      fingerprint: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        scrollWidth: root.scrollWidth,
      },
    };
  };

  const navigate = (url) => {
    if (url && url !== location.href) location.assign(url);
  };

  const scrollTo = (ratio) => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.round(ratio * max));
  };

  // The IFrame API player lives in page scope, so a bridge hands it in on the
  // window. Without one, the entry keeps the HTML element adapter. A room page
  // usually shows no film, so it takes the relay from the tab that does.
  const youTubePlayer = globalThis.__brosrYouTubePlayer || null;
  const relayedMedia = new RelayMediaAdapter();
  const hasLocalMedia = Boolean(youTubePlayer || document.querySelector('video, audio'));
  const mediaAdapter = youTubePlayer
    ? new YouTubeAdapter({
        player: youTubePlayer,
        root: document.getElementById('movie_player'),
        key: playerKey(location.href),
      })
    : hasLocalMedia
      ? null
      : relayedMedia;
  // The player this tab already adopted, so the watcher below swaps only when
  // the page hands in a different one.
  let heldPlayer = youTubePlayer;

  // A sealed room sends bytes, not text. Every frame the client hands over
  // passes this one call site, so the seal lives in one place.
  function sendText(text) {
    if (!socket || socket.readyState !== 1) return;
    if (!sealKey) {
      socket.send(text);
      return;
    }
    socket.send(sealFrame(sealKey, new TextEncoder().encode(text), { room }));
    sealedOut += 1;
  }

  const client = createRoomClient({
    role,
    room,
    peerId,
    hostId,
    name,
    colour,
    roomName,
    build: bridgeBuild,
    alignOffset: savedAlign || 0,
    customCursor: savedCursor,
    sharePointer,
    sameFate,
    cursorSites,
    scrollSites,
    cursorForgot,
    showNames,
    onScrollPolicy: (sites) => {
      const list = Array.isArray(sites) ? sites : null;
      scrollSites = list;
      writeSetting('brosr-scroll-sites', JSON.stringify(list));
    },
    // A learned list is written here and sent to the rest of this browser, so
    // every tab follows the host without holding a socket.
    onPolicy: (sites) => {
      const list = Array.isArray(sites) ? sites : null;
      cursorSites = list;
      writeSetting('brosr-cursor-sites', JSON.stringify(list));
      if (api && api.runtime && api.runtime.sendMessage) {
        api.runtime
          .sendMessage({ type: 'brosr:cursor-policy', sites: list })
          .catch(() => {});
      }
    },
    document,
    viewport,
    // Presence names the page, so another tab draws a cursor only when it
    // shows that same page.
    pageUrl: () => cursorKey(location.href),
    navigate,
    scrollTo,
    // A tile names a new tab. This page has no user gesture to open one with,
    // so its browser opens the page beside the room tab instead.
    openTab: (href) => {
      if (!api || !api.runtime || !api.runtime.sendMessage) return false;
      api.runtime
        .sendMessage({ type: 'brosr:tab-open-local', url: href, key: null })
        .catch(() => {});
      return true;
    },
    mediaAdapter,
    onApp: (message) => {
      // The host app's control panel uses a private app channel. A guest has no
      // token, so the same message from a guest is ignored here.
      if (message.name === PANEL_APP) {
        const data = message.data && typeof message.data === 'object' ? message.data : {};
        if (!panelToken || data.token !== panelToken) return;
        handlePanel(data).catch(() => {});
        return;
      }
      // A viewer report is panel data, not page data. It stays in this tab.
      if (message.name === VIEWER_APP) {
        const data = message.data && typeof message.data === 'object' ? message.data : {};
        viewers.set(String(message.from || ''), {
          viewer: data.viewer && typeof data.viewer === 'object' ? data.viewer : null,
          at: Number(data.at || Date.now()),
        });
        return;
      }
      // Tabs need the browser, so this side asks its own background instead of
      // forwarding the frame to the page.
      if (message.name === TAB_APP) {
        // A frame this browser sent is not news here. The relay skips the
        // sending socket, but a second room tab in the same browser still hears
        // it, and copying an announcement back to its own sender opens the film
        // again on the machine that asked for it.
        if (message.from === peerId) return;
        const close = tabClose(message.data);
        if (close && api && api.runtime && api.runtime.sendMessage) {
          api.runtime
            .sendMessage({ type: 'brosr:tab-close-local', key: close.key })
            .catch(() => {});
        }
        const open = tabOpen(message.data);
        if (open && api && api.runtime && api.runtime.sendMessage) {
          api.runtime
            .sendMessage({ type: 'brosr:tab-open-local', url: open.url, key: open.key })
            .catch(() => {});
        }
        return;
      }
      // The page owns its own protocol. This only forwards it, under the page's
      // own origin, so a room page needs no content-script change.
      window.postMessage(
        {
          source: 'brosr-app',
          type: 'message',
          from: message.from,
          name: message.name,
          data: message.data,
        },
        location.origin
      );
    },
    // The room tab holds no player, so a frame for a film goes to the tab that
    // does. The tab applies the anchor against its own element.
    // The room tab owns the socket, so it forwards each pointer to the rest of
    // this browser. Every tab draws it, because a cursor is not tied to one
    // site.
    onPresence: (position) => {
      if (!api || !api.runtime || !api.runtime.sendMessage) return;
      const at = Date.now();
      if (at - lastPresenceSent < 50) return;
      lastPresenceSent = at;
      api.runtime
        .sendMessage({ type: 'brosr:presence-draw', position })
        .catch(() => {});
    },
    onHold: (hold) => {
      if (!hold || !hold.key) return;
      // This tab may hold the film itself. Apply the hold here before asking
      // the background, because a room tab is not in the film tab list.
      if (hasLocalMedia) {
        const element = client.media.pick(hold.key);
        const reading = element ? client.media.state(element) : null;
        if (reading && reading.key === hold.key) {
          if (hold.active) {
            client.media.apply(element, { action: 'pause' });
          } else {
            client.media.apply(element, { action: 'seek', position: hold.position });
            client.media.apply(element, { action: 'tick', rate: 1 });
            if (hold.playing) client.media.apply(element, { action: 'play' });
          }
          return;
        }
      }
      if (!api || !api.runtime || !api.runtime.sendMessage) return;
      api.runtime
        .sendMessage({
          type: 'brosr:media-apply',
          from: hold.peerId || null,
          name: null,
          action: hold.active ? 'hold' : 'tick',
          key: hold.key,
          position: hold.position,
          playing: Boolean(hold.playing && !hold.active),
          rate: 1,
          volume: 1,
          hold: Boolean(hold.active),
          at: Date.now(),
        })
        .catch(() => {});
    },
    onMedia: (message) => {
      // The host's film is the anchor. Its own frame coming back would seek the
      // film against itself, and a page player answers a seek loop with an
      // error overlay. The sender decides, never the film key. A granted peer
      // watches the same film, so a key check would drop every command it sends.
      if (role === 'host' && message.peerId && message.peerId === peerId) {
        echoMedia += 1;
        return false;
      }
      // The frame carries the position this tab should have now, so the panel
      // anchor is the expected value and the moment it arrived.
      const position = Number.isFinite(message.expected)
        ? message.expected
        : Number(message.position || 0);
      // The expected position was worked out at the instant the room passed
      // on, so that is the anchor instant. A fresh stamp here would shorten
      // the age the film tab adds and land the film short.
      const at = Number(message.at) || Date.now();
      roomMedia = {
        key: message.key,
        title: String(message.title || '').slice(0, 120),
        music: Boolean(message.music),
        position,
        duration: 0,
        playing: Boolean(message.playing),
        rate: Number(message.rate || 1),
        volume: Number(message.volume ?? 1),
        buffering: Boolean(message.buffering),
        ad: Boolean(message.ad),
        at,
      };
      if (!api || !api.runtime || !api.runtime.sendMessage) return false;
      api.runtime
        .sendMessage({
          type: 'brosr:media-apply',
          from: message.peerId || null,
          name: message.name || null,
          action: message.action || null,
          key: message.key,
          position: message.expected,
          playing: Boolean(message.playing),
          rate: Number(message.rate || 1),
          volume: Number(message.volume ?? 1),
          // The ad belongs to the host's film. A viewer tab has to know, so it
          // can wait instead of seeking to the ad's own clock.
          ad: Boolean(message.ad),
          at,
        })
        .catch(() => {});
      return true;
    },
    input: {
      // A grant arrives on the socket long after this page loaded, so the
      // listeners are installed now and every record waits for the grant.
      capture: true,
      grantTo: config.grant || null,
      tabId: peerId,
      origin: location.origin,
      // A granted peer's records reach the browser pipeline instead of the
      // DOM. The client falls back to synthetic replay if the agent refuses.
      trusted: trust ? (records) => trust.send(prepareRecords(records, document)) : null,
    },
    // One time base for the clock, the media ticks and the presence stamps.
    // The exchange compares stamps from two machines, so it needs the wall
    // clock. performance.now() starts at zero in each process, and the offset
    // then absorbs the page's own start time instead of a clock difference.
    now: () => Date.now(),
    send: (frame) => sendText(frame),
  });

  // The app control panel asks for one snapshot and sends one change at a
  // time. The room tab already owns the roster, grants and media view, so this
  // handler turns those into JSON instead of adding a second state store.
  // The session log needs the film tab's own counters. The host tab can ask
  // the background page for the one tab that owns the film, then carry the
  // answer to the app beside the room snapshot.
  async function panelFilmReading(media) {
    if (!media || !media.key) {
      return { reading: null, reply: { ok: false, reason: 'no-media' } };
    }
    if (!api || !api.runtime || !api.runtime.sendMessage) {
      return { reading: null, reply: { ok: false, reason: 'no-bridge' } };
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const answer = await Promise.race([
        api.runtime.sendMessage({ type: 'brosr:film-reading', key: media.key, requestId }),
        new Promise((resolve) => setTimeout(() => resolve(null), 1600)),
      ]);
      if (!answer) return { reading: null, reply: { ok: false, reason: 'timeout' } };
      if (answer.ok && !answer.relay) {
        return { reading: null, reply: { ...answer, reason: 'no-relay' } };
      }
      return { reading: answer.ok && answer.relay ? answer : null, reply: answer };
    } catch {
      return { reading: null, reply: { ok: false, reason: 'send-failed' } };
    }
  }

  async function panelSnapshot() {
    const live = status();
    // The tab list feeds the controls. The film reading feeds the log. They
    // run together, so a slow player never delays a control change.
    const listing =
      role === 'host' && api && api.runtime && api.runtime.sendMessage
        ? Promise.race([
            api.runtime.sendMessage({ type: 'brosr:tabs-list' }),
            new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
          ]).catch(() => null)
        : Promise.resolve(null);
    const [browser, film] = await Promise.all([listing, panelFilmReading(live.media)]);
    const self = {
      id: peerId,
      name,
      self: true,
      granted: true,
      colour: live.colour || null,
      build: live.build || bridgeBuild,
    };
    const peers = [
      self,
      ...(Array.isArray(live.peerList) ? live.peerList : []).filter(
        (peer) => peer && peer.id !== peerId && !peer.self
      ),
    ];
    // A copied report read on its own must name its own author. The app log
    // uses the same rule, but it keeps the host's own control state honest.
    const logPeers = [
      { ...self, granted: Boolean(live.granted) },
      ...(Array.isArray(live.peerList) ? live.peerList : []).filter(
        (peer) => peer && peer.id !== peerId && !peer.self
      ),
    ];
    const diagnostics = {
      room,
      roomName: live.roomName || roomName,
      role,
      peerId,
      name,
      build: live.build || bridgeBuild,
      hostBuild: live.hostBuild || null,
      socket: live.socket,
      reconnects: live.reconnects,
      playing: live.playing,
      peers: live.peers,
      peerList: logPeers,
      media: live.media || null,
      viewers: panelViewers(),
      align: live.align,
      latency: live.latency,
      clockOffset: live.clockOffset,
      driftRate: live.driftRate,
      sampleCount: live.sampleCount,
      seal: live.seal,
      lastMediaFrame: live.lastMediaFrame,
      lastMediaAction: live.lastMediaAction,
      lastLocalMediaAction: live.lastLocalMediaAction,
      mediaDrops: live.mediaDrops,
      mediaDropTicks: live.mediaDropTicks,
      lastMediaDrop: live.lastMediaDrop,
      mediaDropHistory: live.mediaDropHistory,
      holds: live.holds,
      lastHoldEvent: live.lastHoldEvent,
      hostPriority: live.hostPriority,
      lastSeek: live.lastSeek,
      controlSent: live.controlSent,
      controlReceived: live.controlReceived,
      lastControl: live.lastControl,
      controlHistory: live.controlHistory,
      seeks: live.seeks,
      nudges: live.nudges,
      corrections: live.corrections,
      stuckSeeks: live.stuckSeeks,
      relayed: live.relayed,
      mediaEcho: live.mediaEcho,
      mediaEchoLocal: live.mediaEchoLocal,
      firstDrift: live.firstDrift,
      convergedAt: live.convergedAt,
      stutter: live.stutter,
      debug: live.debug,
      reading: film.reading,
      readingReply: film.reply,
    };
    return {
      roomName: live.roomName || roomName,
      hostId: live.hostId || hostId,
      role,
      peerId,
      name,
      room,
      build: live.build || bridgeBuild,
      hostBuild: live.hostBuild || null,
      socket: live.socket,
      peers,
      media: live.media || null,
      sameFate: Boolean(live.sameFate),
      sync: !browser || browser.sync !== false,
      notices: !browser || browser.notices !== false,
      auto: Boolean(browser && browser.auto),
      tabs: browser && Array.isArray(browser.tabs) ? browser.tabs : [],
      cursorSites: Array.isArray(live.cursorSites) ? live.cursorSites : null,
      cursorSeen: Array.isArray(live.cursorSeen) ? live.cursorSeen : [],
      cursorForgot: Array.isArray(live.cursorForgot) ? live.cursorForgot : [],
      scrollSites: Array.isArray(live.scrollSites) ? live.scrollSites : null,
      scrollSeen: Array.isArray(live.scrollSeen) ? live.scrollSeen : [],
      trust: Boolean(trust),
      trustTarget: trustTarget || null,
      diagnostics,
    };
  }

  async function handlePanel(data) {
    const requestId = String(data.requestId || '');
    const answer = (state, extra = {}) =>
      client.sendApp(PANEL_APP, { requestId, ok: true, ...extra, state });
    const refuse = (error, reason = 'command') =>
      client.sendApp(PANEL_APP, {
        requestId,
        ok: false,
        reason,
        error: String((error && error.message) || error),
      });
    const refusal = (message, reason) => {
      const error = new Error(message);
      error.reason = reason;
      return error;
    };
    const runtime = (message) => {
      if (!api || !api.runtime || !api.runtime.sendMessage) {
        throw new Error('This browser has no room bridge.');
      }
      return api.runtime.sendMessage(message);
    };

    try {
      if (data.action === 'grant') {
        if (role !== 'host') throw refusal('Only the host can change control.', 'not-host');
        if (!client.setGrant(String(data.peerId || ''), Boolean(data.allowed))) {
          throw refusal('That person is no longer in the room.', 'not-in-room');
        }
      } else if (data.action === 'cursor-site' || data.action === 'cursor-forget') {
        if (role !== 'host') throw refusal('Only the host can change cursor sites.', 'not-host');
        const site = cursorSiteOf(String(data.site || ''));
        if (!site) throw refusal('That site is not valid.', 'bad-site');
        if (data.action === 'cursor-forget') {
          cursorForgot = client.forgetSite(site, data.on !== false) || cursorForgot;
          writeSetting('brosr-cursor-forgot', JSON.stringify(cursorForgot));
        } else {
          const published = client.publish();
          const base = Array.isArray(published.cursorSites)
            ? published.cursorSites
            : published.cursorSeen || [];
          const next = new Set(base);
          if (data.on) next.add(site);
          else next.delete(site);
          cursorSites = client.setCursorSites([...next]) || [];
          writeSetting('brosr-cursor-sites', JSON.stringify(cursorSites));
          if (data.on) {
            cursorForgot = client.forgetSite(site, false) || cursorForgot;
            writeSetting('brosr-cursor-forgot', JSON.stringify(cursorForgot));
          }
        }
      } else if (data.action === 'scroll-site') {
        if (role !== 'host') throw refusal('Only the host can change scroll sites.', 'not-host');
        const site = cursorSiteOf(String(data.site || ''));
        if (!site) throw refusal('That site is not valid.', 'bad-site');
        const published = client.publish();
        const base = Array.isArray(published.scrollSites)
          ? published.scrollSites
          : published.scrollSeen || [];
        const next = new Set(base);
        if (data.on) next.add(site);
        else next.delete(site);
        client.setScrollSites([...next]);
      } else if (data.action === 'room-name') {
        if (role !== 'host') throw refusal('Only the host can rename the room.', 'not-host');
        client.setRoomName(String(data.value || ''));
      } else if (data.action === 'set') {
        const key = String(data.key || '');
        const on = Boolean(data.on);
        if (key === 'sync') await runtime({ type: 'brosr:sync-toggle', on });
        else if (key === 'notices') await runtime({ type: 'brosr:notice-toggle', on });
        else if (key === 'auto') await runtime({ type: 'brosr:tabs-auto', on });
        else if (key === 'fate') {
          if (!client.setSameFate(on)) {
            throw refusal('Only the host can change this setting.', 'not-host');
          }
          writeSetting('brosr-same-fate', on ? '1' : '0');
        }
        else throw refusal('Unknown room setting.', 'bad-setting');
      } else if (data.action === 'tab') {
        const tabId = Number(data.tabId);
        if (!Number.isInteger(tabId) || tabId < 0) {
          throw refusal('Choose a tab first.', 'bad-tab');
        }
        const reply = await runtime({
          type: 'brosr:tab-share',
          tabId,
          shared: Boolean(data.shared),
        });
        if (!reply || !reply.ok) {
          const error = refusal(
            reply && reply.error ? reply.error : 'That tab is not available.',
            (reply && reply.reason) || 'tab-unavailable'
          );
          throw error;
        }
      } else if (data.action === 'trust') {
        if (!trust) throw refusal('This room has no trusted input channel.', 'no-trust');
        const url = String(data.url || '').trim();
        trustTarget = /^https?:\/\//i.test(url) ? url : null;
      } else if (data.action !== 'status') {
        throw refusal('Unknown room command.', 'unknown-command');
      }
      publish();
      answer(await panelSnapshot());
    } catch (error) {
      refuse(error, error.reason || 'command');
    }
  }

  // A page can name its own ad signal. The probe is read on every tick, so a
  // page script that loads after this entry still works. Without a probe the
  // HTML adapter never claims an ad.
  if (!mediaAdapter) {
    client.media.watchAds((element) =>
      typeof globalThis.__brosrAdProbe === 'function'
        ? Boolean(globalThis.__brosrAdProbe(element))
        : false
    );
  }

  // The player hand-in lives in page scope, so it can land after this entry
  // starts, and a navigation can swap the player for a new one. One watcher
  // adopts it, and a page with no player keeps the adapter it has.
  const adoptPlayer = () => {
    const player = globalThis.__brosrYouTubePlayer;
    if (!player || player === heldPlayer) return false;
    heldPlayer = player;
    client.setMediaAdapter(
      new YouTubeAdapter({
        player,
        root: document.getElementById('movie_player'),
        key: playerKey(location.href),
      })
    );
    return true;
  };
  adoptPlayer();
  setInterval(adoptPlayer, 500);

  // A peer that left stops sending viewer reports. Presence prunes the peer, and
  // this slow pass drops a report from a peer with no panel open.
  setInterval(() => {
    const live = new Set();
    for (const peer of client.roomState.peers.values()) {
      if (peer.id !== peerId) live.add(peer.id);
    }
    for (const [id, entry] of [...viewers]) {
      if (!live.has(id) || Date.now() - Number((entry && entry.at) || 0) > VIEWER_STALE_MS) {
        viewers.delete(id);
      }
    }
  }, 1000);

  // A host that plays the film in the room tab has no other tab to report it,
  // so the room tab reads its own player. A fresh report from a film tab wins,
  // because two senders under one id would pull the anchor against each other.
  // This tab is always top level, so its own address names the film.
  setInterval(() => {
    if (role !== 'host') return;
    if (Date.now() - lastFilmReportAt < 2000) return;
    const state = mediaStateFromDocument(document, location.href, location.hostname);
    if (!state || !state.key) return;
    if (relayedMedia.set(state)) client.sendHostMedia(state);
  }, 500);

  // A greeting runs for every new peer, whatever this browser's role. Two
  // things are lost when a peer joins late. The host sends its anchor only when
  // its state changes, so a guest that joins a paused room applies nothing. A
  // tab shared before the peer arrived has no frame in the room, because the
  // relay keeps no history. Every browser therefore replays the tabs it shared,
  // and the host repeats the anchor, with a slow refresh while the room has a
  // peer, because a guest usually opens the room before it opens the film and a
  // greet that arrives first finds no film tab.
  const greeted = new Set();
  let greetedAt = 0;
  setInterval(() => {
    const live = new Set();
    for (const peer of client.roomState.peers.values()) {
      if (!peer || peer.id === peerId) continue;
      live.add(peer.id);
    }
    // A peer that leaves is forgotten, so a rejoin is greeted at once.
    for (const id of [...greeted]) if (!live.has(id)) greeted.delete(id);
    let fresh = false;
    for (const id of live) {
      if (greeted.has(id)) continue;
      greeted.add(id);
      fresh = true;
    }
    // A tab shared before this peer arrived has no frame in the room, because
    // the relay keeps no history. Each browser asks for one replay of the tabs
    // it shared, so the newcomer opens the copy it missed instead of waiting for
    // a second share.
    if (fresh && api && api.runtime && api.runtime.sendMessage) {
      api.runtime.sendMessage({ type: 'brosr:tabs-replay' }).catch(() => {});
    }
    // Only the host holds the anchor. A peer's own frame would pull the room
    // against it.
    if (role !== 'host') return;
    if (!fresh && (!live.size || Date.now() - greetedAt < 2000)) return;
    // The projected position is where the film is now, so a guest that joins a
    // playing film does not start from the last report. The ad and buffering
    // flags ride along, because a guest waits out the host's ad.
    const anchor = relayedMedia.state();
    if (!anchor) return;
    greetedAt = Date.now();
    // The projection already names this instant, so the report is sent as it
    // stands rather than carried forward a second time. The greeting repeats
    // an anchor, so it must not replay an old host action and reopen the
    // host-priority window on every repeat.
    client.sendHostMedia({ ...relayedMedia.latest, ...anchor, action: false, at: Date.now() });
  }, 500);

  // One film view feeds the panel. A viewer with no tab on the film still sees
  // where the room is, and the panel offers to open it.
  const roomAnchor = () => {
    if (role === 'host') {
      const latest = relayedMedia.latest;
      return latest ? { ...latest, at: Number(latest.at || Date.now()) } : null;
    }
    return roomMedia;
  };
  const panelMedia = () => {
    const seen = viewerState(roomAnchor(), freshState(localMedia), Date.now());
    if (!seen) return null;
    return { ...seen, url: filmUrl(seen.key), role };
  };
  const panelViewers = () =>
    [...viewers.entries()].map(([id, entry]) => ({
      id,
      at: Number((entry && entry.at) || 0),
      viewer: entry && entry.viewer ? entry.viewer : null,
    }));

  // A viewer says where its own tab has the film. The report is small, and the
  // panel only needs it every couple of seconds.
  setInterval(() => {
    const seen = viewerState(roomAnchor(), freshState(localMedia), Date.now());
    if (!seen) return;
    client.sendApp(VIEWER_APP, { viewer: seen, at: Date.now() });
  }, VIEWER_TICK_MS);

  // One object feeds the dataset and the room panel, so the UI cannot show a
  // different number from the harness.
  const panelUrl =
    api && api.runtime && api.runtime.getURL
      ? api.runtime.getURL('panel/room.html')
      : null;

  const status = () => {
    const live = client.publish();
    let invite = null;
    if (inviteKey) {
      try {
        const url = new URL(`${joinUrl(location.href)}#k=${inviteKey}`);
        url.searchParams.set('rname', live.roomName || roomName);
        invite = url.toString();
      } catch {
        invite = `${joinUrl(location.href)}#k=${inviteKey}`;
      }
    }
    return {
      ...live,
      source,
      build: bridgeBuild,
      showOwnCursor,
      panelUrl,
      panelState,
      command: lastCommand,
      bias,
      seal: { mode: sealState, room, out: sealedOut, in: sealedIn, error: sealError },
      // The panel builds the join link from this. It keeps the room and the relay
      // port, so the guest lands in this room and not in the default one.
      inviteUrl: invite,
      media: panelMedia(),
      mediaEchoLocal: echoMedia,
      viewers: panelViewers(),
      socket: socket ? socket.readyState : -1,
      trust: trust ? { url: trust.url, ...trust.stats } : null,
      trustTarget,
      elapsed: Math.round(performance.now() - started),
      location: location.href,
      reconnects,
    };
  };

  // A click that arrives across a layout mismatch is dropped. A silent drop
  // looks like a broken room, so the receiver says what happened.
  const showLayoutNotice = (notice) => {
    if (!notice || notice.at === showLayoutNotice.shown) return;
    if (!document.body) return;
    showLayoutNotice.shown = notice.at;
    let banner = document.getElementById('brosr-notice');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'brosr-notice';
      banner.setAttribute('role', 'status');
      banner.style.cssText =
        'position:fixed;bottom:12px;left:12px;z-index:2147483647;max-width:320px;' +
        'padding:8px 12px;border-radius:8px;background:#2b2b2b;color:#f5f5f5;' +
        'font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.35)';
      document.body.appendChild(banner);
    }
    banner.textContent = 'This page laid out differently, so that click was not applied.';
    clearTimeout(showLayoutNotice.timer);
    showLayoutNotice.timer = setTimeout(() => banner.remove(), 6000);
  };
  showLayoutNotice.shown = null;

  const publish = () => {
    const next = status();
    document.documentElement.dataset.brosr = JSON.stringify(next);
    showLayoutNotice(next.layoutNotice);
  };

  // A player object has no paused field and no play method, so the HTML start
  // path stays off when an adapter is in use.
  const video = mediaAdapter ? null : client.media.pick(null);
  const beginPlayback = () => {
    if (!video) return;
    video.muted = true;
    const startedPlay = video.play();
    if (startedPlay && typeof startedPlay.catch === 'function') startedPlay.catch(() => {});
  };

  // A peer that starts ahead proves the controller closes the gap.
  const applyBias = () => {
    if (!video || !bias) return;
    const max = Number.isFinite(video.duration) ? video.duration - 1 : bias;
    video.currentTime = Math.max(0, Math.min(bias, max));
  };

  if (video) {
    if (video.readyState >= 1) applyBias();
    else video.addEventListener('loadedmetadata', applyBias, { once: true });

    if (role === 'host') {
      if (video.readyState >= 2) beginPlayback();
      else video.addEventListener('loadeddata', beginPlayback, { once: true });
    }
  }

  let reconnects = 0;
  let retryTimer = null;
  let leaving = false;
  window.addEventListener('pagehide', () => { leaving = true; }, { once: true });

  // A LAN room reaches the relay on the page's own hostname. relay= still
  // carries the port, because the jitter proxy listens on 8788.
  const relayHost = location.hostname || '127.0.0.1';

  // The invite carries the key in the fragment. A room with a key refuses to
  // run in the clear, because a silent downgrade is worse than no room.
  const inviteKey =
    config.key || new URLSearchParams(location.hash.replace(/^#/, '')).get('k') || null;
  if (inviteKey) {
    sealState = 'pending';
    try {
      sealKey = await roomKey(inviteKey);
      sealState = 'on';
    } catch (error) {
      sealState = 'failed';
      sealError = error.message;
    }
  }

  const connect = () => {
    socket = new WebSocket(
      `ws://${relayHost}:${relayPort}/room?room=${encodeURIComponent(room)}&role=${encodeURIComponent(role)}&peer=${encodeURIComponent(peerId)}`
    );
    // A sealed frame arrives as binary. An unsealed frame in a sealed room is a
    // bug or an attack, so it is dropped rather than trusted.
    socket.binaryType = 'arraybuffer';
    socket.onmessage = (event) => {
      let frame = event.data;
      if (sealKey) {
        if (!(frame instanceof ArrayBuffer)) return;
        try {
          frame = new TextDecoder().decode(openFrame(sealKey, new Uint8Array(frame), { room }));
          sealedIn += 1;
        } catch {
          return;
        }
      } else if (typeof frame !== 'string') {
        frame = new TextDecoder().decode(frame);
      }
      client.receive(frame, Date.now());
      publish();
    };
    socket.onopen = () => {
      // A hello asks the host for a snapshot, so a rejoin lands on the room's
      // page and scroll instead of starting over.
      client.hello();
      client.tick(Date.now());
      // A grant frame sent before the socket opened went nowhere. The room
      // opened with a grant is sent again now, so the peer can start capturing.
      if (isHost() && input && input.grantTo) client.setGrant(input.grantTo, true);
      publish();
    };
    socket.onerror = () => publish();
    socket.onclose = () => {
      publish();
      if (leaving) return;
      reconnects += 1;
      const delay = Math.min(5000, 250 * reconnects);
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, delay);
      }
    };
  };
  if (sealState === 'failed') {
    publish();
    return { started: false, reason: 'seal-failed', error: sealError };
  }
  connect();

  // A page cannot reach this content script directly. A page-level game talks
  // through window.postMessage, and the room carries it as an app message.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== 'brosr-app' || message.type !== 'send') return;
    client.sendApp(String(message.name || ''), message.data);
  });
  window.postMessage({ source: 'brosr-app', type: 'ready', role, peerId, room }, location.origin);

  // The panel lives in the browser chrome. The background page opens it, and
  // it carries the panel's own render report back here for the harness.
  if (api && api.runtime && api.runtime.sendMessage) {
    if (config.openPanel) {
      api.runtime
        .sendMessage({ type: 'brosr:open-panel', selftest: Boolean(config.selftest) })
        .catch(() => {});
    }
    // The panel cannot see this tab with tabs.query in a headless window, so
    // the tab registers itself instead.
    const hello = () =>
      api.runtime
        .sendMessage({
          type: 'brosr:room-hello',
          role,
          build: bridgeBuild,
          cursor: showOwnCursor ? ownCursor : null,
        })
        .catch(() => {});
    hello();
    setInterval(hello, 2000);
    setInterval(async () => {
      try {
        const reply = await api.runtime.sendMessage({ type: 'brosr:panel-state' });
        if (reply && reply.state) panelState = reply.state;
      } catch {
        // The background page is restarting.
      }
    }, 500);
    // A sidebar can be refused the tab channel, and a tab id can arrive as the
    // -1 placeholder. This copy of the status needs neither, so the panel can
    // always render the room this tab is in.
    setInterval(() => {
      const seen = status();
      api.runtime
        .sendMessage({
          type: 'brosr:room-status',
          room,
          peerId,
          role,
          source,
          panelUrl,
          // Control is what lets a peer share its tabs. The background reads
          // this copy, because the grant arrives on the room socket and never
          // passes through the browser chrome.
          granted: Boolean(seen.granted),
          data: seen,
        })
        .catch(() => {});
    }, 1000);
  }

  // A room page cannot reach the browser chrome. One small button asks for the
  // panel, and the reply says whether the popup opened, so a harness can read
  // the outcome.
  if (source === 'content-script' && isRoomPage(location.href)) {
    const style = document.createElement('style');
    style.textContent = `
      #brosr-panel-button {
        position: fixed;
        right: 10px;
        bottom: 10px;
        z-index: 2147483647;
        margin: 0;
        padding: 6px 8px;
        border: 1px solid ButtonBorder;
        border-radius: 8px;
        background: Canvas;
        color: CanvasText;
        font: 11px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 2px 8px rgb(0 0 0 / 22%);
        cursor: pointer;
      }
      #brosr-panel-button:hover {
        background: color-mix(in srgb, CanvasText 8%, Canvas);
      }
      #brosr-panel-button:focus-visible {
        outline: 2px solid #86b4ff;
        outline-offset: 1px;
      }
    `;
    const button = document.createElement('button');
    button.id = 'brosr-panel-button';
    button.type = 'button';
    button.textContent = 'Room panel';
    button.setAttribute('aria-label', 'Open the Brosr room panel');
    button.addEventListener('click', async () => {
      try {
        const reply = await api.runtime.sendMessage({ type: 'brosr:open-panel' });
        document.documentElement.dataset.brosrPanel =
          reply && reply.ok && reply.surface ? reply.surface : 'failed';
      } catch {
        document.documentElement.dataset.brosrPanel = 'failed';
      }
    });
    document.head.append(style);
    document.body.append(button);
  }

  setInterval(() => {
    client.tick(Date.now());
  }, 50);

  // The core tracks the real pointer, so presence carries where the mouse is.
  setInterval(() => {
    client.presence();
  }, PRESENCE_TICK_MS);
  // A background tab throttles that timer, and the host would then prune a
  // peer that is still connected. Returning to the tab sends presence at once.
  const wakePresence = () => {
    if (document.visibilityState === 'hidden') return;
    client.presence();
  };
  document.addEventListener('visibilitychange', wakePresence);
  window.addEventListener('focus', wakePresence);
  window.addEventListener('pageshow', wakePresence);

  setInterval(publish, 200);
  publish();

  // The room panel lives in the browser chrome, so it asks the tab. Only
  // Firefox exposes api.runtime here, and a plain page test still works.
  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Gecko accepts a returned promise. Chrome does not, so every reply also
      // goes out through sendResponse and the listener holds the channel open.
      const reply = (value) => {
        sendResponse(value);
        return true;
      };
      if (!message) return undefined;
      if (message.type === 'brosr:status') {
        // Firefox resolves a response only from a Promise or sendResponse.
        return reply({ ok: true, room, peerId, role, source, data: status(), panelUrl });
      }
      if (message.type === 'brosr:room-name') {
        const next = client.setRoomName(message.roomName);
        publish();
        return reply({ ok: true, roomName: next });
      }
      if (message.type === 'brosr:align-offset') {
        // A local tool can read the measurement from disk and send this to the
        // room tab. The value is never taken from the relay.
        const accepted = client.setAlignOffset({
          offsetMs: message.offsetMs,
          confidence: message.confidence === undefined ? 1 : message.confidence,
          fingerprint: message.fingerprint,
        });
        if (!accepted) return reply({ ok: false, reason: 'bad-offset' });
        writeSetting(`brosr-align:${room}`, JSON.stringify(accepted));
        publish();
        return reply({ ok: true, align: accepted });
      }
      if (message.type === 'brosr:colour') {
        if (!client.setColour(message.colour)) {
          return reply({ ok: false, reason: 'bad-colour' });
        }
        writeSetting('brosr-colour', String(message.colour));
        publish();
        return reply({ ok: true, colour: String(message.colour) });
      }
      if (message.type === 'brosr:cursor') {
        const next = client.setCursor(message.cursor);
        if (message.cursor && !next) {
          return reply({ ok: false, reason: 'bad-cursor' });
        }
        writeSetting(
          `brosr-cursor:${room}`,
          next ? JSON.stringify(next) : null
        );
        ownCursor = next || null;
        applyOwnCursor(showOwnCursor ? ownCursor : null);
        // Every tab shows the same pointer, so the image has to leave this
        // page as well as join the room.
        if (showOwnCursor && api && api.runtime && api.runtime.sendMessage) {
          api.runtime
            .sendMessage({ type: 'brosr:own-cursor', cursor: ownCursor })
            .catch(() => {});
        }
        publish();
        return reply({ ok: true, cursor: next });
      }
      if (message.type === 'brosr:own-cursor') {
        const next = client.setSharePointer(Boolean(message.on));
        writeSetting('brosr-share-pointer', next ? '1' : '0');
        publish();
        return reply({ ok: true, sharePointer: next });
      }
      if (message.type === 'brosr:show-own-cursor') {
        // The room sees the cursor either way. This switch only decides whether
        // this person sees the image instead of the system arrow.
        showOwnCursor = Boolean(message.on);
        writeSetting('brosr-show-own-cursor', showOwnCursor ? '1' : '0');
        applyOwnCursor(showOwnCursor ? ownCursor : null);
        // Every tab carries a copy of the image, so a clear has to reach them
        // all as well.
        if (api && api.runtime && api.runtime.sendMessage) {
          api.runtime
            .sendMessage({
              type: 'brosr:own-cursor',
              cursor: showOwnCursor ? ownCursor : null,
            })
            .catch(() => {});
        }
        publish();
        return reply({ ok: true, showOwnCursor });
      }
      if (message.type === 'brosr:cursor-names') {
        const on = Boolean(message.on);
        showNames = client.setShowNames(on);
        writeSetting('brosr-cursor-names', showNames ? '1' : '0');
        // Every tab draws its own copy of the overwritten cursor, so the name
        // view has to reach them as well.
        if (api && api.runtime && api.runtime.sendMessage) {
          api.runtime
            .sendMessage({ type: 'brosr:cursor-names-set', on: showNames })
            .catch(() => {});
        }
        publish();
        return reply({ ok: true, names: showNames });
      }
      if (message.type === 'brosr:cursor-site') {
        // Only the host picks the sites. A peer gets a refusal and keeps the
        // list the host sent.
        if (role !== 'host') return reply({ ok: false, reason: 'not-host' });
        const key = cursorSiteOf(String(message.site || ''));
        if (!key) return reply({ ok: false, reason: 'bad-site' });
        // A room with no policy yet allows every site. Switching one off has
        // to remove only that site, so the base is every site this room has
        // seen and not the two app defaults. The old base turned every other
        // site off on the first click.
        const published = client.publish();
        const base = Array.isArray(published.cursorSites)
          ? published.cursorSites
          : published.cursorSeen || [];
        const next = new Set(base);
        if (message.on) next.add(key);
        else next.delete(key);
        cursorSites = client.setCursorSites([...next]) || [];
        writeSetting('brosr-cursor-sites', JSON.stringify(cursorSites));
        // Switching a site on brings its row back, even after a removal.
        if (message.on) {
          cursorForgot = client.forgetSite(key, false) || cursorForgot;
          writeSetting('brosr-cursor-forgot', JSON.stringify(cursorForgot));
        }
        publish();
        return reply({ ok: true, sites: cursorSites });
      }
      if (message.type === 'brosr:cursor-forget') {
        // Only the host holds the list, so only the host can take a row off it.
        if (role !== 'host') return reply({ ok: false, reason: 'not-host' });
        const key = cursorSiteOf(String(message.site || ''));
        if (!key) return reply({ ok: false, reason: 'bad-site' });
        cursorForgot = client.forgetSite(key, message.on !== false) || cursorForgot;
        writeSetting('brosr-cursor-forgot', JSON.stringify(cursorForgot));
        publish();
        return reply({ ok: true, forgot: cursorForgot });
      }
      if (message.type === 'brosr:presence-point') {
        // Another tab of this browser owns the mouse. Presence carries that
        // point, so the room still shows one cursor for this person.
        return reply({ ok: client.setPointer(message.point, message.url) });
      }
      if (message.type === 'brosr:cursor-set') {
        // cursors-4u answers an extension fetch with its bot check, so the
        // panel reads the page a real tab already rendered instead.
        const here = String(location.href || '');
        if (!/^https?:\/\/(www\.)?cursors-4u\.com\/cursor\//i.test(here)) {
          return reply({ ok: false, reason: 'not-a-set-page' });
        }
        return reply({ ok: true, html: document.documentElement.outerHTML, url: here });
      }
      if (message.type === 'brosr:grant') {
        const applied = client.setGrant(String(message.peerId || ''), Boolean(message.allowed));
        return reply({ ok: Boolean(applied), granted: Boolean(message.allowed) });
      }
      if (message.type === 'brosr:active-page') {
        // The browser names the tab a person is looking at, so presence and
        // the host's site list follow the site they browse and not only the
        // room page that holds the socket.
        return reply({ ok: client.setPageUrl(message.url || null) });
      }
      if (message.type === 'brosr:media-state') {
        // A tab on this browser shows the film. The panel reads this copy as
        // the local position either way. Only the host room makes it the
        // room's media, because a peer room forwards frames instead.
        const state = message.state;
        if (state && typeof state === 'object' && state.key) {
          localMedia = state;
          // The room tab is usually hidden behind the film tab, and a hidden
          // tab throttles its presence timer. The active film tab still reports
          // here, so that report also refreshes this peer's presence. Without
          // this a live host or guest is pruned and the room elects a new host.
          client.presence();
        }
        if (client.stats.role === 'host') {
          const stored = relayedMedia.set(state);
          lastFilmReportAt = Date.now();
          if (stored) client.sendHostMedia(state);
          return reply({ ok: stored });
        }
        // A granted peer drives the room from its own film tab. The background
        // already stopped this report when playback sync is off, so the room
        // tab only has to put it on the socket under this peer's id.
        if (!client.isGranted()) return reply({ ok: false, reason: 'no-grant' });
        // A stutter is not a playhead act, but it still travels while the
        // player samples. The host checks the peer's grant before it holds the
        // room, so an ungranted stutter changes nothing.
        client.noteMedia(state);
        // A granted peer drives the room with an act, never with its own
        // clock. Its film may sit behind the anchor, and that lag sent four
        // times a second dragged the host's film back and made the host's own
        // play and pause lose to it.
        if (!state.action) return reply({ ok: true, skipped: 'tick' });
        return reply({ ok: client.sendMedia(state), granted: true });
      }
      if (message.type === 'brosr:tabs-announce') {
        // The background saw a tab this person chose to share. It goes out on
        // the room socket like any other app message.
        client.sendApp(TAB_APP, {
          action: 'open',
          url: String(message.url || ''),
          key: message.key === undefined || message.key === null ? null : String(message.key),
        });
        return reply({ ok: true });
      }
      if (message.type === 'brosr:trust-target') {
        // The helper resolves the URL on this browser and keeps this tab when
        // no tab shows it, so a stale choice never becomes a silent dead end.
        if (!trust) return reply({ ok: false, reason: 'no-trust' });
        const url = String(message.url || '');
        trustTarget = /^https?:\/\//i.test(url) ? url : null;
        publish();
        return reply({ ok: true, url: trustTarget });
      }
      if (message.type === 'brosr:command') {
        lastCommand = String(message.command || '');
        return reply({ ok: true });
      }
      if (message.type === 'brosr:leave') {
        // A leave is not a dropped connection. It clears the stored room, so a
        // later page load starts fresh instead of rejoining with a stale id.
        leaving = true;
        try {
          sessionStorage.removeItem('brosr-room');
        } catch {
          // Storage can be off. The socket still closes.
        }
        if (socket && socket.readyState <= 1) socket.close();
        return reply({ ok: true });
      }
      return undefined;
    });
  }

  return { started: true, role, room, peerId, source };
}
