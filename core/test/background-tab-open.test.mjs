// A mirrored click and a shared-tab announcement can name the same URL at the
// same instant. Their keys differ, so a guard per key is not enough. This test
// runs the real background script against a small fake browser and checks that
// both requests land on one tab.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, '..', '..', 'bridge', 'background.js'),
  'utf8'
);

function loadBackground({
  sessionGet,
  localGet,
  tabs: seed = [],
  store = {},
  localStore = {},
  onSendMessage,
} = {}) {
  const tabs = seed.slice();
  const saved = store;
  const localSaved = localStore;
  const created = [];
  const removedIds = [];
  const sentMessages = [];
  const removedListeners = [];
  const updatedListeners = [];
  let nextId = 10;
  let listener = null;
  let releaseCreate = () => {};

  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });

  const api = {
    storage: {
      session: {
        get: sessionGet || (async () => saved),
        set: async (changes) => Object.assign(saved, changes),
      },
      local: {
        get: localGet || (async () => ({ ...localSaved })),
        set: async (changes) => Object.assign(localSaved, changes),
      },
    },
    tabs: {
      onUpdated: { addListener: (fn) => updatedListeners.push(fn) },
      onRemoved: { addListener: (fn) => removedListeners.push(fn) },
      onActivated: { addListener: () => {} },
      query: async () => tabs.slice(),
      get: async (id) => tabs.find((tab) => tab.id === id) || null,
      create: async ({ url }) => {
        created.push(url);
        await createGate;
        const tab = { id: nextId, url, active: false };
        nextId += 1;
        tabs.push(tab);
        return tab;
      },
      update: async () => {},
      remove: async (id) => {
        removedIds.push(id);
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index !== -1) tabs.splice(index, 1);
      },
      sendMessage: async (tabId, message) => {
        sentMessages.push({ tabId, message });
        if (onSendMessage) return await onSendMessage(tabId, message);
        return { ok: true };
      },
    },
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
      sendMessage: async () => ({ ok: true }),
    },
    commands: { onCommand: { addListener: () => {} } },
  };

  const ctx = {
    browser: api,
    URL,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);

  return {
    tabs,
    created,
    removedIds,
    sentMessages,
    saved,
    localSaved,
    listener,
    release: () => releaseCreate(),
    fireRemoved: (id) => {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index !== -1) tabs.splice(index, 1);
      for (const fn of removedListeners) fn(id);
    },
    fireUpdated: (id, info, tab) => {
      for (const fn of updatedListeners) fn(id, info, tab);
    },
  };
}

async function until(check, label = 'condition', timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${label}`);
}

function ask(listener, message, sender = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('background did not answer')), 1000);
    listener(message, sender, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

test('a live film tab answers a read without waiting for the session restore', async () => {
  let reads = 0;
  const { listener } = loadBackground({
    sessionGet: async () => {
      reads += 1;
      if (reads === 3) return new Promise(() => {});
      return {};
    },
  });
  const hello = await ask(
    listener,
    { type: 'brosr:media-hello', key: 'youtube:test' },
    { tab: { id: 22, active: true, url: 'https://www.youtube.com/watch?v=test' } }
  );
  assert.equal(hello.ok, true);
  const started = Date.now();
  const reply = await ask(listener, {
    type: 'brosr:film-reading',
    key: 'youtube:test',
    requestId: 'read-live',
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.tabId, 22);
  assert.ok(Date.now() - started < 500, 'the read did not wait for the stalled restore');
});

test('a stalled restore with no live owner answers instead of hanging', async () => {
  let reads = 0;
  const { listener } = loadBackground({
    sessionGet: async () => {
      reads += 1;
      if (reads === 3) return new Promise(() => {});
      return {};
    },
  });
  const started = Date.now();
  const reply = await ask(listener, {
    type: 'brosr:film-reading',
    key: 'youtube:missing',
    requestId: 'read-empty',
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'no-tab');
  assert.ok(Date.now() - started < 900, 'the read waited past its deadline');
});

test('a mirrored click and a shared tab open one copy for the same URL', async () => {
  const { created, saved, listener, release } = loadBackground();
  assert.ok(listener, 'the background message listener is registered');

  const url = 'https://example.test/watch';
  const click = ask(listener, { type: 'brosr:tab-open-local', url, key: null });
  const share = ask(listener, { type: 'brosr:tab-open-local', url, key: '42' });
  release();
  const [fromClick, fromShare] = await Promise.all([click, share]);

  assert.equal(created.length, 1, 'only one local tab is created');
  assert.equal(fromClick.tabId, fromShare.tabId, 'both requests name the same tab');
  assert.equal(fromShare.joined, true, 'the shared announcement joined the open');
  assert.equal(saved.remoteKeyTabs['42'], fromClick.tabId, 'the shared key follows the tab');
});

test('a restarted worker still replays the tabs it announced', async () => {
  // Chrome stops an idle worker, and the replay is the only frame a late guest
  // gets. A book kept only in memory left the host with nothing to send, so
  // the newcomer saw no offer until someone shared the tab again.
  const store = {};
  const seed = [
    { id: 1, url: 'http://127.0.0.1:8891/?role=host&room=two&peer=host', active: true },
    { id: 2, url: 'http://127.0.0.1:8891/offer.html', active: false },
  ];
  const first = loadBackground({ tabs: seed, store });
  await ask(first.listener, { type: 'brosr:room-hello', role: 'host' }, { tab: { id: 1 } });
  // The sweep runs after the hello answers.
  await until(
    () => store.announcedTabs && store.announcedTabs['2'] === seed[1].url,
    'the announced book'
  );

  // A restart keeps session storage and loses every variable in the script.
  const again = loadBackground({ tabs: seed, store });
  const reply = await ask(again.listener, { type: 'brosr:tabs-replay' });
  assert.equal(reply.ok, true, 'the restarted worker accepts the replay');
  assert.equal(reply.sent, 1, 'the tab shared before the restart goes out again');
});

test('a stopped copy leaves the room and comes back from the panel', async () => {
  const { created, saved, listener, release } = loadBackground();
  const url = 'https://example.test/film';

  const opened = ask(listener, {
    type: 'brosr:tab-open-local',
    url,
    key: '7',
    foreground: true,
  });
  release();
  const first = await opened;
  assert.equal(first.ok, true);

  const left = await ask(listener, { type: 'brosr:tab-leave-local', key: '7' });
  assert.equal(left.ok, true);
  assert.equal(left.tabId, first.tabId, 'the stopped tab stays open');
  assert.equal(saved.remoteKeyTabs['7'], undefined, 'the stopped key is no longer mapped');

  const listed = await ask(listener, { type: 'brosr:tabs-list' });
  assert.equal(listed.stopped.length, 1, 'the panel can offer the stopped copy');
  assert.equal(listed.stopped[0].key, '7');
  assert.equal(listed.stopped[0].tabId, first.tabId);

  const resumed = await ask(listener, { type: 'brosr:tab-resume', key: '7' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.joined, false, 'the fake browser has no room tab');
  assert.equal(saved.remoteKeyTabs['7'], first.tabId, 'the key points at the same tab');

  const after = await ask(listener, { type: 'brosr:tabs-list' });
  assert.equal(after.stopped.length, 0, 'a resumed copy is no longer stopped');
  assert.equal(created.length, 1, 'resume reuses the open tab');
});

test('a stopped copy does not follow a new film key', async () => {
  // A stop that only emptied the map held until the page named another film.
  // The next key change put the tab back in the map, and the room drove the
  // copy this person had just left.
  const { listener, release } = loadBackground();
  const url = 'https://example.test/film';
  const opened = ask(listener, { type: 'brosr:tab-open-local', url, key: '7' });
  release();
  const first = await opened;

  const hello = await ask(
    listener,
    { type: 'brosr:media-hello', key: 'film:one' },
    { tab: { id: first.tabId, active: true, url } }
  );
  assert.equal(hello.ok, true);
  const before = await ask(listener, { type: 'brosr:media-apply', key: 'film:one', position: 10 });
  assert.equal(before.sent, 1, 'the joined copy follows the film');

  await ask(listener, { type: 'brosr:tab-leave-local', key: '7' });
  const after = await ask(listener, { type: 'brosr:media-apply', key: 'film:one', position: 20 });
  assert.equal(after.sent, 0, 'a stopped copy stops following');

  const again = await ask(
    listener,
    { type: 'brosr:media-hello', key: 'film:two' },
    { tab: { id: first.tabId, active: true, url } }
  );
  assert.equal(again.ok, false, 'a new film key does not rejoin the stopped copy');
  assert.equal(again.reason, 'detached');
  const later = await ask(listener, { type: 'brosr:media-apply', key: 'film:two', position: 30 });
  assert.equal(later.sent, 0, 'the room never drives the stopped copy again');
});

test('a stopped copy is not reused for a later offer', async () => {
  // The open path looked for any tab on the same URL. That matched the copy
  // this person had stopped, and the new key took it back into the room.
  const { created, listener, release } = loadBackground();
  const url = 'https://example.test/film';
  const opened = ask(listener, { type: 'brosr:tab-open-local', url, key: '7' });
  release();
  const first = await opened;
  await ask(listener, { type: 'brosr:tab-leave-local', key: '7' });

  const second = await ask(listener, { type: 'brosr:tab-open-local', url, key: '8' });
  assert.equal(second.ok, true);
  assert.notEqual(second.tabId, first.tabId, 'the stopped tab stays out of the room');
  assert.equal(created.length, 2, 'the offer opens its own copy');
});

test('closing a shared tab right after a worker restart still withdraws it from Live tabs', async () => {
  // Chrome wakes an idle MV3 service worker on tabs.onRemoved before the async
  // session storage restores settle. Reading announced synchronously missed the
  // tab, skipped announceClose, and left the closed tab in session storage and
  // Live tabs.
  const store = {
    roomTabId: 1,
    roomRole: 'host',
    announcedTabs: { '2': 'https://example.test/watch' },
  };
  let releaseRestore = () => {};
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const bg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8891/?role=host&room=two&peer=host', active: true },
      { id: 2, url: 'https://example.test/watch', active: false },
    ],
    store,
    sessionGet: async () => {
      await restoreGate;
      return { ...store };
    },
  });

  bg.fireRemoved(2);
  releaseRestore();

  await until(
    () =>
      bg.sentMessages.some(
        (entry) =>
          entry.tabId === 1 &&
          entry.message &&
          entry.message.type === 'brosr:tabs-announce' &&
          entry.message.action === 'close' &&
          entry.message.key === '2'
      ),
    'close announcement sent to room tab'
  );
  await until(
    () => !store.announcedTabs || store.announcedTabs['2'] === undefined,
    'closed tab removed from session storage'
  );
});

test('closing a guest copy right after a worker restart notifies the room tab', async () => {
  const store = {
    roomTabId: 1,
    roomRole: 'peer',
    remoteKeyTabs: { '7': 12 },
  };
  let releaseRestore = () => {};
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const bg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8891/?role=peer&room=two&peer=guest', active: true },
      { id: 12, url: 'https://example.test/watch', active: false },
    ],
    store,
    sessionGet: async () => {
      await restoreGate;
      return { ...store };
    },
  });

  bg.fireRemoved(12);
  releaseRestore();

  await until(
    () =>
      bg.sentMessages.some(
        (entry) =>
          entry.tabId === 1 &&
          entry.message &&
          entry.message.type === 'brosr:tab-left' &&
          entry.message.key === '7'
      ),
    'tab-left sent to room tab'
  );
  assert.equal(store.remoteKeyTabs['7'], undefined, 'closed copy key removed from storage');
  assert.equal(
    bg.sentMessages.some(
      (entry) =>
        entry.message &&
        entry.message.type === 'brosr:tabs-announce' &&
        entry.message.action === 'close'
    ),
    false,
    'closing a guest copy does not withdraw the publisher offer'
  );
});

test('closing a shared tab still withdraws its offer', async () => {
  const store = { roomTabId: 1, roomRole: 'peer' };
  const localStore = {};
  const bg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8891/?role=peer&room=two&peer=guest', active: true },
      { id: 2, url: 'https://example.test/watch', active: false },
    ],
    store,
    localStore,
  });

  const shared = await ask(bg.listener, { type: 'brosr:tab-share', tabId: 2, shared: true });
  assert.equal(shared.ok, true);
  assert.equal(store.announcedTabs['2'], 'https://example.test/watch');

  await ask(bg.listener, {
    type: 'brosr:room-status',
    room: 'two',
    peerId: 'guest',
    role: 'peer',
  });

  bg.fireRemoved(2);

  await until(
    () =>
      bg.sentMessages.some(
        (entry) =>
          entry.tabId === 1 &&
          entry.message &&
          entry.message.type === 'brosr:tabs-announce' &&
          entry.message.action === 'close' &&
          entry.message.key === '2'
      ),
    'revoked peer still withdraws its closed tab'
  );
});

test('closing a tab while a sweep announcement is in flight does not resurrect it', async () => {
  const store = {};
  let releasePrefs = () => {};
  let prefsStarted = () => {};
  const prefsGate = new Promise((resolve) => {
    releasePrefs = resolve;
  });
  const prefsReached = new Promise((resolve) => {
    prefsStarted = resolve;
  });
  const bg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8891/?role=host&room=two&peer=host', active: true },
      { id: 2, url: 'https://example.test/watch', active: false },
    ],
    store,
    localGet: async () => {
      prefsStarted();
      await prefsGate;
      return {};
    },
  });

  await ask(bg.listener, { type: 'brosr:room-hello', role: 'host' }, { tab: { id: 1 } });
  await prefsReached;
  bg.fireRemoved(2);
  releasePrefs();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(
    store.announcedTabs && store.announcedTabs['2'],
    undefined,
    'closed tab is not resurrected in announcedTabs'
  );
  assert.equal(
    bg.sentMessages.some(
      (entry) =>
        entry.message &&
        entry.message.type === 'brosr:tabs-announce' &&
        !entry.message.action &&
        String(entry.message.key) === '2'
    ),
    false,
    'closed tab is never announced as open after removal'
  );
});

test('unsharing a tab via brosr:tab-share withdraws it from Live tabs', async () => {
  const store = {};
  const bg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8891/?role=host&room=two&peer=host', active: true },
      { id: 2, url: 'https://example.test/watch', active: false },
    ],
    store,
  });

  await ask(bg.listener, { type: 'brosr:room-hello', role: 'host' }, { tab: { id: 1 } });
  await until(
    () => store.announcedTabs && store.announcedTabs['2'] === 'https://example.test/watch',
    'tab 2 announced'
  );

  const unshared = await ask(bg.listener, { type: 'brosr:tab-share', tabId: 2, shared: false });
  assert.equal(unshared.ok, true);
  assert.equal(store.announcedTabs['2'], undefined, 'unshared tab removed from announcedTabs');
  assert.ok(
    bg.sentMessages.some(
      (entry) =>
        entry.tabId === 1 &&
        entry.message &&
        entry.message.type === 'brosr:tabs-announce' &&
        entry.message.action === 'close' &&
        entry.message.key === '2'
    ),
    'unsharing sends a close announcement'
  );
});

test('sweepTabs withdraws an announced tab whose close event was missed', async () => {
  const store = {
    roomTabId: 1,
    roomRole: 'host',
    announcedTabs: { '2': 'https://example.test/closed' },
  };
  const bg = loadBackground({
    tabs: [{ id: 1, url: 'http://127.0.0.1:8891/?role=host&room=two&peer=host', active: true }],
    store,
  });

  await ask(bg.listener, { type: 'brosr:room-hello', role: 'host' }, { tab: { id: 1 } });

  await until(
    () =>
      bg.sentMessages.some(
        (entry) =>
          entry.tabId === 1 &&
          entry.message &&
          entry.message.type === 'brosr:tabs-announce' &&
          entry.message.action === 'close' &&
          entry.message.key === '2'
      ),
    'sweep reconciles missing announced tab'
  );
  assert.equal(store.announcedTabs['2'], undefined, 'reconciled tab removed from storage');
});

test('brosr:tab-close-local waits for remote key restore after a worker restart', async () => {
  const store = {
    roomTabId: 1,
    roomRole: 'peer',
    remoteKeyTabs: { '7': 12 },
  };
  let releaseRestore = () => {};
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const bg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8891/?role=peer&room=two&peer=guest', active: true },
      { id: 12, url: 'https://example.test/watch', active: false },
    ],
    store,
    sessionGet: async () => {
      await restoreGate;
      return { ...store };
    },
  });

  const pending = ask(bg.listener, { type: 'brosr:tab-close-local', key: '7' });
  releaseRestore();
  const reply = await pending;

  assert.equal(reply.ok, true);
  assert.equal(reply.closed, 1);
  assert.deepEqual(bg.removedIds, [12]);
});

test('brosr:room-hello keeps live offers and lets a guest share its own', async () => {
  const store = {
    roomTabId: 1,
    roomRole: 'peer',
    announcedTabs: { '2': 'https://example.test/stale' },
  };
  const bg = loadBackground({
    tabs: [
      { id: 1, url: 'http://127.0.0.1:8891/?role=peer&room=two&peer=guest', active: true },
      { id: 2, url: 'https://example.test/stale', active: false },
    ],
    store,
  });

  await ask(bg.listener, { type: 'brosr:room-hello', role: 'peer' }, { tab: { id: 1 } });

  // The tab is still open, so the hello keeps its offer in the book.
  assert.equal(store.announcedTabs['2'], 'https://example.test/stale');
  // Any room member may offer a tab, so the guest gets a real offer.
  const attempt = await ask(bg.listener, { type: 'brosr:tab-share', tabId: 2, shared: true });
  assert.equal(attempt.ok, true);
});
