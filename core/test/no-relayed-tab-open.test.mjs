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
import { encode } from '../protocol.mjs';
import { createRoomClient } from '../sync.mjs';
import { actionsForRecord, prepareRecords, trustDecision } from '../trust.mjs';

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

test('landing page marks local room controls, tiles, Watch directory/filter, and preserves live cursors', () => {
  const html = fs.readFileSync(path.join(rootDir, 'landing', 'index.html'), 'utf8');
  assert.match(html, /id="live-tabs"[^>]*data-brosr-local="1"/);
  assert.match(html, /id="host-takeover"[^>]*data-brosr-local="1"/);
  assert.match(html, /id="tiles"[^>]*data-brosr-local="1"/);
  assert.match(html, /class="tile tile-youtube"[^>]*data-brosr-local="1"/);
  assert.match(html, /class="tile tile-music"[^>]*data-brosr-local="1"/);
  assert.match(html, /class="tile tile-watch"[^>]*data-brosr-local="1"/);
  assert.match(html, /id="site-filter"[^>]*data-brosr-local="1"/);
  assert.match(html, /id="watch-sites"[^>]*data-brosr-local="1"/);
  assert.match(html, /class="tile tile-play"[^>]*data-brosr-local="1"/);
  assert.match(html, /class="tile tile-notes"[^>]*data-brosr-local="1"/);
  assert.match(html, /class="tile tile-canvas"[^>]*data-brosr-local="1"/);
  assert.match(html, /class="skip"[^>]*data-brosr-local="1"/);
  assert.match(
    html,
    /takeover\.addEventListener\('click',\s*function \(event\)\s*\{\s*if \(event && event\.isTrusted === false\) return;/
  );
  assert.match(html, /stop\.addEventListener\('click',\s*function \(event\)\s*\{\s*if \(!event\.isTrusted\) return;/);
  assert.match(html, /button\.addEventListener\('click',\s*function \(event\)\s*\{\s*if \(!event\.isTrusted\) return;/);
  // Live room cursors remain wired on the landing page.
  assert.match(html, /id="cursors"/);
  assert.match(html, /window\.addEventListener\(\s*'pointermove'/);
});

test('point-only clicks, unresolvable paths, form/base targets, and new-tab shortcuts are refused across all layers', () => {
  const blankLink = {
    tagName: 'A',
    href: 'https://www.youtube.com/',
    target: '_blank',
    getAttribute: (name) => (name === 'href' ? 'https://www.youtube.com/' : name === 'target' ? '_blank' : ''),
    closest: (sel) => (sel === 'a[href]' ? blankLink : null),
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 40 }),
  };
  const tilesSection = {
    tagName: 'SECTION',
    id: 'tiles',
    getAttribute: (name) => (name === 'id' ? 'tiles' : ''),
    closest: (sel) => (sel === '#tiles' ? tilesSection : null),
    getBoundingClientRect: () => ({ left: 200, top: 200, width: 100, height: 40 }),
  };
  const normalBtn = {
    tagName: 'BUTTON',
    id: 'ok',
    getAttribute: (name) => (name === 'id' ? 'ok' : ''),
    closest: () => null,
    getBoundingClientRect: () => ({ left: 400, top: 400, width: 80, height: 30 }),
  };
  const baseBlankDoc = {
    querySelector: (sel) => (sel === 'base[target]' ? { getAttribute: () => '_blank' } : null),
  };
  const baseInheritedLink = {
    tagName: 'A',
    href: 'https://example.test/watch',
    target: '',
    ownerDocument: baseBlankDoc,
    getAttribute: (name) => (name === 'href' ? 'https://example.test/watch' : ''),
    closest: (sel) => (sel === 'a[href]' ? baseInheritedLink : null),
  };
  const formTargetBtn = {
    tagName: 'BUTTON',
    formTarget: '_blank',
    getAttribute: (name) => (name === 'formtarget' ? '_blank' : ''),
    closest: (sel) => (sel.includes('button') ? formTargetBtn : null),
  };
  const formParentBtn = {
    tagName: 'BUTTON',
    form: { target: '_blank', getAttribute: () => '_blank' },
    getAttribute: () => '',
    closest: (sel) => (sel.includes('button') ? formParentBtn : null),
  };

  const doc = {
    querySelectorAll: (sel) => (sel === '#ok' ? [normalBtn] : []),
    elementFromPoint: (x, y) => {
      if (x === 25 && y === 25) return blankLink;
      if (x === 225 && y === 225) return tilesSection;
      if (x === 420 && y === 415) return normalBtn;
      return null;
    },
  };

  // Point-only click landing on a[target="_blank"] or #tiles cannot bypass trust guards.
  assert.deepEqual(trustDecision({ kind: 'click', point: { x: 25, y: 25 }, button: 0 }, doc), {
    allow: false,
    reason: 'new-tab',
  });
  assert.deepEqual(trustDecision({ kind: 'click', point: { x: 225, y: 225 }, button: 0 }, doc), {
    allow: false,
    reason: 'local-control',
  });
  // Unresolvable path with a forged point is rejected as target mismatch.
  assert.deepEqual(
    trustDecision({ kind: 'click', path: '#missing', point: { x: 420, y: 415 }, button: 0 }, doc),
    { allow: false, reason: 'target' }
  );
  // Base target, formtarget, form[target], and #tiles fallback are caught.
  assert.equal(isTabOpeningClick(baseInheritedLink, { button: 0 }), true);
  assert.equal(isTabOpeningClick(formTargetBtn, { button: 0 }), true);
  assert.equal(isTabOpeningClick(formParentBtn, { button: 0 }), true);
  assert.equal(isLocalControl(tilesSection), true);

  // Browser new-tab / new-window keyboard shortcuts are blocked at every layer.
  for (const shortcut of [
    { kind: 'key', key: 't', ctrl: true },
    { kind: 'key', key: 't', meta: true },
    { kind: 'key', key: 'n', ctrl: true },
    { kind: 'key', key: 'n', meta: true },
  ]) {
    assert.equal(isTabOpeningKey(null, shortcut), true);
    assert.equal(inputCaptureDecision({ record: shortcut }).reason, 'new-tab');
    assert.deepEqual(trustDecision(shortcut, doc), { allow: false, reason: 'new-tab' });
    assert.equal(actionsForRecord(shortcut), null);
  }
  // Middle-click is blocked even without a DOM node.
  assert.deepEqual(trustDecision({ kind: 'click', point: { x: 420, y: 415 }, button: 1 }, null), {
    allow: false,
    reason: 'new-tab',
  });
  assert.equal(actionsForRecord({ kind: 'click', point: { x: 420, y: 415 }, button: 1 }), null);

  // prepareRecords filters out all of the above while keeping a normal click.
  const prepared = prepareRecords(
    [
      { kind: 'click', point: { x: 25, y: 25 }, button: 0 },
      { kind: 'click', point: { x: 225, y: 225 }, button: 0 },
      { kind: 'click', path: '#missing', point: { x: 420, y: 415 }, button: 0 },
      { kind: 'click', path: '#ok', button: 1 },
      { kind: 'key', key: 't', meta: true },
      { kind: 'click', path: '#ok', button: 0 },
    ],
    doc
  );
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].path, '#ok');
  assert.equal(prepared[0].button, 0);
});

test('browser-entry never wires remote room-tab navigation and sync enforces host authority on nav', async () => {
  const entry = fs.readFileSync(path.join(rootDir, 'core', 'browser-entry.mjs'), 'utf8');
  assert.doesNotMatch(entry, /location\.assign\(/, 'browser-entry must never call location.assign on remote frames');
  assert.doesNotMatch(entry, /\bnavigate\b/, 'browser-entry must not pass a navigate callback to createRoomClient');

  // Host ignores incoming nav frames; peer ignores non-host or unattributed nav frames.
  const hostNavs = [];
  const host = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    navigate: (url) => hostNavs.push(url),
    send: () => {},
  });
  const onHost = host.receive(encode({ type: 'nav', from: 'peer-1', url: 'https://evil.test', roomTime: 1 }));
  assert.equal(onHost.ignored, 'host');
  assert.deepEqual(hostNavs, []);

  const peerNavs = [];
  const peer = createRoomClient({
    role: 'peer',
    peerId: 'peer-1',
    hostId: 'host-1',
    navigate: (url) => peerNavs.push(url),
    send: () => {},
  });
  assert.equal(
    peer.receive(encode({ type: 'nav', from: 'peer-2', url: 'https://evil.test', roomTime: 1 })).ignored,
    'not-host'
  );
  assert.equal(
    peer.receive(encode({ type: 'nav', url: 'https://evil.test', roomTime: 1 })).ignored,
    'not-host'
  );
  assert.deepEqual(peerNavs, []);

  // Trusted actuator 403 policy refusal (new-tab) never falls back to synthetic replay.
  const doc = makeLandingDoc();
  const hostWithTrust = createRoomClient({
    role: 'host',
    peerId: 'host-1',
    hostId: 'host-1',
    document: doc,
    overlay: false,
    send: () => {},
    input: {
      trusted: async () => ({ ok: false, allow: false, reason: 'new-tab' }),
    },
  });
  hostWithTrust.setGrant('peer-1', true);
  hostWithTrust.receive(
    encode({
      type: 'input',
      peerId: 'peer-1',
      seq: 1,
      records: [{ kind: 'click', path: '#normal-btn', button: 0 }],
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(doc.clicks, [], 'policy refusal must never fall back to synthetic replay');
  assert.equal(hostWithTrust.stats.inputReasons['new-tab'], 1);
});
