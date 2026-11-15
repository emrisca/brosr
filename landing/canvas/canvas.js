'use strict';
// Canvas. One endless warm surface, with a small stroke model so undo,
// symmetry, layers, the room and a PNG export all read from the same record.
// A stroke holds world points, so panning and zooming never move the ink.

const SURFACE = '#faf7f2';
// The grid is a fixed step in world space, doubled or halved until a line sits
// between these two screen widths. One grid then serves every zoom level.
const GRID = 32;
const GRID_MIN_PX = 24;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

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
  colour: '#1c1a17',
  size: 4,
  opacity: 1,
  stabilizer: 0.35,
  symmetry: 'off',
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

// The room. One WebSocket to the relay, app frames only, JSON like the rest of
// the wire. A stroke is a list of points, so it travels as one message.
const ROOM = new URLSearchParams(location.search).get('room') || 'default';
const PEER = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 8);
const PART_POINTS = 300;
const MAX_POINTS = 20000;
// A live frame goes out at most every 60 ms, and a stroke nobody finished is
// dropped from the sheet after 15 s.
const LIVE_MS = 60;
const LIVE_TTL = 15000;
const room = {
  socket: null,
  peers: 0,
  retry: null,
  received: new Map(),
  seen: new Set(),
  inflight: new Map(),
};
let strokeCount = 0;
let live = { id: null, sent: 0, at: 0 };

function nextStrokeId() {
  strokeCount += 1;
  return PEER + '-' + strokeCount;
}

const viewport = document.getElementById('viewport');
// The surface and the grid are painted on the ground canvas. The ink canvas
// above it holds strokes only, so an eraser cuts ink rather than paper.
const ground = document.getElementById('ground');
const canvas = document.getElementById('sheet');
const gctx = ground.getContext('2d');
const ctx = canvas.getContext('2d');

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

// Symmetry needs a fixed axis, and an endless surface has no centre. The first
// point of the stroke is the axis, so the copies always appear beside the line
// that was drawn, at any pan and any zoom. A transform takes the context it
// draws on, because the export paints on a second canvas.
function mirrorTransforms(mode, origin) {
  const list = [(g) => {}];
  if (mode === 'vertical' || mode === 'quad') {
    list.push((g) => {
      g.translate(origin.x * 2, 0);
      g.scale(-1, 1);
    });
  }
  if (mode === 'horizontal' || mode === 'quad') {
    list.push((g) => {
      g.translate(0, origin.y * 2);
      g.scale(1, -1);
    });
  }
  if (mode === 'quad') {
    list.push((g) => {
      g.translate(origin.x * 2, origin.y * 2);
      g.scale(-1, -1);
    });
  }
  return list;
}

function paintShape(g, stroke) {
  const a = stroke.points[0];
  const b = stroke.points[stroke.points.length - 1];
  g.globalAlpha = stroke.opacity;
  g.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  g.strokeStyle = stroke.colour;
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
  const colour = stroke.colour;
  g.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
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
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    return;
  }
  for (const apply of mirrorTransforms(stroke.symmetry, stroke.points[0])) {
    g.save();
    apply(g);
    paintFreehand(g, stroke);
    g.restore();
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

function paintInk(g, withLive) {
  g.globalAlpha = 1;

  for (let index = 0; index < state.layers.length; index++) {
    const layer = state.layers[index];
    if (!layer.visible) continue;
    for (const stroke of layer.strokes) paintStroke(g, stroke);
    if (!withLive) continue;
    if (drawing && drawing.stroke.layer === index) paintStroke(g, drawing.stroke);
    for (const stroke of room.inflight.values()) {
      if (stroke.layer === index) paintStroke(g, stroke);
    }
  }
}

// One grid in world space, with the step doubled until it reads on screen.
// Zooming out therefore thins the grid instead of crowding it.
function paintGrid(g, width, height) {
  let step = GRID;
  while (step * view.z < GRID_MIN_PX) step *= 2;
  while (step * view.z > GRID_MIN_PX * 4) step /= 2;
  const left = -view.x / view.z;
  const top = -view.y / view.z;
  const right = left + width / view.z;
  const bottom = top + height / view.z;

  g.lineWidth = 1 / view.z;
  g.strokeStyle = 'rgba(28, 26, 23, 0.09)';
  g.beginPath();
  for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
    g.moveTo(x, top);
    g.lineTo(x, bottom);
  }
  for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
    g.moveTo(left, y);
    g.lineTo(right, y);
  }
  g.stroke();

  // The origin is the one fixed point an endless surface can steer by.
  g.lineWidth = 1.5 / view.z;
  g.strokeStyle = 'rgba(28, 26, 23, 0.16)';
  g.beginPath();
  if (left <= 0 && right >= 0) {
    g.moveTo(0, top);
    g.lineTo(0, bottom);
  }
  if (top <= 0 && bottom >= 0) {
    g.moveTo(left, 0);
    g.lineTo(right, 0);
  }
  g.stroke();
}

function paintGround(width, height) {
  gctx.setTransform(1, 0, 0, 1, 0, 0);
  gctx.fillStyle = SURFACE;
  gctx.fillRect(0, 0, ground.width, ground.height);
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.save();
  gctx.translate(view.x, view.y);
  gctx.scale(view.z, view.z);
  paintGrid(gctx, width, height);
  gctx.restore();
}

function redraw() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  paintGround(width, height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.z, view.z);
  paintInk(ctx, true);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// View

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// The bounds of the ink, with the widest stroke taken into account. An empty
// canvas has nothing to frame, so the origin takes the middle at 100%.
function contentBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    for (const stroke of layer.strokes) {
      const pad = Math.max(1, stroke.size / 2);
      for (const point of stroke.points) {
        minX = Math.min(minX, point.x - pad);
        minY = Math.min(minY, point.y - pad);
        maxX = Math.max(maxX, point.x + pad);
        maxY = Math.max(maxY, point.y + pad);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function fit() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const box = contentBounds();
  if (!box) {
    view.z = 1;
    view.x = width / 2;
    view.y = height / 2;
    redraw();
    showZoom();
    return;
  }
  const boxWidth = Math.max(1, box.maxX - box.minX);
  const boxHeight = Math.max(1, box.maxY - box.minY);
  view.z = clamp(
    Math.min((width - 64) / boxWidth, (height - 64) / boxHeight),
    MIN_ZOOM,
    MAX_ZOOM
  );
  view.x = (width - boxWidth * view.z) / 2 - box.minX * view.z;
  view.y = (height - boxHeight * view.z) / 2 - box.minY * view.z;
  redraw();
  showZoom();
}

function showZoom() {
  document.getElementById('zoom-out-value').textContent = Math.round(view.z * 100) + '%';
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  for (const node of [ground, canvas]) {
    node.width = Math.max(1, Math.round(width * dpr));
    node.height = Math.max(1, Math.round(height * dpr));
    node.style.width = width + 'px';
    node.style.height = height + 'px';
  }
  redraw();
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
  return removed;
}

function commit(stroke) {
  addStroke(stroke);
  state.history.push({ kind: 'add', stroke });
  state.redo.length = 0;
  sendStroke(stroke);
  showHistory();
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
}

function showHistory() {
  document.getElementById('undo').disabled = state.history.length === 0;
  document.getElementById('redo').disabled = state.redo.length === 0;
}

// ---------------------------------------------------------------------------
// Room

function setRoomState(text, bad) {
  const node = document.getElementById('room-state');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('is-offline', Boolean(bad));
}

function send(data) {
  if (!room.socket || room.socket.readyState !== WebSocket.OPEN) return;
  room.socket.send(JSON.stringify({ v: 1, type: 'app', peerId: PEER, name: 'canvas', data }));
}

function wirePoint(point) {
  return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
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
      symmetry: stroke.symmetry,
      part,
      parts,
      points: stroke.points.slice(part * PART_POINTS, (part + 1) * PART_POINTS).map(wirePoint),
    });
  }
}

function sendRemove(stroke) {
  send({ op: 'remove', id: stroke.id });
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
    symmetry: stroke.symmetry,
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
  if (!['off', 'vertical', 'horizontal', 'quad'].includes(data.symmetry)) return null;
  return {
    id: data.id,
    layer,
    tool: data.tool,
    colour: data.colour,
    size,
    opacity,
    symmetry: data.symmetry,
    points: [],
  };
}

function handle(data) {
  if (!data || typeof data !== 'object') return;

  if (data.op === 'stroke') {
    const stroke = cleanStroke(data);
    if (!stroke) return;
    if (room.seen.has(stroke.id)) return;
    if (!Number.isInteger(data.part) || !Number.isInteger(data.parts) || data.parts < 1) return;
    if (data.part < 0 || data.part >= data.parts) return;

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
        held.points.push({ x: point.x, y: point.y });
      }
    }
    if (data.part === data.parts - 1) {
      room.received.delete(stroke.id);
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
      points.push({ x: point.x, y: point.y });
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
    // strokes it holds, and a stroke id already on the sheet is ignored.
    for (const layer of state.layers) {
      for (const stroke of layer.strokes) sendStroke(stroke);
    }
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
    send({ op: 'sync' });
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
    handle(frame.data);
  });
  socket.addEventListener('close', () => {
    room.socket = null;
    setRoomState('Solo', true);
    clearTimeout(room.retry);
    room.retry = setTimeout(connect, 2000);
  });
  socket.addEventListener('error', () => socket.close());
}

function readPeers() {
  fetch('/status?room=' + encodeURIComponent(ROOM), { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('status'))))
    .then((body) => {
      const peers = Number(body.peers) || 0;
      room.peers = peers;
      setRoomState(peers + (peers === 1 ? ' page in the room' : ' pages in the room'));
    })
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
      symmetry: state.symmetry,
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
  const next = {
    x: last.x + (point.x - last.x) * (1 - pull),
    y: last.y + (point.y - last.y) * (1 - pull),
  };
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
  event.preventDefault();
  viewport.setPointerCapture(event.pointerId);
  const point = toWorld(event);
  startStroke(point);
  if (SHAPES.has(state.preset)) {
    drawing.stroke.points.push(point);
  }
  sendLive(drawing.stroke, true);
  redraw();
});

viewport.addEventListener('pointermove', (event) => {
  const point = toWorld(event);
  const coords = document.getElementById('coords');
  coords.textContent = Math.round(point.x) + ', ' + Math.round(point.y);

  if (panning) {
    view.x = panning.vx + (event.clientX - panning.x);
    view.y = panning.vy + (event.clientY - panning.y);
    redraw();
    return;
  }
  if (!drawing) return;
  if (SHAPES.has(drawing.stroke.tool)) {
    drawing.stroke.points[1] = point;
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

viewport.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const before = { x: (sx - view.x) / view.z, y: (sy - view.y) / view.z };
    view.z = clamp(view.z * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
    view.x = sx - before.x * view.z;
    view.y = sy - before.y * view.z;
    redraw();
    showZoom();
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

document.getElementById('symmetry').addEventListener('change', (event) => {
  state.symmetry = event.target.value;
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
      redraw();
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
  state.history.push({ kind: 'clear', strokes });
  state.redo.length = 0;
  for (const stroke of strokes) sendRemove(stroke);
  redraw();
  showHistory();
});

// The export is what the window shows: the visible world rectangle at twice
// the screen density. The grid stays out of the file, so the drawing is clean.
document.getElementById('export').addEventListener('click', () => {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const out = document.createElement('canvas');
  const scale = 2;
  out.width = Math.max(1, Math.round(width * scale));
  out.height = Math.max(1, Math.round(height * scale));
  // Ink goes on its own layer, so an eraser stroke cuts ink and never the
  // surface. The two layers are joined here.
  const ink = document.createElement('canvas');
  ink.width = out.width;
  ink.height = out.height;
  const target = ink.getContext('2d');
  target.scale(scale, scale);
  target.translate(view.x, view.y);
  target.scale(view.z, view.z);
  paintInk(target, false);
  const outCtx = out.getContext('2d');
  outCtx.fillStyle = SURFACE;
  outCtx.fillRect(0, 0, out.width, out.height);
  outCtx.drawImage(ink, 0, 0);
  out.toBlob((blob) => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'brosr-canvas.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }, 'image/png');
});

document.getElementById('zoom-in').addEventListener('click', () => {
  view.z = clamp(view.z * 1.2, MIN_ZOOM, MAX_ZOOM);
  redraw();
  showZoom();
});

document.getElementById('zoom-out').addEventListener('click', () => {
  view.z = clamp(view.z / 1.2, MIN_ZOOM, MAX_ZOOM);
  redraw();
  showZoom();
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

resize();
fit();
setPreset('pencil');
setColour('#1c1a17');
showLayerState();
showHistory();
connect();
