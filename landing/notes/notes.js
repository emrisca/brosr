'use strict';
// Notes. One page at a time, formatted in place. The host saves each page to
// its own disk and carries the library to the room. A page is shared as
// characters, not as a snapshot of the whole body, so two people can type in
// the same paragraph at once and neither one's words are thrown away.
//
//   ./text-crdt.mjs    the merged text model, no DOM
//   ./notes-editor.mjs the page reader and painter, no transport

import {
  createDoc,
  snapshot,
  restore,
  apply,
  addBlock,
  ensureBlock,
  insertText,
  deleteText,
  setBlockType,
  blockOrder,
  charOrder,
  charCount,
} from './text-crdt.mjs';
import {
  renderDoc,
  renderBlock,
  htmlOf,
  modelFromHtml,
  syncFromDom,
  capturePoint,
  restorePoint,
  placeCaret,
  rectsForRange,
} from './notes-editor.mjs';

const params = new URLSearchParams(location.search);
const ROLE = params.get('role') || 'guest';
const ROOM = params.get('room') || 'default';
const WHO = (params.get('name') || '').replace(/[^\w .-]/g, '').trim().slice(0, 24) || 'Guest';
const PEER = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2))
  .replace(/[^a-z0-9]/gi, '')
  .slice(0, 8);
const api = window.BrosrDocs || null;

const docs = {
  host: ROLE === 'host' && Boolean(api),
  list: [],
  active: '',
  name: 'Untitled note',
  at: 0,
  stored: true,
  hidden: false,
  saveTimer: 0,
  lentAt: 0,
  query: '',
  model: null,
};

const room = { socket: null, retry: null, seq: 0, last: new Map(), carets: new Map(), snaps: new Map() };

const editor = document.getElementById('editor');
const nameInput = document.getElementById('doc-name');
const listEl = document.getElementById('doc-list');
const countEl = document.getElementById('docs-count');
const storeInput = document.getElementById('doc-store');
const newButton = document.getElementById('doc-new');
const searchInput = document.getElementById('doc-search');
const stateEl = document.getElementById('doc-state');
const wordsEl = document.getElementById('word-count');
const roomEl = document.getElementById('room-state');
const fontSize = document.getElementById('font-size');
const toolbar = document.querySelector('.toolbar');
const caretLayer = document.getElementById('carets');

// ---------------------------------------------------------------------------
// Text

function label(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function previewOf(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateWords() {
  if (!wordsEl) return;
  const count = docs.model ? charCount(docs.model) : 0;
  wordsEl.textContent = count === 1 ? '1 character' : count + ' characters';
}

function setState(text) {
  if (stateEl) stateEl.textContent = text;
}

function shortDate(ms) {
  if (!ms) return 'new';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'new';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Documents

function noteFrame() {
  return {
    id: docs.active,
    kind: 'note',
    name: docs.name,
    at: Date.now(),
    hidden: docs.hidden,
    stored: docs.stored,
    body: htmlOf(docs.model),
    crdt: snapshot(docs.model),
  };
}

function mergeEntry(doc) {
  const entry = {
    id: doc.id,
    name: doc.name,
    at: doc.at,
    hidden: doc.hidden === true,
    stored: doc.stored !== false,
    preview: previewOf(doc.body),
  };
  const index = docs.list.findIndex((item) => item.id === doc.id);
  if (index >= 0) docs.list[index] = entry;
  else docs.list.unshift(entry);
  docs.list.sort((a, b) => b.at - a.at);
}

function showDocuments() {
  if (!listEl) return;
  listEl.textContent = '';
  const visible = docs.list.filter((item) => docs.host || !item.hidden);
  const query = docs.query.trim().toLowerCase();
  const matched = query
    ? visible.filter((item) =>
        (item.name + ' ' + (item.preview || '')).toLowerCase().includes(query)
      )
    : visible;
  if (countEl) countEl.textContent = String(visible.length);
  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'doc-empty';
    empty.textContent = docs.host ? 'No saved note yet.' : 'Nothing shared yet.';
    listEl.append(empty);
  } else if (!matched.length) {
    const empty = document.createElement('li');
    empty.className = 'doc-empty';
    empty.textContent = 'No note matches "' + docs.query.trim() + '".';
    listEl.append(empty);
  }
  for (const item of matched) {
    const row = document.createElement('li');
    row.className = 'doc-row';
    if (item.id === docs.active) row.classList.add('is-active');
    if (item.hidden) row.classList.add('is-hidden');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'doc-open';
    const title = document.createElement('span');
    title.className = 'doc-title';
    title.textContent = item.name;
    const preview = document.createElement('span');
    preview.className = 'doc-preview';
    preview.textContent = item.preview || 'Empty note';
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = shortDate(item.at) + (item.hidden ? ', hidden' : '');
    open.append(title, preview, meta);
    open.addEventListener('click', () => openDocument(item.id));
    row.append(open);

    if (docs.host) {
      const tools = document.createElement('div');
      tools.className = 'doc-tools';
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'doc-tool';
      hide.textContent = item.hidden ? 'Show' : 'Hide';
      hide.title = item.hidden ? 'Let the room see this note' : 'Keep this note to yourself';
      hide.addEventListener('click', () => toggleHidden(item));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'doc-tool';
      del.textContent = 'Delete';
      del.title = 'Delete this note from the host';
      del.addEventListener('click', () => deleteDocument(item));
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'doc-tool';
      copy.textContent = 'Copy';
      copy.title = 'Duplicate this note';
      copy.addEventListener('click', () => duplicateDocument(item));
      tools.append(copy, hide, del);
      row.append(tools);
    }
    listEl.append(row);
  }

  if (nameInput) {
    nameInput.value = docs.active ? docs.name : '';
    nameInput.disabled = !docs.host || !docs.active;
  }
  if (storeInput) {
    storeInput.checked = docs.stored;
    storeInput.disabled = !docs.host || !docs.active;
  }
}

function modelFor(doc) {
  if (doc && doc.crdt && Array.isArray(doc.crdt.blocks)) return restore(doc.crdt, PEER);
  return modelFromHtml((doc && doc.body) || '', PEER);
}

function applyDocument(doc, remote) {
  if (!doc || typeof doc.id !== 'string') return;
  docs.active = doc.id;
  docs.name = label(doc.name) || 'Untitled note';
  docs.at = Number(doc.at) || Date.now();
  if (!remote) {
    docs.stored = doc.stored !== false;
    docs.hidden = doc.hidden === true;
  }
  docs.model = modelFor(doc);
  ensureBlock(docs.model);
  renderDoc(editor, docs.model);
  updateWords();
  showDocuments();
  setState(remote || !docs.stored ? 'From the room' : 'Saved');
  editor.scrollTop = 0;
}

async function saveDocument() {
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  if (!docs.host || !api || !docs.active || !docs.stored || !docs.model) return;
  const doc = noteFrame();
  docs.at = doc.at;
  setState('Saving');
  try {
    await api.put(doc);
  } catch {
    setState('Offline');
    return;
  }
  setState('Saved');
  mergeEntry(doc);
  showDocuments();
  // A guest list keeps up without a write per keystroke. One frame every few
  // seconds covers a preview and a date.
  if (Date.now() - docs.lentAt > 3000) {
    docs.lentAt = Date.now();
    send({ op: 'docs', docs: visibleDocuments() });
  }
}

function saveSoon() {
  if (!docs.host || !docs.active) return;
  clearTimeout(docs.saveTimer);
  docs.saveTimer = setTimeout(saveDocument, 700);
}

async function refreshDocuments() {
  if (!docs.host || !api) {
    showDocuments();
    return;
  }
  try {
    const list = await api.list('note');
    docs.list = Array.isArray(list) ? list : [];
  } catch {
    docs.list = Array.isArray(docs.list) ? docs.list : [];
  }
  showDocuments();
  broadcastDocuments();
}

function visibleDocuments() {
  return docs.list
    .filter((item) => !item.hidden)
    .map((item) => ({ id: item.id, name: item.name, at: item.at, preview: item.preview }));
}

function broadcastDocuments() {
  if (!docs.host) return;
  docs.lentAt = Date.now();
  send({ op: 'docs', docs: visibleDocuments() });
}

async function openDocument(id) {
  if (!docs.host) {
    send({ op: 'doc-want', id });
    return;
  }
  if (!api || typeof id !== 'string') return;
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  if (docs.active && docs.active !== id) await saveDocument();
  let doc = null;
  try {
    doc = await api.get(id);
  } catch {
    doc = null;
  }
  if (!doc) return;
  applyDocument(doc, false);
  broadcastOpen();
}

async function newDocument() {
  if (!docs.host) {
    send({ op: 'doc-new' });
    return;
  }
  if (!api) return;
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  if (docs.active) await saveDocument();
  const doc = {
    id: api.id(),
    kind: 'note',
    name: 'Note ' + (docs.list.length + 1),
    at: Date.now(),
    hidden: false,
    stored: docs.stored,
    body: '',
  };
  applyDocument(doc, false);
  if (doc.stored) {
    try {
      await api.put(noteFrame());
    } catch {
      // A failed first save leaves the note in the room only.
    }
    mergeEntry(noteFrame());
    showDocuments();
    broadcastDocuments();
  }
  broadcastOpen();
}

// A copy keeps the page as it reads now and writes a new file, so a draft can
// branch without touching the note it came from.
async function duplicateDocument(entry) {
  if (!docs.host || !api || !entry) return;
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  if (docs.active) await saveDocument();
  let source = null;
  try {
    source = await api.get(entry.id);
  } catch {
    source = null;
  }
  if (!source) return;
  const model = modelFor(source);
  const copy = {
    id: api.id(),
    kind: 'note',
    name: label(source.name + ' copy'),
    at: Date.now(),
    hidden: false,
    stored: docs.stored,
    body: htmlOf(model),
    crdt: snapshot(model),
  };
  if (copy.stored) {
    try {
      await api.put(copy);
    } catch {
      return;
    }
  }
  docs.model = model;
  docs.active = copy.id;
  docs.name = copy.name;
  docs.at = copy.at;
  docs.hidden = false;
  renderDoc(editor, docs.model);
  updateWords();
  if (copy.stored) {
    mergeEntry(copy);
    showDocuments();
    broadcastDocuments();
  }
  broadcastOpen();
}

async function toggleHidden(entry) {
  if (!docs.host || !api) return;
  let doc = null;
  try {
    doc = await api.get(entry.id);
  } catch {
    doc = null;
  }
  if (!doc) return;
  doc.hidden = !(doc.hidden === true);
  try {
    await api.put(doc);
  } catch {
    return;
  }
  if (docs.active === doc.id) docs.hidden = doc.hidden;
  await refreshDocuments();
}

async function deleteDocument(entry) {
  if (!docs.host || !api) return;
  if (!window.confirm('Delete "' + entry.name + '" for good?')) return;
  try {
    await api.remove(entry.id);
  } catch {
    return;
  }
  docs.list = docs.list.filter((item) => item.id !== entry.id);
  if (docs.active === entry.id) {
    docs.active = '';
    docs.name = 'Untitled note';
    docs.stored = true;
    docs.hidden = false;
    docs.model = null;
    editor.replaceChildren();
    if (docs.list.length) await openDocument(docs.list[0].id);
    else await newDocument();
  }
  showDocuments();
  broadcastDocuments();
}

// ---------------------------------------------------------------------------
// Room

function send(data) {
  if (!room.socket || room.socket.readyState !== WebSocket.OPEN) return;
  const frame = JSON.stringify({ v: 1, type: 'app', peerId: PEER, name: 'notes', data });
  if (frame.length > 15 * 1024) return;
  room.socket.send(frame);
}

function sendDirect(peer, data) {
  send({ ...data, to: peer });
}

// One operation is small; a paste is many. Cut the batch so every frame stays
// under the room's ceiling, and let the receiver apply the parts in order.
function chunkOps(ops) {
  const out = [];
  let batch = [];
  for (const op of ops) {
    batch.push(op);
    if (JSON.stringify({ op: 'ops', doc: docs.active, ops: batch }).length > 10000) {
      const last = batch.pop();
      if (batch.length) out.push(batch);
      batch = [last];
    }
  }
  if (batch.length) out.push(batch);
  return out;
}

function sendOps(ops) {
  if (!ops.length) return;
  const stamped = ops.map((op) => ({ ...op, s: PEER, n: (room.seq += 1) }));
  for (const batch of chunkOps(stamped)) send({ op: 'ops', doc: docs.active, ops: batch });
  // The operation already changed this page, so mark the doc dirty for the
  // host write even when the socket is down.
  saveSoon();
}

function snapshotFrames() {
  const state = snapshot(docs.model);
  const items = [];
  for (const block of state.blocks) {
    const base = { id: block.id, l: block.l, t: block.t };
    if (block.d === 1) base.d = 1;
    let chunk = [];
    let size = 0;
    for (const row of block.c || []) {
      const rowSize = JSON.stringify(row).length;
      if (chunk.length && size + rowSize > 5000) {
        items.push({ ...base, c: chunk });
        chunk = [];
        size = 0;
      }
      chunk.push(row);
      size += rowSize;
    }
    items.push({ ...base, c: chunk });
  }
  const frames = [];
  let batch = [];
  for (const item of items) {
    batch.push(item);
    if (JSON.stringify({ op: 'snap', doc: docs.active, items: batch }).length > 10000) {
      const last = batch.pop();
      if (batch.length) frames.push(batch);
      batch = [last];
    }
  }
  if (batch.length) frames.push(batch);
  return frames.map((items, index) => ({
    op: 'snap',
    doc: docs.active,
    name: docs.name,
    at: docs.at,
    items,
    part: index + 1,
    of: frames.length,
  }));
}

function sendSnapshot(to) {
  if (!docs.host || !docs.active || !docs.model) return;
  for (const frame of snapshotFrames()) {
    if (to) sendDirect(to, frame);
    else send(frame);
  }
}

function broadcastOpen() {
  if (!docs.host || !docs.active) return;
  send({ op: 'doc-open', doc: { id: docs.active, name: docs.name, at: docs.at } });
  sendSnapshot();
}

function askForSync() {
  if (docs.active) send({ op: 'resync', doc: docs.active });
}

// A frame carries the sender's counter. A jump means a frame was lost, and the
// host can rebuild this page from its own copy.
function noteSequence(op) {
  if (!op || typeof op.s !== 'string' || typeof op.n !== 'number') return;
  const last = room.last.get(op.s) || 0;
  if (op.n <= last) return;
  room.last.set(op.s, op.n);
  if (op.n > last + 1) askForSync();
}

function showRoom(text) {
  if (roomEl) roomEl.textContent = text;
}

const COLOURS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#4d7c0f'];

function colourFor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[hash % COLOURS.length];
}

function pointPayload(point) {
  return {
    start: { b: point.start.b, n: point.start.n, id: point.start.id },
    end: { b: point.end.b, n: point.end.n, id: point.end.id },
  };
}

let lastCaretAt = 0;

function shareCaret(force) {
  if (!room.socket || !docs.active || !docs.model) return;
  const now = Date.now();
  if (!force && now - lastCaretAt < 140) return;
  lastCaretAt = now;
  const point = capturePoint(editor, docs.model);
  if (!point) {
    send({ op: 'caret', doc: docs.active, gone: true });
    return;
  }
  send({ op: 'caret', doc: docs.active, at: pointPayload(point), name: WHO, colour: colourFor(PEER) });
}

function drawCarets() {
  if (!caretLayer) return;
  caretLayer.replaceChildren();
  if (!docs.model) return;
  const wrap = caretLayer.parentElement;
  const box = wrap ? wrap.getBoundingClientRect() : { left: 0, top: 0 };
  const page = editor.getBoundingClientRect();
  const now = Date.now();
  for (const [id, peer] of room.carets) {
    if (now - peer.seen > 8000) {
      room.carets.delete(id);
      continue;
    }
    if (!peer.at) continue;
    const rects = rectsForRange(editor, docs.model, peer.at.start, peer.at.end);
    const visible = rects.filter((rect) => rect.bottom > page.top && rect.top < page.bottom && rect.right > page.left);
    if (!visible.length) continue;
    const collapsed =
      peer.at.start.b === peer.at.end.b && peer.at.start.n === peer.at.end.n;
    if (!collapsed) {
      for (const rect of visible) {
        const mark = document.createElement('div');
        mark.className = 'peer-mark';
        mark.style.left = rect.left - box.left + 'px';
        mark.style.top = rect.top - box.top + 'px';
        mark.style.width = Math.max(2, rect.width) + 'px';
        mark.style.height = rect.height + 'px';
        mark.style.background = peer.colour;
        caretLayer.append(mark);
      }
    }
    const last = visible[visible.length - 1];
    const bar = document.createElement('div');
    bar.className = 'peer-caret';
    bar.dataset.peer = id;
    bar.style.left = last.left - box.left + (collapsed ? 0 : last.width) + 'px';
    bar.style.top = last.top - box.top + 'px';
    bar.style.height = last.height + 'px';
    bar.style.background = peer.colour;
    const tag = document.createElement('span');
    tag.className = 'peer-name';
    tag.textContent = peer.name;
    tag.style.background = peer.colour;
    bar.append(tag);
    caretLayer.append(bar);
  }
}

function applyRemote(ops, from) {
  if (!docs.model || !Array.isArray(ops)) return;
  const before = capturePoint(editor, docs.model);
  const touched = new Set();
  for (const op of ops) {
    noteSequence(op);
    for (const id of apply(docs.model, op)) touched.add(id);
  }
  if (!touched.size) return;
  let whole = false;
  for (const id of touched) {
    if (!renderBlock(editor, docs.model, id)) {
      whole = true;
      break;
    }
  }
  if (whole) renderDoc(editor, docs.model);
  if (before) restorePoint(editor, docs.model, before);
  updateWords();
  drawCarets();
  if (docs.host) saveSoon();
  else setState('Shared');
}

function adoptSnapshot(items, from) {
  const byId = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    const held = byId.get(item.id);
    if (held) held.c.push(...(item.c || []));
    else byId.set(item.id, { id: item.id, l: item.l, t: item.t, d: item.d, c: [...(item.c || [])] });
  }
  const point = capturePoint(editor, docs.model);
  docs.model = restore({ v: 1, blocks: [...byId.values()] }, PEER);
  ensureBlock(docs.model);
  renderDoc(editor, docs.model);
  if (point) restorePoint(editor, docs.model, point);
  updateWords();
  drawCarets();
  if (docs.host) saveSoon();
  else setState('Shared');
}

function handle(from, data) {
  if (!data || typeof data !== 'object') return;
  if (data.to && data.to !== PEER) return;

  if (data.op === 'docs' && Array.isArray(data.docs)) {
    if (docs.host) return;
    docs.list = data.docs
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        name: label(item.name) || 'Note',
        at: Number(item.at) || 0,
        hidden: false,
        stored: false,
        preview: typeof item.preview === 'string' ? item.preview.slice(0, 140) : '',
      }));
    showDocuments();
    return;
  }

  if (data.op === 'docs-ask') {
    if (!docs.host) return;
    broadcastDocuments();
    if (docs.active) {
      sendDirect(from, {
        op: 'doc-open',
        doc: { id: docs.active, name: docs.name, at: docs.at },
      });
      sendSnapshot(from);
    }
    return;
  }

  if (data.op === 'doc-want' && typeof data.id === 'string') {
    if (!docs.host) return;
    const entry = docs.list.find((item) => item.id === data.id);
    if (!entry || entry.hidden) return;
    openDocument(data.id);
    return;
  }

  if (data.op === 'doc-new') {
    if (docs.host) newDocument();
    return;
  }

  if (data.op === 'doc-open' && data.doc) {
    if (docs.host) return;
    const doc = data.doc;
    if (doc.id === docs.active) return;
    docs.active = doc.id;
    docs.name = label(doc.name) || 'Untitled note';
    docs.at = Number(doc.at) || Date.now();
    docs.model = createDoc(PEER);
    ensureBlock(docs.model);
    renderDoc(editor, docs.model);
    showDocuments();
    updateWords();
    setState('Opening');
    return;
  }

  if (data.op === 'snap' && Array.isArray(data.items)) {
    if (docs.host) return;
    if (data.doc && data.doc !== docs.active) {
      docs.active = data.doc;
      docs.name = label(data.name) || docs.name;
      docs.model = createDoc(PEER);
      ensureBlock(docs.model);
      renderDoc(editor, docs.model);
      showDocuments();
    }
    const key = 'snap';
    let held = room.snaps.get(key);
    if (!held || data.part === 1) {
      held = { items: [], of: Number(data.of) || 1 };
      room.snaps.set(key, held);
    }
    held.items.push(...data.items);
    if ((Number(data.part) || 1) >= (held.of || 1)) {
      room.snaps.delete(key);
      adoptSnapshot(held.items, from);
    }
    return;
  }

  if (data.op === 'ops' && Array.isArray(data.ops)) {
    if (!docs.active || data.doc !== docs.active) return;
    applyRemote(data.ops, from);
    return;
  }

  if (data.op === 'resync') {
    if (!docs.host) return;
    if (data.doc && data.doc !== docs.active) return;
    sendSnapshot(from);
    return;
  }

  if (data.op === 'caret' && data.doc === docs.active) {
    if (data.gone) room.carets.delete(from);
    else if (data.at) {
      room.carets.set(from, {
        name: label(data.name) || 'Guest',
        colour: /^#[0-9a-f]{6}$/i.test(data.colour || '') ? data.colour : colourFor(from),
        at: data.at,
        seen: Date.now(),
      });
    }
    drawCarets();
    return;
  }

  if (data.op === 'doc-name' && typeof data.name === 'string' && !docs.host) {
    if (data.doc && data.doc !== docs.active) return;
    docs.name = label(data.name) || 'Untitled note';
    showDocuments();
  }
}

function connect() {
  if (!/^https?:$/.test(location.protocol)) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(
    scheme + '://' + location.host + '/room?room=' + encodeURIComponent(ROOM) + '&peer=' + PEER
  );
  room.socket = socket;

  socket.addEventListener('open', () => {
    showRoom('Connected');
    room.last.clear();
    if (docs.host) {
      broadcastDocuments();
      if (docs.active) broadcastOpen();
    } else {
      send({ op: 'docs-ask' });
    }
    shareCaret(true);
  });
  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!frame || frame.type !== 'app' || frame.name !== 'notes') return;
    if (frame.peerId === PEER) return;
    handle(frame.peerId, frame.data);
  });
  socket.addEventListener('close', () => {
    room.socket = null;
    showRoom('Solo');
    room.carets.clear();
    drawCarets();
    clearTimeout(room.retry);
    room.retry = setTimeout(connect, 2000);
  });
  socket.addEventListener('error', () => socket.close());
}

// ---------------------------------------------------------------------------
// Editing

let composing = false;

function syncLocal() {
  if (!docs.model || !docs.active) return;
  const ops = syncFromDom(editor, docs.model);
  if (!ops.length) return;
  updateWords();
  setState(docs.host ? 'Saving' : 'Editing');
  sendOps(ops);
  shareCaret(true);
}

editor.addEventListener('compositionstart', () => {
  composing = true;
});

editor.addEventListener('compositionend', () => {
  composing = false;
  syncLocal();
});

editor.addEventListener('input', () => {
  if (composing) return;
  syncLocal();
});

editor.addEventListener('blur', () => {
  if (docs.host && docs.active && docs.stored) saveDocument();
});

// A paste from the web brings a whole stylesheet with it. Notes keep the words,
// and one pasted block stays in the paragraph it lands in.
editor.addEventListener('paste', (event) => {
  const data = event.clipboardData || window.clipboardData;
  if (!data) return;
  const text = data.getData('text/plain');
  if (!text) return;
  event.preventDefault();
  document.execCommand('insertText', false, text.replace(/\s*\n+\s*/g, ' '));
});

document.addEventListener('selectionchange', () => {
  if (document.activeElement === editor) shareCaret(false);
});

setInterval(() => {
  if (room.carets.size) drawCarets();
  if (document.activeElement === editor) shareCaret(true);
}, 2000);

editor.addEventListener('scroll', drawCarets, { passive: true });
window.addEventListener('resize', drawCarets);

// Enter inside a bullet continues the bullet. The model owns the split, so the
// new block keeps an id the room can place.
editor.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing) return;
  if (!docs.model) return;
  const point = capturePoint(editor, docs.model);
  if (!point) return;
  const block = docs.model.blocks.get(point.start.b);
  if (!block || (block.type !== 'li' && block.type !== 'li1')) return;
  const live = charOrder(block);
  if (!live.length) {
    event.preventDefault();
    const op = setBlockType(docs.model, block.id, 'p');
    if (op) {
      renderDoc(editor, docs.model);
      placeCaret(editor, docs.model, point);
      sendOps([op]);
    }
    return;
  }
  event.preventDefault();
  const at = point.start.n;
  const end = point.end.b === block.id ? Math.max(at, point.end.n) : live.length;
  const tail = live.slice(at).map((node) => node.ch).join('');
  const face = live[at] ? live[at].marks : '';
  const ops = [];
  for (const op of deleteText(docs.model, block.id, at, end - at)) ops.push(op);
  for (const op of deleteText(docs.model, block.id, at, Math.max(0, live.length - at))) ops.push(op);
  const made = addBlock(docs.model, block.id, block.type);
  ops.push(made.op);
  for (const op of insertText(docs.model, made.id, 0, tail, face)) ops.push(op);
  renderDoc(editor, docs.model);
  placeCaret(editor, docs.model, {
    start: { b: made.id, n: 0, id: '' },
    end: { b: made.id, n: 0, id: '' },
  });
  sendOps(ops);
  updateWords();
});

if (toolbar) {
  // A toolbar press must not take the selection away from the page.
  toolbar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });
}

function setBlock(type) {
  if (!docs.model) return;
  const point = capturePoint(editor, docs.model);
  const id = point ? point.start.b : blockOrder(docs.model)[0];
  const block = docs.model.blocks.get(id);
  if (!block) return;
  const next = type === block.type ? 'p' : type;
  const op = setBlockType(docs.model, id, next);
  editor.focus();
  if (!op) return;
  renderDoc(editor, docs.model);
  if (point) placeCaret(editor, docs.model, point);
  sendOps([op]);
}

for (const button of document.querySelectorAll('.toolbar button[data-cmd]')) {
  button.addEventListener('click', () => {
    const cmd = button.dataset.cmd;
    if (cmd === 'hiliteColor') {
      const on = button.getAttribute('aria-pressed') === 'true';
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('hiliteColor', false, on ? 'transparent' : '#fde68a');
      button.setAttribute('aria-pressed', on ? 'false' : 'true');
    } else {
      document.execCommand(cmd, false, null);
    }
    editor.focus();
    syncLocal();
  });
}

for (const button of document.querySelectorAll('.toolbar button[data-block]')) {
  button.addEventListener('click', () => {
    const type = button.dataset.block;
    if (type === 'list') setBlock('li');
    else if (type === 'list1') setBlock('li1');
    else setBlock(type);
  });
}

if (fontSize) {
  fontSize.addEventListener('change', () => {
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('fontSize', false, fontSize.value);
    editor.focus();
    syncLocal();
  });
}

if (nameInput) {
  nameInput.addEventListener('change', () => {
    if (!docs.host || !docs.active) return;
    docs.name = label(nameInput.value) || 'Untitled note';
    const entry = docs.list.find((item) => item.id === docs.active);
    if (entry) entry.name = docs.name;
    showDocuments();
    saveSoon();
    broadcastDocuments();
    send({ op: 'doc-name', doc: docs.active, name: docs.name });
  });
}

if (storeInput) {
  storeInput.addEventListener('change', async () => {
    if (!docs.host || !docs.active) return;
    docs.stored = storeInput.checked;
    if (docs.stored) {
      await saveDocument();
      return;
    }
    clearTimeout(docs.saveTimer);
    docs.saveTimer = 0;
    if (api) {
      try {
        await api.remove(docs.active);
      } catch {
        // The file may never have been written.
      }
    }
    docs.list = docs.list.filter((item) => item.id !== docs.active);
    showDocuments();
    setState('Not stored');
    broadcastDocuments();
  });
}

if (newButton) newButton.addEventListener('click', () => newDocument());

if (searchInput) {
  searchInput.addEventListener('input', () => {
    docs.query = searchInput.value;
    showDocuments();
  });
}

document.getElementById('export').addEventListener('click', () => {
  const name = label(docs.name) || 'note';
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' +
    escapeHtml(name) +
    '</title>\n<style>\nbody{max-width:44rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1b1f;background:#fff}\nh1,h2{line-height:1.2}\nmark{background:#fde68a}\n</style>\n</head>\n<body>\n' +
    htmlOf(docs.model) +
    '\n</body>\n</html>\n';
  const blob = new Blob([html], { type: 'text/html' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.html';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
});

window.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return;
  if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (docs.host) saveDocument();
  }
});

// ---------------------------------------------------------------------------
// Start

async function start() {
  document.body.classList.toggle('is-guest', !docs.host);
  document.execCommand('defaultParagraphSeparator', false, 'p');
  if (!docs.host) {
    docs.model = createDoc(PEER);
    ensureBlock(docs.model);
    renderDoc(editor, docs.model);
    showDocuments();
    setState('Shared');
    updateWords();
    connect();
    return;
  }
  await refreshDocuments();
  if (docs.list.length) await openDocument(docs.list[0].id);
  else await newDocument();
  connect();
}

start();
