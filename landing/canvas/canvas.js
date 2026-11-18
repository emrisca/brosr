'use strict';
// Canvas. A paper sheet drawn on one canvas, with a small stroke model so undo,
// layers, the room and a PNG export all read from the same record.

// The sheet is a square. Ink is clipped to it on every pass, so the desk around
// it stays empty no matter where a hand ends up.
const PAPER = { width: 2400, height: 2400 };
const PAPER_COLOUR = '#f7f7f8';

// A brush wider than the old 80 goes a long way toward a usable eraser: at 400
// one pass clears a sixth of the sheet.
const MAX_BRUSH = 400;
// Each layer is a paper-sized bitmap once it holds ink, about 23 MB. Six keeps
// a full stack near 160 MB, which a small laptop still carries.
const MAX_LAYERS = 6;

const PRESETS = {
  pencil: { label: 'Pencil', size: 4, opacity: 1 },
  ink: { label: 'Ink', size: 7, opacity: 1 },
  marker: { label: 'Marker', size: 22, opacity: 0.5 },
  airbrush: { label: 'Airbrush', size: 30, opacity: 0.55 },
  eraser: { label: 'Eraser', size: 60, opacity: 1 },
  line: { label: 'Line', size: 4, opacity: 1 },
  rect: { label: 'Box', size: 4, opacity: 1 },
  ellipse: { label: 'Oval', size: 4, opacity: 1 },
};

const SHAPES = new Set(['line', 'rect', 'ellipse']);

function blankLayer(name) {
  return { name, strokes: [], images: [], visible: true, opacity: 1 };
}

const state = {
  preset: 'pencil',
  colour: '#18181b',
  size: 4,
  opacity: 1,
  stabilizer: 0.35,
  activeLayer: 1,
  // Every tool remembers the width and the opacity the hand last gave it, so
  // an eraser comes back at its own size instead of the pencil's.
  sizes: {},
  opacities: {},
  layers: [blankLayer('Sketch'), blankLayer('Ink')],
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
// The room URL already carries the name the person joined with. Canvas reads it
// first, so the page carries the same name as the room line and the other apps
// in the room instead of asking for it a second time.
const ROOM_NAME = cleanName(new URLSearchParams(location.search).get('name'));
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

// An eraser paints transparent black in destination-out, so it takes ink off
// the layer it sits on and leaves the paper and every lower layer untouched.
function inkColour(stroke) {
  return stroke.tool === 'eraser' ? '#000000' : stroke.colour;
}

function paintShape(g, stroke) {
  const a = stroke.points[0];
  const b = stroke.points[stroke.points.length - 1];
  g.globalAlpha = stroke.opacity;
  g.strokeStyle = inkColour(stroke);
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
  const colour = inkColour(stroke);
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
  const erase = stroke.tool === 'eraser';
  const mode = g.globalCompositeOperation;
  if (erase) g.globalCompositeOperation = 'destination-out';
  if (SHAPES.has(stroke.tool)) paintShape(g, stroke);
  else paintFreehand(g, stroke);
  g.globalAlpha = 1;
  if (erase) g.globalCompositeOperation = mode;
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

// The sheet is flattened into one paper-sized bitmap, so a frame draws one
// image, the line in progress and the pointers no matter how much is on the
// sheet. Each layer also keeps its own bitmap underneath, because an eraser has
// to cut one layer without reaching the paper or the layers below it. A layer
// bitmap is only allocated once the layer holds something.
const ink = document.createElement('canvas');
ink.width = PAPER.width;
ink.height = PAPER.height;
const inkCtx = ink.getContext('2d');
const SHARP_ZOOM = 1.02;
const SHARP_IDLE_MS = 120;
let inkDirty = true;
let sharp = null;
let sharpTimer = 0;

// Replaying a layer builds it from its own record, which is what makes undo
// bring erased ink back: the erase stroke leaves the record, and the layer is
// painted again without it.
function layerContext(layer) {
  if (!layer.canvas) {
    layer.canvas = document.createElement('canvas');
    layer.canvas.width = PAPER.width;
    layer.canvas.height = PAPER.height;
    const target = layer.canvas.getContext('2d');
    for (const stroke of layer.strokes) paintStroke(target, stroke);
  }
  return layer.canvas.getContext('2d');
}

function paintImage(g, item, alpha) {
  const entry = imageFor(item.src);
  if (!entry || !entry.ready) return;
  const layerAlpha = alpha === undefined ? 1 : alpha;
  const itemAlpha = item.opacity === undefined ? 1 : item.opacity;
  g.globalAlpha = layerAlpha * itemAlpha;
  g.drawImage(entry.img, item.x, item.y, item.width, item.height);
  g.globalAlpha = 1;
}

// A stroke on the top visible layer with a fully opaque layer paints straight
// into the flattened bitmap, so a commit costs no rebuild. Anything else marks
// the bitmap, and the next frame re-composites the layer bitmaps.
function canBake(stroke) {
  const layer = state.layers[stroke.layer];
  if (!layer || !layer.visible || stroke.tool === 'eraser') return false;
  if ((layer.opacity === undefined ? 1 : layer.opacity) < 1) return false;
  for (let i = stroke.layer + 1; i < state.layers.length; i += 1) {
    if (state.layers[i].visible) return false;
  }
  return true;
}

// Every visible stroke in one pass, for a caller that wants the model painted
// and not the cached sheet.
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

// The finished picture at paper size. An export and a test read this, so the
// layer order, the layer opacity and the images all land the way the sheet
// shows them.
function paintComposite(g) {
  g.fillStyle = PAPER_COLOUR;
  g.fillRect(0, 0, PAPER.width, PAPER.height);
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    const alpha = layer.opacity === undefined ? 1 : layer.opacity;
    if (layer.canvas || layer.strokes.length) {
      layerContext(layer);
      g.globalAlpha = alpha;
      g.drawImage(layer.canvas, 0, 0);
    }
    for (const item of layer.images) paintImage(g, item, alpha);
    g.globalAlpha = 1;
  }
}

function paintInk() {
  inkCtx.setTransform(1, 0, 0, 1, 0, 0);
  inkCtx.globalAlpha = 1;
  inkCtx.globalCompositeOperation = 'source-over';
  inkCtx.clearRect(0, 0, PAPER.width, PAPER.height);
  inkCtx.fillStyle = PAPER_COLOUR;
  inkCtx.fillRect(0, 0, PAPER.width, PAPER.height);
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    if (!layer.canvas && !layer.strokes.length) continue;
    layerContext(layer);
    const alpha = layer.opacity === undefined ? 1 : layer.opacity;
    inkCtx.globalAlpha = alpha;
    inkCtx.drawImage(layer.canvas, 0, 0);
    for (const item of layer.images) {
      if (item.animated) continue;
      paintImage(inkCtx, item, alpha);
    }
    inkCtx.globalAlpha = 1;
  }
  inkDirty = false;
}

// `applied` says the live eraser already cut this layer while the hand moved,
// so the stroke only needs the flattened bitmap rebuilt.
function addToInk(stroke, applied) {
  const layer = state.layers[stroke.layer];
  if (!layer) return;
  if (applied) {
    markInk();
    return;
  }
  const target = layerContext(layer);
  paintStroke(target, stroke);
  if (inkDirty || !canBake(stroke)) {
    markInk();
    return;
  }
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

// The eraser cuts the layer as the hand moves, so the erase is visible before
// the pointer lifts. The record keeps the stroke, and a rebuild cuts the same
// ink again.
function eraseLive(stroke, from) {
  const layer = state.layers[stroke.layer];
  if (!layer) return;
  const target = layerContext(layer);
  const start = Math.max(0, (from || 1) - 1);
  const slice = { ...stroke, points: stroke.points.slice(start) };
  target.save();
  target.beginPath();
  target.rect(0, 0, PAPER.width, PAPER.height);
  target.clip();
  paintStroke(target, slice);
  target.restore();
  markInk();
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
  // A GIF only animates while it is drawn from its own image element, so an
  // animated item rides on top of the flattened sheet at every frame instead of
  // being baked into it.
  for (const layer of state.layers) {
    if (!layer.visible) continue;
    for (const item of layer.images) {
      if (!item.animated) continue;
      paintImage(g, item, layer.opacity === undefined ? 1 : layer.opacity);
    }
  }
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
  paintCursor(ctx);
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

// A ring the size of the brush follows the hand. It is the only way to judge a
// 300-wide eraser before it lands, and it keeps the sheet readable because the
// ring is drawn in paper units and stays one screen width at every zoom.
function paintCursor(g) {
  if (!pointer || drawing || panning || spaceDown) return;
  if (!onPaperPoint(pointer)) return;
  const radius = Math.max(2, state.size / 2);
  g.save();
  g.beginPath();
  g.arc(pointer.x, pointer.y, radius, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  g.lineWidth = 2 / view.z;
  g.stroke();
  g.beginPath();
  g.arc(pointer.x, pointer.y, Math.max(1, radius - 1.5 / view.z), 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  g.lineWidth = 1.2 / view.z;
  g.stroke();
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

function addStroke(stroke, applied) {
  const before = state.layers.length;
  const layer = ensureLayer(stroke.layer);
  if (!layer) return;
  // The layer bitmap is built from the strokes it already holds, so the new one
  // is pushed after the build and never painted twice.
  layerContext(layer);
  layer.strokes.push(stroke);
  room.seen.add(stroke.id);
  addToInk(stroke, applied);
  if (state.layers.length !== before) renderLayers();
}

function removeById(id) {
  let removed = false;
  for (const layer of state.layers) {
    const index = layer.strokes.findIndex((stroke) => stroke.id === id);
    if (index >= 0) {
      layer.strokes.splice(index, 1);
      // The layer bitmap still holds the stroke that just left, so it is
      // replayed from the record on the next paint.
      layer.canvas = null;
      removed = true;
    }
  }
  if (removed) markInk();
  return removed;
}

function commit(stroke, applied) {
  addStroke(stroke, applied);
  state.history.push({ kind: 'add', stroke });
  state.redo.length = 0;
  sendStroke(stroke);
  showHistory();
  touchDocument();
}

// Only this page's own work belongs in the undo stack. A remote frame lands
// without a history entry, and this guard keeps a stray one from being undone
// here: undo takes back my drawings, never another person's.
function localOp(stack) {
  while (stack.length) {
    const op = stack[stack.length - 1];
    const owner = op.kind === 'add' ? op.stroke.owner : op.kind === 'image' ? op.item.owner : PEER;
    if (owner === PEER) return op;
    stack.pop();
  }
  return null;
}

function undo() {
  const op = localOp(state.history);
  if (!op) return;
  state.history.pop();
  if (op.kind === 'add') {
    removeById(op.stroke.id);
    sendRemove(op.stroke);
    state.redo.push(op);
  } else if (op.kind === 'image') {
    removeImageById(op.item.id);
    state.redo.push(op);
  } else {
    for (const stroke of op.strokes) {
      if (!state.layers[stroke.layer]) continue;
      addStroke(stroke);
      sendStroke(stroke);
    }
    for (const entry of op.images || []) {
      if (!state.layers[entry.layer]) continue;
      storeImageItem(entry.layer, entry.item);
      sendImageItem(entry.layer, entry.item);
    }
    state.redo.push({ kind: 'clear', strokes: op.strokes.slice(), images: (op.images || []).slice() });
  }
  redraw();
  renderImages();
  showHistory();
  touchDocument();
}

function redo() {
  const op = localOp(state.redo);
  if (!op) return;
  state.redo.pop();
  if (op.kind === 'add') {
    addStroke(op.stroke);
    sendStroke(op.stroke);
    state.history.push(op);
  } else if (op.kind === 'image') {
    storeImageItem(op.layer, op.item);
    sendImageItem(op.layer, op.item);
    state.history.push(op);
  } else {
    for (const stroke of op.strokes) {
      removeById(stroke.id);
      sendRemove(stroke);
    }
    for (const entry of op.images || []) removeImageById(entry.item.id);
    state.history.push(op);
  }
  redraw();
  renderImages();
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

function docImages() {
  return state.layers.reduce((sum, layer) => sum + layer.images.length, 0);
}

// A row says what is on the sheet. An image counts beside the strokes, because
// a canvas of two photos would otherwise read as empty.
function docPreview() {
  const strokes = docStrokes();
  const images = docImages();
  const parts = [strokes === 1 ? '1 stroke' : strokes + ' strokes'];
  if (images) parts.push(images === 1 ? '1 image' : images + ' images');
  return parts.join(', ');
}

function emptyBody() {
  return {
    layers: state.layers.map((layer) => ({
      name: layer.name,
      visible: true,
      opacity: 1,
      strokes: [],
      images: [],
    })),
    activeLayer: 1,
  };
}

function docBody() {
  return {
    layers: state.layers.map((layer) => ({
      name: layer.name,
      visible: layer.visible !== false,
      opacity: layer.opacity === undefined ? 1 : layer.opacity,
      strokes: layer.strokes,
      images: layer.images.map((item) => ({ ...item })),
    })),
    activeLayer: state.activeLayer,
  };
}

// A document swap clears the sheet and every record that would let an old
// stroke answer for the new canvas.
function resetDocument() {
  for (const layer of state.layers) {
    layer.strokes = [];
    layer.images = [];
    layer.canvas = null;
  }
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
  // The stored stack decides the stack. A document from the old two-layer app
  // still opens, and one with images and opacity keeps both.
  const count = clamp(layers.length || 2, 2, MAX_LAYERS);
  const next = [];
  for (let index = 0; index < count; index += 1) {
    const source = layers[index] || {};
    const name =
      typeof source.name === 'string' && source.name
        ? source.name.slice(0, 20)
        : 'Layer ' + (index + 1);
    const layer = blankLayer(name);
    layer.visible = source.visible !== false;
    layer.opacity = clamp(Number(source.opacity) || 1, 0.05, 1);
    if (Array.isArray(source.strokes)) {
      for (const raw of source.strokes) {
        const stroke = storedStroke(raw, index);
        if (stroke) layer.strokes.push(stroke);
      }
    }
    if (Array.isArray(source.images)) {
      for (const raw of source.images) {
        const item = storedImage(raw);
        if (item) layer.images.push(item);
      }
    }
    next.push(layer);
  }
  state.layers = next;
  state.activeLayer = clamp(
    Number(doc.body && doc.body.activeLayer) || 0,
    0,
    state.layers.length - 1
  );
  markInk();
  redraw();
  renderLayers();
  renderImages();
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
      shortDate(item.at) + ', ' + (item.preview || 'empty') + (item.hidden ? ', hidden' : '');
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
    // A canvas that outgrows the store still lives in the room, and the status
    // line says why the list did not move.
    note('This canvas is too big to store on the host. It stays in the room.');
    return;
  }
  const preview = docPreview();
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
// Layers, images and colour

const layerListEl = document.getElementById('layers');
const layerCountEl = document.getElementById('layer-count');
const layerOpacityInput = document.getElementById('layer-opacity');
const layerOpacityOut = document.getElementById('layer-opacity-out');
let noteTimer = 0;
let picking = false;

// One line in the footer says why a thing did not happen, so a refusal never
// looks like a broken button.
function note(text) {
  const node = document.getElementById('note');
  if (!node) return;
  node.textContent = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    node.textContent = '';
  }, 6000);
}

function layerLabel(index) {
  return 'Layer ' + (index + 1);
}

function cleanLayerName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

function ensureLayer(index) {
  while (state.layers.length <= index && state.layers.length < MAX_LAYERS) {
    state.layers.push(blankLayer(layerLabel(state.layers.length)));
  }
  return state.layers[index] || null;
}

function sendLayers() {
  send({
    op: 'layers',
    layers: state.layers.map((layer) => ({
      name: layer.name,
      visible: layer.visible !== false,
      opacity: layer.opacity === undefined ? 1 : layer.opacity,
    })),
  });
}

function sendLayerOp(data) {
  send({ op: 'layer', ...data });
}

function addLayer() {
  if (state.layers.length >= MAX_LAYERS) {
    note('Six layers is the limit on a sheet this size.');
    return null;
  }
  const index = state.layers.length;
  const layer = blankLayer(layerLabel(index));
  state.layers.push(layer);
  state.activeLayer = index;
  markInk();
  redraw();
  renderLayers();
  touchDocument();
  sendLayerOp({ kind: 'add', index, name: layer.name });
  return layer;
}

function removeLayer(index) {
  if (state.layers.length <= 1) {
    note('A sheet keeps at least one layer.');
    return;
  }
  if (!state.layers[index]) return;
  state.layers.splice(index, 1);
  if (state.activeLayer > index) state.activeLayer -= 1;
  if (state.activeLayer >= state.layers.length) state.activeLayer = state.layers.length - 1;
  markInk();
  redraw();
  renderLayers();
  touchDocument();
  sendLayerOp({ kind: 'remove', index });
}

function moveLayer(from, to) {
  if (from === to) return;
  if (from < 0 || to < 0 || from >= state.layers.length || to >= state.layers.length) return;
  const [layer] = state.layers.splice(from, 1);
  state.layers.splice(to, 0, layer);
  if (state.activeLayer === from) state.activeLayer = to;
  else if (from < state.activeLayer && to >= state.activeLayer) state.activeLayer -= 1;
  else if (from > state.activeLayer && to <= state.activeLayer) state.activeLayer += 1;
  markInk();
  redraw();
  renderLayers();
  touchDocument();
  sendLayerOp({ kind: 'move', from, to });
}

function renameLayer(index, name) {
  const layer = state.layers[index];
  if (!layer) return;
  layer.name = cleanLayerName(name) || layerLabel(index);
  renderLayers();
  touchDocument();
  sendLayerOp({ kind: 'rename', index, name: layer.name });
}

function setLayerVisible(index, visible) {
  const layer = state.layers[index];
  if (!layer) return;
  layer.visible = Boolean(visible);
  markInk();
  redraw();
  renderLayers();
  touchDocument();
  sendLayerOp({ kind: 'visible', index, value: layer.visible });
}

function setLayerOpacity(index, value) {
  const layer = state.layers[index];
  if (!layer) return;
  layer.opacity = clamp(Number(value) || 1, 0.05, 1);
  markInk();
  redraw();
  if (layerOpacityOut) layerOpacityOut.textContent = Math.round(layer.opacity * 100) + '%';
  const row = layerListEl
    ? layerListEl.querySelector('.layer[data-layer="' + index + '"] .layer-meta')
    : null;
  if (row) row.textContent = Math.round(layer.opacity * 100) + '%';
  touchDocument();
  sendLayerOp({ kind: 'opacity', index, value: layer.opacity });
}

function clearLayer(index) {
  const layer = state.layers[index];
  if (!layer) return;
  const strokes = layer.strokes.filter((stroke) => stroke.owner === PEER);
  const images = layer.images.filter((item) => item.owner === PEER);
  if (!strokes.length && !images.length) {
    note('Only your own ink clears on a shared sheet.');
    return;
  }
  layer.strokes = layer.strokes.filter((stroke) => stroke.owner !== PEER);
  layer.images = layer.images.filter((item) => item.owner !== PEER);
  layer.canvas = null;
  for (const stroke of strokes) sendRemove(stroke);
  for (const item of images) send({ op: 'image-remove', id: item.id });
  state.history.push({
    kind: 'clear',
    strokes,
    images: images.map((item) => ({ layer: index, item })),
  });
  state.redo.length = 0;
  markInk();
  redraw();
  renderLayers();
  showHistory();
  touchDocument();
  sendLayerOp({ kind: 'clear', index });
}

// A layer op from the wire makes the same change without sending it back, so
// two pages never answer each other in a loop.
function applyLayerOp(data, from) {
  if (!data || typeof data !== 'object') return;
  const index = Number(data.index);
  if (data.kind === 'add') {
    if (!Number.isInteger(index) || index < 0 || index > state.layers.length) return;
    if (index >= MAX_LAYERS) return;
    if (state.layers.length >= MAX_LAYERS && index >= state.layers.length) return;
    const layer = index === state.layers.length ? ensureLayer(index) : state.layers[index];
    if (!layer) return;
    layer.name = cleanLayerName(data.name) || layerLabel(index);
    markInk();
    redraw();
    renderLayers();
    return;
  }
  if (data.kind === 'remove') {
    if (!Number.isInteger(index) || !state.layers[index] || state.layers.length <= 1) return;
    state.layers.splice(index, 1);
    if (state.activeLayer > index) state.activeLayer -= 1;
    if (state.activeLayer >= state.layers.length) state.activeLayer = state.layers.length - 1;
    markInk();
    redraw();
    renderLayers();
    return;
  }
  if (!Number.isInteger(index) || !state.layers[index]) return;
  const layer = state.layers[index];
  if (data.kind === 'rename') {
    layer.name = cleanLayerName(data.name) || layerLabel(index);
    renderLayers();
    return;
  }
  if (data.kind === 'visible') {
    layer.visible = data.value !== false;
    markInk();
    redraw();
    renderLayers();
    return;
  }
  if (data.kind === 'opacity') {
    layer.opacity = clamp(Number(data.value) || 1, 0.05, 1);
    markInk();
    redraw();
    renderLayers();
    return;
  }
  if (data.kind === 'move') {
    const to = Number(data.to);
    if (!Number.isInteger(to) || to < 0 || to >= state.layers.length) return;
    const [moved] = state.layers.splice(index, 1);
    state.layers.splice(to, 0, moved);
    if (state.activeLayer === index) state.activeLayer = to;
    else if (index < state.activeLayer && to >= state.activeLayer) state.activeLayer -= 1;
    else if (index > state.activeLayer && to <= state.activeLayer) state.activeLayer += 1;
    markInk();
    redraw();
    renderLayers();
    return;
  }
  if (data.kind === 'clear') {
    // A peer's clear takes that peer's work and leaves the rest of the sheet.
    layer.strokes = layer.strokes.filter((stroke) => stroke.owner !== from);
    layer.images = layer.images.filter((item) => item.owner !== from);
    layer.canvas = null;
    markInk();
    redraw();
    renderLayers();
  }
}

function startRename(index, holder) {
  const layer = state.layers[index];
  if (!layer || !holder) return;
  const input = document.createElement('input');
  input.className = 'layer-rename';
  input.type = 'text';
  input.maxLength = 20;
  input.value = layer.name;
  holder.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) renameLayer(index, input.value);
    else renderLayers();
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function renderLayers() {
  if (!layerListEl) return;
  layerListEl.textContent = '';
  // The top of the stack reads first, the way a layer list does elsewhere.
  for (let index = state.layers.length - 1; index >= 0; index -= 1) {
    const layer = state.layers[index];
    const row = document.createElement('div');
    row.className = 'layer';
    row.dataset.layer = String(index);
    if (index === state.activeLayer) row.classList.add('is-active');

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'layer-pick';
    pick.dataset.layer = String(index);
    pick.setAttribute('aria-pressed', String(index === state.activeLayer));
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;
    name.title = 'Double click to rename this layer';
    const meta = document.createElement('span');
    meta.className = 'layer-meta';
    meta.textContent = Math.round((layer.opacity === undefined ? 1 : layer.opacity) * 100) + '%';
    pick.append(name, meta);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'layer-toggle';
    eye.dataset.visible = String(index);
    eye.textContent = layer.visible ? 'Show' : 'Hidden';
    eye.title = layer.visible ? 'Hide this layer' : 'Show this layer';

    row.append(pick, eye);
    layerListEl.append(row);

    pick.addEventListener('click', () => {
      state.activeLayer = index;
      renderLayers();
    });
    name.addEventListener('dblclick', (event) => {
      event.preventDefault();
      startRename(index, pick);
    });
    eye.addEventListener('click', () => setLayerVisible(index, !layer.visible));
  }
  if (layerCountEl) layerCountEl.textContent = state.layers.length + '/' + MAX_LAYERS;
  syncLayerControls();
}

function syncLayerControls() {
  const layer = state.layers[state.activeLayer];
  if (!layer) return;
  const opacity = layer.opacity === undefined ? 1 : layer.opacity;
  if (layerOpacityInput) layerOpacityInput.value = String(Math.round(opacity * 100));
  if (layerOpacityOut) layerOpacityOut.textContent = Math.round(opacity * 100) + '%';
  renderImages();
}

// ---------------------------------------------------------------------------
// Images

const IMAGE_MAX_BYTES = 1.6 * 1024 * 1024;
const IMAGE_MAX_SIDE = 1600;
const imageCache = new Map();
let imageCount = 0;

function nextImageId() {
  imageCount += 1;
  return PEER + '-img' + imageCount;
}

function imageFor(src) {
  let entry = imageCache.get(src);
  if (entry) return entry;
  entry = { img: new Image(), ready: false, failed: false };
  entry.img.addEventListener('load', () => {
    entry.ready = true;
    markInk();
    redraw();
    renderImages();
  });
  entry.img.addEventListener('error', () => {
    entry.failed = true;
    renderImages();
  });
  entry.img.src = src;
  imageCache.set(src, entry);
  return entry;
}

function isAnimatedSrc(src) {
  return /^data:image\/gif;/i.test(String(src || ''));
}

function cleanWireImage(data) {
  const owner = cleanOwner(data && data.owner);
  if (!data || typeof data.id !== 'string' || !data.id || data.id.length > 80) return null;
  const src = typeof data.src === 'string' ? data.src : '';
  if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) return null;
  if (src.length > IMAGE_MAX_BYTES * 1.8) return null;
  const numbers = [data.x, data.y, data.width, data.height].map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const [x, y, width, height] = numbers;
  if (width <= 0 || height <= 0) return null;
  if (room.seen.has(data.id)) return null;
  const item = {
    id: data.id,
    src,
    x: clamp(x, 0, PAPER.width),
    y: clamp(y, 0, PAPER.height),
    width: clamp(width, 1, PAPER.width),
    height: clamp(height, 1, PAPER.height),
    opacity: clamp(Number(data.opacity) || 1, 0.05, 1),
    owner: owner,
    animated: data.animated === true || isAnimatedSrc(src),
  };
  room.seen.add(item.id);
  return item;
}

function storedImage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return cleanWireImage(raw);
}

function sendImageItem(layerIndex, item) {
  send({
    op: 'image',
    layer: layerIndex,
    id: item.id,
    src: item.src,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    opacity: item.opacity,
    owner: item.owner || PEER,
    animated: item.animated === true,
  });
}

function storeImageItem(layerIndex, item) {
  if (!item) return null;
  const layer = ensureLayer(layerIndex);
  if (!layer) return null;
  if (layer.images.some((held) => held.id === item.id)) return null;
  layer.images.push(item);
  imageFor(item.src);
  markInk();
  redraw();
  renderImages();
  return item;
}

function placeImageItem(layerIndex, item) {
  if (!storeImageItem(layerIndex, item)) return null;
  state.history.push({ kind: 'image', layer: layerIndex, item });
  state.redo.length = 0;
  showHistory();
  sendImageItem(layerIndex, item);
  touchDocument();
  return item;
}

function removeImageById(id, fromRoom) {
  let removed = false;
  for (const layer of state.layers) {
    const at = layer.images.findIndex((item) => item.id === id);
    if (at < 0) continue;
    layer.images.splice(at, 1);
    removed = true;
  }
  if (!removed) return false;
  markInk();
  redraw();
  renderImages();
  touchDocument();
  if (!fromRoom) send({ op: 'image-remove', id });
  return true;
}

function renderImages() {
  const list = document.getElementById('image-list');
  if (!list) return;
  list.textContent = '';
  const layer = state.layers[state.activeLayer];
  if (!layer || !layer.images.length) {
    const empty = document.createElement('li');
    empty.className = 'image-empty';
    empty.textContent = 'No image on this layer.';
    list.append(empty);
    return;
  }
  for (const item of layer.images) {
    const row = document.createElement('li');
    row.className = 'image-row';
    const thumb = document.createElement('img');
    thumb.src = item.src;
    thumb.alt = '';
    thumb.className = 'image-thumb';
    const size = document.createElement('span');
    size.className = 'image-size';
    size.textContent = Math.round(item.width) + ' x ' + Math.round(item.height);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'doc-tool';
    del.textContent = 'Remove';
    del.addEventListener('click', () => removeImageById(item.id));
    row.append(thumb, size);
    // A peer's picture can be seen here, but only its author takes it away.
    if (item.owner === PEER) row.append(del);
    list.append(row);
  }
}

// A new image lands in the middle of the view at no more than 60% of the
// paper, so a phone photo arrives as something a person can see at once.
function fitBox(width, height) {
  const maxSide = Math.min(PAPER.width, PAPER.height) * 0.6;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const box = { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
  const centre = viewCentre();
  box.x = clamp(centre.x - box.width / 2, 0, PAPER.width - box.width);
  box.y = clamp(centre.y - box.height / 2, 0, PAPER.height - box.height);
  return box;
}

function viewCentre() {
  const rect = viewport.getBoundingClientRect();
  const point = toWorld({
    clientX: rect.left + viewport.clientWidth / 2,
    clientY: rect.top + viewport.clientHeight / 2,
  });
  return { x: clamp(point.x, 0, PAPER.width), y: clamp(point.y, 0, PAPER.height) };
}

// A large photo is scaled down before it becomes a data URL, so the sheet, the
// room frame and the stored document all stay inside their budgets.
function prepareImage(src, type) {
  const entry = imageFor(src);
  return new Promise((resolve) => {
    const run = () => {
      if (entry.failed) {
        resolve('');
        return;
      }
      if (!entry.ready) return;
      if (isAnimatedSrc(src)) {
        resolve(src.length > IMAGE_MAX_BYTES * 1.2 ? '' : src);
        return;
      }
      const longest = Math.max(entry.img.naturalWidth, entry.img.naturalHeight);
      if (!longest) {
        resolve('');
        return;
      }
      if (src.length <= IMAGE_MAX_BYTES && longest <= IMAGE_MAX_SIDE) {
        resolve(src);
        return;
      }
      const scale = Math.min(1, IMAGE_MAX_SIDE / longest);
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(entry.img.naturalWidth * scale));
      out.height = Math.max(1, Math.round(entry.img.naturalHeight * scale));
      out.getContext('2d').drawImage(entry.img, 0, 0, out.width, out.height);
      resolve(out.toDataURL(type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86));
    };
    entry.img.addEventListener('load', run);
    run();
  });
}

function insertImageSource(src, label) {
  if (!/^data:image\//i.test(String(src || ''))) {
    note('Only an image can land on the sheet.');
    return Promise.resolve(null);
  }
  if (src.length > IMAGE_MAX_BYTES * 1.5) {
    note('That image is too large to store. Keep it under ' + Math.round(IMAGE_MAX_BYTES / 1048576) + ' MB.');
    return Promise.resolve(null);
  }
  const entry = imageFor(src);
  return new Promise((resolve) => {
    const settle = () => {
      if (entry.failed) {
        note('That image did not decode.');
        resolve(null);
        return;
      }
      if (!entry.ready) return;
      entry.img.removeEventListener('load', settle);
      const natural = {
        width: entry.img.naturalWidth || 1,
        height: entry.img.naturalHeight || 1,
      };
      const box = fitBox(natural.width, natural.height);
      const item = {
        id: nextImageId(),
        src,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        opacity: 1,
        owner: PEER,
        animated: isAnimatedSrc(src),
      };
      placeImageItem(state.activeLayer, item);
      const where = state.layers[state.activeLayer];
      note((label || 'Image') + ' landed on ' + ((where && where.name) || 'the layer') + '.');
      resolve(item);
    };
    entry.img.addEventListener('load', settle);
    settle();
  });
}

function readImageFile(file) {
  if (!file) return Promise.resolve(null);
  if (!/^image\//.test(file.type || '')) {
    note('That file is not an image.');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  }).then((src) => {
    if (!src) {
      note('That file could not be read.');
      return null;
    }
    return prepareImage(src, file.type).then((ready) => {
      if (!ready) {
        note('That image is too large to store. Keep it under ' + Math.round(IMAGE_MAX_BYTES / 1048576) + ' MB.');
        return null;
      }
      return insertImageSource(ready, file.name);
    });
  });
}

// ---------------------------------------------------------------------------
// GIF search

const GIF_KEY = 'brosr.canvas.tenor';
// The key Tenor publishes for demos. It carries light use, and a person who
// searches a lot can put a registered key in the field and it wins.
const GIF_DEMO_KEY = 'LIVDSRZULELA';

function gifKey() {
  try {
    return localStorage.getItem(GIF_KEY) || GIF_DEMO_KEY;
  } catch {
    return GIF_DEMO_KEY;
  }
}

function setGifStatus(text, busy) {
  const node = document.getElementById('gif-status');
  if (!node) return;
  node.textContent = text;
  if (busy) node.dataset.busy = 'true';
  else delete node.dataset.busy;
}

function openGif() {
  const dialog = document.getElementById('gif-dialog');
  if (!dialog) return;
  dialog.hidden = false;
  const key = document.getElementById('gif-key');
  if (key) key.value = gifKey() === GIF_DEMO_KEY ? '' : gifKey();
  const query = document.getElementById('gif-query');
  if (query) query.focus();
}

function closeGif() {
  const dialog = document.getElementById('gif-dialog');
  if (dialog) dialog.hidden = true;
}

async function chooseGif(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    setGifStatus('That is not a GIF address.');
    return;
  }
  setGifStatus('Fetching that GIF...');
  try {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error('status ' + response.status);
    const blob = await response.blob();
    if (blob.size > IMAGE_MAX_BYTES) {
      setGifStatus(
        'That GIF is ' + (blob.size / 1048576).toFixed(1) + ' MB and will not store. Pick a smaller one.'
      );
      return;
    }
    const src = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
    if (!src) throw new Error('read');
    const item = await insertImageSource(src, 'GIF');
    if (item) {
      closeGif();
      setGifStatus('');
    } else {
      setGifStatus('That GIF could not be placed.');
    }
  } catch (error) {
    setGifStatus(
      'That host refused the copy (' +
        (error && error.message ? error.message : 'network') +
        '). Paste a direct GIF address below instead.'
    );
  }
}

async function searchGifs() {
  const query = document.getElementById('gif-query');
  const results = document.getElementById('gif-results');
  if (!query || !results) return;
  const text = query.value.trim();
  if (!text) {
    setGifStatus('Type what the GIF should show.');
    return;
  }
  // A search is a grid of tiles that have not arrived yet, not a line of text
  // where the pictures will be.
  results.textContent = '';
  results.setAttribute('aria-busy', 'true');
  for (let i = 0; i < 12; i += 1) {
    const tile = document.createElement('div');
    tile.className = 'gif-skeleton';
    tile.setAttribute('aria-hidden', 'true');
    results.append(tile);
  }
  setGifStatus('Searching Tenor.', true);
  const url =
    'https://g.tenor.com/v1/search?q=' +
    encodeURIComponent(text) +
    '&key=' +
    encodeURIComponent(gifKey()) +
    '&limit=24&media_filter=minimal&contentfilter=high';
  let data = null;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('status ' + response.status);
    data = await response.json();
  } catch (error) {
    results.textContent = '';
    results.removeAttribute('aria-busy');
    setGifStatus(
      'Tenor did not answer (' +
        (error && error.message ? error.message : 'network') +
        '). A registered key may fix it.'
    );
    return;
  }
  results.textContent = '';
  results.removeAttribute('aria-busy');
  const hits = Array.isArray(data && data.results) ? data.results : [];
  if (!hits.length) {
    setGifStatus('No GIF for "' + text + '".');
    return;
  }
  let shown = 0;
  for (const hit of hits) {
    const media = hit && Array.isArray(hit.media) ? hit.media[0] : null;
    const full = media && media.gif ? media.gif.url : '';
    const thumb = media && media.tinygif ? media.tinygif.url : full;
    if (!full) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gif-item';
    const img = document.createElement('img');
    img.src = thumb;
    img.alt = hit.content_description || 'GIF';
    img.loading = 'lazy';
    button.append(img);
    button.addEventListener('click', () => chooseGif(full));
    results.append(button);
    shown += 1;
  }
  setGifStatus(shown ? shown + ' results. Click one to place it.' : 'No GIF for "' + text + '".');
}

// ---------------------------------------------------------------------------
// Colour extras

const RECENT_KEY = 'brosr.canvas.recent';
const MAX_RECENT = 8;

function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((value) => /^#[0-9a-f]{6}$/i.test(value)).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function renderRecent(list) {
  const holder = document.getElementById('recents');
  if (!holder) return;
  holder.textContent = '';
  for (const colour of list || readRecent()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-swatch';
    button.style.setProperty('--c', colour);
    button.title = colour;
    button.setAttribute('aria-label', 'Recent colour ' + colour);
    button.addEventListener('click', () => setColour(colour, true));
    holder.append(button);
  }
}

function rememberColour(colour) {
  const list = [colour]
    .concat(readRecent().filter((value) => value.toLowerCase() !== colour.toLowerCase()))
    .slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // A private window can refuse storage, and the swatch still works.
  }
  renderRecent(list);
}

// The browser eyedropper is exact and leaves the page alone. Without it, the
// next press on the sheet reads the flattened paper pixel under the hand.
function startPick() {
  if (typeof window.EyeDropper === 'function') {
    new window.EyeDropper()
      .open()
      .then((result) => setColour(result.sRGBHex, true))
      .catch(() => {});
    return;
  }
  picking = true;
  viewport.classList.add('picking');
  note('Click the sheet to take its colour.');
}

function sampleAt(point) {
  if (inkDirty) paintInk();
  const x = Math.round(clamp(point.x, 0, PAPER.width - 1));
  const y = Math.round(clamp(point.y, 0, PAPER.height - 1));
  const pixel = inkCtx.getImageData(x, y, 1, 1).data;
  return (
    '#' +
    [pixel[0], pixel[1], pixel[2]]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
  );
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
  setRoomState(pages + ', ' + strokeTotal() + ' strokes, ' + who);
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
      owner: stroke.owner || PEER,
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
  state.layers.forEach((layer, index) => {
    for (const stroke of layer.strokes) sendStroke(stroke);
    for (const item of layer.images) sendImageItem(index, item);
  });
  sendLayers();
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
function cleanOwner(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(value) ? value : '';
}

// A stroke belongs to the page that drew it. Undo and clear ask this before
// they touch anything, so a peer's ink is never in this page's history.
function ownStroke(stroke) {
  return Boolean(stroke && stroke.owner === PEER);
}

function cleanStroke(data) {
  if (!data || typeof data.id !== 'string' || !data.id || data.id.length > 80) return null;
  const layer = Number(data.layer);
  if (!Number.isInteger(layer) || layer < 0 || layer >= MAX_LAYERS) return null;
  if (!PRESETS[data.tool]) return null;
  if (typeof data.colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.colour)) return null;
  const size = Number(data.size);
  const opacity = Number(data.opacity);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BRUSH) return null;
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) return null;
  return {
    id: data.id,
    layer,
    tool: data.tool,
    colour: data.colour,
    size,
    opacity,
    owner: cleanOwner(data.owner),
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

  if (data.op === 'layers' && Array.isArray(data.layers)) {
    // The stack is positional, so the sender's list is the truth. A page that
    // just joined takes the room's count, names and opacity.
    const wanted = clamp(data.layers.length, 1, MAX_LAYERS);
    while (state.layers.length > wanted) state.layers.pop();
    while (state.layers.length < wanted) {
      state.layers.push(blankLayer(layerLabel(state.layers.length)));
    }
    state.layers.forEach((layer, index) => {
      const source = data.layers[index];
      if (!source || typeof source !== 'object') return;
      layer.name = cleanLayerName(source.name) || layerLabel(index);
      layer.visible = source.visible !== false;
      layer.opacity = clamp(Number(source.opacity) || 1, 0.05, 1);
    });
    if (state.activeLayer >= state.layers.length) state.activeLayer = state.layers.length - 1;
    markInk();
    redraw();
    renderLayers();
    return;
  }

  if (data.op === 'layer') {
    applyLayerOp(data, from);
    return;
  }

  if (data.op === 'image') {
    const index = Number(data.layer);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_LAYERS) return;
    const item = cleanWireImage(data);
    if (!item) return;
    if (!item.owner) item.owner = cleanOwner(from);
    storeImageItem(index, item);
    return;
  }

  if (data.op === 'image-remove' && typeof data.id === 'string') {
    removeImageById(data.id, true);
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
    // A frame that names no author belongs to the page that sent it.
    if (!stroke.owner) stroke.owner = cleanOwner(from);
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
    if (!stroke.owner) stroke.owner = cleanOwner(from);
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
    // Images and the layer stack travel the same way, so a joiner opens a
    // sheet that matches the room and not an empty two-layer default.
    state.layers.forEach((layer, index) => {
      for (const item of layer.images) sendImageItem(index, item);
    });
    sendLayers();
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
      owner: PEER,
      tool: state.preset,
      colour: state.colour,
      size: state.size,
      opacity: state.opacity,
      layer: state.activeLayer,
      points: [point],
    },
    last: point,
    // How many points the live eraser has already cut into the layer.
    painted: 1,
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
  if (stroke.tool === 'eraser') {
    eraseLive(stroke, drawing.painted);
    drawing.painted = stroke.points.length;
  }
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
  if (picking) {
    picking = false;
    viewport.classList.remove('picking');
    setColour(sampleAt(point), true);
    note('Took ' + state.colour + ' from the sheet.');
    return;
  }
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
  // An eraser already cut the layer while the hand moved, so the commit only
  // records the stroke and lets the next frame rebuild the flattened sheet.
  if (stroke.points.length > 1) commit(stroke, stroke.tool === 'eraser');
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

// A trackpad sends fractional deltas on two axes, so two fingers scroll. A
// wheel sends whole notches on one axis, and a pinch arrives as ctrl plus a
// wheel, so both of those still zoom. Chrome turns a small synthetic delta
// into a -120 wheelDeltaY, so the delta itself has to be read first.
function trackpadScroll(event) {
  if (event.ctrlKey || event.deltaMode !== 0) return false;
  if (event.deltaX % 1 !== 0 || event.deltaY % 1 !== 0) return true;
  if (Math.abs(event.deltaX) > 0) return true;
  if (typeof event.wheelDeltaY === 'number' && event.wheelDeltaY !== 0) {
    return Math.abs(event.wheelDeltaY) % 120 !== 0;
  }
  return false;
}

viewport.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    if (trackpadScroll(event)) {
      // The sheet follows the fingers, so a scroll down moves the paper up.
      view.x -= event.deltaX;
      view.y -= event.deltaY;
      fitted = false;
      redraw();
      refreshPointer(true);
      return;
    }
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
  const preset = PRESETS[name] || PRESETS.pencil;
  // Each tool remembers the width and the opacity the hand last gave it, so an
  // eraser comes back at its own size instead of the pencil's.
  if (PRESETS[state.preset]) {
    state.sizes[state.preset] = state.size;
    state.opacities[state.preset] = state.opacity;
  }
  state.preset = PRESETS[name] ? name : 'pencil';
  state.size = state.sizes[name] === undefined ? preset.size : state.sizes[name];
  state.opacity = state.opacities[name] === undefined ? preset.opacity : state.opacities[name];
  for (const button of document.querySelectorAll('.brush')) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === state.preset));
  }
  document.getElementById('size').value = String(Math.round(state.size));
  document.getElementById('opacity').value = String(Math.round(state.opacity * 100));
  document.getElementById('size-out').textContent = String(Math.round(state.size));
  document.getElementById('opacity-out').textContent = Math.round(state.opacity * 100) + '%';
  document.getElementById('tool-state').textContent = preset.label;
  if (picking) {
    picking = false;
    viewport.classList.remove('picking');
  }
}

function cleanColour(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : '';
}

function setColour(colour, remember) {
  const clean = cleanColour(colour) || '#18181b';
  state.colour = clean;
  const picker = document.getElementById('colour');
  if (picker && picker.value.toLowerCase() !== clean) picker.value = clean;
  const hex = document.getElementById('hex');
  if (hex && hex.value.toLowerCase() !== clean) hex.value = clean;
  for (const button of document.querySelectorAll('.swatch')) {
    button.setAttribute('aria-pressed', String(button.dataset.color.toLowerCase() === clean));
  }
  if (remember) rememberColour(clean);
}

// The rail and the stage switch between one dark set and one light set of the
// same roles. The paper keeps its colour in both, so a switch never changes a
// stroke. The choice is kept for the next launch.
const THEME_KEY = 'brosr.canvas.theme';
const themeButton = document.getElementById('theme');

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch (error) {
    return 'dark';
  }
}

function showTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  if (!themeButton) return;
  themeButton.textContent = light ? 'Dark' : 'Light';
  themeButton.title = light ? 'Use the dark theme' : 'Use the light theme';
}

function setTheme(theme) {
  showTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    // A private window refuses storage, and the page still switches.
  }
}

showTheme(readTheme());
if (themeButton) {
  themeButton.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
}

for (const button of document.querySelectorAll('.brush')) {
  button.addEventListener('click', () => setPreset(button.dataset.preset));
}

document.getElementById('size').addEventListener('input', (event) => {
  state.size = clamp(Number(event.target.value) || 1, 1, MAX_BRUSH);
  state.sizes[state.preset] = state.size;
  document.getElementById('size-out').textContent = String(Math.round(state.size));
});

document.getElementById('opacity').addEventListener('input', (event) => {
  state.opacity = Number(event.target.value) / 100;
  state.opacities[state.preset] = state.opacity;
  document.getElementById('opacity-out').textContent = Math.round(state.opacity * 100) + '%';
});

document.getElementById('layer-opacity').addEventListener('input', (event) => {
  setLayerOpacity(state.activeLayer, Number(event.target.value) / 100);
});

document.getElementById('stabilizer').addEventListener('input', (event) => {
  state.stabilizer = Number(event.target.value) / 100;
  document.getElementById('stabilizer-out').textContent = Math.round(state.stabilizer * 100) + '%';
});

for (const button of document.querySelectorAll('.swatch')) {
  button.addEventListener('click', () => setColour(button.dataset.color, true));
}

document.getElementById('colour').addEventListener('input', (event) => setColour(event.target.value));

const hexInput = document.getElementById('hex');
hexInput.addEventListener('input', (event) => {
  const clean = cleanColour(event.target.value);
  if (clean) setColour(clean);
});
hexInput.addEventListener('change', (event) => {
  const clean = cleanColour(event.target.value);
  if (clean) setColour(clean, true);
  else event.target.value = state.colour;
});
hexInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const clean = cleanColour(event.target.value);
  if (clean) setColour(clean, true);
  else event.target.value = state.colour;
});

document.getElementById('pick').addEventListener('click', startPick);

document.getElementById('layer-add').addEventListener('click', () => addLayer());
document.getElementById('layer-up').addEventListener('click', () => {
  moveLayer(state.activeLayer, state.activeLayer + 1);
});
document.getElementById('layer-down').addEventListener('click', () => {
  moveLayer(state.activeLayer, state.activeLayer - 1);
});
document.getElementById('layer-del').addEventListener('click', () => removeLayer(state.activeLayer));
document.getElementById('layer-clear').addEventListener('click', () => clearLayer(state.activeLayer));

document.getElementById('image-import').addEventListener('click', () => {
  document.getElementById('image-file').click();
});

document.getElementById('image-file').addEventListener('change', (event) => {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (file) readImageFile(file);
});

document.getElementById('gif-open').addEventListener('click', openGif);
document.getElementById('gif-close').addEventListener('click', closeGif);
document.getElementById('gif-go').addEventListener('click', () => searchGifs());

const gifDialog = document.getElementById('gif-dialog');
gifDialog.addEventListener('click', (event) => {
  if (event.target === gifDialog) closeGif();
});

document.getElementById('gif-query').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  searchGifs();
});

document.getElementById('gif-url-add').addEventListener('click', () => {
  const input = document.getElementById('gif-url');
  const url = input ? input.value.trim() : '';
  if (!url) {
    setGifStatus('Paste a GIF address first.');
    return;
  }
  chooseGif(url);
});

document.getElementById('gif-key').addEventListener('change', (event) => {
  const value = String(event.target.value || '').trim();
  try {
    if (value) localStorage.setItem(GIF_KEY, value);
    else localStorage.removeItem(GIF_KEY);
  } catch {
    // A private window can refuse storage, and the search still runs.
  }
});

document.getElementById('undo').addEventListener('click', undo);
document.getElementById('redo').addEventListener('click', redo);

document.getElementById('clear').addEventListener('click', () => {
  // Clear takes this page's ink and leaves every peer's strokes and images.
  const strokes = [];
  const images = [];
  for (const [index, layer] of state.layers.entries()) {
    const mineStrokes = layer.strokes.filter((stroke) => stroke.owner === PEER);
    const mineImages = layer.images.filter((item) => item.owner === PEER);
    if (!mineStrokes.length && !mineImages.length) continue;
    for (const stroke of mineStrokes) strokes.push(stroke);
    for (const item of mineImages) images.push({ layer: index, item });
    layer.strokes = layer.strokes.filter((stroke) => stroke.owner !== PEER);
    layer.images = layer.images.filter((item) => item.owner !== PEER);
    layer.canvas = null;
  }
  if (!strokes.length && !images.length) return;
  state.history.push({ kind: 'clear', strokes, images });
  state.redo.length = 0;
  for (const stroke of strokes) sendRemove(stroke);
  for (const entry of images) send({ op: 'image-remove', id: entry.item.id });
  markInk();
  redraw();
  renderLayers();
  showHistory();
  touchDocument();
});

document.getElementById('export').addEventListener('click', () => {
  const out = document.createElement('canvas');
  out.width = PAPER.width;
  out.height = PAPER.height;
  paintComposite(out.getContext('2d'));
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
  // Escape backs out of a pick or a dialog even while a field has the focus.
  if (event.key === 'Escape') {
    if (picking) {
      picking = false;
      viewport.classList.remove('picking');
      note('Colour pick cancelled.');
    }
    const dialog = document.getElementById('gif-dialog');
    if (dialog && !dialog.hidden) closeGif();
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
    const next = clamp(state.size + (event.key === ']' ? 2 : -2), 1, MAX_BRUSH);
    state.size = next;
    state.sizes[state.preset] = next;
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
  const saved = localStorage.getItem(NAME_KEY) || '';
  nameInput.value = ROOM_NAME || saved;
  // A name from this room is the newer one, so it replaces the saved label.
  if (ROOM_NAME && ROOM_NAME !== saved) localStorage.setItem(NAME_KEY, ROOM_NAME);
} catch {
  nameInput.value = ROOM_NAME;
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
renderRecent();
renderLayers();
renderImages();
showHistory();
sendHere();
setInterval(sendHere, HERE_MS);
connect();
startDocuments();
