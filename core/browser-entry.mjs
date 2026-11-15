// Content-script entry. The bridge loads this file, and it starts the sync
// client against the relay. Everything it reports lands in
// document.documentElement.dataset.brosr, so the harness can read the same
// numbers whether the core runs in the content script or in the page.

import { createRoomClient, PRESENCE_TICK_MS } from './sync.mjs';
import { CursorOverlay } from './overlay.mjs';
import { TAB_APP, tabOpen } from './tabs.mjs';
import { YouTubeAdapter, playerKey } from './youtube.mjs';
import {
  RELAY_TICK_MS,
  RelayMediaAdapter,
  RemoteMediaSync,
  filmUrl,
  freshState,
  mediaStateFromDocument,
  viewerState,
} from './media-relay.mjs';
import { openFrame, sealFrame, roomKey } from './seal.mjs';

// Gecko exposes browser, Chrome exposes chrome. The core runs in both.
const api = globalThis.browser || globalThis.chrome || null;

// The panel button stays off unrelated pages. A room page is a fixture whose
// name starts with one of the room words, which is what the panel looks for.
const ROOM_PAGE = /^https?:\/\/[^/]+\/(room|media|board|form|ad|sync|layout)[^/]*\.html/;

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

// A page outside the room draws the room cursors without joining it. Only the
// room tab holds the socket, so the bridge carries presence from that tab to
// every page here, and carries this page's pointer back. The relay runs at the
// presence rate, so a plain tab moves as smoothly as the room page itself.
const POINTER_RELAY_MS = 16;
// A room can start after this page did, so a page that found none asks again.
const CURSOR_RETRY_MS = 4000;
const CURSOR_RETRY_MAX_MS = 60000;
// A restarted background forgets which pages asked. A page that joined says so
// again now and then.
const CURSOR_HEARTBEAT_MS = 20000;

async function startCursors() {
  const send = (message) => api.runtime.sendMessage(message);
  const here = () => cursorKey(location.href);

  let overlay = null;
  const drawn = new Set();
  const mount = () => {
    if (!overlay) overlay = new CursorOverlay({ document }).attach();
    return overlay;
  };

  const drop = (id) => {
    if (!overlay || !drawn.delete(id)) return;
    overlay.removePeer(id);
  };

  // A cursor draws only on the page it belongs to.
  const draw = (peer) => {
    if (!peer || typeof peer !== 'object' || !peer.id) return;
    if (peer.url !== here()) {
      drop(peer.id);
      return;
    }
    mount().setPeer(peer);
    drawn.add(peer.id);
  };

  const roster = (peers) => {
    const next = new Set();
    for (const peer of Array.isArray(peers) ? peers : []) {
      if (!peer || !peer.id || peer.url !== here()) continue;
      next.add(peer.id);
      draw(peer);
    }
    for (const id of [...drawn]) {
      if (!next.has(id)) drop(id);
    }
  };

  api.runtime.onMessage.addListener((message) => {
    if (!message) return undefined;
    if (message.type === 'brosr:presence') draw(message.peer);
    else if (message.type === 'brosr:presence-roster') roster(message.peers);
    else if (message.type === 'brosr:cursor-drop') drop(String(message.id || ''));
    return undefined;
  });

  // A page with a player tells the room where the film is. The room tab has
  // the socket, so this page only relays. A page without a player takes the
  // room anchor instead, and the tab that shows the film applies it.
  const remote = new RemoteMediaSync({ document, href: location.href, hostname: location.hostname });
  const relay = { key: '', position: 0, playing: false, ad: false, sends: 0, applies: 0, last: null };
  const publishRelay = () => {
    document.documentElement.dataset.brosrRelay = JSON.stringify(relay);
  };
  api.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'brosr:media-apply') return undefined;
    relay.applies += 1;
    relay.last = remote.handle(message);
    publishRelay();
    return undefined;
  });

  let relayKey = '';
  setInterval(() => {
    const state = mediaStateFromDocument(document, location.href, location.hostname);
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
  }, RELAY_TICK_MS);

  let joined = false;
  let last = 0;
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!joined || !event.isTrusted) return;
      const now = Date.now();
      if (now - last < POINTER_RELAY_MS) return;
      const x = Number(event.clientX);
      const y = Number(event.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      last = now;
      send({
        type: 'brosr:pointer',
        point: { x: Math.round(x), y: Math.round(y) },
        url: here(),
      }).catch(() => {});
    },
    { passive: true, capture: true }
  );

  const join = async () => {
    try {
      const reply = await send({ type: 'brosr:cursor-hello', url: here() });
      joined = Boolean(reply && reply.ok);
    } catch {
      joined = false;
    }
    return joined;
  };

  // A page that changes without a reload, like a video site, is a different
  // page in the same tab. The tab stops drawing the old page's cursors.
  let key = here();
  setInterval(() => {
    const next = here();
    if (next === key) return;
    key = next;
    if (overlay) overlay.clear();
    drawn.clear();
    if (joined) send({ type: 'brosr:cursor-hello', url: key }).catch(() => {});
  }, 1000);

  let delay = CURSOR_RETRY_MS;
  const loop = async () => {
    const ok = await join();
    delay = ok ? CURSOR_HEARTBEAT_MS : Math.min(delay * 2, CURSOR_RETRY_MAX_MS);
    setTimeout(loop, delay);
  };
  loop();

  return { started: true, role: 'cursor', room: null, peerId: null };
}

export async function start() {
  if (window.__brosrStarted) return { started: false, reason: 'already-running' };
  window.__brosrStarted = true;

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
        bias: Number(params.get('bias') || 0),
        relayPort: params.get('relay') || '8787',
        capture: params.get('capture') === '1',
        grant: params.get('grant') || null,
        // The key travels in the fragment. sessionStorage keeps it across the
        // navigation a peer follows, so the next page stays sealed.
        key: params.get('k') || hashParams.get('k') || null,
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
  // A page with no room of its own is a normal tab. It draws the room cursors
  // and reports its pointer, and it joins nothing.
  if (!fresh && !stored && !ROOM_PAGE.test(location.href)) return startCursors();
  const role = config.role === 'host' ? 'host' : 'peer';
  const room = config.room || 'spike';
  const peerId = config.peerId;
  const hostId = config.hostId || 'host';
  const name = config.name || peerId;
  const bias = Number(config.bias || 0);
  const relayPort = config.relayPort || '8787';
  const source =
    api && api.runtime && api.runtime.id ? 'content-script' : 'page';
  const started = performance.now();
  let socket = null;
  let panelState = null;
  let lastCommand = null;
  // The panel reads one film view. The room anchor is the host's relay for the
  // host and the last arriving frame for a peer. The local copy is what this
  // browser's own film tab last reported.
  let localMedia = null;
  let roomMedia = null;
  const viewers = new Map();
  // A room that arrives with a key seals every frame it sends. The key stays in
  // the fragment, so the relay never receives it in a request line.
  let sealKey = null;
  let sealState = 'off';
  let sealError = null;
  let sealedOut = 0;
  let sealedIn = 0;

  // The room parameters describe this tab, not the page. A peer that follows
  // the host's URL must not inherit the host's role, so the announced URL is
  // the page alone.
  const roomParams = ['role', 'peer', 'host', 'room', 'name', 'bias', 'relay'];
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

  // Remote cursors are drawn here and on every other tab of this browser. Only
  // this tab holds the socket, so it hands each presence to the bridge, which
  // fans it out to the pages that asked for cursors.
  const remoteCursors = new Map();
  const relayPresence = (peer) => {
    if (!peer || !peer.id || !api || !api.runtime || !api.runtime.sendMessage) return;
    remoteCursors.set(peer.id, peer);
    api.runtime.sendMessage({ type: 'brosr:presence-out', peer }).catch(() => {});
  };

  const client = createRoomClient({
    role,
    room,
    peerId,
    hostId,
    name,
    colour: role === 'host' ? '#e2603f' : '#3f86e2',
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
    onPresence: relayPresence,
    // The room tab holds no player, so a frame for a film goes to the tab that
    // does. The tab applies the anchor against its own element.
    onMedia: (message) => {
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
          key: message.key,
          position: message.expected,
          playing: Boolean(message.playing),
          rate: Number(message.rate || 1),
          volume: Number(message.volume ?? 1),
          at: Date.now(),
        })
        .catch(() => {});
      return true;
    },
    input: {
      capture: Boolean(config.capture),
      grantTo: config.grant || null,
      tabId: peerId,
      origin: location.origin,
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

  // A peer that left stops sending presence. The room prunes it, and this slow
  // roster is what removes its cursor from the other tabs.
  setInterval(() => {
    if (!api || !api.runtime || !api.runtime.sendMessage) return;
    const live = new Set();
    for (const peer of client.roomState.peers.values()) {
      if (peer.id !== peerId) live.add(peer.id);
    }
    for (const id of [...remoteCursors.keys()]) {
      if (!live.has(id)) remoteCursors.delete(id);
    }
    for (const [id, entry] of [...viewers]) {
      if (!live.has(id) || Date.now() - Number((entry && entry.at) || 0) > VIEWER_STALE_MS) {
        viewers.delete(id);
      }
    }
    api.runtime
      .sendMessage({ type: 'brosr:presence-roster', peers: [...remoteCursors.values()] })
      .catch(() => {});
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

  const status = () => ({
    ...client.publish(),
    source,
    panelUrl,
    panelState,
    command: lastCommand,
    bias,
    seal: { mode: sealState, room, out: sealedOut, in: sealedIn, error: sealError },
    // The panel builds the join link from this. It keeps the room and the relay
    // port, so the guest lands in this room and not in the default one.
    inviteUrl: inviteKey ? `${joinUrl(location.href)}#k=${inviteKey}` : null,
    media: panelMedia(),
    viewers: panelViewers(),
    socket: socket ? socket.readyState : -1,
    elapsed: Math.round(performance.now() - started),
    location: location.href,
    reconnects,
  });

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
      api.runtime.sendMessage({ type: 'brosr:room-hello', role }).catch(() => {});
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
      api.runtime
        .sendMessage({
          type: 'brosr:room-status',
          room,
          peerId,
          role,
          source,
          panelUrl,
          data: status(),
        })
        .catch(() => {});
    }, 1000);
  }

  // A room page cannot reach the browser chrome. One small button asks for the
  // panel, and the reply says whether the popup opened, so a harness can read
  // the outcome.
  if (source === 'content-script' && ROOM_PAGE.test(location.href)) {
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
    client.presence({
      id: peerId,
      name,
      colour: role === 'host' ? '#e2603f' : '#3f86e2',
    });
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
      if (message.type === 'brosr:grant') {
        const applied = client.setGrant(String(message.peerId || ''), Boolean(message.allowed));
        return reply({ ok: Boolean(applied), granted: Boolean(message.allowed) });
      }
      if (message.type === 'brosr:pointer') {
        // A pointer on another tab of this browser. The presence tick carries
        // it out, so the room sees one cursor per person, not one per tab.
        return reply({ ok: client.setPointer(message.point, message.url) });
      }
      if (message.type === 'brosr:media-state') {
        // A tab on this browser shows the film. The panel reads this copy as
        // the local position either way. Only the host room makes it the
        // room's media, because a peer room forwards frames instead.
        const state = message.state;
        if (state && typeof state === 'object' && state.key) localMedia = state;
        if (client.stats.role !== 'host') return reply({ ok: false, reason: 'peer' });
        return reply({ ok: relayedMedia.set(state) });
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
