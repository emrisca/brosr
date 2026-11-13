// The bridge background page. A content script cannot open an extension page,
// and BiDi cannot navigate to one, so this page opens the panel and carries the
// panel's render state back to the room tab.
let lastPanel = null;
let lastSelftest = null;
let roomTabId = null;
let panelTabId = null;

browser.tabs.onRemoved.addListener((id) => {
  if (id !== panelTabId) return;
  panelTabId = null;
  lastPanel = null;
  lastSelftest = null;
});

function openPanel(selftest) {
  const suffix = selftest ? '?selftest=1' : '';
  return browser.tabs
    .create({ url: browser.runtime.getURL(`panel/room.html${suffix}`) })
    .then((tab) => {
      panelTabId = tab.id;
      return { ok: true, tabId: tab.id };
    })
    .catch(() => ({ ok: false }));
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return undefined;
  if (message.type === 'brosr:room-hello') {
    if (sender && sender.tab) roomTabId = sender.tab.id;
    return Promise.resolve({ ok: true });
  }
  if (message.type === 'brosr:room-tab') {
    return Promise.resolve({ ok: roomTabId !== null, tabId: roomTabId });
  }
  if (message.type === 'brosr:panel-report') {
    const fromTab = sender && sender.tab ? sender.tab.id : null;
    // One panel owns the state. A second tab panel is ignored, and the first
    // tab to report is adopted so a sidebar-only session still works.
    if (panelTabId !== null && fromTab !== null && fromTab !== panelTabId) {
      return Promise.resolve({ ok: false, ignored: true });
    }
    if (panelTabId === null && fromTab !== null) panelTabId = fromTab;
    const state = message.state || null;
    lastPanel = state;
    if (state && state.selftest === '1') lastSelftest = state;
    return Promise.resolve({ ok: true });
  }
  if (message.type === 'brosr:panel-state') {
    return Promise.resolve({ ok: true, state: lastSelftest || lastPanel });
  }
  if (message.type === 'brosr:open-panel') {
    if (panelTabId !== null) {
      return browser.tabs
        .update(panelTabId, { active: true })
        .then(() => ({ ok: true, reused: true }))
        .catch(() => openPanel(Boolean(message.selftest)));
    }
    return openPanel(Boolean(message.selftest));
  }
  return undefined;
});

// The toolbar button and the keyboard command open the real sidebar. No query
// flag, no popup. A build without sidebar support gets the panel as a tab.
function openRoomPanel(selftest) {
  return browser.sidebarAction
    .open()
    .then(() => ({ ok: true, sidebar: true }))
    .catch(() => openPanel(Boolean(selftest)));
}

browser.browserAction.onClicked.addListener(() => {
  openRoomPanel(false);
});

browser.commands.onCommand.addListener((command) => {
  if (command === 'open-room-panel') openRoomPanel(false);
});
