// The app side of the alignment lane. A peer measures how far its copy of a
// film sits from the copy the room is watching, then publishes one number.
//
// This module holds the rules only: what is accepted off the wire, what is
// clamped, and how room time becomes this peer's own position. It has no IO,
// no timer and no Bend, so a test drives it the same way a browser does.
//
// The number travels inside the existing app message, so no wire type is added
// and the protocol version does not move.

export const APP_NAME = 'align.offset';
// A copy that sits more than half an hour from the room is not the same film.
export const MAX_OFFSET_MS = 30 * 60 * 1000;
// Below this the peak is not a match, and a seek on a guess is worse than no
// correction at all.
export const MIN_CONFIDENCE = 0.5;
// One measurement per peer per second. An offset is a fact about two files,
// not a stream.
export const ALIGN_GAP_MS = 1000;

// A positive offset means this peer's copy starts later, so room time has to be
// pushed forward before it names a position in this file.
export function localPosition(roomPosition, offsetMs) {
  if (!Number.isFinite(roomPosition)) return roomPosition;
  if (!Number.isFinite(offsetMs) || offsetMs === 0) return roomPosition;
  return roomPosition + offsetMs / 1000;
}

export function clampOffset(offsetMs, max = MAX_OFFSET_MS) {
  if (!Number.isFinite(offsetMs)) return null;
  return Math.max(-max, Math.min(max, Math.round(offsetMs)));
}

// Every field has to make sense. Repairing one field silently is how a wrong
// number reaches a seek, so a payload with a bad field is dropped whole.
export function acceptOffset(payload, { maxOffsetMs = MAX_OFFSET_MS } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { offsetMs, confidence, fingerprint } = payload;
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > maxOffsetMs) return null;
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || confidence > 1) return null;
  if (fingerprint !== undefined && fingerprint !== null) {
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{1,64}$/i.test(fingerprint)) return null;
  }
  return {
    offsetMs: Math.round(offsetMs),
    confidence,
    fingerprint: fingerprint || null,
  };
}

// The panel prints this, and it is the one place the sign is spelled out.
export function formatOffset(offsetMs) {
  if (!Number.isFinite(offsetMs)) return 'unknown';
  if (offsetMs === 0) return '0 s';
  const sign = offsetMs > 0 ? '+' : '-';
  const abs = Math.abs(offsetMs);
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`;
  return `${sign}${(abs / 1000).toFixed(1)} s`;
}
