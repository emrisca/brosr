// Room clock. The four-timestamp exchange from Section 7 of ../plan.md.
// The sample with the smallest round trip wins, because a small round trip
// is the closest thing to a clean path that a pair of peers can observe.

export const PING_INTERVAL_MS = 30000;
// A lost pong must not silence the clock for the whole session.
export const PING_TIMEOUT_MS = 5000;

export class ClockEstimator {
  constructor({ now = () => Date.now(), intervalMs = PING_INTERVAL_MS } = {}) {
    this.now = now;
    this.intervalMs = intervalMs;
    this.best = null;
    this.samples = 0;
    this.pending = null;
    this.lastSampleAt = -Infinity;
  }

  // t0 leaves this side.
  ping(local = this.now()) {
    this.pending = local;
    return { type: 'ping', t0: local };
  }

  // t1 arrives, t2 leaves the other side.
  answer(message, arrival = this.now(), send = arrival) {
    if (!message || message.type !== 'ping') throw new Error('answer needs a ping');
    return { type: 'pong', t0: message.t0, t1: arrival, t2: send };
  }

  // t3 arrives here. Returns the sample, or null when it is impossible.
  onPong(message, local = this.now()) {
    const { t0, t1, t2 } = message;
    const t3 = local;
    // A reply that lost its start stamp reads as a round trip of the whole wall
    // clock, and that bogus sample can then win the minimum for the session.
    // A reply with no start stamp, or one with zero reply stamps, reads as a
    // round trip of the whole wall clock and can win the minimum instead.
    if (!(t0 > 0) || !(t1 > 0) || !(t2 > 0)) return null;
    const rtt = t3 - t0 - (t2 - t1);
    if (!(rtt >= 0)) return null;
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    this.samples += 1;
    this.pending = null;
    this.lastSampleAt = local;
    if (!this.best || rtt < this.best.rtt) this.best = { rtt, offset };
    return { rtt, offset };
  }

  offset() {
    return this.best ? this.best.offset : 0;
  }

  roundTrip() {
    return this.best ? this.best.rtt : null;
  }

  // Local time in the host's base. Everything timed uses this, never the wall clock.
  roomTime(local = this.now()) {
    return local + this.offset();
  }

  due(local = this.now()) {
    if (this.pending !== null && local - this.pending < PING_TIMEOUT_MS) return false;
    return local - this.lastSampleAt >= this.intervalMs;
  }
}
