// The media policy from Section 7 of ../plan.md.
// A seek costs a visible stutter, so it is the last resort. A rate nudge of
// five percent is inaudible and closes small errors without one.

export const SEEK_MS = 300;
export const NUDGE_MS = 40;
export const MAX_RATE_DELTA = 0.05;

// A positive drift means this side is ahead of the host.
export function decideDrift(driftMs, { buffering = false, adPlaying = false } = {}) {
  if (adPlaying) return { action: 'pause', reason: 'ad' };
  if (buffering) return { action: 'pause', reason: 'buffering' };
  const abs = Math.abs(driftMs);
  if (!Number.isFinite(abs)) return { action: 'none', rate: 1 };
  if (abs > SEEK_MS) return { action: 'seek' };
  if (abs > NUDGE_MS) {
    return { action: 'nudge', rate: driftMs > 0 ? 1 - MAX_RATE_DELTA : 1 + MAX_RATE_DELTA };
  }
  return { action: 'none', rate: 1 };
}

export class DriftController {
  constructor() {
    this.seeks = 0;
    this.nudges = 0;
    this.rate = 1;
    this.lastAction = 'none';
  }

  tick(driftMs, flags = {}) {
    const step = decideDrift(driftMs, flags);
    this.lastAction = step.action;
    if (step.action === 'seek') {
      this.seeks += 1;
      this.rate = 1;
    } else if (step.action === 'nudge') {
      this.nudges += 1;
      this.rate = step.rate;
    } else {
      this.rate = 1;
    }
    return step;
  }

  stats() {
    return { seeks: this.seeks, nudges: this.nudges, rate: this.rate, lastAction: this.lastAction };
  }
}
