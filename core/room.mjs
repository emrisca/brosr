// Room state: who is here, what sequence the room is at, and the two rate
// limits from Section 10 of ../plan.md. It holds no transport and no DOM.

export const MAX_INPUT_PER_SECOND = 120;
export const MAX_NAV_PER_SECOND = 1;

export class Room {
  constructor({ role = 'peer', peerId = 'me', now = () => Date.now() } = {}) {
    this.role = role;
    this.peerId = peerId;
    this.now = now;
    this.peers = new Map();
    this.sequence = 0;
    this.inputSeq = new Map();
    this.inputWindow = new Map();
    this.navWindow = null;
    this.url = null;
    this.scroll = 0;
    this.fingerprint = null;
  }

  join(peer) {
    if (!peer || !peer.id) throw new Error('a peer needs an id');
    const existing = this.peers.get(peer.id);
    const next = { ...(existing || {}), ...peer, joinedAt: existing ? existing.joinedAt : this.now() };
    this.peers.set(peer.id, next);
    return next;
  }

  leave(id) {
    this.inputSeq.delete(id);
    this.inputWindow.delete(id);
    return this.peers.delete(id);
  }

  nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  // Per-peer ordering. A receiver applies a batch once and drops a replay.
  acceptInput({ peerId, seq, records }) {
    if (!Array.isArray(records) || !records.length) return { accepted: false, reason: 'empty' };
    const last = this.inputSeq.get(peerId) ?? 0;
    if (seq <= last) return { accepted: false, reason: 'stale' };
    this.inputSeq.set(peerId, seq);
    return { accepted: true, records };
  }

  allowInput(peerId = this.peerId) {
    const now = this.now();
    const bucket = this.inputWindow.get(peerId);
    if (!bucket || now - bucket.start >= 1000) {
      this.inputWindow.set(peerId, { start: now, count: 1 });
      return true;
    }
    if (bucket.count >= MAX_INPUT_PER_SECOND) return false;
    bucket.count += 1;
    return true;
  }

  allowNav() {
    const now = this.now();
    if (this.navWindow !== null && now - this.navWindow < 1000 / MAX_NAV_PER_SECOND) return false;
    this.navWindow = now;
    return true;
  }

  applyNav({ url } = {}) {
    if (typeof url !== 'string' || !url) throw new Error('a navigation needs a url');
    this.url = url;
    this.scroll = 0;
    return url;
  }

  applyView({ scroll, fingerprint } = {}) {
    const ratio = Math.max(0, Math.min(1, Number(scroll) || 0));
    this.scroll = ratio;
    if (!fingerprint) return { scroll: ratio, mismatch: false };
    const mismatch = this.viewportDrift(fingerprint) > 0.05;
    this.fingerprint = this.fingerprint || fingerprint;
    return { scroll: ratio, mismatch };
  }

  // Two windows of different sizes are not the same layout, so a relayed
  // click may land somewhere else. The room says so instead of guessing.
  viewportDrift(fingerprint) {
    if (!this.fingerprint || !fingerprint) return 0;
    let worst = 0;
    for (const field of ['innerWidth', 'innerHeight', 'scrollWidth']) {
      const mine = Number(this.fingerprint[field]);
      const theirs = Number(fingerprint[field]);
      if (!mine || !theirs) continue;
      worst = Math.max(worst, Math.abs(mine - theirs) / Math.max(mine, theirs));
    }
    return worst;
  }

  snapshot(extra = {}) {
    return {
      type: 'snapshot',
      sequence: this.sequence,
      peers: [...this.peers.values()],
      url: this.url,
      scroll: this.scroll,
      fingerprint: this.fingerprint,
      ...extra,
    };
  }

  applySnapshot(snapshot) {
    if (!snapshot) return null;
    this.sequence = Math.max(this.sequence, Number(snapshot.sequence) || 0);
    if (snapshot.url) this.url = snapshot.url;
    if (typeof snapshot.scroll === 'number') {
      this.scroll = Math.max(0, Math.min(1, snapshot.scroll));
    }
    if (snapshot.fingerprint && !this.fingerprint) this.fingerprint = snapshot.fingerprint;
    for (const peer of snapshot.peers || []) this.join(peer);
    return snapshot;
  }
}
