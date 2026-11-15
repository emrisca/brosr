// The bridge background script. The toolbar opens the room panel as a popup
// inside the browser window. The chord and the page button ask for that same
// popup, and no path here opens a window of its own. This script owns the room
// tab id and the last status the room published.
//
// The same file runs as a Gecko background page and as a Chrome service
// worker. A worker stops when it is idle, so the small state below is also kept
// in session storage, where both engines can find it again after a restart.

const api = globalThis.browser || globalThis.chrome;
const session = api.storage && api.storage.session ? api.storage.session : null;

// The room page names its tab. A hello message is one source and this is the
// second, because a tab restored from the session store can miss the hello.
const ROOM_URL = /^https?:\/\/[^/]+\/(room|media|board|form|ad|sync|layout)[^/]*\.html/;

// Firefox reports no tab as -1. A check for null alone would keep that
// placeholder and send every message to it.
const validId = (id) => Number.isInteger(id) && id >= 0;

// background.js runs as a classic script in Gecko, so it cannot import
// core/tabs.mjs. This check stays in step with shareable() there.
const BLOCKED = /^(chrome|chrome-extension|moz-extension|edge|about|view-source|file|data|blob|javascript):/i;
function shareable(url) {
  if (typeof url !== 'string' || !url || BLOCKED.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// A cursor belongs to a page, and two copies of one page sit at different
// addresses because of the room params. The key drops those, and it stays in
// step with cursorKey() in core/browser-entry.mjs.
const CURSOR_PARAMS = [
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
    const url = new URL(String(href || ''));
    for (const key of CURSOR_PARAMS) url.searchParams.delete(key);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

// A pointer moves far more often than a room needs. One tab can send at most
// every 60 ms, which keeps a tab drag from flooding the worker.
const CURSOR_MS = 60;
const cursorAt = new Map();
function cursorAllowed(tabId) {
  const now = Date.now();
  if (now - (cursorAt.get(tabId) || 0) < CURSOR_MS) return false;
  cursorAt.set(tabId, now);
  return true;
}

const text = (error) => String((error && error.message) || error);

// The live copy is the fast path. Storage is the copy that survives a worker
// restart, and a session store that throws leaves the fast path in place.
const memory = {
  roomTabId: null,
  roomRole: null,
  lastPanel: null,
  lastSelftest: null,
  lastRoomStatus: null,
  remoteKeyTabs: null,
  mediaTabKeys: null,
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
  announced.delete(id);
  remoteTabs.delete(id);
  mediaTabs.delete(id);
  save({ mediaTabKeys: mediaBook() });
  let unkeyed = false;
  for (const [key, tabId] of [...remoteKeys]) {
    if (tabId !== id) continue;
    remoteKeys.delete(key);
    unkeyed = true;
  }
  if (unkeyed) save({ remoteKeyTabs: Object.fromEntries(remoteKeys) });
  state().then((seen) => {
    if (id === seen.roomTabId) {
      save({ roomTabId: null, roomRole: null });
    }
  });
});

// Sharing is host-led. A guest opens what the host announces and never sends
// its own tabs, so one person's browsing stays private by default.
const local = api.storage && api.storage.local ? api.storage.local : null;
const prefs = { autoShare: true, muted: {}, shared: {}, sync: true, notices: true, granted: false };
let roomRole = null;
let prefsLoaded = false;

async function loadPrefs() {
  if (prefsLoaded) return prefs;
  prefsLoaded = true;
  if (!local) return prefs;
  try {
    const saved = await local.get(['autoShare', 'muted', 'shared', 'sync', 'notices', 'granted']);
    if (saved) {
      prefs.autoShare = saved.autoShare !== false;
      prefs.muted = saved.muted || {};
      prefs.shared = saved.shared || {};
      prefs.sync = saved.sync !== false;
      prefs.notices = saved.notices !== false;
      prefs.granted = saved.granted === true;
    }
  } catch {
    // A refused read keeps the defaults.
  }
  return prefs;
}

async function savePrefs(changes) {
  Object.assign(prefs, changes);
  if (!local) return;
  try {
    await local.set(changes);
  } catch {
    // A worker that is shutting down refuses the write.
  }
}

state()
  .then((saved) => {
    if (!roomRole) roomRole = saved.roomRole || null;
  })
  .catch(() => {});

// Tabs the room opened here, and the last URL announced for each tab. A tab
// opened from a frame never goes back out, which is what stops a loop.
const remoteTabs = new Set();
const announced = new Map();
// A shared tab keeps the host tab id that opened it. A later navigation in
// that tab moves the copy here instead of opening another tab.
const remoteKeys = new Map();

state()
  .then((saved) => {
    const book = saved && saved.remoteKeyTabs;
    if (!book || typeof book !== 'object') return;
    for (const [key, id] of Object.entries(book)) if (validId(id)) remoteKeys.set(key, id);
  })
  .catch(() => {});
// Tabs with a player, keyed by the film each one shows. The room tab drives
// playback through this map, because the film is usually in another tab.
const mediaTabs = new Map();
// A worker restart empties that map, and a film tab only announces a new key
// when the film changes. The book keeps the last entry per tab, so a paused tab
// is still reachable after the worker comes back. A write happens only when a
// key changes, not on every four-a-second report.
const mediaBook = () =>
  Object.fromEntries(
    [...mediaTabs].map(([id, entry]) => [String(id), { key: entry.key, at: entry.at }])
  );
async function rememberMediaTab(id, key) {
  const next = { key: String(key || ''), at: Date.now() };
  const prev = mediaTabs.get(id);
  mediaTabs.set(id, next);
  if (!prev || prev.key !== next.key) await save({ mediaTabKeys: mediaBook() });
}
state()
  .then((saved) => {
    const book = saved && saved.mediaTabKeys;
    if (!book || typeof book !== 'object') return;
    for (const [raw, entry] of Object.entries(book)) {
      const id = Number(raw);
      if (!validId(id) || !entry || !entry.key) continue;
      mediaTabs.set(id, { key: String(entry.key), at: Number(entry.at) || Date.now() });
    }
  })
  .catch(() => {});
// A host tab can reach the open path from several frames at once. One slot per
// host tab keeps that burst to a single local tab.
const opening = new Set();
// The film this browser plays last. A paused background tab does not replace
// the film someone is watching, so only a playing tab takes the focus.
let mediaFocus = '';
async function announce(url, key) {
  if (!shareable(url)) return false;
  const id = await roomTab();
  if (!validId(id)) return false;
  const message = { type: 'brosr:tabs-announce', url };
  if (key !== undefined && key !== null) message.key = key;
  try {
    await api.tabs.sendMessage(id, message);
    return true;
  } catch {
    return false;
  }
}

// Control allows a tab to go out, and a granted peer holds it just as the host
// does. A plain peer shares nothing.
async function mayShare() {
  await loadPrefs();
  return roomRole === 'host' || prefs.granted === true;
}

// One tab id reaches several browser events at once. A set closes the window
// between the first event and the record that the tab went out, so a host tab
// opens one copy, not three.
const announcing = new Set();
async function shareTab(tab) {
  if (!tab || !validId(tab.id) || !shareable(tab.url)) return false;
  if (announcing.has(tab.id)) return false;
  announcing.add(tab.id);
  try {
    if (announced.get(tab.id) === tab.url) return false;
    announced.set(tab.id, tab.url);
    return await announce(tab.url, tab.id);
  } finally {
    announcing.delete(tab.id);
  }
}

async function considerTab(tab) {
  if (!tab || !validId(tab.id) || !shareable(tab.url)) return;
  if (!(await mayShare())) return;
  const seen = await state();
  if (tab.id === seen.roomTabId || ROOM_URL.test(tab.url)) return;
  if (remoteTabs.has(tab.id)) return;
  if (announced.get(tab.id) === tab.url) return;
  await loadPrefs();
  // A ticked tab goes out even when new tabs are off, which is what the panel
  // offers for one tab at a time.
  if (prefs.muted[String(tab.id)]) return;
  if (!prefs.autoShare && prefs.shared[String(tab.id)] !== true) return;
  await shareTab(tab);
}

// A new tab reports its URL on creation in Gecko and after a navigation in
// Chromium, so both events ask the same question and the dedupe above holds.
api.tabs.onUpdated.addListener((id, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  considerTab(tab || { id, url: info.url }).catch(() => {});
});

// The toolbar declares the popup, so the browser owns that click and anchors the
// panel under the toolbar. The chord and the page button reach the same popup
// through openPopup, which both engines expose from a user action. A build that
// refuses it leaves the panel to the toolbar click, and no path opens a window.
async function openPanel() {
  const toolbar = api.action || api.browserAction;
  if (!toolbar || typeof toolbar.openPopup !== 'function') {
    return { ok: false, surface: null, reason: 'no-open-popup' };
  }
  try {
    await toolbar.openPopup();
    return { ok: true, surface: 'popup' };
  } catch (error) {
    return { ok: false, surface: null, reason: 'popup-refused', detail: text(error) };
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
      // The query at startup can claim the room tab before the page says hello.
      // A hello from that same tab still names the role, so the panel knows
      // whether it may change which tabs sync.
      if (seen.roomTabId === null || seen.roomTabId === from) {
        roomRole = message.role === 'host' ? 'host' : 'peer';
        await save({ roomTabId: from, roomRole });
      }
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
    // The room tab is the one place that knows whether this browser holds
    // control, so its report is also the grant state the tab list reads.
    if (message.granted !== undefined) await savePrefs({ granted: Boolean(message.granted) });
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
    const changes = { lastPanel: message.state || null };
    if (message.state && message.state.selftest === '1') changes.lastSelftest = message.state;
    await save(changes);
    return { ok: true };
  }
  if (message.type === 'brosr:panel-state') {
    const seen = await state();
    const last = seen.lastSelftest || seen.lastPanel;
    // The panel names its own container in its URL. A page opened by hand reads
    // as the popup, because that is where a room shows it.
    return { ok: true, state: last ? { ...last, surface: last.surface || 'popup' } : null };
  }
  // The panel can be refused the room tab channel. It asks here instead, and
  // this script repeats the question with the id it already holds.
  // The panel lists the tabs this browser can share and flips one on or off.
  // A guest gets its own list back with everything marked private, because a
  // guest never shares tabs.
  if (message.type === 'brosr:tabs-list') {
    await loadPrefs();
    const seen = await state();
    const role = roomRole || seen.roomRole || '';
    const canShare = role === 'host' || prefs.granted === true;
    const all = await api.tabs.query({}).catch(() => []);
    const tabs = all
      .filter((tab) => validId(tab.id) && shareable(tab.url))
      .slice(0, 40)
      .map((tab) => ({
        id: tab.id,
        title: tab.title || tab.url,
        url: tab.url,
        active: Boolean(tab.active),
        room: tab.id === seen.roomTabId,
        // A ticked tab counts on its own, so one tab can go to the room with
        // new tabs left off.
        shared:
          canShare &&
          tab.id !== seen.roomTabId &&
          !prefs.muted[String(tab.id)] &&
          (prefs.shared[String(tab.id)] === true || prefs.autoShare),
      }));
    return {
      ok: true,
      role,
      canShare,
      auto: prefs.autoShare,
      sync: prefs.sync,
      notices: prefs.notices,
      granted: prefs.granted,
      tabs,
    };
  }
  if (message.type === 'brosr:tabs-auto') {
    if (!(await mayShare())) return { ok: false, reason: 'no-control' };
    await savePrefs({ autoShare: Boolean(message.on) });
    return { ok: true, auto: prefs.autoShare };
  }
  // Playback sync is a choice. With it off no media frame leaves this browser
  // and none is applied here, so a tab can sit in a room and play on its own.
  if (message.type === 'brosr:sync-toggle') {
    await savePrefs({ sync: Boolean(message.on) });
    return { ok: true, sync: prefs.sync };
  }
  // The action notice is a choice too. Playback still syncs when it is off;
  // only the name card in the film tab stays away.
  if (message.type === 'brosr:notice-toggle') {
    await savePrefs({ notices: Boolean(message.on) });
    return { ok: true, notices: prefs.notices };
  }
  if (message.type === 'brosr:tab-share') {
    const tabId = Number(message.tabId);
    if (!validId(tabId)) return { ok: false, reason: 'bad-tab' };
    if (!(await mayShare())) return { ok: false, reason: 'no-control' };
    await loadPrefs();
    const muted = { ...prefs.muted };
    const shared = { ...prefs.shared };
    if (message.shared) {
      delete muted[String(tabId)];
      shared[String(tabId)] = true;
    } else {
      delete shared[String(tabId)];
      muted[String(tabId)] = true;
    }
    await savePrefs({ muted, shared });
    // Turning a tab on sends it now, so a tab opened before sharing was on
    // still reaches the room. The same guard stops a second open when the
    // tab events and this click land together.
    if (message.shared) {
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (tab && shareable(tab.url) && announced.get(tabId) !== tab.url) {
        await shareTab(tab);
      }
    } else {
      announced.delete(tabId);
    }
    return { ok: true, shared: Boolean(message.shared) };
  }
  // A frame arrived from the room. The tab opens in the background, and it is
  // marked so this browser never announces it back.
  if (message.type === 'brosr:tab-open-local') {
    if (!shareable(message.url)) return { ok: false, reason: 'url' };
    const key = message.key === undefined || message.key === null ? null : String(message.key);
    const slot = key === null ? `url:${message.url}` : `key:${key}`;
    if (opening.has(slot)) return { ok: true, opening: true };
    opening.add(slot);
    try {
      const known = key === null ? null : remoteKeys.get(key);
      // The same host tab moved to another page. Its copy here moves too, so a
      // click on a video or a search result does not spawn a second tab. A
      // redirect that only rewrites the query leaves the copy alone, because
      // reloading it would restart the film.
      if (validId(known) && typeof api.tabs.update === 'function') {
        const copy = await api.tabs.get(known).catch(() => null);
        if (copy && copy.url === message.url) return { ok: true, tabId: known, updated: false };
        if (copy) {
          try {
            await api.tabs.update(known, { url: message.url });
            return { ok: true, tabId: known, updated: true };
          } catch {
            // The copy is gone, so the next step opens a fresh one.
            remoteKeys.delete(key);
            remoteTabs.delete(known);
          }
        } else {
          remoteKeys.delete(key);
          remoteTabs.delete(known);
        }
      }
      // A tab this browser already shows needs no copy. A second player on the
      // film the host is watching cannot start, and YouTube reports that as an
      // error card, so the copy is the fault and not the film.
      const all = await api.tabs.query({}).catch(() => []);
      const shown = all.find((tab) => validId(tab.id) && tab.url === message.url);
      if (shown) return { ok: true, tabId: shown.id, existing: true };
      try {
        const tab = await api.tabs.create({ url: message.url, active: false });
        if (tab && validId(tab.id)) {
          remoteTabs.add(tab.id);
          if (key !== null) {
            remoteKeys.set(key, tab.id);
            await save({ remoteKeyTabs: Object.fromEntries(remoteKeys) });
          }
        }
        return { ok: true, tabId: tab && tab.id, updated: false };
      } catch (error) {
        return { ok: false, reason: 'create', error: text(error) };
      }
    } finally {
      opening.delete(slot);
    }
  }
  // A shared tab reports its pointer. The room tab holds the socket, so the
  // point goes there and the room puts it on the wire under this peer.
  if (message.type === 'brosr:cursor-out') {
    const from = sender && sender.tab ? sender.tab.id : null;
    const page = cursorKey(message.page);
    const x = Number(message.x);
    const y = Number(message.y);
    if (!validId(from) || !page || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: 'cursor' };
    }
    if (!cursorAllowed(from)) return { ok: true, skipped: 'rate' };
    const id = await roomTab();
    if (!validId(id) || id === from) return { ok: false, reason: 'no-room' };
    api.tabs
      .sendMessage(id, { type: 'brosr:cursor-send', page, x, y })
      .catch(() => {});
    return { ok: true };
  }
  // A cursor from the room reaches the tabs that show that page and no others,
  // because a dot on a different page points at nothing.
  if (message.type === 'brosr:cursor-apply') {
    const page = cursorKey(message.page);
    const x = Number(message.x);
    const y = Number(message.y);
    if (!page || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: 'cursor' };
    }
    const name = String(message.name || '').slice(0, 24);
    const from = String(message.from || '');
    const seen = await state();
    const all = await api.tabs.query({}).catch(() => []);
    for (const tab of all) {
      if (!validId(tab.id) || tab.id === seen.roomTabId) continue;
      if (cursorKey(tab.url) !== page) continue;
      api.tabs
        .sendMessage(tab.id, {
          type: 'brosr:cursor-draw',
          page,
          x: Math.max(0, Math.min(1, x)),
          y: Math.max(0, Math.min(1, y)),
          name,
          from,
        })
        .catch(() => {});
    }
    return { ok: true };
  }
  if (message.type === 'brosr:tab-status') {
    const id = await roomTab();
    if (id === null) return { ok: false, reason: 'no-tab' };
    return api.tabs
      .sendMessage(id, { type: 'brosr:status' })
      .then((reply) => ({ ok: true, reply }))
      .catch((error) => ({ ok: false, reason: 'send-failed', error: text(error) }));
  }
  // One name for the panel, kept for a content script from an older build. A
  // summon tab exists only to carry this message, so it goes once the panel is
  // asked for. The reply still reaches the tab before it closes.
  if (message.type === 'brosr:open-sidebar' || message.type === 'brosr:open-panel') {
    const summon =
      message.summon && sender && sender.tab && validId(sender.tab.id) ? sender.tab.id : null;
    const reply = await openPanel();
    if (summon !== null) api.tabs.remove(summon).catch(() => {});
    return reply;
  }
  // A tab with a player says which film it shows. The room tab owns the
  // socket, so the state goes there from every other tab.
  if (message.type === 'brosr:media-hello') {
    const from = sender && sender.tab ? sender.tab.id : null;
    if (!validId(from)) return { ok: false, reason: 'no-tab' };
    const id = await roomTab();
    if (id === from) {
      mediaTabs.delete(from);
      save({ mediaTabKeys: mediaBook() });
      return { ok: false, reason: 'room-tab' };
    }
    await rememberMediaTab(from, message.key);
    return { ok: true, tabs: mediaTabs.size };
  }
  if (message.type === 'brosr:media-out') {
    const from = sender && sender.tab ? sender.tab.id : null;
    if (!validId(from)) return { ok: false, reason: 'no-tab' };
    const media = message.state;
    if (!media || typeof media !== 'object' || !media.key) return { ok: false, reason: 'state' };
    await rememberMediaTab(from, media.key);
    await loadPrefs();
    if (!prefs.sync) return { ok: true, skipped: 'sync-off' };
    // A tab that is not playing must not take the room away from the film the
    // host is watching. The focused film may always send, playing or paused.
    if (!media.playing && mediaFocus && mediaFocus !== String(media.key)) {
      return { ok: true, skipped: 'background' };
    }
    if (media.playing) mediaFocus = String(media.key);
    const id = await roomTab();
    if (!validId(id) || id === from) return { ok: false, reason: 'no-room' };
    api.tabs.sendMessage(id, { type: 'brosr:media-state', state: media }).catch(() => {});
    return { ok: true };
  }
  // The panel opens the room's film here. A tab that already shows it comes to
  // the front, and only a missing film opens a new tab.
  if (message.type === 'brosr:open-film') {
    const key = String(message.key || '');
    const url = String(message.url || '');
    if (!key || !shareable(url)) return { ok: false, reason: 'url' };
    for (const [id, entry] of [...mediaTabs]) {
      if (!entry || entry.key !== key) continue;
      try {
        await api.tabs.update(id, { active: true });
        return { ok: true, tabId: id, focused: true };
      } catch {
        mediaTabs.delete(id);
      }
    }
    try {
      // The panel can sit in its own popup window, and a tab created there
      // closes with that window. The film opens beside the room tab instead.
      const options = { url, active: true };
      const roomId = await roomTab();
      if (validId(roomId)) {
        const room = await api.tabs.get(roomId).catch(() => null);
        if (room && Number.isInteger(room.windowId)) options.windowId = room.windowId;
      }
      const tab = await api.tabs.create(options);
      return { ok: true, tabId: tab && tab.id, focused: false };
    } catch (error) {
      return { ok: false, reason: 'create', error: text(error) };
    }
  }
  // A frame from the room names a film. A tab that shows that film takes the
  // anchor, and a tab that shows something else never sees it.
  if (message.type === 'brosr:media-apply') {
    const key = String(message.key || '');
    if (!key) return { ok: false, reason: 'key' };
    await loadPrefs();
    if (!prefs.sync) return { ok: true, skipped: 'sync-off' };
    const targets = [...mediaTabs].filter(([, entry]) => entry && entry.key === key);
    const results = await Promise.all(
      targets.map(([id]) =>
        api.tabs
          .sendMessage(id, {
            type: 'brosr:media-apply',
            from: message.from || null,
            name: message.name || null,
            action: message.action || null,
            notices: prefs.notices,
            key,
            position: message.position,
            playing: Boolean(message.playing),
            rate: message.rate,
            volume: message.volume,
            ad: Boolean(message.ad),
            at: message.at,
          })
          .then(() => true)
          .catch(() => {
            mediaTabs.delete(id);
            save({ mediaTabKeys: mediaBook() });
            return false;
          })
      )
    );
    return { ok: true, sent: results.filter(Boolean).length };
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
// never sees it. The chord runs inside a user action, which is the one place a
// popup can be opened from a script.
api.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-room-panel') return;
  // The room tab records the command, so a headless run can prove the key
  // chord reached the bridge even when the sidebar opens without a new tab.
  const id = await roomTab();
  if (validId(id)) api.tabs.sendMessage(id, { type: 'brosr:command', command }).catch(() => {});
  await openPanel();
});
