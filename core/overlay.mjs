// The cursor overlay. Rule 1 in Section 4.3 of ../plan.md: it draws inside one
// closed shadow root, pinned to the viewport, with pointer events off. It adds
// no global CSS and no wrapper that a page style could reach.

export const CURSOR_SIZE = 18;
export const DEFAULT_COLOUR = '#e2603f';

export class CursorOverlay {
  constructor({ document, host = null, size = CURSOR_SIZE } = {}) {
    if (!document) throw new Error('CursorOverlay needs a document');
    this.document = document;
    this.host = host;
    this.size = size;
    this.nodes = new Map();
    this.mounted = false;
    this.hostNode = null;
    this.shadow = null;
    this.layer = null;
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
      });
      const dot = this.document.createElement('div');
      Object.assign(dot.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: `${this.size}px`,
        height: `${this.size}px`,
        borderRadius: '50%',
        border: '2px solid rgba(255, 255, 255, 0.9)',
        boxSizing: 'border-box',
        pointerEvents: 'none',
      });
      const label = this.document.createElement('span');
      Object.assign(label.style, {
        position: 'absolute',
        left: `${this.size}px`,
        top: `-${this.size}px`,
        font: '11px/1.4 system-ui, sans-serif',
        color: '#fff',
        padding: '1px 5px',
        borderRadius: '3px',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      });
      wrap.appendChild(dot);
      wrap.appendChild(label);
      this.layer.appendChild(wrap);
      node = { wrap, dot, label };
      this.nodes.set(peer.id, node);
    }
    const colour = peer.colour || DEFAULT_COLOUR;
    node.dot.style.background = colour;
    node.label.style.background = colour;
    node.label.textContent = peer.name || peer.id;
    const point = peer.point || { x: 0, y: 0 };
    node.wrap.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`;
    return node;
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
    if (this.hostNode && this.hostNode.parentNode) this.hostNode.parentNode.removeChild(this.hostNode);
    this.mounted = false;
    this.hostNode = null;
    return this;
  }

  stats() {
    return { mounted: this.mounted, peers: this.nodes.size };
  }
}
