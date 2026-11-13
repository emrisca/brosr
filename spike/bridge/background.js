// The bridge background page. A content script cannot open an extension page,
// and BiDi cannot navigate to one, so this page opens the panel and carries the
// panel's render state back to the room tab.
let lastPanel = null;
let roomTabId = null;

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
    lastPanel = message.state || null;
    return Promise.resolve({ ok: true });
  }
  if (message.type === 'brosr:panel-state') {
    return Promise.resolve({ ok: true, state: lastPanel });
  }
  if (message.type === 'brosr:open-panel') {
    const suffix = message.selftest ? '?selftest=1' : '';
    browser.tabs.create({ url: browser.runtime.getURL(`panel/room.html${suffix}`) }).catch(() => {});
    return Promise.resolve({ ok: true });
  }
  return undefined;
});
