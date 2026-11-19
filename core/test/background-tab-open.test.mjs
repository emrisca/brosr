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

function loadBackground() {
  const tabs = [];
  const saved = {};
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
        get: async () => ({}),
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

function ask(listener, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('background did not answer')), 1000);
    listener(message, {}, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

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
