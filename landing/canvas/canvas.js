'use strict';
// Canvas. A paper sheet drawn on one canvas, with a small stroke model so undo,
// layers, the room and a PNG export all read from the same record.

// The sheet is a square. Ink is clipped to it on every pass, so the desk around
// it stays empty no matter where a hand ends up.
const PAPER = { width: 2400, height: 2400 };
const PAPER_COLOUR = '#f7f7f8';

const PRESETS = {
  pencil: { label: 'Pencil', size: 4, opacity: 1 },
  ink: { label: 'Ink', size: 7, opacity: 1 },
  marker: { label: 'Marker', size: 22, opacity: 0.5 },
  airbrush: { label: 'Airbrush', size: 30, opacity: 0.55 },
  eraser: { label: 'Eraser', size: 26, opacity: 1 },
  line: { label: 'Line', size: 4, opacity: 1 },
  rect: { label: 'Box', size: 4, opacity: 1 },
  ellipse: { label: 'Oval', size: 4, opacity: 1 },
};

const SHAPES = new Set(['line', 'rect', 'ellipse']);

const state = {
  preset: 'pencil',
  colour: '#18181b',
  size: 4,
  opacity: 1,
  stabilizer: 0.35,
  activeLayer: 1,
  layers: [
    { name: 'Sketch', strokes: [], visible: true },
    { name: 'Ink', strokes: [], visible: true },
  ],
  history: [],
  redo: [],
};

const view = { x: 0, y: 0, z: 1 };
let dpr = 1;
let drawing = null;
let panning = null;
let spaceDown = false;
// The view follows the window until the hand moves it. A resize then refits a
// sheet nobody zoomed, and leaves a zoomed sheet where it is.
let fitted = true;

// The room. One WebSocket to the relay, app frames only, JSON like the rest of
// the wire. A stroke is a list of points, so it travels as one message.
const ROOM = new URLSearchParams(location.search).get('room') || 'default';
const PEER = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 8);
const PART_POINTS = 300;
const MAX_POINTS = 20000;
// Presence. A canvas page says who it is on open and every few seconds, so the
// room line names the other people with the sheet open, not only a count.
const HERE_MS = 3000;
const HERE_TTL = 9000;
const NAME_KEY = 'brosr.canvas.name';
// A live frame goes out at most every 60 ms, and a stroke nobody finished is
// dropped from the sheet after 15 s.
const LIVE_MS = 60;
const LIVE_TTL = 15000;
// A remote pointer. Each page publishes where its pointer is on the sheet, in
// sheet coordinates, so pan, zoom and window size never move the dot another
// person sees. A point off the paper is cleared, so only the sheet shows one.
const POINTER_MS = 60;
const POINTER_ARROW = 'M0 0 L0 19 L5 14.5 L8 21 L11 19.5 L8 13.5 L15 13.5 Z';
const room = {
  socket: null,
  // One entry per canvas page, keyed by peer id. A page that stops sending
  // presence is dropped after HERE_TTL.
  here: new Map(),
  retry: null,
  ask: null,
  received: new Map(),
  parts: new Map(),
  seen: new Set(),
  inflight: new Map(),
};
let strokeCount = 0;
let live = { id: null, sent: 0, at: 0 };
let pointer = null;
let pointerSent = 0;
// The last client point, kept so a zoom, a pan or a window resize can read the
// paper under a hand that has not moved.
let pointerAt = null;
// A remote dot glides to the point it reports instead of jumping there. The
// move is the same 80 ms linear one the landing page cursors take, so a short
// hop and a long one both get their own glide. The eased point is what the sheet
// paints. A page in the background paints no frames, so it snaps, and a dot seen
// for the first time appears where it is.
const GLIDE_MS = 80;
const glide = new Map();
let glideRaf = 0;

function nextStrokeId() {
  strokeCount += 1;
  return PEER + '-' + strokeCount;
}

const viewport = document.getElementById('viewport');
const canvas = document.getElementById('sheet');
const ctx = canvas.getContext('2d');
const nameInput = document.getElementById('name');

// The host keeps the library on its own disk. A guest reads the room's copy, so
// a peer on the LAN needs no token and no path to the host folder.
const ROLE = new URLSearchParams(location.search).get('role') || 'guest';
const docs = {
  api: window.BrosrDocs || null,
  host: ROLE === 'host' && Boolean(window.BrosrDocs),
  list: [],
  active: '',
  name: 'Untitled canvas',
  at: 0,
  stored: true,
  hidden: false,
  saveTimer: 0,
  sentAt: 0,
  query: '',
};

// ---------------------------------------------------------------------------
// Painting

function hexAlpha(hex, alpha) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function paintShape(g, stroke) {
  const a = stroke.points[0];
  const b = stroke.points[stroke.points.length - 1];
  g.globalAlpha = stroke.opacity;
  g.strokeStyle = stroke.tool === 'eraser' ? PAPER_COLOUR : stroke.colour;
  g.lineWidth = Math.max(0.5, stroke.size);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  if (stroke.tool === 'line') {
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
  } else if (stroke.tool === 'rect') {
    g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else {
    g.ellipse(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      Math.abs(b.x - a.x) / 2,
      Math.abs(b.y - a.y) / 2,
      0,
      0,
      Math.PI * 2
    );
  }
  g.stroke();
}

function paintFreehand(g, stroke) {
  const points = stroke.points;
  const radius = Math.max(0.6, stroke.size / 2);
  const colour = stroke.tool === 'eraser' ? PAPER_COLOUR : stroke.colour;
  const marker = stroke.tool === 'marker';
  const air = stroke.tool === 'airbrush';
  const step = Math.max(0.9, radius * (air ? 0.45 : 0.3));

  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const distance = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let j = 1; j <= count; j++) {
      const t = j / count;
      const x = p0.x + (p1.x - p0.x) * t;
      const y = p0.y + (p1.y - p0.y) * t;
      let r = radius;
      let alpha = stroke.opacity;

      if (stroke.tool === 'ink') {
        // Both ends thin out, so a fast line still has a drawn edge.
        const edge = Math.min(i - 1, points.length - 1 - i);
        r = radius * (0.45 + 0.55 * Math.min(1, (edge + t) / 6));
      } else if (stroke.tool === 'pencil') {
        r = radius * (0.82 + Math.random() * 0.28);
        alpha *= 0.92;
      } else if (marker) {
        alpha *= 0.4;
      }

      if (air) {
        const glow = g.createRadialGradient(x, y, 0, x, y, r * 1.9);
        glow.addColorStop(0, hexAlpha(colour, 0.15 * alpha));
        glow.addColorStop(1, hexAlpha(colour, 0));
        g.fillStyle = glow;
        g.globalAlpha = 1;
        g.beginPath();
        g.arc(x, y, r * 1.9, 0, Math.PI * 2);
        g.fill();
      } else {
        g.globalAlpha = Math.min(1, alpha);
        g.fillStyle = colour;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

function paintStroke(g, stroke) {
  if (!stroke.points.length) return;
  if (SHAPES.has(stroke.tool)) {
    paintShape(g, stroke);
    return;
  }
  paintFreehand(g, stroke);
  g.globalAlpha = 1;
}

// The sheet is the only place ink can land. A point past an edge is pulled back
// to it, and every paint pass is clipped to the same rectangle, so a stroke that
// leaves the paper stops at the paper instead of drawing on the desk.
function clampPoint(point) {
  return {
    x: clamp(point.x, 0, PAPER.width),
    y: clamp(point.y, 0, PAPER.height),
  };
}

function onPaperPoint(point) {
  return point.x >= 0 && point.y >= 0 && point.x <= PAPER.width && point.y <= PAPER.height;
}

// ---------------------------------------------------------------------------
// Frames

// The committed ink lives in one paper-sized bitmap, so a frame draws two
// images, the line in progress and the pointers no matter how much is on the
// sheet. The bitmap holds one pixel per sheet pixel, which is exact at a 100%
// view and sharp below it. A zoomed-in view magnifies it, so the page keeps a
// screen-sized crop for that case and rebuilds it once the view rests.
const ink = document.createElement('canvas');
ink.width = PAPER.width;
ink.height = PAPER.height;
const inkCtx = ink.getContext('2d');
const SHARP_ZOOM = 1.02;
const SHARP_IDLE_MS = 120;
let inkDirty = true;
let sharp = null;
let sharpTimer = 0;

function paintCommitted(g) {
  g.save();
  g.beginPath();
  g.rect(0, 0, PAPER.width, PAPER.height);
  g.clip();
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    for (const stroke of layer.strokes) paintStroke(g, stroke);
  }
  g.restore();
  g.globalAlpha = 1;
}

function paintInk() {
  inkCtx.setTransform(1, 0, 0, 1, 0, 0);
  inkCtx.globalAlpha = 1;
  inkCtx.clearRect(0, 0, PAPER.width, PAPER.height);
  inkCtx.fillStyle = PAPER_COLOUR;
  inkCtx.fillRect(0, 0, PAPER.width, PAPER.height);
  paintCommitted(inkCtx);
  inkDirty = false;
}

// A finished stroke goes straight into the bitmap, so a commit never repaints
// the sheet. Undo, a remote remove or a hidden layer still rebuilds it once.
function addToInk(stroke) {
  const layer = state.layers[stroke.layer];
  if (inkDirty || !layer || !layer.visible) return;
  inkCtx.save();
  inkCtx.beginPath();
  inkCtx.rect(0, 0, PAPER.width, PAPER.height);
  inkCtx.clip();
  paintStroke(inkCtx, stroke);
  inkCtx.restore();
}

function markInk() {
  inkDirty = true;
  sharp = null;
}

function drawSheet(g) {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.save();
  g.translate(view.x, view.y);
  g.scale(view.z, view.z);
  g.shadowColor = 'rgba(0, 0, 0, 0.45)';
  g.shadowBlur = 28;
  g.shadowOffsetY = 8;
  g.fillStyle = PAPER_COLOUR;
  g.fillRect(0, 0, PAPER.width, PAPER.height);
  g.shadowColor = 'transparent';
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
  g.drawImage(ink, 0, 0, PAPER.width, PAPER.height);
  g.restore();
}

function sharpMatches() {
  return Boolean(
    sharp &&
      sharp.width === canvas.width &&
      sharp.height === canvas.height &&
      sharp.dpr === dpr &&
      sharp.view.x === view.x &&
      sharp.view.y === view.y &&
      sharp.view.z === view.z
  );
}

function paintSharp() {
  clearTimeout(sharpTimer);
  sharpTimer = 0;
  if (view.z <= SHARP_ZOOM || canvas.width < 1 || canvas.height < 1) return;
  if (inkDirty) paintInk();
  const crop = document.createElement('canvas');
  crop.width = canvas.width;
  crop.height = canvas.height;
  drawSheet(crop.getContext('2d'));
  sharp = {
    canvas: crop,
    view: { x: view.x, y: view.y, z: view.z },
    dpr,
    width: crop.width,
    height: crop.height,
  };
}

// A zoomed view paints from the magnified bitmap while it moves, then settles
// into the crisp crop once it stops. The wait is why a wheel turn stays cheap.
function scheduleSharp() {
  if (sharpMatches() || view.z <= SHARP_ZOOM || sharpTimer) return;
  sharpTimer = setTimeout(() => {
    paintSharp();
    redraw();
  }, SHARP_IDLE_MS);
}

function paintLive(g) {
  if (drawing) {
    const layer = state.layers[drawing.stroke.layer];
    if (layer && layer.visible) paintStroke(g, drawing.stroke);
  }
  for (const stroke of room.inflight.values()) {
    const layer = state.layers[stroke.layer];
    if (layer && layer.visible) paintStroke(g, stroke);
  }
  g.globalAlpha = 1;
}

function redraw() {
  const width = canvas.width;
  const height = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (sharpMatches()) {
    ctx.drawImage(sharp.canvas, 0, 0);
  } else {
    if (inkDirty) paintInk();
    drawSheet(ctx);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.z, view.z);
  ctx.beginPath();
  ctx.rect(0, 0, PAPER.width, PAPER.height);
  ctx.clip();
  paintLive(ctx);
  paintPointers(ctx);
  ctx.restore();
  scheduleSharp();
}

// A remote dot carries the person's name and keeps one screen size at every
// zoom, because the sheet is what zooms and not the pointer.
function pointerColour(id) {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum = (sum * 31 + id.charCodeAt(i)) % 360;
  return 'hsl(' + sum + ' 62% 46%)';
}

// The dot lives inside the paper. The clip is the sheet frame, so a pointer at
// the paper edge is cut by the same rectangle that holds the ink.
function paintPointers(g) {
  let any = false;
  for (const [id, entry] of room.here) {
    if (id !== PEER && entry.pointer) {
      any = true;
      break;
    }
  }
  if (!any) return;

  g.save();
  g.beginPath();
  g.rect(0, 0, PAPER.width, PAPER.height);
  g.clip();
  const arrow = new Path2D(POINTER_ARROW);

  for (const [id, entry] of room.here) {
    if (id === PEER || !entry.pointer) continue;
    const at = glide.get(id) || entry.pointer;
    g.save();
    g.translate(at.x, at.y);
    g.scale(1 / view.z, 1 / view.z);
    g.fillStyle = pointerColour(id);
    g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    g.lineWidth = 1.3;
    g.lineJoin = 'round';
    g.fill(arrow);
    g.stroke(arrow);
    const label = String(entry.name || '').slice(0, 24);
    if (label) {
      g.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.textBaseline = 'middle';
      const width = g.measureText(label).width + 10;
      g.fillStyle = 'rgba(0, 0, 0, 0.82)';
      g.beginPath();
      if (typeof g.roundRect === 'function') g.roundRect(15, 1, width, 16, 5);
      else g.rect(15, 1, width, 16);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(label, 20, 9.5);
    }
    g.restore();
  }
  g.restore();
}

function glideTarget(id) {
  const entry = room.here.get(id);
  return entry && entry.pointer ? entry.pointer : null;
}

function glideFrame(now) {
  glideRaf = 0;
  let moving = false;
  for (const [id, at] of glide) {
    if (!glideTarget(id)) {
      glide.delete(id);
      continue;
    }
    if (!at.t0) continue;
    const p = Math.min(1, (now - at.t0) / GLIDE_MS);
    if (p >= 1) {
      at.x = at.tx;
      at.y = at.ty;
      at.t0 = 0;
      continue;
    }
    at.x = at.sx + (at.tx - at.sx) * p;
    at.y = at.sy + (at.ty - at.sy) * p;
    moving = true;
  }
  redraw();
  if (moving) glideRaf = requestAnimationFrame(glideFrame);
}

// A report starts the next 80 ms from wherever the dot is now, the way a new
// CSS transition picks up from the current position. A report that lands
// mid-glide therefore keeps the motion going instead of jumping ahead. The loop
// stops on its own once every dot has arrived, so a resting sheet paints no
// extra frames.
function glideTo(id) {
  const target = glideTarget(id);
  if (!target) {
    glide.delete(id);
    return;
  }
  const at = glide.get(id);
  if (!at || document.hidden) {
    glide.set(id, {
      x: target.x,
      y: target.y,
      sx: target.x,
      sy: target.y,
      tx: target.x,
      ty: target.y,
      t0: 0,
    });
    return;
  }
  if (at.tx === target.x && at.ty === target.y) return;
  const now = performance.now();
  const p = at.t0 ? Math.min(1, (now - at.t0) / GLIDE_MS) : 1;
  const x = at.sx + (at.tx - at.sx) * p;
  const y = at.sy + (at.ty - at.sy) * p;
  glide.set(id, { x, y, sx: x, sy: y, tx: target.x, ty: target.y, t0: now });
  if (!glideRaf) glideRaf = requestAnimationFrame(glideFrame);
}

// A hidden page paints no frames, so a glide in flight is finished at once
// instead of resuming when the tab comes back. The show paints the settled dot.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    redraw();
    return;
  }
  if (glideRaf) cancelAnimationFrame(glideRaf);
  glideRaf = 0;
  for (const [id, at] of glide) {
    const target = glideTarget(id);
    if (!target) continue;
    at.x = at.sx = at.tx = target.x;
    at.y = at.sy = at.ty = target.y;
    at.t0 = 0;
  }
});

// ---------------------------------------------------------------------------
// View

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fit() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  view.z = Math.min(width / PAPER.width, height / PAPER.height) * 0.9;
  view.x = (width - PAPER.width * view.z) / 2;
  view.y = (height - PAPER.height * view.z) / 2;
  fitted = true;
  redraw();
  showZoom();
  refreshPointer(true);
}

function showZoom() {
  document.getElementById('zoom-out-value').textContent = Math.round(view.z * 100) + '%';
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  // A window that changes size keeps a fitted sheet fitted. A sheet the hand
  // zoomed stays at that zoom, because a resize is not a request to refit.
  if (fitted) {
    fit();
    return;
  }
  redraw();
  refreshPointer(true);
}

function toWorld(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - view.x) / view.z,
    y: (event.clientY - rect.top - view.y) / view.z,
  };
}

// ---------------------------------------------------------------------------
// History

function addStroke(stroke) {
  state.layers[stroke.layer].strokes.push(stroke);
  room.seen.add(stroke.id);
  addToInk(stroke);
}

function removeById(id) {
  let removed = false;
  for (const layer of state.layers) {
    const index = layer.strokes.findIndex((stroke) => stroke.id === id);
    if (index >= 0) {
      layer.strokes.splice(index, 1);
      removed = true;
    }
  }
  if (removed) markInk();
  return removed;
}

function commit(stroke) {
  addStroke(stroke);
  state.history.push({ kind: 'add', stroke });
  state.redo.length = 0;
  sendStroke(stroke);
  showHistory();
  touchDocument();
}

function undo() {
  const op = state.history.pop();
  if (!op) return;
  if (op.kind === 'add') {
    removeById(op.stroke.id);
    sendRemove(op.stroke);
    state.redo.push(op);
  } else {
    for (const stroke of op.strokes) {
      addStroke(stroke);
      sendStroke(stroke);
    }
    state.redo.push({ kind: 'clear', strokes: op.strokes.slice() });
  }
  redraw();
  showHistory();
  touchDocument();
}

function redo() {
  const op = state.redo.pop();
  if (!op) return;
  if (op.kind === 'add') {
    addStroke(op.stroke);
    sendStroke(op.stroke);
    state.history.push(op);
  } else {
    for (const stroke of op.strokes) {
      removeById(stroke.id);
      sendRemove(stroke);
    }
    state.history.push({ kind: 'clear', strokes: op.strokes.slice() });
  }
  redraw();
  showHistory();
  touchDocument();
}

function showHistory() {
  document.getElementById('undo').disabled = state.history.length === 0;
  document.getElementById('redo').disabled = state.redo.length === 0;
  // The room line carries the sheet count, so it follows a local commit or an
  // undo at once instead of waiting for the next poll.
  if (room.socket && room.socket.readyState === WebSocket.OPEN) showRoomState();
}

// ---------------------------------------------------------------------------
// Documents

const docNameInput = document.getElementById('doc-name');
const docListEl = document.getElementById('doc-list');
const docCountEl = document.getElementById('docs-count');
const docStoreInput = document.getElementById('doc-store');
const docNewButton = document.getElementById('doc-new');
const docDuplicateButton = document.getElementById('doc-duplicate');
const docSearchInput = document.getElementById('doc-search');

function docLabel(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function shortDate(ms) {
  if (!ms) return 'new';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'new';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function docStrokes() {
  return state.layers.reduce((sum, layer) => sum + layer.strokes.length, 0);
}

function emptyBody() {
  return {
    layers: state.layers.map((layer) => ({ name: layer.name, visible: true, strokes: [] })),
    activeLayer: 1,
  };
}

function docBody() {
  return {
    layers: state.layers.map((layer) => ({
      name: layer.name,
      visible: layer.visible !== false,
      strokes: layer.strokes,
    })),
    activeLayer: state.activeLayer,
  };
}

// A document swap clears the sheet and every record that would let an old
// stroke answer for the new canvas.
function resetDocument() {
  for (const layer of state.layers) layer.strokes = [];
  state.history.length = 0;
  state.redo.length = 0;
  room.seen.clear();
  room.received.clear();
  room.parts.clear();
  room.inflight.clear();
  markInk();
  redraw();
  showHistory();
}

// A stored stroke is untrusted like a wire one, so it takes the same checks and
// then a full point list before it goes on the sheet.
function storedStroke(raw, layerIndex) {
  if (!raw || typeof raw !== 'object') return null;
  const stroke = cleanStroke({ ...raw, layer: layerIndex });
  if (!stroke) return null;
  if (!Array.isArray(raw.points) || raw.points.length < 1) return null;
  for (const point of raw.points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  }
  stroke.points = raw.points.map(clampPoint);
  room.seen.add(stroke.id);
  return stroke;
}

function applyDocument(doc) {
  if (!doc || typeof doc.id !== 'string') return;
  resetDocument();
  docs.active = doc.id;
  docs.name = docLabel(doc.name) || 'Untitled canvas';
  docs.at = Number(doc.at) || Date.now();
  docs.stored = doc.stored !== false;
  docs.hidden = doc.hidden === true;
  const layers = doc.body && Array.isArray(doc.body.layers) ? doc.body.layers : [];
  state.layers.forEach((layer, index) => {
    const source = layers[index];
    layer.strokes = [];
    if (!source) return;
    if (typeof source.name === 'string' && source.name) layer.name = source.name.slice(0, 20);
    layer.visible = source.visible !== false;
    if (!Array.isArray(source.strokes)) return;
    for (const raw of source.strokes) {
      const stroke = storedStroke(raw, index);
      if (stroke) layer.strokes.push(stroke);
    }
  });
  markInk();
  redraw();
  showHistory();
  showDocuments();
}

function showDocuments() {
  if (!docListEl) return;
  docListEl.textContent = '';
  const visible = docs.list.filter((item) => docs.host || !item.hidden);
  const query = docs.query.trim().toLowerCase();
  const matched = query
    ? visible.filter((item) =>
        (item.name + ' ' + (item.preview || '')).toLowerCase().includes(query)
      )
    : visible;
  if (docCountEl) docCountEl.textContent = String(visible.length);
  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'doc-empty';
    empty.textContent = docs.host ? 'No saved canvas yet.' : 'Nothing shared yet.';
    docListEl.append(empty);
  } else if (!matched.length) {
    const empty = document.createElement('li');
    empty.className = 'doc-empty';
    empty.textContent = 'No canvas matches "' + docs.query.trim() + '".';
    docListEl.append(empty);
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
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent =
      shortDate(item.at) + ' · ' + (item.preview || 'empty') + (item.hidden ? ' · hidden' : '');
    open.append(title, meta);
    open.addEventListener('click', () => requestDocument(item.id));
    row.append(open);

    if (docs.host) {
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'doc-tool';
      hide.textContent = item.hidden ? 'Show' : 'Hide';
      hide.title = item.hidden ? 'Let the room see this canvas' : 'Keep this canvas to yourself';
      hide.addEventListener('click', () => toggleDocumentHidden(item));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'doc-tool';
      del.textContent = 'Delete';
      del.title = 'Delete this canvas from the host';
      del.addEventListener('click', () => deleteDocument(item));
      row.append(hide, del);
    }
    docListEl.append(row);
  }

  if (docNameInput) {
    docNameInput.value = docs.active ? docs.name : '';
    docNameInput.disabled = !docs.host || !docs.active;
  }
  if (docStoreInput) {
    docStoreInput.checked = docs.stored;
    docStoreInput.disabled = !docs.host || !docs.active;
  }
}

async function saveDocument() {
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  if (!docs.host || !docs.api || !docs.active || !docs.stored) return;
  const doc = {
    id: docs.active,
    kind: 'canvas',
    name: docs.name,
    at: Date.now(),
    hidden: docs.hidden,
    stored: true,
    body: docBody(),
  };
  docs.at = doc.at;
  try {
    await docs.api.put(doc);
  } catch {
    return;
  }
  const preview = docStrokes() === 1 ? '1 stroke' : docStrokes() + ' strokes';
  const entry = { id: doc.id, name: doc.name, at: doc.at, hidden: doc.hidden, stored: true, preview };
  const index = docs.list.findIndex((item) => item.id === doc.id);
  if (index >= 0) docs.list[index] = entry;
  else docs.list.unshift(entry);
  docs.list.sort((a, b) => b.at - a.at);
  showDocuments();
  if (Date.now() - docs.sentAt > 4000) {
    docs.sentAt = Date.now();
    broadcastDocuments();
  }
}

// Drawing settles for 700 ms and then the host writes. A stroke burst during
// that window costs one write, not one per point.
function touchDocument() {
  if (!docs.host || !docs.active || !docs.stored) return;
  clearTimeout(docs.saveTimer);
  docs.saveTimer = setTimeout(saveDocument, 700);
}

function documentsFrame() {
  return {
    op: 'docs',
    docs: docs.list
      .filter((item) => !item.hidden)
      .map((item) => ({ id: item.id, name: item.name, at: item.at, preview: item.preview })),
  };
}

function broadcastDocuments() {
  if (!docs.host) return;
  docs.sentAt = Date.now();
  send(documentsFrame());
}

// The relay fans a frame out to the room, so a reply for one page carries the
// peer it is for and every other page drops it.
function sendDirect(peer, data) {
  send({ ...data, to: peer });
}

async function refreshDocuments() {
  if (!docs.host || !docs.api) {
    showDocuments();
    return;
  }
  try {
    const list = await docs.api.list('canvas');
    docs.list = Array.isArray(list) ? list : [];
  } catch {
    docs.list = Array.isArray(docs.list) ? docs.list : [];
  }
  showDocuments();
  broadcastDocuments();
}

async function openDocument(id) {
  if (!docs.host) {
    send({ op: 'doc-want', id });
    return;
  }
  if (!docs.api || typeof id !== 'string') return;
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  if (docs.active && docs.active !== id) await saveDocument();
  let doc = null;
  try {
    doc = await docs.api.get(id);
  } catch {
    doc = null;
  }
  if (!doc) return;
  applyDocument(doc);
  send({ op: 'doc-open', id: doc.id, name: docs.name, at: docs.at });
  announce();
}

function requestDocument(id) {
  if (docs.host) openDocument(id);
  else send({ op: 'doc-want', id });
}

async function newDocument() {
  if (!docs.host) {
    send({ op: 'doc-new' });
    return;
  }
  if (!docs.api) return;
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  if (docs.active) await saveDocument();
  const doc = {
    id: docs.api.id(),
    kind: 'canvas',
    name: 'Canvas ' + (docs.list.length + 1),
    at: Date.now(),
    hidden: false,
    stored: docs.stored,
    body: emptyBody(),
  };
  applyDocument(doc);
  if (doc.stored) {
    try {
      await docs.api.put(doc);
    } catch {
      // A failed first save leaves the canvas in the room only.
    }
    docs.list.unshift({
      id: doc.id,
      name: doc.name,
      at: doc.at,
      hidden: false,
      stored: true,
      preview: '0 strokes',
    });
    docs.list.sort((a, b) => b.at - a.at);
    showDocuments();
    broadcastDocuments();
  }
  send({ op: 'doc-open', id: doc.id, name: doc.name, at: doc.at });
}

// A copy starts a new file with fresh stroke ids, so the room paints it from
// scratch and the original stays as it was.
async function duplicateDocument() {
  if (!docs.host || !docs.api || !docs.active) return;
  clearTimeout(docs.saveTimer);
  docs.saveTimer = 0;
  await saveDocument();
  const body = docBody();
  const copy = {
    id: docs.api.id(),
    kind: 'canvas',
    name: docLabel(docs.name + ' copy'),
    at: Date.now(),
    hidden: false,
    stored: docs.stored,
    body: {
      layers: body.layers.map((layer) => ({
        name: layer.name,
        visible: layer.visible !== false,
        strokes: layer.strokes.map((stroke) => ({ ...stroke, id: nextStrokeId() })),
      })),
      activeLayer: body.activeLayer,
    },
  };
  applyDocument(copy);
  if (copy.stored) {
    try {
      await docs.api.put(copy);
    } catch {
      // A failed first save leaves the copy in the room only.
    }
    docs.list.unshift({
      id: copy.id,
      name: copy.name,
      at: copy.at,
      hidden: false,
      stored: true,
      preview: docStrokes() === 1 ? '1 stroke' : docStrokes() + ' strokes',
    });
    docs.list.sort((a, b) => b.at - a.at);
    showDocuments();
    broadcastDocuments();
  }
  send({ op: 'doc-open', id: copy.id, name: copy.name, at: copy.at });
  announce();
}

async function toggleDocumentHidden(entry) {
  if (!docs.host || !docs.api) return;
  let doc = null;
  try {
    doc = await docs.api.get(entry.id);
  } catch {
    doc = null;
  }
  if (!doc) return;
  doc.hidden = !(doc.hidden === true);
  try {
    await docs.api.put(doc);
  } catch {
    return;
  }
  if (docs.active === doc.id) docs.hidden = doc.hidden;
  await refreshDocuments();
}

async function deleteDocument(entry) {
  if (!docs.host || !docs.api) return;
  if (!window.confirm('Delete "' + entry.name + '" for good?')) return;
  try {
    await docs.api.remove(entry.id);
  } catch {
    return;
  }
  docs.list = docs.list.filter((item) => item.id !== entry.id);
  if (docs.active === entry.id) {
    docs.active = '';
    docs.name = 'Untitled canvas';
    docs.stored = true;
    docs.hidden = false;
    resetDocument();
    if (docs.list.length) await openDocument(docs.list[0].id);
    else await newDocument();
  }
  showDocuments();
  broadcastDocuments();
}

async function startDocuments() {
  document.body.classList.toggle('is-guest', !docs.host);
  if (!docs.host || !docs.api) {
    showDocuments();
    return;
  }
  await refreshDocuments();
  // The newest canvas comes back with the next room, so a host that starts a
  // room lands on the sheet it was last using.
  if (docs.list.length) await openDocument(docs.list[0].id);
  else await newDocument();
}

if (docNewButton) docNewButton.addEventListener('click', () => newDocument());
if (docDuplicateButton) docDuplicateButton.addEventListener('click', () => duplicateDocument());
if (docSearchInput) {
  docSearchInput.addEventListener('input', () => {
    docs.query = docSearchInput.value;
    showDocuments();
  });
}

if (docNameInput) {
  docNameInput.addEventListener('change', () => {
    if (!docs.host || !docs.active) return;
    docs.name = docLabel(docNameInput.value) || 'Untitled canvas';
    const entry = docs.list.find((item) => item.id === docs.active);
    if (entry) entry.name = docs.name;
    showDocuments();
    touchDocument();
    broadcastDocuments();
  });
}

if (docStoreInput) {
  docStoreInput.addEventListener('change', async () => {
    if (!docs.host || !docs.active) return;
    docs.stored = docStoreInput.checked;
    if (docs.stored) {
      await saveDocument();
      return;
    }
    clearTimeout(docs.saveTimer);
    docs.saveTimer = 0;
    if (docs.api) {
      try {
        await docs.api.remove(docs.active);
      } catch {
        // The file may never have been written.
      }
    }
    docs.list = docs.list.filter((item) => item.id !== docs.active);
    showDocuments();
    broadcastDocuments();
  });
}

// ---------------------------------------------------------------------------
// Room

function setRoomState(text, bad) {
  const node = document.getElementById('room-state');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('is-offline', Boolean(bad));
}

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, 24);
}

// An unnamed page still needs a label the other pages can read, so it takes the
// short form of its own id.
function myName() {
  return cleanName(nameInput.value) || 'Guest ' + PEER.slice(0, 4);
}

function pruneHere() {
  const cutoff = Date.now() - HERE_TTL;
  let dropped = false;
  for (const [id, entry] of room.here) {
    if (id === PEER) continue;
    if (entry.at < cutoff) {
      room.here.delete(id);
      glide.delete(id);
      dropped = true;
    }
  }
  return dropped;
}

// One line says how many pages hold the sheet, how much ink is on it and who
// else is here, which is also the fastest way to see that a late join arrived
// empty.
function showRoomState() {
  pruneHere();
  const count = Math.max(1, room.here.size);
  const pages = count + (count === 1 ? ' page in the room' : ' pages in the room');
  const others = [...room.here.entries()]
    .filter(([id]) => id !== PEER)
    .map(([, entry]) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const named = others.slice(0, 3);
  const rest = others.length - named.length;
  const who = named.length
    ? 'you, ' + named.join(', ') + (rest > 0 ? ', +' + rest : '')
    : 'only you';
  setRoomState(pages + ' · ' + strokeTotal() + ' strokes · ' + who);
}

function send(data) {
  if (!room.socket || room.socket.readyState !== WebSocket.OPEN) return;
  room.socket.send(JSON.stringify({ v: 1, type: 'app', peerId: PEER, name: 'canvas', data }));
}

// Presence is the page's own name. The entry lands even before the socket does,
// so the line stays honest while a page waits to connect.
function sendHere() {
  const name = myName();
  room.here.set(PEER, { name, pointer, at: Date.now() });
  if (!room.socket || room.socket.readyState !== WebSocket.OPEN) return;
  // The point rides the heartbeat too, so a page that joins late sees where
  // each pointer rested instead of waiting for the next move.
  send({ op: 'here', name, pointer: pointer ? wirePoint(pointer) : null });
  showRoomState();
}

function wirePoint(point) {
  return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
}

function cleanPointer(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// A pointer goes out at most every 60 ms, and a clear frame goes out at once so
// a dot never keeps pointing at the desk after the hand left the paper.
function sendPointer(force) {
  if (!room.socket || room.socket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && now - pointerSent < POINTER_MS) return;
  pointerSent = now;
  if (!pointer) {
    send({ op: 'pointer', gone: true });
    return;
  }
  send({ op: 'pointer', ...wirePoint(pointer) });
}

// A zoom, a pan or a window resize moves the paper under a hand that has not
// moved. The last client point is read again against the new view, so the dot
// follows the paper point under the cursor instead of the one it rested on
// before the change.
function refreshPointer(force) {
  if (!pointerAt) return;
  const point = toWorld({ clientX: pointerAt.x, clientY: pointerAt.y });
  const next = onPaperPoint(point) ? point : null;
  if (!next && !pointer) return;
  if (!force && pointer && next && Math.hypot(next.x - pointer.x, next.y - pointer.y) < 0.5) {
    return;
  }
  pointer = next;
  sendPointer(true);
}

function sendStroke(stroke) {
  const parts = Math.max(1, Math.ceil(stroke.points.length / PART_POINTS));
  for (let part = 0; part < parts; part++) {
    send({
      op: 'stroke',
      id: stroke.id,
      layer: stroke.layer,
      tool: stroke.tool,
      colour: stroke.colour,
      size: stroke.size,
      opacity: stroke.opacity,
      part,
      parts,
      points: stroke.points.slice(part * PART_POINTS, (part + 1) * PART_POINTS).map(wirePoint),
    });
  }
}

function sendRemove(stroke) {
  send({ op: 'remove', id: stroke.id });
}

function strokeTotal() {
  return state.layers.reduce((sum, layer) => sum + layer.strokes.length, 0);
}

// A page that drew before its socket opened still owns those strokes, and one
// that reconnects owns everything from before the drop. Handing the sheet over
// on open is what makes both sides converge, and the ids stop the repeat.
function announce() {
  for (const layer of state.layers) {
    for (const stroke of layer.strokes) sendStroke(stroke);
  }
}

// A joiner asks for the sheet. A peer that is still opening its own socket
// hears nothing the first time, so an empty page asks once more.
function requestSheet() {
  send({ op: 'sync' });
  clearTimeout(room.ask);
  room.ask = setTimeout(() => {
    if (!room.socket) return;
    if (strokeTotal() === 0) send({ op: 'sync' });
  }, 1200);
}

// A peer should see the line while it is drawn, not only after the pointer
// lifts. A live frame carries the points added since the last one. A shape
// sends its two ends again, because the second end moves instead of growing.
function sendLive(stroke, force) {
  if (live.id !== stroke.id) {
    live = { id: stroke.id, sent: 0, at: 0 };
  }
  const now = Date.now();
  if (!force && now - live.at < LIVE_MS) return;
  const shape = SHAPES.has(stroke.tool);
  const fresh = shape ? stroke.points : stroke.points.slice(live.sent);
  if (!fresh.length) return;
  live.at = now;
  live.sent = stroke.points.length;
  send({
    op: 'live',
    id: stroke.id,
    layer: stroke.layer,
    tool: stroke.tool,
    colour: stroke.colour,
    size: stroke.size,
    opacity: stroke.opacity,
    shape,
    points: fresh.map(wirePoint),
  });
}

// The finished stroke still travels once, so a page that joins later replays
// the sheet from the record rather than from these frames.
function sendLiveEnd(stroke) {
  send({ op: 'live-end', id: stroke.id });
}

// A frame from the wire is untrusted. Anything that is not a stroke this app
// can paint is dropped, not repaired.
function cleanStroke(data) {
  if (!data || typeof data.id !== 'string' || !data.id || data.id.length > 80) return null;
  const layer = Number(data.layer);
  if (!Number.isInteger(layer) || layer < 0 || layer >= state.layers.length) return null;
  if (!PRESETS[data.tool]) return null;
  if (typeof data.colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.colour)) return null;
  const size = Number(data.size);
  const opacity = Number(data.opacity);
  if (!Number.isFinite(size) || size <= 0 || size > 200) return null;
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) return null;
  return {
    id: data.id,
    layer,
    tool: data.tool,
    colour: data.colour,
    size,
    opacity,
    points: [],
  };
}

function handle(from, data) {
  if (typeof from !== 'string' || !from || from === PEER) return;
  if (!data || typeof data !== 'object') return;
  if (data.to && data.to !== PEER) return;

  if (data.op === 'here') {
    const name = cleanName(data.name);
    if (!name) return;
    // The heartbeat replaces the name and keeps the last point unless the
    // frame carries one, so a move between two beats never blinks out.
    const fresh = !room.here.has(from);
    const entry = room.here.get(from) || { pointer: null };
    entry.name = name;
    entry.at = Date.now();
    if ('pointer' in data) entry.pointer = cleanPointer(data.pointer);
    room.here.set(from, entry);
    glideTo(from);
    showRoomState();
    // A page that arrives after the host already opened a canvas gets the
    // library and the open sheet, so it never waits for the next change.
    if (fresh && docs.host) {
      sendDirect(from, documentsFrame());
      if (docs.active) {
        sendDirect(from, { op: 'doc-open', id: docs.active, name: docs.name, at: docs.at });
      }
    }
    redraw();
    return;
  }

  // A pointer is sheet coordinates and nothing else. The page that sends it
  // already dropped a point off the paper, and this side draws inside the
  // frame, so a bad point can never land on the desk.
  if (data.op === 'pointer') {
    const entry = room.here.get(from);
    if (!entry) return;
    entry.pointer = data.gone === true ? null : cleanPointer(data);
    glideTo(from);
    redraw();
    return;
  }

  if (data.op === 'docs' && Array.isArray(data.docs)) {
    if (docs.host) return;
    docs.list = data.docs
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        name: docLabel(item.name) || 'Canvas',
        at: Number(item.at) || 0,
        preview: typeof item.preview === 'string' ? item.preview.slice(0, 80) : '',
        hidden: false,
      }));
    showDocuments();
    return;
  }

  if (data.op === 'docs-ask') {
    if (docs.host) broadcastDocuments();
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

  if (data.op === 'doc-open' && typeof data.id === 'string') {
    if (docs.host) return;
    resetDocument();
    docs.active = data.id;
    docs.name = docLabel(data.name) || 'Canvas';
    docs.at = Number(data.at) || Date.now();
    docs.stored = false;
    docs.hidden = false;
    showDocuments();
    return;
  }

  if (data.op === 'stroke') {
    const stroke = cleanStroke(data);
    if (!stroke) return;
    if (room.seen.has(stroke.id)) return;
    if (!Number.isInteger(data.part) || !Number.isInteger(data.parts) || data.parts < 1) return;
    if (data.part < 0 || data.part >= data.parts) return;

    // A sync reply can repeat a part that already arrived, and appending it
    // twice doubles those points. Each part lands once per stroke.
    let parts = room.parts.get(stroke.id);
    if (!parts) {
      parts = new Set();
      room.parts.set(stroke.id, parts);
    }
    if (parts.has(data.part)) return;
    parts.add(data.part);

    if (data.part === 0) {
      if (!Array.isArray(data.points)) return;
      room.inflight.delete(stroke.id);
      room.received.set(stroke.id, stroke);
    }
    const held = room.received.get(stroke.id);
    if (!held) return;
    if (Array.isArray(data.points)) {
      for (const point of data.points) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        if (held.points.length >= MAX_POINTS) break;
        held.points.push(clampPoint(point));
      }
    }
    if (data.part === data.parts - 1) {
      room.received.delete(stroke.id);
      room.parts.delete(stroke.id);
      // The finished copy replaces the live one this page was drawing, so the
      // line never shows twice while the last parts are in flight.
      room.inflight.delete(stroke.id);
      if (held.points.length > 1) {
        addStroke(held);
        redraw();
      }
    }
    return;
  }

  if (data.op === 'live') {
    const stroke = cleanStroke(data);
    if (!stroke || !Array.isArray(data.points)) return;
    if (room.seen.has(stroke.id)) return;
    const points = [];
    for (const point of data.points) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      points.push(clampPoint(point));
    }
    let held = room.inflight.get(stroke.id);
    if (!held) {
      held = stroke;
      room.inflight.set(stroke.id, held);
    }
    if (data.shape === true) held.points = points;
    else if (held.points.length + points.length <= MAX_POINTS) held.points.push(...points);
    held.at = Date.now();
    redraw();
    return;
  }

  if (data.op === 'live-end' && typeof data.id === 'string') {
    if (room.inflight.delete(data.id)) redraw();
    return;
  }

  if (data.op === 'remove' && typeof data.id === 'string') {
    room.inflight.delete(data.id);
    if (removeById(data.id)) redraw();
    return;
  }

  if (data.op === 'sync') {
    // A page that just joined asks for the sheet. Every page answers with the
    // strokes it holds, and a stroke id already on the sheet is ignored. The
    // end frame says how many there were, so the joiner can tell an empty room
    // from an answer that has not arrived yet.
    let answered = 0;
    for (const layer of state.layers) {
      for (const stroke of layer.strokes) {
        sendStroke(stroke);
        answered += 1;
      }
    }
    // The joiner learns every name at once instead of waiting for the next
    // heartbeat from each page.
    sendHere();
    send({ op: 'sync-end', from: PEER, strokes: answered });
    return;
  }

  if (data.op === 'sync-end') {
    if (typeof data.strokes !== 'number' || !Number.isFinite(data.strokes)) return;
    readPeers();
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
    // Announce what this page holds, then ask for the rest of the sheet. The
    // name goes first, so a joiner is named while its strokes arrive.
    sendHere();
    if (docs.host) {
      broadcastDocuments();
      if (docs.active) {
        send({ op: 'doc-open', id: docs.active, name: docs.name, at: docs.at });
      }
    }
    announce();
    requestSheet();
    readPeers();
  });
  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!frame || frame.type !== 'app' || frame.name !== 'canvas') return;
    if (frame.peerId === PEER) return;
    handle(frame.peerId, frame.data);
  });
  socket.addEventListener('close', () => {
    room.socket = null;
    setRoomState('Solo', true);
    clearTimeout(room.retry);
    room.retry = setTimeout(connect, 2000);
  });
  socket.addEventListener('error', () => socket.close());
}

// The canvas counts canvas pages from presence, because the relay counts every
// socket in the room and a film page is not a sheet. The read stays as a relay
// liveness check.
function readPeers() {
  fetch('/status?room=' + encodeURIComponent(ROOM), { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('status'))))
    .then(() => showRoomState())
    .catch(() => setRoomState('Solo', true));
}

setInterval(() => {
  if (room.socket) readPeers();
  // A peer that closed its tab in the middle of a line leaves a half stroke
  // behind. Its stamp stops moving, so it is dropped here.
  const cutoff = Date.now() - LIVE_TTL;
  let stale = false;
  for (const [id, stroke] of room.inflight) {
    if (stroke.at < cutoff) {
      room.inflight.delete(id);
      stale = true;
    }
  }
  // A stroke that stopped part way keeps only its part count. Once no part is
  // in flight the record is dead weight.
  for (const id of room.parts.keys()) {
    if (!room.received.has(id)) room.parts.delete(id);
  }
  if (stale) redraw();
}, 5000);

// ---------------------------------------------------------------------------
// Pointer

function startStroke(point) {
  drawing = {
    stroke: {
      id: nextStrokeId(),
      tool: state.preset,
      colour: state.colour,
      size: state.size,
      opacity: state.opacity,
      layer: state.activeLayer,
      points: [point],
    },
    last: point,
  };
}

function addPoint(point) {
  const stroke = drawing.stroke;
  const last = drawing.last;
  const gap = Math.hypot(point.x - last.x, point.y - last.y);
  if (gap < 0.6) return;

  // A stabilizer pulls the new point toward the last one, so a shaky hand
  // produces a shorter, calmer path.
  const pull = state.stabilizer * 0.85;
  const next = clampPoint({
    x: last.x + (point.x - last.x) * (1 - pull),
    y: last.y + (point.y - last.y) * (1 - pull),
  });
  stroke.points.push(next);
  drawing.last = next;
  sendLive(stroke, false);
  redraw();
}

viewport.addEventListener('pointerdown', (event) => {
  if (event.button === 1 || spaceDown) {
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('panning');
    panning = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    return;
  }
  if (event.button !== 0) return;
  const point = toWorld(event);
  // A press on the desk is not a stroke. Ink only starts on the sheet.
  if (!onPaperPoint(point)) return;
  event.preventDefault();
  viewport.setPointerCapture(event.pointerId);
  startStroke(clampPoint(point));
  if (SHAPES.has(state.preset)) {
    drawing.stroke.points.push(clampPoint(point));
  }
  sendLive(drawing.stroke, true);
  redraw();
});

viewport.addEventListener('pointermove', (event) => {
  pointerAt = { x: event.clientX, y: event.clientY };
  const point = toWorld(event);
  const coords = document.getElementById('coords');
  coords.textContent = Math.round(point.x) + ', ' + Math.round(point.y);

  // Only a point on the paper travels, and leaving the paper clears the dot.
  const onPaper = onPaperPoint(point);
  if (onPaper) {
    pointer = point;
    sendPointer(false);
  } else if (pointer) {
    pointer = null;
    sendPointer(true);
  }

  if (panning) {
    view.x = panning.vx + (event.clientX - panning.x);
    view.y = panning.vy + (event.clientY - panning.y);
    fitted = false;
    // The move was read against the view before this pan step, so the point is
    // read again now that the paper has moved under the hand.
    refreshPointer(true);
    redraw();
    return;
  }
  if (!drawing) return;
  if (SHAPES.has(drawing.stroke.tool)) {
    drawing.stroke.points[1] = clampPoint(point);
    redraw();
    return;
  }
  addPoint(point);
});

function endStroke(event) {
  if (panning) {
    panning = null;
    viewport.classList.remove('panning');
    if (event && viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    return;
  }
  if (!drawing) return;
  const stroke = drawing.stroke;
  drawing = null;
  if (event && viewport.hasPointerCapture(event.pointerId)) {
    viewport.releasePointerCapture(event.pointerId);
  }
  if (stroke.points.length > 1) commit(stroke);
  sendLiveEnd(stroke);
  redraw();
}

viewport.addEventListener('pointerup', endStroke);
viewport.addEventListener('pointercancel', endStroke);

// The pointer leaving the window is not a move, so the dot is cleared here.
viewport.addEventListener('pointerleave', () => {
  pointerAt = null;
  if (!pointer) return;
  pointer = null;
  sendPointer(true);
});

viewport.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const before = { x: (sx - view.x) / view.z, y: (sy - view.y) / view.z };
    view.z = clamp(view.z * Math.exp(-event.deltaY * 0.0015), 0.15, 8);
    view.x = sx - before.x * view.z;
    view.y = sy - before.y * view.z;
    fitted = false;
    redraw();
    showZoom();
    refreshPointer(true);
  },
  { passive: false }
);

// ---------------------------------------------------------------------------
// Controls

function setPreset(name) {
  state.preset = name;
  const preset = PRESETS[name];
  state.size = preset.size;
  state.opacity = preset.opacity;
  for (const button of document.querySelectorAll('.brush')) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === name));
  }
  document.getElementById('size').value = String(Math.round(state.size));
  document.getElementById('opacity').value = String(Math.round(state.opacity * 100));
  document.getElementById('size-out').textContent = String(Math.round(state.size));
  document.getElementById('opacity-out').textContent = Math.round(state.opacity * 100) + '%';
  document.getElementById('tool-state').textContent = preset.label;
}

function setColour(colour) {
  state.colour = colour;
  document.getElementById('colour').value = colour;
  for (const button of document.querySelectorAll('.swatch')) {
    button.setAttribute('aria-pressed', String(button.dataset.color.toLowerCase() === colour.toLowerCase()));
  }
}

function showLayerState() {
  for (const button of document.querySelectorAll('.layer')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.layer) === state.activeLayer));
  }
}

for (const button of document.querySelectorAll('.brush')) {
  button.addEventListener('click', () => setPreset(button.dataset.preset));
}

document.getElementById('size').addEventListener('input', (event) => {
  state.size = Number(event.target.value);
  document.getElementById('size-out').textContent = String(Math.round(state.size));
});

document.getElementById('opacity').addEventListener('input', (event) => {
  state.opacity = Number(event.target.value) / 100;
  document.getElementById('opacity-out').textContent = Math.round(state.opacity * 100) + '%';
});

document.getElementById('stabilizer').addEventListener('input', (event) => {
  state.stabilizer = Number(event.target.value) / 100;
  document.getElementById('stabilizer-out').textContent = Math.round(state.stabilizer * 100) + '%';
});

for (const button of document.querySelectorAll('.swatch')) {
  button.addEventListener('click', () => setColour(button.dataset.color));
}

document.getElementById('colour').addEventListener('input', (event) => setColour(event.target.value));

for (const button of document.querySelectorAll('.layer')) {
  button.addEventListener('click', (event) => {
    if (event.target.dataset.visible !== undefined) {
      const index = Number(event.target.dataset.visible);
      const layer = state.layers[index];
      layer.visible = !layer.visible;
      event.target.textContent = layer.visible ? 'Show' : 'Hidden';
      event.target.dataset.on = layer.visible ? 'on' : 'off';
      markInk();
      redraw();
      touchDocument();
      return;
    }
    state.activeLayer = Number(button.dataset.layer);
    showLayerState();
  });
}

document.getElementById('undo').addEventListener('click', undo);
document.getElementById('redo').addEventListener('click', redo);

document.getElementById('clear').addEventListener('click', () => {
  const strokes = state.layers.flatMap((layer) => layer.strokes.slice());
  if (!strokes.length) return;
  state.layers.forEach((layer) => {
    layer.strokes = [];
  });
  markInk();
  state.history.push({ kind: 'clear', strokes });
  state.redo.length = 0;
  for (const stroke of strokes) sendRemove(stroke);
  redraw();
  showHistory();
  touchDocument();
});

document.getElementById('export').addEventListener('click', () => {
  const out = document.createElement('canvas');
  const scale = 2;
  out.width = PAPER.width * scale;
  out.height = PAPER.height * scale;
  const target = out.getContext('2d');
  target.scale(scale, scale);
  target.fillStyle = PAPER_COLOUR;
  target.fillRect(0, 0, PAPER.width, PAPER.height);
  paintCommitted(target);
  out.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download =
      (docLabel(docs.name) || 'canvas')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') + '.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }, 'image/png');
});

document.getElementById('zoom-in').addEventListener('click', () => {
  view.z = clamp(view.z * 1.2, 0.15, 8);
  fitted = false;
  redraw();
  showZoom();
  refreshPointer(true);
});

document.getElementById('zoom-out').addEventListener('click', () => {
  view.z = clamp(view.z / 1.2, 0.15, 8);
  fitted = false;
  redraw();
  showZoom();
  refreshPointer(true);
});

document.getElementById('fit').addEventListener('click', fit);

// ---------------------------------------------------------------------------
// Keys

window.addEventListener('keydown', (event) => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

  if (event.code === 'Space' && !typing) {
    spaceDown = true;
    event.preventDefault();
    return;
  }
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (typing || mod) return;

  const keys = {
    b: 'pencil',
    i: 'ink',
    m: 'marker',
    a: 'airbrush',
    e: 'eraser',
    l: 'line',
    r: 'rect',
    o: 'ellipse',
  };
  if (keys[event.key.toLowerCase()]) {
    setPreset(keys[event.key.toLowerCase()]);
    return;
  }
  if (event.key === '[' || event.key === ']') {
    const next = clamp(state.size + (event.key === ']' ? 2 : -2), 1, 80);
    state.size = next;
    document.getElementById('size').value = String(next);
    document.getElementById('size-out').textContent = String(next);
    return;
  }
  if (event.key === '0') fit();
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') spaceDown = false;
});

window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Start

try {
  nameInput.value = localStorage.getItem(NAME_KEY) || '';
} catch {
  nameInput.value = '';
}
nameInput.addEventListener('input', () => {
  try {
    localStorage.setItem(NAME_KEY, nameInput.value.slice(0, 24));
  } catch {
    // A private window can refuse storage, and the name still works without it.
  }
  sendHere();
});

resize();
fit();
setPreset('pencil');
setColour('#18181b');
showLayerState();
showHistory();
sendHere();
setInterval(sendHere, HERE_MS);
connect();
startDocuments();
