import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  inputCaptureDecision,
  isLocalControl,
  isTabOpeningClick,
  isTabOpeningKey,
  replayInput,
} from '../input.mjs';
import { createRoomClient } from '../sync.mjs';
import { prepareRecords, trustDecision } from '../trust.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..');

function makeLandingDoc(origin = 'http://127.0.0.1:8891') {
  const listeners = new Map();
  const clicks = [];
  const docEl = { tagName: 'HTML', nodeType: 1, parentNode: null, children: [] };
  const body = { tagName: 'BODY', nodeType: 1, parentNode: docEl, children: [] };
  docEl.children.push(body);

  function makeEl({
    tagName,
    id = '',
    className = '',
    href = '',
    target = '',
    localControl = false,
    inLiveTabs = false,
    onClick = null,
  }) {
    const node = {
      tagName: tagName.toUpperCase(),
      id,
      className,
      href,
      target,
      nodeType: 1,
      parentNode: body,
      ownerDocument: null,
      getAttribute(name) {
        if (name === 'id') return id || null;
        if (name === 'href') return href || null;
        if (name === 'target') return target || null;
        if (name === 'data-brosr-local') return localControl ? '1' : null;
        return null;
      },
      hasAttribute(name) {
        if (name === 'download') return false;
        return this.getAttribute(name) !== null;
      },
      closest(selector) {
        const parts = String(selector)
          .split(',')
          .map((s) => s.trim());
        for (const part of parts) {
          if (part === 'a[href]' && tagName.toLowerCase() === 'a' && href) return node;
          if (part === '[data-brosr-local]' && localControl) return node;
          if (part === '#live-tabs' && inLiveTabs) return { id: 'live-tabs' };
          if (part === '#host-takeover' && id === 'host-takeover') return node;
          if (part === '#brosr-panel-button' && id === 'brosr-panel-button') return node;
        }
        return null;
      },
      getBoundingClientRect() {
        return { left: 100, top: 100, width: 120, height: 40 };
      },
      dispatchEvent(ev) {
        if (ev.type === 'click') {
          clicks.push(id);
          if (onClick) onClick(ev);
        }
        return true;
      },
    };
    body.children.push(node);
    return node;
  }

  const tileLink = makeEl({
    tagName: 'a',
    id: 'tile-canvas',
    href: `${origin}/canvas/`,
    target: '_blank',
  });
  const externalLink = makeEl({
    tagName: 'a',
    id: 'watch-yt',
    href: 'https://www.youtube.com/',
    target: '_blank',
  });
  const sameTabLink = makeEl({
    tagName: 'a',
    id: 'same-tab-link',
    href: `${origin}/notes/`,
    target: '_self',
  });
  const liveOpenBtn = makeEl({
    tagName: 'button',
    id: 'live-open-7',
    inLiveTabs: true,
  });
  const takeoverBtn = makeEl({
    tagName: 'button',
    id: 'host-takeover',
    localControl: true,
  });
  const panelBtn = makeEl({
    tagName: 'button',
    id: 'brosr-panel-button',
    localControl: true,
  });
  const normalBtn = makeEl({
    tagName: 'button',
    id: 'normal-btn',
  });

  const pathMap = {
    '#tile-canvas': tileLink,
    '#watch-yt': externalLink,
    '#same-tab-link': sameTabLink,
    '#live-open-7': liveOpenBtn,
    '#host-takeover': takeoverBtn,
    '#brosr-panel-button': panelBtn,
    '#normal-btn': normalBtn,
  };

  const doc = {
    documentElement: docEl,
    location: { origin, href: `${origin}/?room=test&peer=host`, assign: () => {} },
    activeElement: null,
    defaultView: {
      innerWidth: 1280,
      innerHeight: 720,
      Event: class {
        constructor(t) {
          this.type = t;
        }
      },
      MouseEvent: class {
        constructor(t) {
          this.type = t;
        }
      },
      KeyboardEvent: class {
        constructor(t) {
          this.type = t;
        }
      },
      WheelEvent: class {
        constructor(t) {
          this.type = t;
        }
      },
      addEventListener() {},
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    querySelectorAll(selector) {
      if (pathMap[selector]) return [pathMap[selector]];
      return [];
    },
    dispatchEvent() {
      return true;
    },
    fireClick(el, opts = {}) {
      for (const fn of listeners.get('click') || []) {
        fn({
          isTrusted: true,
          target: el,
          button: 0,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          clientX: 110,
          clientY: 110,
          ...opts,
        });
      }
    },
    fireKeydown(el, opts = {}) {
      for (const fn of listeners.get('keydown') || []) {
        fn({
          isTrusted: true,
          target: el,
          key: 'Enter',
          code: 'Enter',
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
          ...opts,
        });
      }
    },
    clicks,
    tileLink,
    externalLink,
    sameTabLink,
    liveOpenBtn,
    takeoverBtn,
    panelBtn,
    normalBtn,
  };
  docEl.ownerDocument = doc;
  body.ownerDocument = doc;
  for (const n of body.children) n.ownerDocument = doc;
  return doc;
}

function loadBackground() {
  let listener = null;
  const created = [];
  const updated = [];
  let nextId = 100;
  const tabsById = new Map();
  const api = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
      getManifest: () => ({ version: '0.3.54' }),
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
    },
    tabs: {
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      query: async () => [...tabsById.values()],
      get: async (id) => tabsById.get(id) || null,
      create: async (opts) => {
        const tab = { id: nextId++, url: opts.url, active: Boolean(opts.active) };
        tabsById.set(tab.id, tab);
        created.push(tab);
        return tab;
      },
      update: async (id, opts) => {
        const existing = tabsById.get(id);
        if (!existing) throw new Error('missing');
        if (opts.url) existing.url = opts.url;
        updated.push({ id, ...opts });
        return existing;
      },
      remove: async (id) => {
        tabsById.delete(id);
      },
      sendMessage: async () => ({ ok: true }),
    },
  };
  const code = fs.readFileSync(path.join(rootDir, 'bridge', 'background.js'), 'utf8');
  vm.runInNewContext(code, {
    browser: api,
    chrome: api,
    URL,
    URLSearchParams,
    Set,
    Map,
    Promise,
    console,
    setTimeout,
    clearTimeout,
  });
  return {
    created,
    updated,
    tabsById,
    ask: (msg, sender = {}) => new Promise((resolve) => listener(msg, sender, resolve)),
  };
}

test('capture, synthetic replay, and trusted actuation never relay tab-opening or local-control clicks', () => {
  const hostDoc = makeLandingDoc();
  const peerDoc = makeLandingDoc();
  const wireToHost = [];
  const wireToPeer = [];

  const host = createRoomClient({
    role: 'host',
    room: 'no-tabs',
    peerId: 'host',
    hostId: 'host',
    document: hostDoc,
    overlay: false,
    send: (frame) => wireToPeer.push(frame),
  });
  const peer = createRoomClient({
    role: 'peer',
    room: 'no-tabs',
    peerId: 'peer',
    hostId: 'host',
    document: peerDoc,
    overlay: false,
    input: { capture: true },
    send: (frame) => wireToHost.push(frame),
  });

  host.setGrant('peer', true);
  while (wireToPeer.length) peer.receive(wireToPeer.shift());

  // 1. Peer capture refuses _blank tiles, external _blank links, middle/modifier
  //    clicks on links, Enter on _blank links, and local controls.
  peerDoc.fireClick(peerDoc.tileLink);
  peerDoc.fireClick(peerDoc.externalLink);
  peerDoc.fireClick(peerDoc.sameTabLink, { button: 1 });
  peerDoc.fireClick(peerDoc.sameTabLink, { metaKey: true });
  peerDoc.fireClick(peerDoc.sameTabLink, { ctrlKey: true });
  peerDoc.fireClick(peerDoc.liveOpenBtn);
  peerDoc.fireClick(peerDoc.takeoverBtn);
  peerDoc.fireClick(peerDoc.panelBtn);
  peerDoc.fireKeydown(peerDoc.tileLink, { key: 'Enter' });
  peerDoc.fireKeydown(peerDoc.sameTabLink, { key: 'Enter', metaKey: true });

  assert.equal(wireToHost.length, 0, 'none of the tab-opening or local-control acts are captured');

  // Verify helper decisions directly as well.
  assert.equal(isLocalControl(peerDoc.liveOpenBtn), true);
  assert.equal(isLocalControl(peerDoc.takeoverBtn), true);
  assert.equal(isLocalControl(peerDoc.panelBtn), true);
  assert.equal(isTabOpeningClick(peerDoc.tileLink, { button: 0 }), true);
  assert.equal(isTabOpeningClick(peerDoc.sameTabLink, { button: 1 }), true);
  assert.equal(isTabOpeningKey(peerDoc.tileLink, { key: 'Enter' }), true);
  assert.equal(
    inputCaptureDecision({ doc: peerDoc, event: { isTrusted: true, target: peerDoc.tileLink, button: 0 } }).reason,
    'new-tab'
  );
  assert.equal(
    inputCaptureDecision({ doc: peerDoc, event: { isTrusted: true, target: peerDoc.liveOpenBtn, button: 0 } }).reason,
    'local-control'
  );

  // 2. Even if an older or forged peer sends raw records directly over the wire,
  //    both synthetic replay and trusted actuation drop them with explicit reasons.
  const forged = [
    { kind: 'click', path: '#tile-canvas', button: 0 },
    { kind: 'click', path: '#watch-yt', button: 0 },
    { kind: 'click', path: '#same-tab-link', button: 1 },
    { kind: 'click', path: '#live-open-7', button: 0 },
    { kind: 'click', path: '#host-takeover', button: 0 },
    { kind: 'click', path: '#brosr-panel-button', button: 0 },
    { kind: 'key', path: '#tile-canvas', key: 'Enter' },
    { kind: 'click', path: '#normal-btn', button: 0 },
  ];

  const replayed = replayInput(forged, { root: hostDoc });
  assert.equal(replayed.applied, 1, 'only the normal same-tab button click applies');
  assert.equal(replayed.dropped, 7);
  assert.equal(replayed.reasons['new-tab'], 4);
  assert.equal(replayed.reasons['local-control'], 3);
  assert.deepEqual(hostDoc.clicks, ['normal-btn']);

  assert.deepEqual(trustDecision(forged[0], hostDoc), { allow: false, reason: 'new-tab' });
  assert.deepEqual(trustDecision(forged[1], hostDoc), { allow: false, reason: 'new-tab' });
  assert.deepEqual(trustDecision(forged[2], hostDoc), { allow: false, reason: 'new-tab' });
  assert.deepEqual(trustDecision(forged[3], hostDoc), { allow: false, reason: 'local-control' });
  assert.deepEqual(trustDecision(forged[4], hostDoc), { allow: false, reason: 'local-control' });
  assert.deepEqual(trustDecision(forged[5], hostDoc), { allow: false, reason: 'local-control' });
  assert.deepEqual(trustDecision(forged[6], hostDoc), { allow: false, reason: 'new-tab' });
  assert.deepEqual(trustDecision(forged[7], hostDoc), { allow: true, reason: 'ok' });

  const prepared = prepareRecords(forged, hostDoc);
  assert.equal(prepared.length, 1, 'prepareRecords emits only the normal button click');
});

test('background brosr:tab-open-local with updateOnly never creates a tab when copy is missing', async () => {
  const bg = loadBackground();

  // Remote follow update arrives for a key that has no local copy -> must NOT create a tab.
  const missing = await bg.ask({
    type: 'brosr:tab-open-local',
    url: 'https://example.test/episode-2',
    key: '99',
    updateOnly: true,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'no-copy');
  assert.equal(bg.created.length, 0);

  // Explicit local click ("Open" in Live tabs) creates the joined copy once.
  const opened = await bg.ask({
    type: 'brosr:tab-open-local',
    url: 'https://example.test/episode-1',
    key: '7',
    foreground: true,
  });
  assert.equal(opened.ok, true);
  assert.equal(bg.created.length, 1);

  // Remote navigation update with updateOnly: true updates the existing joined copy in place.
  const followed = await bg.ask({
    type: 'brosr:tab-open-local',
    url: 'https://example.test/episode-2',
    key: '7',
    updateOnly: true,
  });
  assert.equal(followed.ok, true);
  assert.equal(followed.updated, true);
  assert.equal(bg.created.length, 1, 'still only 1 tab created');
  assert.equal(bg.updated.at(-1).url, 'https://example.test/episode-2');

  // If the user closes their copy locally, a subsequent remote updateOnly follow does NOT reopen it.
  bg.tabsById.delete(opened.tabId);
  const afterClose = await bg.ask({
    type: 'brosr:tab-open-local',
    url: 'https://example.test/episode-3',
    key: '7',
    updateOnly: true,
  });
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.reason, 'no-copy');
  assert.equal(bg.created.length, 1, 'closed copy is never recreated by a remote update');
});

test('landing page marks local room controls and rejects synthetic Live tabs clicks', () => {
  const html = fs.readFileSync(path.join(rootDir, 'landing', 'index.html'), 'utf8');
  assert.match(html, /id="live-tabs"[^>]*data-brosr-local="1"/);
  assert.match(html, /id="host-takeover"[^>]*data-brosr-local="1"/);
  assert.match(html, /stop\.addEventListener\('click',\s*function \(event\)\s*\{\s*if \(!event\.isTrusted\) return;/);
  assert.match(html, /button\.addEventListener\('click',\s*function \(event\)\s*\{\s*if \(!event\.isTrusted\) return;/);
});
