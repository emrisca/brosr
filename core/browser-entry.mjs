// Content-script entry. The bridge loads this file, and it starts the sync
// client against the relay. Everything it reports lands in
// document.documentElement.dataset.brosr, so the harness can read the same
// numbers whether the core runs in the content script or in the page.

import { createRoomClient, PRESENCE_TICK_MS } from './sync.mjs';

export async function start() {
  if (window.__brosrStarted) return { started: false, reason: 'already-running' };
  window.__brosrStarted = true;

  const params = new URLSearchParams(location.search);
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
    typeof browser !== 'undefined' && browser.runtime && browser.runtime.id ? 'content-script' : 'page';
  const started = performance.now();
  let socket = null;
  let panelState = null;
  let lastCommand = null;

  // The room parameters describe this tab, not the page. A peer that follows
  // the host's URL must not inherit the host's role, so the announced URL is
  // the page alone.
  const roomParams = ['role', 'peer', 'host', 'room', 'name', 'bias', 'relay'];
  const cleanUrl = (href) => {
    try {
      const url = new URL(href);
      for (const key of roomParams) url.searchParams.delete(key);
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
    send: (frame) => {
      if (socket && socket.readyState === 1) socket.send(frame);
    },
  });

  // One object feeds the dataset and the room panel, so the UI cannot show a
  // different number from the harness.
  const panelUrl =
    typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL
      ? browser.runtime.getURL('panel/room.html')
      : null;

  const status = () => ({
    ...client.publish(),
    source,
    panelUrl,
    panelState,
    command: lastCommand,
    bias,
    socket: socket ? socket.readyState : -1,
    elapsed: Math.round(performance.now() - started),
    location: location.href,
    reconnects,
  });

  const publish = () => {
    document.documentElement.dataset.brosr = JSON.stringify(status());
  };

  const video = client.media.pick(null);
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

  const connect = () => {
    socket = new WebSocket(
      `ws://${relayHost}:${relayPort}/room?room=${encodeURIComponent(room)}&role=${encodeURIComponent(role)}&peer=${encodeURIComponent(peerId)}`
    );
    socket.onmessage = (event) => {
      client.receive(event.data, Date.now());
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
  if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
    if (config.openPanel) {
      browser.runtime
        .sendMessage({ type: 'brosr:open-panel', selftest: Boolean(config.selftest) })
        .catch(() => {});
    }
    // The panel cannot see this tab with tabs.query in a headless window, so
    // the tab registers itself instead.
    const hello = () =>
      browser.runtime.sendMessage({ type: 'brosr:room-hello', role }).catch(() => {});
    hello();
    setInterval(hello, 2000);
    setInterval(async () => {
      try {
        const reply = await browser.runtime.sendMessage({ type: 'brosr:panel-state' });
        if (reply && reply.state) panelState = reply.state;
      } catch {
        // The background page is restarting.
      }
    }, 500);
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
  // Firefox exposes browser.runtime here, and a plain page test still works.
  if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.onMessage) {
    browser.runtime.onMessage.addListener((message) => {
      if (!message) return undefined;
      if (message.type === 'brosr:status') {
        // Firefox resolves a response only from a Promise or sendResponse.
        return Promise.resolve({ ok: true, room, peerId, role, source, data: status(), panelUrl });
      }
      if (message.type === 'brosr:grant') {
        const applied = client.setGrant(String(message.peerId || ''), Boolean(message.allowed));
        return Promise.resolve({ ok: Boolean(applied), granted: Boolean(message.allowed) });
      }
      if (message.type === 'brosr:command') {
        lastCommand = String(message.command || '');
        return Promise.resolve({ ok: true });
      }
      return undefined;
    });
  }

  return { started: true, role, room, peerId, source };
}
