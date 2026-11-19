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

function loadBackground({ sessionGet, tabs: seed = [], store = {} } = {}) {
  const tabs = seed.slice();
  const saved = store;
  const created = [];
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
        get: async () => ({}),
        set: async () => {},
      },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
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
      remove: async () => {},
      sendMessage: async () => ({ ok: true }),
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
    created,
    saved,
    listener,
    release: () => releaseCreate(),
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
