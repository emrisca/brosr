'use strict';
// The page half of co-typing. The browser keeps the caret, the selection and
// its own undo, so this file never intercepts typing. It reads the page into
// runs, turns the difference into operations, and paints the model back. Text
// from a peer is always put in a text node, never parsed as HTML.

import {
  blockOrder,
  charOrder,
  runsOf,
  markSet,
  markString,
  normalizeType,
  createDoc,
  addBlock,
  insertText,
  deleteText,
  deleteBlock,
  ensureBlock,
  blockText,
} from './text-crdt.mjs';

const LIST_TAG = { li: 'ul', li1: 'ol' };

function tagFor(type) {
  switch (normalizeType(type)) {
    case 'h1':
      return 'h1';
    case 'h2':
      return 'h2';
    case 'pre':
      return 'pre';
    case 'li':
    case 'li1':
      return 'li';
    default:
      return 'p';
  }
}

function typeOf(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'h1' || tag === 'h2' || tag === 'pre' || tag === 'li') return tag;
  return 'p';
}

function blockEl(editor, id) {
  if (!id) return null;
  return editor.querySelector('[data-b="' + String(id).replace(/["\\]/g, '\\$&') + '"]');
}

// A span does not inherit a background, so a highlight is found by walking up
// to the block. Every other face is inherited and reads the same anywhere.
function hasInk(colour) {
  const value = String(colour || '');
  if (!value || value === 'transparent') return false;
  const match = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!match) return true;
  const parts = match[1].split(',').map((part) => parseFloat(part));
  if (parts.length === 4 && parts[3] === 0) return false;
  return true;
}

function facesFor(node, stop) {
  const marks = new Set();
  let el = node.parentElement;
  while (el) {
    const style = window.getComputedStyle(el);
    if ((parseInt(style.fontWeight, 10) || 400) >= 600) marks.add('b');
    if (style.fontStyle === 'italic') marks.add('i');
    if (String(style.textDecorationLine || '').includes('underline')) marks.add('u');
    if (hasInk(style.backgroundColor)) marks.add('h');
    if (el === stop) break;
    el = el.parentElement;
  }
  return markString(marks);
}

function readBlock(el, type) {
  const runs = [];
  const faces = [];
  let text = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue || '';
    if (value) {
      const face = facesFor(node, el);
      const points = [...value];
      text += value;
      for (let i = 0; i < points.length; i += 1) faces.push(face);
      const last = runs[runs.length - 1];
      if (last && last.marks === face) last.text += value;
      else runs.push({ text: value, marks: face });
    }
    node = walker.nextNode();
  }
  return { id: el.dataset.b || '', type, text, faces, runs, el };
}

// The page reads block by block. A list wrapper carries no id of its own, so
// its items are the blocks.
export function readDoc(editor) {
  const blocks = [];
  for (const child of editor.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.nodeValue || '';
      if (text.trim()) {
        blocks.push({
          id: '',
          type: 'p',
          text,
          faces: [...text].map(() => ''),
          runs: [{ text, marks: '' }],
          el: null,
        });
      }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      for (const item of child.children) {
        if (item.tagName.toLowerCase() === 'li') {
          blocks.push(readBlock(item, tag === 'ol' ? 'li1' : 'li'));
        }
      }
      continue;
    }
    blocks.push(readBlock(child, typeOf(child)));
  }
  return blocks;
}

function paintRuns(el, block) {
  const frag = document.createDocumentFragment();
  for (const run of runsOf(block)) {
    if (!run.text) continue;
    const marks = markSet(run.marks);
    let node = document.createTextNode(run.text);
    for (const mark of ['h', 'u', 'i', 'b']) {
      if (!marks.has(mark)) continue;
      const wrap = document.createElement(mark === 'h' ? 'mark' : mark);
      wrap.append(node);
      node = wrap;
    }
    frag.append(node);
  }
  el.replaceChildren(frag);
  if (!el.childNodes.length) el.append(document.createElement('br'));
}

function blockNode(doc, block) {
  const el = document.createElement(tagFor(block.type));
  el.dataset.b = block.id;
  paintRuns(el, block);
  return el;
}

export function renderDoc(editor, doc) {
  const frag = document.createDocumentFragment();
  let list = null;
  let kind = '';
  for (const id of blockOrder(doc)) {
    const block = doc.blocks.get(id);
    if (!block) continue;
    const type = normalizeType(block.type);
    if (LIST_TAG[type]) {
      const tag = LIST_TAG[type];
      if (!list || kind !== tag) {
        list = document.createElement(tag);
        kind = tag;
        frag.append(list);
      }
      list.append(blockNode(doc, block));
    } else {
      list = null;
      kind = '';
      frag.append(blockNode(doc, block));
    }
  }
  if (!frag.childNodes.length) {
    const id = ensureBlock(doc);
    frag.append(blockNode(doc, doc.blocks.get(id)));
  }
  editor.replaceChildren(frag);
}

// One block changed. A tag or list change needs the whole document, and the
// caller falls back to that.
export function renderBlock(editor, doc, id) {
  const block = doc.blocks.get(id);
  const el = blockEl(editor, id);
  if (!block || doc.blockDeleted.has(id)) {
    if (el) {
      const list = el.parentElement;
      el.remove();
      if (list && list.tagName.toLowerCase() !== 'li' && !list.children.length) list.remove();
    }
    return true;
  }
  if (!el || el.tagName.toLowerCase() !== tagFor(block.type)) return false;
  paintRuns(el, block);
  return true;
}

// ---------------------------------------------------------------------------
// The page becomes operations

function markOps(doc, id, item) {
  const block = doc.blocks.get(id);
  const live = charOrder(block);
  const ops = [];
  for (const mark of ['b', 'i', 'u', 'h']) {
    const add = [];
    const remove = [];
    for (let i = 0; i < live.length; i += 1) {
      const want = (item.faces[i] || '').includes(mark);
      const has = live[i].marks.includes(mark);
      if (want && !has) add.push(live[i].id);
      else if (!want && has) remove.push(live[i].id);
    }
    if (add.length) ops.push(setMarks(doc, id, add, mark, true));
    if (remove.length) ops.push(setMarks(doc, id, remove, mark, false));
  }
  return ops.filter(Boolean);
}

function setMarks(doc, id, ids, mark, on) {
  const block = doc.blocks.get(id);
  const changed = [];
  for (const charId of ids) {
    const node = block.nodes.get(charId);
    if (!node || node.deleted) continue;
    const set = markSet(node.marks);
    if (on ? set.has(mark) : !set.has(mark)) continue;
    if (on) set.add(mark);
    else set.delete(mark);
    node.marks = markString(set);
    changed.push(charId);
  }
  if (!changed.length) return null;
  return { op: 'fmt', b: id, m: mark, on, ids: changed };
}

// The face of the text a reader just typed is the face of the text it landed
// on, which is how typing inside a bold word stays bold.
function faceAt(item, index, doc, id) {
  const live = charOrder(doc.blocks.get(id));
  const before = item.faces[index];
  if (before !== undefined) return before;
  const last = live.length ? live[live.length - 1].marks : '';
  return item.faces[item.faces.length - 1] ?? last;
}

export function syncFromDom(editor, doc) {
  const blocks = readDoc(editor);
  const ops = [];

  // Every block was taken out in one gesture. Keep one empty page.
  if (!blocks.length) {
    for (const id of blockOrder(doc)) {
      const op = deleteBlock(doc, id);
      if (op) ops.push(op);
    }
    const made = addBlock(doc, '', 'p');
    ops.push(made.op);
    renderDoc(editor, doc);
    placeCaret(editor, doc, {
      start: { b: made.id, n: 0, id: '' },
      end: { b: made.id, n: 0, id: '' },
    });
    return ops;
  }

  const order = blockOrder(doc);
  const used = new Set();
  const pairs = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const item = blocks[index];
    let id = '';
    if (item.id && doc.blocks.has(item.id) && !doc.blockDeleted.has(item.id) && !used.has(item.id)) {
      id = item.id;
    }
    if (!id) {
      const at = order[index];
      if (at && !used.has(at)) id = at;
    }
    if (id) {
      used.add(id);
      if (item.el && item.el.dataset.b !== id) item.el.dataset.b = id;
    }
    pairs.push({ item, id });
  }

  for (const id of order) {
    if (used.has(id)) continue;
    const op = deleteBlock(doc, id);
    if (op) ops.push(op);
  }

  let previous = '';
  for (const { item, id } of pairs) {
    if (!id) {
      const made = addBlock(doc, previous, item.type);
      ops.push(made.op);
      if (item.el) item.el.dataset.b = made.id;
      for (const op of insertText(doc, made.id, 0, item.text, item.faces[0] || '')) ops.push(op);
      previous = made.id;
      continue;
    }
    const block = doc.blocks.get(id);
    if (block.type !== item.type) {
      block.type = normalizeType(item.type);
      ops.push({ op: 'btype', b: id, t: block.type });
    }
    if (blockText(block) !== item.text) {
      const before = [...blockText(block)];
      const after = [...item.text];
      let pre = 0;
      const max = Math.min(before.length, after.length);
      while (pre < max && before[pre] === after[pre]) pre += 1;
      let suf = 0;
      while (
        suf < Math.min(before.length - pre, after.length - pre) &&
        before[before.length - 1 - suf] === after[after.length - 1 - suf]
      ) {
        suf += 1;
      }
      const face = faceAt(item, pre, doc, id);
      for (const op of deleteText(doc, id, pre, before.length - pre - suf)) ops.push(op);
      for (const op of insertText(doc, id, pre, after.slice(pre, after.length - suf).join(''), face)) {
        ops.push(op);
      }
    }
    for (const op of markOps(doc, id, item)) ops.push(op);
    previous = id;
  }
  return ops.filter(Boolean);
}

// ---------------------------------------------------------------------------
// The caret

function blockAt(editor, node) {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  return el ? el.closest('[data-b]') : null;
}

function pointOf(node, offset, editor, doc) {
  const el = blockAt(editor, node);
  if (!el) return null;
  const id = el.dataset.b;
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(node, offset);
  const chars = [...range.toString()].length;
  const block = doc.blocks.get(id);
  const live = block ? charOrder(block) : [];
  return { b: id, n: chars, id: live[chars] ? live[chars].id : '', end: chars >= live.length };
}

export function capturePoint(editor, doc) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !doc) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  const start = pointOf(range.startContainer, range.startOffset, editor, doc);
  const end = pointOf(range.endContainer, range.endOffset, editor, doc);
  if (!start || !end) return null;
  return { start, end };
}

function textPoint(el, index) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let node = walker.nextNode();
  while (node) {
    const points = [...(node.nodeValue || '')];
    if (seen + points.length >= index) {
      return { node, offset: points.slice(0, index - seen).join('').length };
    }
    seen += points.length;
    node = walker.nextNode();
  }
  return { node: el, offset: el.childNodes.length };
}

function domPoint(editor, doc, at) {
  const block = at ? doc.blocks.get(at.b) : null;
  const el = block ? blockEl(editor, at.b) : null;
  if (!block || !el) {
    const last = blockOrder(doc).pop();
    const tail = last ? blockEl(editor, last) : null;
    return tail ? textPoint(tail, charOrder(doc.blocks.get(last)).length) : null;
  }
  const live = charOrder(block);
  let index = at.id ? live.findIndex((node) => node.id === at.id) : -1;
  if (index < 0) index = Math.min(at.n, live.length);
  return textPoint(el, index);
}

// A point is placed by the id of the character it sits before. When that
// character was deleted while the page was showing, the count is the fallback.
export function restorePoint(editor, doc, point) {
  if (!point) return;
  const start = domPoint(editor, doc, point.start);
  const end = domPoint(editor, doc, point.end);
  if (!start || !end) return;
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function placeCaret(editor, doc, point) {
  restorePoint(editor, doc, point);
}

// A peer caret is drawn from character positions, so it follows a merge.
// A collapsed range has no rectangles, so a plain caret is measured through one
// neighbouring character: the one it sits before, or the one it sits after at
// the end of a block.
export function rectsForRange(editor, doc, from, to) {
  const start = domPoint(editor, doc, from);
  const end = domPoint(editor, doc, to);
  if (!start || !end) return [];
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return [];
  }
  let edge = '';
  if (range.collapsed) {
    const node = range.startContainer;
    const offset = range.startOffset;
    const length = node.nodeType === Node.TEXT_NODE ? (node.nodeValue || '').length : 0;
    try {
      if (length && offset < length) {
        range.setEnd(node, offset + 1);
        edge = 'left';
      } else if (length && offset > 0) {
        range.setStart(node, offset - 1);
        edge = 'right';
      } else {
        return [];
      }
    } catch {
      return [];
    }
  }
  return [...range.getClientRects()].map((rect) => {
    const left = edge === 'right' ? rect.right : rect.left;
    const width = edge ? 0 : rect.width;
    return {
      left,
      top: rect.top,
      width,
      height: rect.height,
      right: left + width,
      bottom: rect.top + rect.height,
    };
  });
}

// ---------------------------------------------------------------------------
// Disk

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineHtml(block) {
  return runsOf(block)
    .map((run) => {
      let html = escapeHtml(run.text);
      const marks = markSet(run.marks);
      if (marks.has('b')) html = '<b>' + html + '</b>';
      if (marks.has('i')) html = '<i>' + html + '</i>';
      if (marks.has('u')) html = '<u>' + html + '</u>';
      if (marks.has('h')) html = '<mark>' + html + '</mark>';
      return html;
    })
    .join('');
}

export function htmlOf(doc) {
  const out = [];
  let list = '';
  const closeList = () => {
    if (list) {
      out.push('</' + list + '>');
      list = '';
    }
  };
  for (const id of blockOrder(doc)) {
    const block = doc.blocks.get(id);
    if (!block) continue;
    const type = normalizeType(block.type);
    const tag = tagFor(type);
    if (LIST_TAG[type]) {
      if (list !== LIST_TAG[type]) {
        closeList();
        list = LIST_TAG[type];
        out.push('<' + list + '>');
      }
    } else {
      closeList();
    }
    out.push('<' + tag + '>' + inlineHtml(block) + '</' + tag + '>');
  }
  closeList();
  return out.join('');
}

// An older note has a body and no model. Read it once through the same run
// reader the editor uses, so faces and paragraphs survive the first open.
export function modelFromHtml(html, site) {
  const doc = createDoc(site);
  const host = document.createElement('div');
  host.innerHTML = String(html || '');
  const blocks = [];
  const box = document.createElement('div');
  for (const child of [...host.childNodes]) box.append(child.cloneNode(true));
  for (const child of box.children) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      for (const item of child.children) {
        if (item.tagName.toLowerCase() === 'li') blocks.push(readBlock(item, tag === 'ol' ? 'li1' : 'li'));
      }
    } else {
      blocks.push(readBlock(child, typeOf(child)));
    }
  }
  if (!blocks.length && box.textContent.trim()) {
    blocks.push({ id: '', type: 'p', text: box.textContent, faces: [...box.textContent].map(() => ''), runs: [], el: null });
  }
  let previous = '';
  for (const item of blocks) {
    const made = addBlock(doc, previous, item.type);
    insertText(doc, made.id, 0, item.text, item.faces[0] || '');
    previous = made.id;
  }
  if (!previous) ensureBlock(doc);
  return doc;
}
