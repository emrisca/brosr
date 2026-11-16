'use strict';
// Notes. One page at a time, formatted in place. The host saves each page to
// its own disk and carries the library to the room. A guest edits the open page
// and the host writes it, so nobody needs a path to the host folder.

const params = new URLSearchParams(location.search);
const ROLE = params.get('role') || 'guest';
const ROOM = params.get('room') || 'default';
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
  putTimer: 0,
  sentAt: 0,
};

const room = { socket: null, retry: null };

const editor = document.getElementById('editor');
const nameInput = document.getElementById('doc-name');
const listEl = document.getElementById('doc-list');
const countEl = document.getElementById('docs-count');
const storeInput = document.getElementById('doc-store');
const newButton = document.getElementById('doc-new');
const stateEl = document.getElementById('doc-state');
const wordsEl = document.getElementById('word-count');
const roomEl = document.getElementById('room-state');
const fontSize = document.getElementById('font-size');
const toolbar = document.querySelector('.toolbar');

// ---------------------------------------------------------------------------
// Text

function label(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// A page body comes from the app or from a peer, so it never arrives with a
// script, an inline handler or a javascript: link.
function cleanHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
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
  const text = editor.innerText.replace(/\s+/g, ' ').trim();
  const count = text ? text.split(' ').length : 0;
  wordsEl.textContent = count + (count === 1 ? ' word' : ' words');
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
    body: cleanHtml(editor.innerHTML),
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
  if (countEl) countEl.textContent = String(visible.length);
  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'doc-empty';
    empty.textContent = docs.host ? 'No saved note yet.' : 'Nothing shared yet.';
    listEl.append(empty);
  }
  for (const item of visible) {
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
    meta.textContent = shortDate(item.at) + (item.hidden ? ' · hidden' : '');
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
      tools.append(hide, del);
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

function applyDocument(doc, remote) {
  if (!doc || typeof doc.id !== 'string') return;
  docs.active = doc.id;
  docs.name = label(doc.name) || 'Untitled note';
  docs.at = Number(doc.at) || Date.now();
  if (!remote) {
    docs.stored = doc.stored !== false;
    docs.hidden = doc.hidden === true;
  }
  editor.innerHTML = cleanHtml(doc.body || '');
  updateWords();
  showDocuments();
  setState(remote || !docs.stored ? 'From the room' : 'Saved');
  editor.scrollTop = 0;
}

async function saveDocument() {
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  if (!docs.host || !api || !docs.active || !docs.stored) return;
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
  if (Date.now() - docs.sentAt > 3000) {
    docs.sentAt = Date.now();
    send({ op: 'put', doc: { id: doc.id, name: doc.name, at: doc.at, body: doc.body } });
  }
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
  docs.sentAt = Date.now();
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
  send({
    op: 'doc-open',
    doc: { id: doc.id, name: doc.name, at: docs.at, body: doc.body },
  });
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
      await api.put(doc);
    } catch {
      // A failed first save leaves the note in the room only.
    }
    mergeEntry(doc);
    showDocuments();
    broadcastDocuments();
  }
  send({ op: 'doc-open', doc: { id: doc.id, name: doc.name, at: doc.at, body: '' } });
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
    editor.innerHTML = '';
    updateWords();
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
  room.socket.send(JSON.stringify({ v: 1, type: 'app', peerId: PEER, name: 'notes', data }));
}

const PEER = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 8);

function showRoom(text) {
  if (roomEl) roomEl.textContent = text;
}

// The relay fans every frame out to the room, so a reply for one page carries
// the peer it is for and the other pages drop it.
function sendDirect(peer, data) {
  send({ ...data, to: peer });
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
    // A page that joins after the host opened a note gets that note, so it
    // starts on the same page as the rest of the room.
    if (docs.active) {
      sendDirect(from, {
        op: 'doc-open',
        doc: { id: docs.active, name: docs.name, at: docs.at, body: cleanHtml(editor.innerHTML) },
      });
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
    applyDocument(data.doc, true);
    docs.stored = false;
    showDocuments();
    setState('Shared');
    return;
  }

  if (data.op === 'put' && data.doc) {
    const doc = data.doc;
    if (!doc || doc.id !== docs.active) return;
    const at = Number(doc.at) || 0;
    if (at <= docs.at) return;
    if (docs.host) {
      docs.at = at;
      // A host that is mid sentence keeps the caret and writes on the next
      // pause instead of having the page replaced under the hand.
      if (document.activeElement !== editor) {
        editor.innerHTML = cleanHtml(doc.body || '');
        updateWords();
      }
      if (docs.stored) {
        clearTimeout(docs.saveTimer);
        docs.saveTimer = setTimeout(saveDocument, 900);
      }
      return;
    }
    docs.at = at;
    if (document.activeElement !== editor) {
      editor.innerHTML = cleanHtml(doc.body || '');
      updateWords();
    }
    return;
  }
}

function connect() {
  if (!/^https?:$/.test(location.protocol)) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(
    scheme + '://' + location.host + '/room?room=' + encodeURIComponent(ROOM)
  );
  room.socket = socket;

  socket.addEventListener('open', () => {
    showRoom('Connected');
    if (docs.host) {
      broadcastDocuments();
      if (docs.active) {
        send({
          op: 'doc-open',
          doc: { id: docs.active, name: docs.name, at: docs.at, body: cleanHtml(editor.innerHTML) },
        });
      }
    } else {
      send({ op: 'docs-ask' });
    }
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
    clearTimeout(room.retry);
    room.retry = setTimeout(connect, 2000);
  });
  socket.addEventListener('error', () => socket.close());
}

// ---------------------------------------------------------------------------
// Editor

function saveSoon() {
  if (!docs.active) return;
  if (docs.host) {
    clearTimeout(docs.saveTimer);
    docs.saveTimer = setTimeout(saveDocument, 800);
    return;
  }
  clearTimeout(docs.putTimer);
  docs.putTimer = setTimeout(() => {
    send({ op: 'put', doc: { id: docs.active, name: docs.name, at: Date.now(), body: cleanHtml(editor.innerHTML) } });
  }, 500);
}

editor.addEventListener('input', () => {
  updateWords();
  setState(docs.host ? 'Saving' : 'Editing');
  saveSoon();
});

editor.addEventListener('blur', () => {
  if (docs.host && docs.active && docs.stored) saveDocument();
});

// A paste from the web brings a whole stylesheet with it. Notes keep the text,
// which is what a page here is for.
editor.addEventListener('paste', (event) => {
  const data = event.clipboardData || window.clipboardData;
  if (!data) return;
  const text = data.getData('text/plain');
  if (!text) return;
  event.preventDefault();
  document.execCommand('insertText', false, text);
});

if (toolbar) {
  // A toolbar press must not take the selection away from the page.
  toolbar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });
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
    saveSoon();
  });
}

for (const button of document.querySelectorAll('.toolbar button[data-block]')) {
  button.addEventListener('click', () => {
    document.execCommand('formatBlock', false, button.dataset.block);
    editor.focus();
    saveSoon();
  });
}

if (fontSize) {
  fontSize.addEventListener('change', () => {
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('fontSize', false, fontSize.value);
    editor.focus();
    saveSoon();
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

document.getElementById('export').addEventListener('click', () => {
  const name = label(docs.name) || 'note';
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' +
    escapeHtml(name) +
    '</title>\n<style>\nbody{max-width:44rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1b1f;background:#fff}\nh1,h2{line-height:1.2}\nmark{background:#fde68a}\n</style>\n</head>\n<body>\n' +
    cleanHtml(editor.innerHTML) +
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
  if (!docs.host) {
    showDocuments();
    setState('Shared');
    connect();
    return;
  }
  await refreshDocuments();
  if (docs.list.length) await openDocument(docs.list[0].id);
  else await newDocument();
  connect();
}

start();
