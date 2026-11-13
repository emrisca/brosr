// The Brosr wire protocol. One JSON message per frame, with a 16 KB ceiling.
// Section 7 of ../plan.md is the specification this file implements.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024;

export const TYPES = [
  'hello',
  'welcome',
  'snapshot',
  'nav',
  'view',
  'media',
  'input',
  'app',
  'presence',
  'control',
  'ping',
  'pong',
  'bye',
];

const KNOWN = new Set(TYPES);
const MEDIA_ACTIONS = new Set(['play', 'pause', 'seek', 'tick']);

function fail(message) {
  throw new Error(message);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validate(message) {
  switch (message.type) {
    case 'hello':
    case 'welcome':
      if (typeof message.peerId !== 'string' || !message.peerId) fail(`${message.type} needs a peerId`);
      break;
    case 'snapshot':
      if (!isNumber(message.sequence)) fail('snapshot needs a sequence');
      break;
    case 'nav':
      if (typeof message.url !== 'string' || !message.url) fail('nav needs a url');
      break;
    case 'view':
      if (!isNumber(message.scroll)) fail('view needs a scroll ratio');
      break;
    case 'media':
      if (!MEDIA_ACTIONS.has(message.action)) fail(`media action ${message.action} is unknown`);
      if (!isNumber(message.position)) fail('media needs a position in seconds');
      if (!isNumber(message.roomTime)) fail('media needs a roomTime');
      break;
    case 'input':
      if (!Array.isArray(message.records) || !message.records.length) fail('input needs records');
      if (!isNumber(message.seq)) fail('input needs a seq');
      break;
    case 'app':
      // A page-level message: the name picks the handler, the data stays opaque
      // to the room. The frame ceiling still applies.
      if (typeof message.peerId !== 'string' || !message.peerId) fail('app needs a peerId');
      if (typeof message.name !== 'string' || !message.name) fail('app needs a name');
      if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) {
        fail('app needs a data object');
      }
      break;
    case 'presence':
      if (!message.point || !isNumber(message.point.x) || !isNumber(message.point.y)) {
        fail('presence needs a point');
      }
      break;
    case 'control':
      if (typeof message.peerId !== 'string') fail('control needs a peerId');
      if (typeof message.allowed !== 'boolean') fail('control needs an allowed flag');
      break;
    case 'ping':
      if (!isNumber(message.t0)) fail('ping needs t0');
      break;
    case 'pong':
      if (!isNumber(message.t0) || !isNumber(message.t1) || !isNumber(message.t2)) {
        fail('pong needs t0, t1 and t2');
      }
      break;
    case 'bye':
      break;
    default:
      fail(`unknown message type: ${message.type}`);
  }
  return message;
}

export function encode(message) {
  if (!message || typeof message !== 'object') fail('a message must be an object');
  if (!KNOWN.has(message.type)) fail(`unknown message type: ${message.type}`);
  validate(message);
  const frame = JSON.stringify({ v: PROTOCOL_VERSION, ...message });
  const bytes = new TextEncoder().encode(frame).length;
  if (bytes > MAX_FRAME_BYTES) {
    fail(`a frame of ${bytes} bytes is over the ${MAX_FRAME_BYTES} byte limit`);
  }
  return frame;
}

export function decode(frame) {
  let message;
  try {
    message = JSON.parse(frame);
  } catch {
    fail('the frame is not JSON');
  }
  if (!message || typeof message !== 'object') fail('the frame is not an object');
  if (message.v !== PROTOCOL_VERSION) fail(`protocol version ${message.v} is not ${PROTOCOL_VERSION}`);
  if (!KNOWN.has(message.type)) fail(`unknown message type: ${message.type}`);
  return validate(message);
}

// Split an input batch until every frame fits. Order is kept.
export function splitInput(message) {
  if (!message || message.type !== 'input') fail('splitInput needs an input message');
  const out = [];
  let batch = [];
  for (const record of message.records) {
    batch.push(record);
    let fits = true;
    try {
      encode({ ...message, records: batch });
    } catch {
      fits = false;
    }
    if (!fits) {
      const last = batch.pop();
      if (!batch.length) fail('one input record is over the frame limit');
      out.push({ ...message, records: batch });
      batch = [last];
    }
  }
  if (batch.length) out.push({ ...message, records: batch });
  return out;
}
