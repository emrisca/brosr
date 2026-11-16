// The cursor overlay. Rule 1 in Section 4.3 of ../docs/plan.md: it draws inside one
// closed shadow root, pinned to the viewport, with pointer events off. It adds
// no global CSS and no wrapper that a page style could reach.

export const CURSOR_WIDTH = 15;
export const CURSOR_HEIGHT = 21;
export const DEFAULT_COLOUR = '#e2603f';
// Presence arrives about thirty times a second. A cursor that jumps to each
// point reads as a stutter, so it eases toward the newest one on every frame.
// The time constant is short enough to stay honest about the position.
export const SMOOTHING_MS = 70;
// A point this far away is a jump, not movement: a new page, a restored
// window, or a peer that was idle. Gliding there would invent a path.
export const JUMP_PX = 320;

const SVG_NS = 'http://www.w3.org/2000/svg';
// A pointer with its tip at (0, 0), so the wrap translate lands on the exact
// point the peer reported. The tail and notch are what make it read as a
// cursor rather than a triangle.
const ARROW = 'M0 0 L0 19 L5 14.5 L8 21 L11 19.5 L8 13.5 L15 13.5 Z';

const px = (value) => Math.round(value * 10) / 10;

// A room action has a person behind it. The film tab says who paused it for a
// few seconds, in the same closed shadow root style as the cursor.
export const NOTICE_MS = 4000;
// A smaller gap is the tick drift, not a person moving the playhead.
export const SEEK_NOTICE_SECONDS = 1;

const clock = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, '0');
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}:${String(mins % 60).padStart(2, '0')}:${secs}`;
  return `${mins}:${secs}`;
};

// The words the notice shows. An unknown action says nothing, so a tick never
// turns into noise.
export function actionText({ name, action, position, rate } = {}) {
  const who = String(name || '').trim();
  if (!who) return '';
  if (action === 'play') return `${who} played the video`;
  if (action === 'pause') return `${who} paused the video`;
  if (action === 'seek') return `${who} jumped to ${clock(position)}`;
  if (action === 'rate') return `${who} set the speed to ${Number(rate || 1)}x`;
  return '';
}

// The room sends a frame on every tick. Only a change names an action: play or
// pause when that flag moves, a speed change when the rate moves, and a seek
// when the playhead lands somewhere the previous frame did not predict.
export function mediaAction(previous, frame, now = Date.now()) {
  if (!previous || !frame) return null;
  if (previous.key && frame.key && previous.key !== frame.key) return null;
  if (Boolean(previous.playing) !== Boolean(frame.playing)) {
    return frame.playing ? 'play' : 'pause';
  }
  if (Math.abs(Number(previous.rate || 1) - Number(frame.rate || 1)) > 0.01) return 'rate';
  const age = Math.max(0, Number(now) - Number(previous.at || now)) / 1000;
  const projected =
    Number(previous.position || 0) +
    (previous.playing ? age * Number(previous.rate || 1) : 0);
  if (Math.abs(Number(frame.position || 0) - projected) > SEEK_NOTICE_SECONDS) return 'seek';
  return null;
}

export class ActionNotice {
  constructor({
    document,
    host = null,
    holdMs = NOTICE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = {}) {
    if (!document) throw new Error('ActionNotice needs a document');
    this.document = document;
    this.host = host;
    this.holdMs = holdMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.mounted = false;
    this.visible = false;
    this.hostNode = null;
    this.shadow = null;
    this.node = null;
    this.text = null;
    this.timer = null;
  }

  attach() {
    if (this.mounted) return this;
    const host = this.host || this.document.createElement('div');
    host.setAttribute('data-brosr-notice', '');
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
      contain: 'layout style',
    });
    this.shadow = host.attachShadow({ mode: 'closed' });
    const view = this.document.defaultView || null;
    const reduce = Boolean(
      view &&
        typeof view.matchMedia === 'function' &&
        view.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    const node = this.document.createElement('div');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    Object.assign(node.style, {
      position: 'absolute',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      maxWidth: '90vw',
      boxSizing: 'border-box',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      font: "500 13px/18px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: '#fff',
      background: 'rgba(22, 22, 24, 0.9)',
      padding: '8px 14px',
      borderRadius: '999px',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.28)',
      whiteSpace: 'nowrap',
      opacity: '0',
      transition: reduce ? 'none' : 'opacity 160ms ease',
    });
    const text = this.document.createElement('span');
    node.appendChild(text);
    this.shadow.appendChild(node);
    if (!this.host) this.document.documentElement.appendChild(host);
    this.hostNode = host;
    this.node = node;
    this.text = text;
    this.mounted = true;
    return this;
  }

  show(entry = {}) {
    const text = actionText(entry);
    if (!text) return false;
    this.attach();
    this.text.textContent = text;
    this.node.style.opacity = '1';
    this.visible = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.hide(), this.holdMs);
    return true;
  }

  hide() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.visible = false;
    if (this.node) this.node.style.opacity = '0';
    return this;
  }

  destroy() {
    this.hide();
    if (this.hostNode && this.hostNode.parentNode) {
      this.hostNode.parentNode.removeChild(this.hostNode);
    }
    this.mounted = false;
    this.hostNode = null;
    this.node = null;
    this.text = null;
    return this;
  }

  stats() {
    return {
      mounted: this.mounted,
      showing: this.visible,
      text: this.text ? this.text.textContent : '',
    };
  }
}

export class CursorOverlay {
  constructor({ document, host = null, smoothing = SMOOTHING_MS } = {}) {
    if (!document) throw new Error('CursorOverlay needs a document');
    this.document = document;
    this.host = host;
    this.smoothing = smoothing;
    this.nodes = new Map();
    this.mounted = false;
    this.hostNode = null;
    this.shadow = null;
    this.layer = null;

    const view = document.defaultView || null;
    this.view = view;
    this.frameHandle = null;
    this.lastFrame = 0;
    this.raf =
      view && typeof view.requestAnimationFrame === 'function'
        ? view.requestAnimationFrame.bind(view)
        : null;
    this.cancel =
      view && typeof view.cancelAnimationFrame === 'function'
        ? view.cancelAnimationFrame.bind(view)
        : null;
    // A cursor that eases is motion, and some people ask for less of it.
    this.reduceMotion = Boolean(
      view &&
        typeof view.matchMedia === 'function' &&
        view.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  attach() {
    if (this.mounted) return this;
    const host = this.host || this.document.createElement('div');
    host.setAttribute('data-brosr-overlay', '');
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
      contain: 'strict',
    });
    this.shadow = host.attachShadow({ mode: 'closed' });
    this.layer = this.document.createElement('div');
    Object.assign(this.layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    this.shadow.appendChild(this.layer);
    if (!this.host) this.document.documentElement.appendChild(host);
    this.hostNode = host;
    this.mounted = true;
    return this;
  }

  makePointer() {
    const svg = this.document.createElementNS
      ? this.document.createElementNS(SVG_NS, 'svg')
      : this.document.createElement('svg');
    svg.setAttribute('viewBox', `0 0 ${CURSOR_WIDTH} ${CURSOR_HEIGHT}`);
    Object.assign(svg.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${CURSOR_WIDTH}px`,
      height: `${CURSOR_HEIGHT}px`,
      overflow: 'visible',
      pointerEvents: 'none',
      filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45))',
      willChange: 'transform',
    });
    const path = this.document.createElementNS
      ? this.document.createElementNS(SVG_NS, 'path')
      : this.document.createElement('path');
    path.setAttribute('d', ARROW);
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('stroke', 'rgba(255, 255, 255, 0.92)');
    path.setAttribute('stroke-width', '1.3');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    return svg;
  }

  setPeer(peer = {}) {
    this.attach();
    if (!peer.id) throw new Error('a cursor needs a peer id');
    let node = this.nodes.get(peer.id);
    if (!node) {
      const wrap = this.document.createElement('div');
      Object.assign(wrap.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '0',
        height: '0',
        pointerEvents: 'none',
        visibility: 'hidden',
      });
      const pointer = this.makePointer();
      const label = this.document.createElement('span');
      Object.assign(label.style, {
        position: 'absolute',
        left: '16px',
        top: '16px',
        font: "500 11px/16px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: '#fff',
        padding: '2px 6px',
        borderRadius: '6px',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.25)',
      });
      const image = this.document.createElement('img');
      image.alt = '';
      Object.assign(image.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        display: 'none',
        maxWidth: '48px',
        maxHeight: '48px',
        pointerEvents: 'none',
        filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45))',
      });
      wrap.appendChild(pointer);
      wrap.appendChild(label);
      wrap.appendChild(image);
      this.layer.appendChild(wrap);
      node = { wrap, pointer, label, image, imageSrc: '', point: null, target: { x: 0, y: 0 } };
      this.nodes.set(peer.id, node);
    }

    const colour = peer.colour || DEFAULT_COLOUR;
    const custom = peer.cursor && peer.cursor.src ? peer.cursor : null;
    node.pointer.style.color = colour;
    node.label.style.background = custom ? '#2b2b2b' : colour;
    node.label.style.left = custom
      ? `${Math.max(20, Math.min(48, Number(custom.w) || 32)) + 2}px`
      : '16px';
    node.label.textContent = peer.name || peer.id;
    // A viewer can turn every pointer name off. The peer still draws.
    node.label.style.display = peer.showName === false ? 'none' : 'block';
    if (custom) {
      if (node.imageSrc !== custom.src) {
        node.imageSrc = custom.src;
        node.image.src = custom.src;
      }
      node.image.style.width = `${Math.max(12, Math.min(48, Number(custom.w) || 32))}px`;
      node.image.style.height = `${Math.max(12, Math.min(48, Number(custom.h) || 32))}px`;
      node.image.style.display = 'block';
      node.pointer.style.display = 'none';
    } else {
      node.image.style.display = 'none';
      node.pointer.style.display = 'block';
    }

    const point = peer.point || { x: 0, y: 0 };
    const first = node.point === null;
    const moved = node.target.x !== point.x || node.target.y !== point.y;
    node.target = { x: point.x, y: point.y };
    // Without a frame loop there is nothing to ease with, and reduced motion
    // asks for no easing, so both cases land on the point at once.
    if (first || !this.raf || this.reduceMotion) node.point = { x: point.x, y: point.y };

    // A fresh peer has no position yet, and (0, 0) is the corner. Keep it
    // hidden until a real move gives the pointer somewhere to point.
    const known = point.x !== 0 || point.y !== 0;
    node.wrap.style.visibility = known ? 'visible' : 'hidden';
    this.render(node);
    if (!first && moved) this.schedule();
    return node;
  }

  render(node) {
    const x = px(node.point.x);
    const y = px(node.point.y);
    node.wrap.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  schedule() {
    if (!this.raf || this.reduceMotion || this.frameHandle !== null) return;
    this.lastFrame = 0;
    this.frameHandle = this.raf((time) => this.step(time));
  }

  step(time) {
    this.frameHandle = null;
    const elapsed = this.lastFrame ? Math.min(64, time - this.lastFrame) : 16;
    this.lastFrame = time;
    const ease = 1 - Math.exp(-elapsed / this.smoothing);
    let moving = false;

    for (const node of this.nodes.values()) {
      const dx = node.target.x - node.point.x;
      const dy = node.target.y - node.point.y;
      const far = Math.abs(dx) > JUMP_PX || Math.abs(dy) > JUMP_PX;
      if (far || (Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15)) {
        node.point = { x: node.target.x, y: node.target.y };
      } else {
        node.point = { x: node.point.x + dx * ease, y: node.point.y + dy * ease };
        moving = true;
      }
      this.render(node);
    }

    if (moving) this.frameHandle = this.raf((next) => this.step(next));
    else this.lastFrame = 0;
  }

  removePeer(id) {
    const node = this.nodes.get(id);
    if (!node) return false;
    if (node.wrap.parentNode) node.wrap.parentNode.removeChild(node.wrap);
    this.nodes.delete(id);
    return true;
  }

  clear() {
    for (const id of [...this.nodes.keys()]) this.removePeer(id);
  }

  destroy() {
    this.clear();
    if (this.frameHandle !== null && this.cancel) this.cancel(this.frameHandle);
    this.frameHandle = null;
    if (this.hostNode && this.hostNode.parentNode) this.hostNode.parentNode.removeChild(this.hostNode);
    this.mounted = false;
    this.hostNode = null;
    return this;
  }

  stats() {
    return { mounted: this.mounted, peers: this.nodes.size };
  }
}
