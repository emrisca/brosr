'use strict';
// Canvas. A paper sheet drawn on one canvas, with a small stroke model so undo,
// symmetry, layers and a PNG export all read from the same record.

const PAPER = { width: 2400, height: 1600 };
const PAPER_COLOUR = '#faf7f2';

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

const viewport = document.getElementById('viewport');
const canvas = document.getElementById('sheet');
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

function mirrorTransforms(mode) {
  const cx = PAPER.width / 2;
  const cy = PAPER.height / 2;
  const list = [() => {}];
  const flipX = () => {
    ctx.translate(PAPER.width, 0);
    ctx.scale(-1, 1);
  };
  const flipY = () => {
    ctx.translate(0, PAPER.height);
    ctx.scale(1, -1);
  };
  if (mode === 'vertical' || mode === 'quad') list.push(flipX);
  if (mode === 'horizontal' || mode === 'quad') list.push(flipY);
  if (mode === 'quad') {
    list.push(() => {
      ctx.translate(PAPER.width, PAPER.height);
      ctx.scale(-1, -1);
    });
  }
  // The transforms must land around the sheet centre.
  return list.map((apply) => () => {
    ctx.translate(cx, cy);
    apply();
    ctx.translate(-cx, -cy);
  });
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
  for (const apply of mirrorTransforms(stroke.symmetry)) {
    g.save();
    apply();
    paintFreehand(g, stroke);
    g.restore();
  }
  g.globalAlpha = 1;
}

function paintScene(g, withLive) {
  g.globalAlpha = 1;
  g.fillStyle = PAPER_COLOUR;
  g.fillRect(0, 0, PAPER.width, PAPER.height);

  for (let index = 0; index < state.layers.length; index++) {
    const layer = state.layers[index];
    if (!layer.visible) continue;
    for (const stroke of layer.strokes) paintStroke(g, stroke);
    if (withLive && drawing && drawing.stroke.layer === index) paintStroke(g, drawing.stroke);
  }
}

function redraw() {
  const width = canvas.width;
  const height = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.z, view.z);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = PAPER_COLOUR;
  ctx.fillRect(0, 0, PAPER.width, PAPER.height);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  paintScene(ctx, true);
  ctx.restore();
}

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
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
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

function removeStroke(stroke) {
  const list = state.layers[stroke.layer].strokes;
  const index = list.lastIndexOf(stroke);
  if (index >= 0) list.splice(index, 1);
}

function swapLayers(snapshot) {
  const current = state.layers.map((layer) => layer.strokes.slice());
  state.layers.forEach((layer, index) => {
    layer.strokes = snapshot[index].slice();
  });
  return current;
}

function commit(stroke) {
  state.layers[stroke.layer].strokes.push(stroke);
  state.history.push({ kind: 'add', stroke });
  state.redo.length = 0;
  showHistory();
}

function undo() {
  const op = state.history.pop();
  if (!op) return;
  if (op.kind === 'add') {
    removeStroke(op.stroke);
    state.redo.push(op);
  } else {
    state.redo.push({ kind: 'swap', snapshot: swapLayers(op.snapshot) });
  }
  redraw();
  showHistory();
}

function redo() {
  const op = state.redo.pop();
  if (!op) return;
  if (op.kind === 'add') {
    state.layers[op.stroke.layer].strokes.push(op.stroke);
    state.history.push(op);
  } else {
    state.history.push({ kind: 'swap', snapshot: swapLayers(op.snapshot) });
  }
  redraw();
  showHistory();
}

function showHistory() {
  document.getElementById('undo').disabled = state.history.length === 0;
  document.getElementById('redo').disabled = state.redo.length === 0;
}

// ---------------------------------------------------------------------------
// Pointer

function startStroke(point) {
  drawing = {
    stroke: {
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
    view.z = clamp(view.z * Math.exp(-event.deltaY * 0.0015), 0.15, 8);
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
  const empty = state.layers.every((layer) => layer.strokes.length === 0);
  if (empty) return;
  const snapshot = state.layers.map((layer) => layer.strokes.slice());
  state.layers.forEach((layer) => {
    layer.strokes = [];
  });
  state.history.push({ kind: 'swap', snapshot });
  state.redo.length = 0;
  redraw();
  showHistory();
});

document.getElementById('export').addEventListener('click', () => {
  const out = document.createElement('canvas');
  const scale = 2;
  out.width = PAPER.width * scale;
  out.height = PAPER.height * scale;
  const target = out.getContext('2d');
  target.scale(scale, scale);
  paintScene(target, false);
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
  view.z = clamp(view.z * 1.2, 0.15, 8);
  redraw();
  showZoom();
});

document.getElementById('zoom-out').addEventListener('click', () => {
  view.z = clamp(view.z / 1.2, 0.15, 8);
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
