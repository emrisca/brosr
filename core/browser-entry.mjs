// Content-script entry. The bridge loads this file, and it starts the sync
// client against the relay. Everything it reports lands in
// document.documentElement.dataset.brosr, so the harness can read the same
// numbers whether the core runs in the content script or in the page.

import { createRoomClient, PRESENCE_TICK_MS } from './sync.mjs';
import { YouTubeAdapter, playerKey } from './youtube.mjs';
import { openFrame, sealFrame, roomKey } from './seal.mjs';

// Gecko exposes browser, Chrome exposes chrome. The core runs in both.
const api = globalThis.browser || globalThis.chrome || null;

// The panel button stays off unrelated pages. A room page is a fixture whose
// name starts with one of the room words, which is what the panel looks for.
const ROOM_PAGE = /^https?:\/\/[^/]+\/(room|media|board|form|ad|sync|layout)[^/]*\.html/;

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
  // window. Without one, the entry keeps the HTML element adapter.
  const youTubePlayer = globalThis.__brosrYouTubePlayer || null;
  const mediaAdapter = youTubePlayer
    ? new YouTubeAdapter({
        player: youTubePlayer,
        root: document.getElementById('movie_player'),
        key: playerKey(location.href),
      })
    : null;

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
    colour: role === 'host' ? '#e2603f' : '#3f86e2',
    document,
    viewport,
    navigate,
    scrollTo,
    mediaAdapter,
    onApp: (message) => {
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
    // The panel builds the join link from this. The announced location stays
    // clean, so a peer never copies the key into its own tab URL.
    inviteUrl: inviteKey ? `${cleanUrl(location.href)}#k=${inviteKey}` : null,
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

  setInterval(() => {
    const t = (performance.now() - started) / 1000;
    client.presence({
      id: peerId,
      name,
      colour: role === 'host' ? '#e2603f' : '#3f86e2',
      point: {
        x: 120 + Math.cos(t * 0.7 + peerId.length) * 80,
        y: 140 + Math.sin(t * 0.7 + peerId.length) * 60,
      },
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
