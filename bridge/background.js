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
// The landing page is the front door, and its room params are what mark it, so
// a landing page opened by hand stays a plain tab. The fixture names stay,
// because those pages still exist.
const ROOM_FIXTURE = /^https?:\/\/[^/]+\/(room|media|board|form|ad|sync|layout)[^/]*\.html/;
function isRoomPage(href) {
  if (typeof href !== 'string' || !href) return false;
  if (ROOM_FIXTURE.test(href)) return true;
  try {
    const url = new URL(href);
    return url.searchParams.has('room') && url.searchParams.has('peer');
  } catch {
    return false;
  }
}

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
  if (!tab || !validId(tab.id) || !isRoomPage(tab.url || '')) return null;
  if (seen.roomTabId !== null && seen.roomTabId !== tab.id) return null;
  return tab.id;
}

// The stored id can be missing or unusable. One query answers both, so the
// panel never receives a number that tabs.sendMessage rejects.
async function roomTab() {
  const seen = await state();
  if (validId(seen.roomTabId)) {
    // A tab id from an earlier browser run names no tab now. Holding it would
    // reject every report from the real room tab.
    const held = await api.tabs.get(seen.roomTabId).catch(() => null);
    if (held) return seen.roomTabId;
    await save({ roomTabId: null, roomRole: null });
  }
  let id = null;
  try {
    const tabs = await api.tabs.query({});
    const found = tabs.find((tab) => validId(tab.id) && isRoomPage(tab.url || ''));
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
  const found = tabs.find((tab) => validId(tab.id) && isRoomPage(tab.url || ''));
  if (found) save({ roomTabId: found.id });
}).catch(() => {});

api.tabs.onRemoved.addListener((id) => {
  // A tab this browser published is the room's offer. Closing it withdraws
  // that offer. A copy that arrived from the room is not the offer, so closing
  // it only leaves the sync and returns the row to Open.
  const remoteKey = remoteOrigins.get(id);
  const shared = announced.has(id) && remoteKey === undefined;
  const key = remoteKey ?? id;
  const remotelyClosed = closing.delete(id);
  for (const [key, entry] of [...stoppedTabs]) {
    if (entry.tabId === id) stoppedTabs.delete(key);
  }
  announced.delete(id);
  remoteTabs.delete(id);
  remoteOrigins.delete(id);
  mediaTabs.delete(id);
  // A closed tab frees its id, so a later tab must not inherit the stop.
  detachedTabs.delete(id);
  publishedPlaying.delete(String(remoteKey ?? id));
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
  // A copy closing is a peer leaving that tab, not the publisher closing it.
  if (remoteKey !== undefined && !shared && !remotelyClosed) {
    notifyLeft(remoteKey).catch(() => {});
  }
  // A published tab closing closes the same tab everywhere. A close this
  // browser just applied from the room is already accounted for, so it does
  // not echo back.
  if (shared && !remotelyClosed) {
    mayShare()
      .then((allowed) => {
        if (allowed) announceClose(key);
      })
      .catch(() => {});
  }
});

// Sharing is host-led. A guest opens what the host announces and never sends
// its own tabs, so one person's browsing stays private by default.
const local = api.storage && api.storage.local ? api.storage.local : null;
const prefs = {
  autoShare: true,
  muted: {},
  shared: {},
  sync: true,
  notices: true,
  granted: false,
  // Null means the two brosr apps on the page's own origin. A host replaces
  // this with its own list, and a peer keeps the list its host sent.
  cursorSites: null,
  cursorNames: true,
};
let roomRole = null;
let prefsLoaded = false;

async function loadPrefs() {
  if (prefsLoaded) return prefs;
  prefsLoaded = true;
  if (!local) return prefs;
  try {
    const saved = await local.get([
      'autoShare',
      'muted',
      'shared',
      'sync',
      'notices',
      'granted',
      'cursorSites',
      'cursorNames',
    ]);
    if (saved) {
      prefs.autoShare = saved.autoShare !== false;
      prefs.muted = saved.muted || {};
      prefs.shared = saved.shared || {};
      prefs.sync = saved.sync !== false;
      prefs.notices = saved.notices !== false;
      prefs.granted = saved.granted === true;
      prefs.cursorSites = Array.isArray(saved.cursorSites)
        ? saved.cursorSites.filter((site) => typeof site === 'string')
        : null;
      prefs.cursorNames = saved.cursorNames !== false;
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
// The key a tab arrived under. A mirrored tab keeps that key through a
// navigation, so the other browser moves the same tab instead of opening a
// second one.
const remoteOrigins = new Map();
// A copy this person stopped syncing. It stays open, and a later navigation
// must not publish it back to the room.
const detachedTabs = new Set();
// The panel lists these, so a stop is not a one-way door. The entry keeps the
// offer key and the tab it names until the tab closes or someone resumes it.
const stoppedTabs = new Map();

state()
  .then((saved) => {
    const book = saved && saved.remoteKeyTabs;
    if (!book || typeof book !== 'object') return;
    for (const [key, id] of Object.entries(book)) {
      if (!validId(id)) continue;
      remoteKeys.set(key, id);
      remoteOrigins.set(id, key);
    }
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
async function rememberMediaTab(id, key, playing) {
  const next = { key: String(key || ''), playing: Boolean(playing), at: Date.now() };
  const prev = mediaTabs.get(id);
  mediaTabs.set(id, next);
  if (!prev || prev.key !== next.key) await save({ mediaTabKeys: mediaBook() });
}
const mediaRestored = state()
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
// A state read can stall while the worker wakes. A film read has a live map to
// fall back on, so its restore wait needs a deadline.
const mediaRestoreDeadline = new Promise((resolve) => setTimeout(resolve, 250));
// A host tab can reach the open path from several frames at once. One slot per
// host tab keeps that burst to a single local tab.
const opening = new Set();
// A mirrored click and a shared-tab announcement can name the same URL at the
// same instant under different keys. The URL map lets the second request join
// the first open instead of racing it and creating another tab.
const openingByUrl = new Map();

async function mapRemoteKey(key, tabId) {
  if (key === undefined || key === null || key === '' || !validId(tabId)) return;
  const id = String(key);
  if (remoteKeys.get(id) === tabId && remoteOrigins.get(tabId) === key) return;
  remoteKeys.set(id, tabId);
  remoteOrigins.set(tabId, key);
  await save({ remoteKeyTabs: Object.fromEntries(remoteKeys) });
}
// The film this browser plays last. A paused background tab does not replace
// the film someone is watching, so only a playing tab takes the focus.
let mediaFocus = '';
let mediaFocusTab = null;

// One owner for a film read. A browser can hold several copies of the same
// film, and asking every tab makes a slow tab look like a broken panel. The
// focused or most recently active copy answers.
function filmOwner(key) {
  const candidates = [...mediaTabs].filter(([, entry]) => entry && entry.key === key);
  if (!candidates.length) return null;
  const focused = candidates.find(
    ([id]) => mediaFocusTab !== null && String(id) === String(mediaFocusTab)
  );
  if (focused) return focused;
  return candidates.sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))[0];
}
async function announce(url, key, title, media) {
  if (!shareable(url)) return false;
  const id = await roomTab();
  if (!validId(id)) return false;
  const message = { type: 'brosr:tabs-announce', url };
  if (key !== undefined && key !== null) message.key = key;
  if (title) message.title = String(title).slice(0, 140);
  // A tab with a player travels with its state, so the row says whether the
  // tab plays from the first frame and not only after a later report.
  if (media && typeof media.playing === 'boolean') message.playing = media.playing;
  try {
    await api.tabs.sendMessage(id, message);
    return true;
  } catch {
    return false;
  }
}

// A copy this browser opened is gone. The room tab owns the list, so it hears
// the key and puts that row back to Open.
async function notifyLeft(key) {
  const id = await roomTab();
  if (!validId(id)) return false;
  try {
    await api.tabs.sendMessage(id, { type: 'brosr:tab-left', key: String(key) });
    return true;
  } catch {
    return false;
  }
}

// A shared tab started or stopped playing. The frame is small, because the
// offer already carries the URL and the title. One frame per change, not one
// per four-a-second report.
const publishedPlaying = new Map();
async function notifyMedia(key, playing) {
  if (key === undefined || key === null || key === '') return false;
  const id = String(key);
  const next = playing === true;
  if (publishedPlaying.get(id) === next) return false;
  publishedPlaying.set(id, next);
  const room = await roomTab();
  if (!validId(room)) return false;
  try {
    await api.tabs.sendMessage(room, {
      type: 'brosr:tabs-announce',
      action: 'media',
      key: id,
      playing: next,
    });
    return true;
  } catch {
    return false;
  }
}

async function announceClose(key) {
  if (key === undefined || key === null || key === '') return false;
  const id = await roomTab();
  if (!validId(id)) return false;
  try {
    await api.tabs.sendMessage(id, {
      type: 'brosr:tabs-announce',
      action: 'close',
      key: String(key),
    });
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

// A tab that was already open when the room started never loads again, so the
// navigation events cannot offer it. The room's start and a fresh grant sweep
// the open tabs once, so a guest sees the pages the host already had.
async function sweepTabs() {
  const all = await api.tabs.query({}).catch(() => []);
  for (const tab of all) considerTab(tab).catch(() => {});
}

// One tab id reaches several browser events at once. A set closes the window
// between the first event and the record that the tab went out, so a host tab
// opens one copy, not three.
const announcing = new Set();
const closing = new Set();
async function shareTab(tab) {
  if (!tab || !validId(tab.id) || !shareable(tab.url)) return false;
  if (announcing.has(tab.id)) return false;
  announcing.add(tab.id);
  try {
    if (announced.get(tab.id) === tab.url) return false;
    announced.set(tab.id, tab.url);
    // A tab that arrived from another browser goes out under the key it came
    // with, so the other side navigates that same tab. A tab from this browser
    // names itself.
    const arrived = remoteOrigins.get(tab.id);
    const key = arrived === undefined || arrived === null ? tab.id : arrived;
    // A tab this browser owns keeps its id as its key. Writing that pair into
    // the remote book made the offer look like a copy, so a replay skipped it
    // and closing it reported a peer leaving instead of withdrawing the offer.
    if (arrived !== undefined && arrived !== null) await mapRemoteKey(key, tab.id);
    return await announce(tab.url, key, tab.title, mediaTabs.get(tab.id));
  } finally {
    announcing.delete(tab.id);
  }
}

async function considerTab(tab) {
  if (!tab || !validId(tab.id) || !shareable(tab.url)) return;
  if (!(await mayShare())) return;
  // A copy that arrived from the room is this browser's copy, not this
  // person's tab. Navigating it never moves the publisher's offer.
  if (remoteOrigins.has(tab.id)) return;
  // A copy this person stopped syncing stays private, even after a navigation
  // puts it on a shareable page.
  if (detachedTabs.has(tab.id)) return;
  const seen = await state();
  if (tab.id === seen.roomTabId || isRoomPage(tab.url)) return;
  // A mirrored tab is this browser's copy of another tab. Its navigation is
  // still news to that browser, so it goes out under the key it arrived with.
  // The per-tab URL record below stops the two copies from echoing.
  if (announced.get(tab.id) === tab.url) return;
  await loadPrefs();
  // A ticked tab goes out even when new tabs are off, which is what the panel
  // offers for one tab at a time.
  if (prefs.muted[String(tab.id)]) return;
  if (!prefs.autoShare && prefs.shared[String(tab.id)] !== true) return;
  await shareTab(tab);
}

// The page a person is looking at names the site their cursor belongs to. The
// room tab holds the socket and would otherwise name its own relay page for
// the whole session, so the active tab is reported to it when it changes. A
// room tab that comes to the front hands the name back to itself.
async function reportActivePage(tab) {
  const id = await roomTab();
  if (!validId(id)) return;
  const url = tab && tab.id !== id && shareable(tab.url) ? tab.url : null;
  api.tabs.sendMessage(id, { type: 'brosr:active-page', url }).catch(() => {});
}

api.tabs.onActivated.addListener((info) => {
  api.tabs.get(info.tabId).then((tab) => reportActivePage(tab)).catch(() => {});
});

// A new tab reports its URL on creation in Gecko and after a navigation in
// Chromium, so both events ask the same question and the dedupe above holds.
api.tabs.onUpdated.addListener((id, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  if (tab && tab.active) reportActivePage(tab).catch(() => {});
});

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
// A site list and the name view belong to the whole browser, so a change from
// the room tab reaches every page that draws a pointer.
async function broadcastCursor(message, sender) {
  const from = sender && sender.tab ? sender.tab.id : null;
  const all = await api.tabs.query({}).catch(() => []);
  await Promise.all(
    all
      .filter((tab) => validId(tab.id) && tab.id !== from && shareable(tab.url))
      .map((tab) => api.tabs.sendMessage(tab.id, message).catch(() => {}))
  );
}

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
      // whether it may change which tabs sync. A stored id that no longer
      // names a tab yields to the live hello.
      const held = validId(seen.roomTabId)
        ? await api.tabs.get(seen.roomTabId).catch(() => null)
        : null;
      if (seen.roomTabId === null || seen.roomTabId === from || !held) {
        roomRole = message.role === 'host' ? 'host' : 'peer';
        await save({ roomTabId: from, roomRole });
        // The room just started on this browser. Tabs that were open before it
        // have no navigation left to announce them, so they are offered here.
        if (roomRole === 'host') sweepTabs().catch(() => {});
      }
    }
    // A tab that opens later still gets the cursor this person picked. The
    // room tab repeats this hello, so the image follows every new tab.
    if (message.cursor !== undefined) {
      const all = await api.tabs.query({}).catch(() => []);
      await Promise.all(
        all
          .filter((tab) => validId(tab.id) && tab.id !== from && shareable(tab.url))
          .map((tab) =>
            api.tabs
              .sendMessage(tab.id, {
                type: 'brosr:cursor-image',
                cursor: message.cursor || null,
              })
              .catch(() => {})
          )
      );
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
    if (message.granted !== undefined) {
      await loadPrefs();
      const before = prefs.granted;
      await savePrefs({ granted: Boolean(message.granted) });
      // Control just arrived, so the tabs this person already had become
      // offers too, without waiting for each one to navigate.
      if (!before && prefs.granted) sweepTabs().catch(() => {});
    }
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
  if (message.type === 'brosr:cursor-settings') {
    await loadPrefs();
    return {
      ok: true,
      names: prefs.cursorNames !== false,
      sites: Array.isArray(prefs.cursorSites) ? prefs.cursorSites : null,
    };
  }
  if (message.type === 'brosr:cursor-names-set') {
    await loadPrefs();
    await savePrefs({ cursorNames: message.on !== false });
    await broadcastCursor(
      {
        type: 'brosr:cursor-settings',
        names: prefs.cursorNames !== false,
        sites: Array.isArray(prefs.cursorSites) ? prefs.cursorSites : null,
      },
      sender
    );
    return { ok: true, names: prefs.cursorNames !== false };
  }
  if (message.type === 'brosr:cursor-policy') {
    // Only the room tab speaks for this browser. A page cannot rewrite the
    // host's list on its own.
    const id = await roomTab();
    const from = sender && sender.tab ? sender.tab.id : null;
    if (!validId(id) || id !== from) return { ok: false, reason: 'not-room-tab' };
    // Null is the host's allow-every-site rule. An empty array is the host
    // switching every site off, so the two must not collapse into one.
    if (message.sites !== null && !Array.isArray(message.sites)) {
      return { ok: false, reason: 'sites' };
    }
    const sites = Array.isArray(message.sites)
      ? message.sites.filter((site) => typeof site === 'string')
      : null;
    await savePrefs({ cursorSites: sites });
    await broadcastCursor(
      {
        type: 'brosr:cursor-settings',
        names: prefs.cursorNames !== false,
        sites,
      },
      sender
    );
    return { ok: true, sites };
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
    // A stopped copy still exists, so the panel can offer it back. A tab that
    // closed drops out here, which keeps the list honest between updates.
    const stopped = [];
    for (const [key, entry] of [...stoppedTabs]) {
      const tab = all.find((item) => item.id === entry.tabId);
      if (!tab || !detachedTabs.has(entry.tabId)) {
        stoppedTabs.delete(key);
        continue;
      }
      stopped.push({
        key,
        tabId: entry.tabId,
        url: tab.url || entry.url,
        title: tab.title || entry.title,
      });
    }
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
      stopped,
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
  // A peer that joins after a tab was shared never saw that frame, because the
  // relay keeps no history. The room tab asks once per new peer, and this sends
  // the same tabs again so the newcomer opens the copy it missed. The announced
  // map is the record of what already went out, so a tab nobody shared stays
  // private.
  if (message.type === 'brosr:tabs-replay') {
    if (!(await mayShare())) return { ok: false, reason: 'no-control' };
    const all = await api.tabs.query({}).catch(() => []);
    const shown = new Map(
      all.filter((tab) => validId(tab.id)).map((tab) => [tab.id, tab])
    );
    let sent = 0;
    for (const [raw, url] of announced) {
      const id = Number(raw);
      // A copy this browser opened is not an offer of its own.
      if (remoteOrigins.has(id)) continue;
      const tab = shown.get(id);
      // A tab that navigated or closed keeps no replay. The tab events keep the
      // record current, so a mismatch here means the record is stale.
      if (!tab || tab.url !== url || !shareable(tab.url)) continue;
      if (await announce(tab.url, id, tab.title, mediaTabs.get(id))) sent += 1;
    }
    return { ok: true, sent };
  }
  // A frame arrived from the room. The tab opens in the background, and it is
  // marked so this browser never announces it back.
  // Stop syncing a copy without closing it. The tab keeps its page and its
  // place in this browser, and nothing about it goes back to the room.
  if (message.type === 'brosr:tab-leave-local') {
    const key = String(message.key || '');
    if (!key) return { ok: false, reason: 'key' };
    const id = remoteKeys.get(key);
    remoteKeys.delete(key);
    // The room tab already forgot the row, so a second leave still answers.
    if (!validId(id)) {
      await save({ remoteKeyTabs: Object.fromEntries(remoteKeys) });
      return { ok: true, tabId: null };
    }
    const tab = await api.tabs.get(id).catch(() => null);
    stoppedTabs.set(key, {
      tabId: id,
      url: tab && tab.url ? String(tab.url) : '',
      title: tab && tab.title ? String(tab.title).slice(0, 140) : '',
      at: Date.now(),
    });
    remoteOrigins.delete(id);
    remoteTabs.delete(id);
    detachedTabs.add(id);
    // A stopped tab no longer names a film. Its player goes quiet for the room.
    mediaTabs.delete(id);
    await save({
      remoteKeyTabs: Object.fromEntries(remoteKeys),
      mediaTabKeys: mediaBook(),
    });
    return { ok: true, tabId: id };
  }
  // A stopped copy can join the room again. The tab never closed, so it takes
  // its key back and the room tab puts it in the joined list once more.
  if (message.type === 'brosr:tab-resume') {
    const key = String(message.key || '');
    if (!key) return { ok: false, reason: 'key' };
    const entry = stoppedTabs.get(key);
    if (!entry) return { ok: false, reason: 'no-stopped' };
    const tab = await api.tabs.get(entry.tabId).catch(() => null);
    if (!tab) {
      stoppedTabs.delete(key);
      detachedTabs.delete(entry.tabId);
      return { ok: false, reason: 'no-tab' };
    }
    stoppedTabs.delete(key);
    detachedTabs.delete(entry.tabId);
    remoteKeys.set(key, entry.tabId);
    remoteOrigins.set(entry.tabId, key);
    await save({ remoteKeyTabs: Object.fromEntries(remoteKeys) });
    const room = await roomTab();
    let joined = false;
    if (validId(room) && typeof api.tabs.sendMessage === 'function') {
      try {
        await api.tabs.sendMessage(room, { type: 'brosr:tabs-resumed', key });
        joined = true;
      } catch {
        joined = false;
      }
    }
    return { ok: true, tabId: entry.tabId, joined };
  }
  if (message.type === 'brosr:tab-close-local') {
    const key = String(message.key || '');
    if (!key) return { ok: false, reason: 'key' };
    const id = remoteKeys.get(key);
    if (!validId(id)) return { ok: true, closed: 0 };
    closing.add(id);
    try {
      await api.tabs.remove(id);
      return { ok: true, closed: 1 };
    } catch (error) {
      closing.delete(id);
      return { ok: false, reason: 'close', error: text(error) };
    }
  }
  if (message.type === 'brosr:tab-open-local') {
    if (!shareable(message.url)) return { ok: false, reason: 'url' };
    const key = message.key === undefined || message.key === null ? null : String(message.key);
    // A click on the landing page brings the copy forward. An automatic open
    // keeps the tab in the background, so a person is not pulled away from
    // whatever they were reading.
    const foreground = message.foreground === true;
    const slot = key === null ? `url:${message.url}` : `key:${key}`;
    if (opening.has(slot)) return { ok: true, opening: true };
    // A shared announcement and a mirrored click can name the same URL at the
    // same instant. Their slots differ, so the second request waits for the
    // open already in flight and then maps its key to that one tab.
    const pending = openingByUrl.get(message.url);
    if (pending) {
      const result = await pending;
      if (result && result.ok && validId(result.tabId)) {
        await mapRemoteKey(key, result.tabId);
        if (foreground) api.tabs.update(result.tabId, { active: true }).catch(() => {});
        return { ...result, joined: true };
      }
    }
    opening.add(slot);
    const work = (async () => {
      const known = key === null ? null : remoteKeys.get(key);
      // The same host tab moved to another page. Its copy here moves too, so a
      // click on a video or a search result does not spawn a second tab. A
      // redirect that only rewrites the query leaves the copy alone, because
      // reloading it would restart the film.
      if (validId(known) && typeof api.tabs.update === 'function') {
        const copy = await api.tabs.get(known).catch(() => null);
        if (copy && copy.url === message.url) {
          await mapRemoteKey(key, known);
          if (foreground) api.tabs.update(known, { active: true }).catch(() => {});
          return { ok: true, tabId: known, updated: false };
        }
        if (copy) {
          try {
            const target = { url: message.url };
            if (foreground) target.active = true;
            await api.tabs.update(known, target);
            await mapRemoteKey(key, known);
            return { ok: true, tabId: known, updated: true };
          } catch {
            // The copy is gone, so the next step opens a fresh one.
            if (key !== null) remoteKeys.delete(key);
            remoteTabs.delete(known);
          }
        } else {
          if (key !== null) remoteKeys.delete(key);
          remoteTabs.delete(known);
        }
      }
      // A tab this browser already shows needs no copy. A second player on the
      // film the host is watching cannot start, and YouTube reports that as an
      // error card, so the copy is the fault and not the film.
      const all = await api.tabs.query({}).catch(() => []);
      const shown = all.find((tab) => validId(tab.id) && tab.url === message.url);
      if (shown) {
        await mapRemoteKey(key, shown.id);
        if (foreground) api.tabs.update(shown.id, { active: true }).catch(() => {});
        return { ok: true, tabId: shown.id, existing: true };
      }
      try {
        const tab = await api.tabs.create({ url: message.url, active: foreground });
        if (tab && validId(tab.id)) {
          remoteTabs.add(tab.id);
          await mapRemoteKey(key, tab.id);
        }
        return { ok: true, tabId: tab && tab.id, updated: false };
      } catch (error) {
        return { ok: false, reason: 'create', error: text(error) };
      }
    })();
    openingByUrl.set(message.url, work);
    try {
      return await work;
    } finally {
      opening.delete(slot);
      if (openingByUrl.get(message.url) === work) openingByUrl.delete(message.url);
    }
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
    await rememberMediaTab(from, message.key, false);
    if (sender.tab.active) mediaFocusTab = from;
    return { ok: true, tabs: mediaTabs.size };
  }
  if (message.type === 'brosr:media-out') {
    const from = sender && sender.tab ? sender.tab.id : null;
    if (!validId(from)) return { ok: false, reason: 'no-tab' };
    // A stopped copy keeps its player silent for the room.
    if (detachedTabs.has(from)) return { ok: false, reason: 'detached' };
    const media = message.state;
    if (!media || typeof media !== 'object' || !media.key) return { ok: false, reason: 'state' };
    await rememberMediaTab(from, media.key, media.playing);
    // A tab this browser shared says whether it plays now, so its row updates
    // in place instead of waiting for the next URL change.
    if (announced.has(from)) {
      await notifyMedia(remoteOrigins.get(from) ?? from, media.playing === true);
    }
    await loadPrefs();
    if (!prefs.sync) return { ok: true, skipped: 'sync-off' };
    // A tab that is not playing must not take the room away from the film the
    // host is watching. The focused film may always send, playing or paused.
    if (!media.playing && mediaFocus && mediaFocus !== String(media.key)) {
      return { ok: true, skipped: 'background' };
    }
    if (media.playing) {
      mediaFocus = String(media.key);
      mediaFocusTab = from;
    }
    const id = await roomTab();
    if (!validId(id) || id === from) return { ok: false, reason: 'no-room' };
    api.tabs.sendMessage(id, { type: 'brosr:media-state', state: media }).catch(() => {});
    return { ok: true };
  }
  // The panel opens the room's film here. A tab that already shows it comes to
  // the front, and only a missing film opens a new tab.
  // The panel asks for the counters of the tab that holds the room's film.
  // Those live on that page, so the background page asks each known film tab
  // and returns the first answer. A tab that closed drops out of the map here.
  if (message.type === 'brosr:film-reading') {
    const filmKey = String(message.key || '');
    if (!filmKey) return { ok: false, reason: 'key' };
    // A live tab is already in the map. A restarted worker fills it from its
    // book after a message can arrive, so an empty map waits for that fill.
    // The restore can stall while the worker wakes, so it gets a short head
    // start and no more; the live map is enough to answer.
    let owner = filmOwner(filmKey);
    if (!owner) {
      await Promise.race([mediaRestored, mediaRestoreDeadline]);
      owner = filmOwner(filmKey);
    }
    if (!owner) {
      return {
        ok: false,
        reason: 'no-tab',
        want: filmKey,
        tabs: [...mediaTabs.entries()].map(([id, entry]) => ({ id, key: entry && entry.key })),
      };
    }
    const [id] = owner;
    const requestId = String(message.requestId || '');
    try {
      // One owner, one answer. A tab mid-load can leave the message
      // unanswered, so the panel gets a short deadline instead of holding
      // the whole panel open forever.
      const reply = await Promise.race([
        api.tabs.sendMessage(id, { type: 'brosr:relay-reading', requestId }),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
      if (reply && reply.ok && (!requestId || !reply.requestId || reply.requestId === requestId)) {
        return { ok: true, tabId: id, ...reply };
      }
      if (!reply) {
        return { ok: false, reason: 'no-tab', want: filmKey, failed: [{ id, answer: 'timeout' }] };
      }
      mediaTabs.delete(id);
      save({ mediaTabKeys: mediaBook() });
      return { ok: false, reason: 'no-tab', want: filmKey, failed: [{ id, answer: 'empty' }] };
    } catch (error) {
      mediaTabs.delete(id);
      save({ mediaTabKeys: mediaBook() });
      return { ok: false, reason: 'no-tab', want: filmKey, failed: [{ id, error: text(error) }] };
    }
  }
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
            ...(typeof message.hold === 'boolean' ? { hold: message.hold } : {}),
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
  // A peer pointer is for every site this person reads, so the room tab hands
  // each frame here and every other tab draws it.
  if (message.type === 'brosr:presence-draw') {
    const from = sender && sender.tab ? sender.tab.id : null;
    const all = await api.tabs.query({}).catch(() => []);
    await Promise.all(
      all
        .filter((tab) => validId(tab.id) && tab.id !== from && shareable(tab.url))
        .map((tab) =>
          api.tabs
            .sendMessage(tab.id, {
              type: 'brosr:presence-draw',
              position: message.position,
            })
            .catch(() => {})
        )
    );
    return { ok: true };
  }
  // A new cursor image goes to every tab, so the person sees their own pick
  // wherever they are and not only on the room tab.
  if (message.type === 'brosr:own-cursor') {
    const from = sender && sender.tab ? sender.tab.id : null;
    const all = await api.tabs.query({}).catch(() => []);
    await Promise.all(
      all
        .filter((tab) => validId(tab.id) && tab.id !== from && shareable(tab.url))
        .map((tab) =>
          api.tabs
            .sendMessage(tab.id, {
              type: 'brosr:cursor-image',
              cursor: message.cursor || null,
            })
            .catch(() => {})
        )
    );
    return { ok: true };
  }
  // The mouse may sit on a tab that holds no socket. That tab reports the
  // point here, and the room tab speaks for this person on the wire.
  if (message.type === 'brosr:presence-point') {
    const point = message.point && typeof message.point === 'object' ? message.point : null;
    if (!point) return { ok: false, reason: 'point' };
    const id = await roomTab();
    if (!validId(id)) return { ok: false, reason: 'no-room-tab' };
    const from = sender && sender.tab ? sender.tab.id : null;
    if (id === from) return { ok: true, skipped: 'sender' };
    try {
      await api.tabs.sendMessage(id, {
        type: 'brosr:presence-point',
        point,
        url: message.url || null,
      });
    } catch {
      return { ok: false, reason: 'send' };
    }
    return { ok: true };
  }
  return undefined;
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then((reply) => {
      if (reply !== undefined) sendResponse(reply);
    })
    .catch((error) => {
      sendResponse({ ok: false, error: text(error) });
    });
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
