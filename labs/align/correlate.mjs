// Integer correlation for the alignment lane.
//
// The input is two envelopes, one value per window, each scaled into bytes.
// A lag means this: b's content starts `lag` windows later than a's. So a
// positive lag is a copy that carries extra at the head.
//
// Everything the kernel computes is integer arithmetic, so Bend can produce
// bit-identical dots. The peak is chosen here from those dots and prefix sums,
// so both engines compare the same floats.

export const CONFIDENCE_FLOOR = 0.5;

// Two copies of one film share most of the film. A lag whose overlap is under
// half of the shorter copy rests on too few windows, and a handful of windows
// can look alike by accident, so those lags are never scored.
const MIN_OVERLAP_FRACTION = 0.5;

// The overlap of a and b when b is shifted by lag. A pair at a[i] reads b[i+lag].
export function span(a, b, lag) {
  const start = Math.max(0, -lag);
  const end = Math.min(a.length, b.length - lag);
  return { start, end: Math.max(start, end) };
}

export function dotAt(a, b, lag) {
  const { start, end } = span(a, b, lag);
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += a[i] * b[i + lag];
  return sum;
}

// Prefix sums and squares, so the mean and the variance of any overlap are one
// subtraction each. The values are bytes and a two hour film is a few hundred
// thousand windows, so the widest sum stays well inside a double's exact
// integer range.
export function prefix(list) {
  const sums = new Float64Array(list.length + 1);
  const squares = new Float64Array(list.length + 1);
  for (let i = 0; i < list.length; i += 1) {
    sums[i + 1] = sums[i] + list[i];
    squares[i + 1] = squares[i] + list[i] * list[i];
  }
  return { sums, squares };
}

function overlapFloor(aLength, bLength) {
  return Math.ceil(Math.min(aLength, bLength) * MIN_OVERLAP_FRACTION);
}

// The Pearson correlation of the overlap. Two copies of one film sit near one,
// even when one of them is quieter, and two unrelated programmes sit near zero.
// A plain cosine would call both of them near one, because every window of a
// film has a positive mean, and that mean carries no evidence at all.
function correlation(dot, n, sumA, sumB, squareA, squareB) {
  if (n < 2) return 0;
  const covariance = dot - (sumA * sumB) / n;
  const varianceA = squareA - (sumA * sumA) / n;
  const varianceB = squareB - (sumB * sumB) / n;
  if (!(varianceA > 0) || !(varianceB > 0)) return 0;
  const score = covariance / Math.sqrt(varianceA * varianceB);
  return Math.max(-1, Math.min(1, score));
}

// A lag is scored by its correlation, not by the raw dot. A dot counts one term
// per overlapping window, so a lag near zero collects more terms than a lag at
// the edge of the search and wins on that alone, even when the extra windows
// carry no evidence. Correlation is bounded, so a wrong lag cannot run away on
// a short overlap, and a true shift scores one and cannot be beaten.
//
// The same rule over a set of already scored lags, for an engine that returns
// dots instead of arrays. Pass both envelopes as `a` and `b` to score by
// correlation, the way bestLag does. Without them the dots are compared as
// given, which is only right when every lag covers the same windows. Both
// engines must agree, and a test asserts they do.
export function bestFromDots(dots, { a, b } = {}) {
  const entries = dots instanceof Map ? [...dots.entries()] : dots;
  if (!entries.length) throw new Error('no lags were scored');
  const known = Boolean(a && b) && Number.isInteger(a.length) && Number.isInteger(b.length);
  const sa = known ? prefix(a) : null;
  const sb = known ? prefix(b) : null;
  const floor = known ? overlapFloor(a.length, b.length) : 0;
  // A search with no positive evidence answers zero, and zero is a no-op.
  let best = { lag: 0, dot: 0, score: 0 };
  for (const [lag, dot] of entries) {
    let score = dot;
    if (known) {
      const { start, end } = span(a, b, lag);
      const n = end - start;
      if (n < floor) continue;
      score = correlation(
        dot,
        n,
        sa.sums[end] - sa.sums[start],
        sb.sums[end + lag] - sb.sums[start + lag],
        sa.squares[end] - sa.squares[start],
        sb.squares[end + lag] - sb.squares[start + lag]
      );
    }
    if (score > best.score) {
      best = { lag, dot, score };
    } else if (score === best.score && score > 0) {
      const closer = Math.abs(lag) < Math.abs(best.lag);
      const lower = Math.abs(lag) === Math.abs(best.lag) && lag < best.lag;
      if (closer || lower) best = { lag, dot, score };
    }
  }
  return best;
}

// A tie prefers the lag nearest zero, then the smaller lag. Without a rule the
// winner would depend on iteration order, and a flat signal would move between
// machines or between engines.
export function bestLag(a, b, first, last) {
  const sa = prefix(a);
  const sb = prefix(b);
  const floor = overlapFloor(a.length, b.length);
  let best = { lag: 0, dot: 0, score: 0 };
  for (let lag = first; lag <= last; lag += 1) {
    const { start, end } = span(a, b, lag);
    const n = end - start;
    if (n < floor) continue;
    const dot = dotAt(a, b, lag);
    const score = correlation(
      dot,
      n,
      sa.sums[end] - sa.sums[start],
      sb.sums[end + lag] - sb.sums[start + lag],
      sa.squares[end] - sa.squares[start],
      sb.squares[end + lag] - sb.squares[start + lag]
    );
    if (score > best.score) {
      best = { lag, dot, score };
    } else if (score === best.score && score > 0) {
      const closer = Math.abs(lag) < Math.abs(best.lag);
      const lower = Math.abs(lag) === Math.abs(best.lag) && lag < best.lag;
      if (closer || lower) best = { lag, dot, score };
    }
  }
  return best;
}

// The correlation at one lag, computed from the arrays directly.
export function confidence(a, b, lag) {
  const { start, end } = span(a, b, lag);
  const n = end - start;
  if (n < 2) return 0;
  let dot = 0;
  let sumA = 0;
  let sumB = 0;
  let squareA = 0;
  let squareB = 0;
  for (let i = start; i < end; i += 1) {
    const x = a[i];
    const y = b[i + lag];
    dot += x * y;
    sumA += x;
    sumB += y;
    squareA += x * x;
    squareB += y * y;
  }
  return correlation(dot, n, sumA, sumB, squareA, squareB);
}

function centre(window, width) {
  const start = Math.max(0, Math.floor((window.length - width) / 2));
  return start;
}

// Two passes. One second windows over the whole film find the minute, one
// window steps over a twenty second slice find the frame. The refinement only
// searches one second around the coarse answer, so a wrong coarse answer is
// never silently repaired by a wide fine search.
export async function matchCopies(a, b, { maxOffsetMs = 600000, windowMs = 20, best = bestLag } = {}) {
  if (!a.length || !b.length) throw new Error('both envelopes need at least one window');
  const coarseFactor = Math.round(1000 / windowMs);
  if (coarseFactor < 1) throw new Error('a window longer than one second has no coarse factor');

  const coarseA = aggregate(a, coarseFactor);
  const coarseB = aggregate(b, coarseFactor);
  if (!coarseA.length || !coarseB.length) throw new Error('film is shorter than one coarse second');

  const [qa, qb] = quantize(coarseA, coarseB);
  const maxLagS = Math.floor(maxOffsetMs / 1000);
  const coarse = await best(qa, qb, -maxLagS, maxLagS);

  const centreLag = coarse.lag * coarseFactor;
  const overlap = span(a, b, centreLag);
  const room = overlap.end - overlap.start;
  const fineSpan = Math.round(20000 / windowMs);
  const width = Math.min(fineSpan, room);

  if (width < 32) {
    const score = confidence(qa, qb, coarse.lag);
    return {
      offsetMs: coarse.lag * 1000,
      confidence: score,
      coarse: { lag: coarse.lag, dot: coarse.dot },
      fine: null,
      windows: a.length,
    };
  }

  const start = overlap.start + Math.floor((room - width) / 2);
  const fineA = a.slice(start, start + width);
  const fineB = b.slice(start + centreLag, start + centreLag + width);
  const [fa, fb] = quantize(fineA, fineB);
  const reach = Math.max(1, Math.round(1000 / windowMs));
  const fine = await best(fa, fb, -reach, reach);
  const lag = centreLag + fine.lag;

  return {
    offsetMs: lag * windowMs,
    confidence: confidence(fa, fb, fine.lag),
    coarse: { lag: coarse.lag, dot: coarse.dot },
    fine: { lag: fine.lag, dot: fine.dot, width },
    windows: a.length,
  };
}

// Averaging whole groups only. A partial tail is dropped, which at one second
// groups costs less than a second of the film and cannot move the peak.
export function aggregate(values, factor) {
  if (!Number.isInteger(factor) || factor < 1) throw new Error('aggregate needs a whole factor');
  const out = [];
  for (let i = 0; i + factor <= values.length; i += factor) {
    let sum = 0;
    for (let k = 0; k < factor; k += 1) sum += values[i + k];
    out.push(Math.round(sum / factor));
  }
  return out;
}

// Each copy is scaled onto its own range. The comparison is correlation, which
// is free of gain and offset, so a quieter rip still aligns. Five bits, not
// eight, keep a full two hour coarse dot inside Bend 0.2.38's u24: the worst
// case is 7200 * 31 * 31, under 6.9 million. A list with no variation becomes
// zero, and a flat copy matches nothing, which is the honest answer.
export const ENVELOPE_MAX = 31;

export function quantize(...lists) {
  return lists.map((list) => {
    let min = Infinity;
    let max = -Infinity;
    for (const value of list) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const width = max - min;
    if (!Number.isFinite(width) || width <= 0) return list.map(() => 0);
    return list.map((value) => Math.round(((value - min) * ENVELOPE_MAX) / width));
  });
}

export { centre };
