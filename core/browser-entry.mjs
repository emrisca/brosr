// Content-script entry. The bridge loads this file, and it starts the sync
// client against the relay. Everything it reports lands in
// document.documentElement.dataset.brosr, so the harness can read the same
// numbers whether the core runs in the content script or in the page.

import { createRoomClient, PRESENCE_TICK_MS } from './sync.mjs';
import { TAB_APP, tabOpen } from './tabs.mjs';
import { YouTubeAdapter, playerKey } from './youtube.mjs';
import {
  RELAY_TICK_MS,
  RelayMediaAdapter,
  RemoteMediaSync,
  filmUrl,
  framePageHref,
  freshState,
  mediaStateFromDocument,
  viewerState,
} from './media-relay.mjs';
import { openFrame, sealFrame, roomKey } from './seal.mjs';
import { ActionNotice, CursorOverlay, mediaAction } from './overlay.mjs';
import { cleanCursor, cleanRoomName, isColour, randomColour } from './cursor.mjs';
import { createTrustClient, prepareRecords } from './trust.mjs';

// Gecko exposes browser, Chrome exposes chrome. The core runs in both.
const api = globalThis.browser || globalThis.chrome || null;

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
  const relay = { key: '', position: 0, playing: false, ad: false, sends: 0, applies: 0, last: null };
  const publishRelay = () => {
    document.documentElement.dataset.brosrRelay = JSON.stringify(relay);
  };
  // A frame that reaches this tab is remote by contract: the room tab drops
  // this browser's own report before it relays anything. The notice names the
  // person behind the change, and a skipped frame resets the baseline so the
  // end of an ad never reads as a person seeking.
  // Cursors reach every tab of this browser, so a peer pointer lands on
  // whatever site this person is reading. The room tab owns the socket and
  // forwards each frame here.
  const cursorLayer =
    window.top === window ? new CursorOverlay({ document }).attach() : null;
  const cursorPoints = new Map();
  const pixelPoint = (point) => ({
    x: Math.max(0, Math.min(1, Number(point && point.x) || 0)) * window.innerWidth,
    y: Math.max(0, Math.min(1, Number(point && point.y) || 0)) * window.innerHeight,
  });
  const placeCursor = (entry) => {
    if (!cursorLayer || !entry || !entry.id) return;
    const share = entry.point || { x: 0, y: 0 };
    cursorPoints.set(entry.id, { ...entry, point: share });
    cursorLayer.setPeer({
      id: entry.id,
      name: entry.name,
      colour: entry.colour,
      cursor: entry.cursor || null,
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
  runtime.onMessage.addListener((message) => {
    if (!message) return undefined;
    if (message.type === 'brosr:presence-draw') {
      placeCursor(message.position);
      return undefined;
    }
    if (message.type === 'brosr:cursor-image') {
      applyOwnCursor(message.cursor || null);
      return undefined;
    }
    if (message.type !== 'brosr:media-apply') return undefined;
    relay.applies += 1;
    const result = remote.handle(message);
    relay.last = result;
    publishRelay();
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
    return undefined;
  });

  let relayKey = '';
  function reportMedia() {
    const state = mediaStateFromDocument(document, pageHref(), location.hostname);
    if (!state) return;
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
  // while the interval above catches the rest of the clock.
  for (const type of ['play', 'pause', 'seeked', 'ratechange']) {
    document.addEventListener(type, reportMedia, true);
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
  const room = config.room || 'spike';
  const peerId = config.peerId;
  const hostId = config.hostId || 'host';
  const name = config.name || peerId;
  const roomName = cleanRoomName(config.roomName || 'Room');
  const readSetting = (key) => {
    try {
      return globalThis.localStorage ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  };
  const writeSetting = (key, value) => {
    try {
      if (!globalThis.localStorage) return;
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch {
      // A refused store costs this room only.
    }
  };
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

  // The room parameters describe this tab, not the page. A peer that follows
  // the host's URL must not inherit the host's role, so the announced URL is
  // the page alone.
  const roomParams = ['role', 'peer', 'host', 'room', 'rname', 'name', 'bias', 'relay'];
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
    customCursor: savedCursor,
    sharePointer,
    document,
    viewport,
    // Presence names the page, so another tab draws a cursor only when it
    // shows that same page.
    pageUrl: () => cursorKey(location.href),
    navigate,
    scrollTo,
    mediaAdapter,
    onApp: (message) => {
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
      roomMedia = {
        key: message.key,
        position,
        duration: 0,
        playing: Boolean(message.playing),
        rate: Number(message.rate || 1),
        volume: Number(message.volume ?? 1),
        buffering: Boolean(message.buffering),
        ad: Boolean(message.ad),
        at: Date.now(),
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
          at: Date.now(),
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
      if (message.type === 'brosr:media-state') {
        // A tab on this browser shows the film. The panel reads this copy as
        // the local position either way. Only the host room makes it the
        // room's media, because a peer room forwards frames instead.
        const state = message.state;
        if (state && typeof state === 'object' && state.key) localMedia = state;
        if (client.stats.role === 'host') {
          const stored = relayedMedia.set(state);
          if (stored) client.sendHostMedia(state);
          return reply({ ok: stored });
        }
        // A granted peer drives the room from its own film tab. The background
        // already stopped this report when playback sync is off, so the room
        // tab only has to put it on the socket under this peer's id.
        if (!client.isGranted()) return reply({ ok: false, reason: 'no-grant' });
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
