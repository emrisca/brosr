// The bridge background script. The toolbar opens the room UI as an anchored
// popup, and the chord or the page button opens it as a window. This script
// owns that window, the room tab id, and the last status the room published.
//
// The same file runs as a Gecko background page and as a Chrome service
// worker. A worker stops when it is idle, so the small state below is also kept
// in session storage, where both engines can find it again after a restart.

const api = globalThis.browser || globalThis.chrome;
const session = api.storage && api.storage.session ? api.storage.session : null;

const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 640;

// The room page names its tab. A hello message is one source and this is the
// second, because a tab restored from the session store can miss the hello.
const ROOM_URL = /^https?:\/\/[^/]+\/(room|media|board|form|ad|sync|layout)[^/]*\.html/;

// Firefox reports no tab as -1. A check for null alone would keep that
// placeholder and send every message to it.
const validId = (id) => Number.isInteger(id) && id >= 0;

const text = (error) => String((error && error.message) || error);

// The live copy is the fast path. Storage is the copy that survives a worker
// restart, and a session store that throws leaves the fast path in place.
const memory = {
  roomTabId: null,
  panelWindowId: null,
  panelSurface: null,
  lastPanel: null,
  lastSelftest: null,
  lastRoomStatus: null,
};

async function state() {
  if (!session) return { ...memory };
  try {
    const saved = await session.get(Object.keys(memory));
    return { ...memory, ...(saved || {}) };
  } catch {
    return { ...memory };
  }
}

async function save(changes) {
  Object.assign(memory, changes);
  if (!session) return;
  try {
    await session.set(changes);
  } catch {
    // A worker that is shutting down refuses the write. The live copy is still
    // right for this lifetime.
  }
}

function rememberTab(tab, seen) {
  if (!tab || !validId(tab.id) || !ROOM_URL.test(tab.url || '')) return null;
  if (seen.roomTabId !== null && seen.roomTabId !== tab.id) return null;
  return tab.id;
}

// The stored id can be missing or unusable. One query answers both, so the
// panel never receives a number that tabs.sendMessage rejects.
async function roomTab() {
  const seen = await state();
  if (validId(seen.roomTabId)) return seen.roomTabId;
  let id = null;
  try {
    const tabs = await api.tabs.query({});
    const found = tabs.find((tab) => validId(tab.id) && ROOM_URL.test(tab.url || ''));
    if (found) id = found.id;
  } catch {
    // A restricted window can refuse the query.
  }
  await save({ roomTabId: id });
  return id;
}

api.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status !== 'complete' && !info.url) return;
  state().then((seen) => {
    const next = rememberTab(tab, seen);
    if (next !== null) save({ roomTabId: next });
  });
});

api.tabs.query({}).then((tabs) => {
  const found = tabs.find((tab) => validId(tab.id) && ROOM_URL.test(tab.url || ''));
  if (found) save({ roomTabId: found.id });
}).catch(() => {});

api.tabs.onRemoved.addListener((id) => {
  state().then((seen) => {
    if (id === seen.roomTabId) save({ roomTabId: null });
  });
});

api.windows.onRemoved.addListener((id) => {
  state().then((seen) => {
    if (id !== seen.panelWindowId) return;
    save({ panelWindowId: null, panelSurface: null, lastPanel: null, lastSelftest: null });
  });
});

// Focus an open room window before making another one. A second copy of the
// panel would fight the first over the same room.
async function focusPanel() {
  const seen = await state();
  if (!validId(seen.panelWindowId)) return false;
  try {
    await api.windows.update(seen.panelWindowId, { focused: true });
    return true;
  } catch {
    await save({ panelWindowId: null });
    return false;
  }
}

// The window keeps its own size and stays open beside the room, which the chord
// and the page button both need. A build that refuses the window gets a tab,
// which still works.
async function openPanelWindow(selftest) {
  const seen = await state();
  if (await focusPanel()) {
    return {
      ok: true,
      windowId: seen.panelWindowId,
      reused: true,
      surface: seen.panelSurface || 'window',
    };
  }
  const suffix = selftest ? '?selftest=1' : '';
  const url = api.runtime.getURL(`panel/room.html${suffix}`);
  try {
    const win = await api.windows.create({
      url,
      type: 'popup',
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
    });
    await save({ panelWindowId: win.id, panelSurface: 'window' });
    return { ok: true, windowId: win.id, surface: 'window' };
  } catch (error) {
    const tab = await api.tabs.create({ url }).catch(() => null);
    if (tab) {
      await save({ panelSurface: 'tab' });
      return { ok: true, tabId: tab.id, surface: 'tab' };
    }
    return { ok: false, error: text(error) };
  }
}

// Every message answers the same way on both engines. A Chrome listener that
// returns a promise is ignored, so each branch replies through sendResponse and
// the listener returns true to hold the channel open.
async function handle(message, sender) {
  if (!message) return undefined;
  if (message.type === 'brosr:room-hello') {
    // Two room tabs both say hello. The panel needs the host tab, because only
    // the host can change control.
    const from = sender && sender.tab ? sender.tab.id : null;
    if (validId(from)) {
      const seen = await state();
      if (message.role === 'host') await save({ roomTabId: from });
      else if (seen.roomTabId === null) await save({ roomTabId: from });
    }
    return { ok: true };
  }
  if (message.type === 'brosr:room-tab') {
    const id = await roomTab();
    // This reply reaches the page through the panel report, so it carries
    // counts only and never a tab inventory.
    const tabs = await api.tabs.query({}).catch(() => []);
    const seen = await state();
    return {
      ok: id !== null,
      tabId: id,
      debug: { stored: seen.roomTabId, count: tabs.length, found: Boolean(id) },
    };
  }
  if (message.type === 'brosr:room-status') {
    await save({
      lastRoomStatus: {
        at: Date.now(),
        room: message.room || '',
        peerId: message.peerId || '',
        role: message.role || '',
        source: message.source || '',
        panelUrl: message.panelUrl || null,
        data: message.data || null,
      },
    });
    return { ok: true };
  }
  if (message.type === 'brosr:cached-status') {
    const seen = await state();
    return { ok: Boolean(seen.lastRoomStatus), status: seen.lastRoomStatus };
  }
  if (message.type === 'brosr:panel-report') {
    const fromWindow =
      sender && sender.tab && validId(sender.tab.windowId) ? sender.tab.windowId : null;
    const seen = await state();
    const changes = { lastPanel: message.state || null };
    // One panel owns the state. The first window to report is adopted, so a
    // panel opened by the room page still lands here.
    if (seen.panelWindowId === null && fromWindow !== null) changes.panelWindowId = fromWindow;
    if (message.state && message.state.selftest === '1') changes.lastSelftest = message.state;
    await save(changes);
    return { ok: true };
  }
  if (message.type === 'brosr:panel-state') {
    const seen = await state();
    const last = seen.lastSelftest || seen.lastPanel;
    // The panel cannot see the container it sits in, so the opener names it.
    // A harness reads this instead of guessing a surface from the width.
    // The panel names its own container when the toolbar opens it as a popup.
    // The opener names it when it made a window. The panel's report wins.
    return { ok: true, state: last ? { ...last, surface: last.surface || seen.panelSurface } : null };
  }
  // The panel can be refused the room tab channel. It asks here instead, and
  // this script repeats the question with the id it already holds.
  if (message.type === 'brosr:tab-status') {
    const id = await roomTab();
    if (id === null) return { ok: false, reason: 'no-tab' };
    return api.tabs
      .sendMessage(id, { type: 'brosr:status' })
      .then((reply) => ({ ok: true, reply }))
      .catch((error) => ({ ok: false, reason: 'send-failed', error: text(error) }));
  }
  // One name for the window, kept for a content script from an older build.
  // A summon tab exists only to carry this message, so it goes once the window
  // is there. The reply still reaches the tab before it closes.
  if (message.type === 'brosr:open-sidebar' || message.type === 'brosr:open-panel') {
    const summon =
      message.summon && sender && sender.tab && validId(sender.tab.id) ? sender.tab.id : null;
    const reply = await openPanelWindow(Boolean(message.selftest));
    if (summon !== null) api.tabs.remove(summon).catch(() => {});
    return reply;
  }
  return undefined;
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then((reply) => {
      if (reply !== undefined) sendResponse(reply);
    })
    .catch((error) => sendResponse({ ok: false, error: text(error) }));
  return true;
});

// The toolbar declares a popup, so the browser owns that click and this script
// never sees it. The chord and the page button still open a window, because
// Gecko has no call that shows a popup from a message.
api.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-room-panel') return;
  // The room tab records the command, so a headless run can prove the key
  // chord reached the bridge even when the window opens without a new tab.
  const id = await roomTab();
  if (validId(id)) api.tabs.sendMessage(id, { type: 'brosr:command', command }).catch(() => {});
  openPanelWindow(false);
});
