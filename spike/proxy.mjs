// A bad link, on purpose. This proxy sits between a room tab and the relay and
// adds one-way delay and message loss in both directions. It speaks WebSocket
// to both sides, so a dropped message is a whole message rather than a torn
// frame, and every message in the protocol is safe to lose.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8788);
const UPSTREAM = process.env.UPSTREAM || 'ws://127.0.0.1:8787';
const DELAY_MS = Number(process.env.DELAY_MS || 120);
const DROP_RATE = Number(process.env.DROP_RATE || 0.05);

const stats = { up: 0, down: 0, droppedUp: 0, droppedDown: 0 };

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/stats') {
    const body = JSON.stringify({ ...stats, delayMs: DELAY_MS, dropRate: DROP_RATE });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return false;
  }
  const digest = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + digest + '\r\n\r\n'
  );
  return true;
}

function sendFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function readFrames(session, onText) {
  let buf = session.buf;
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) break;
    const mask = masked ? buf.subarray(off, off + 4) : null;
    const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    buf = buf.subarray(off + maskLen + len);
    if (opcode === 1) onText(payload.toString('utf8'));
    if (opcode === 8) {
      session.closed = true;
      break;
    }
  }
  session.buf = buf;
}

server.on('upgrade', (req, socket) => {
  if (!accept(req, socket)) return;

  const upstream = new WebSocket(UPSTREAM + req.url);
  const pending = [];
  const session = { buf: Buffer.alloc(0), closed: false };

  const toUpstream = (text) => {
    if (upstream.readyState === 1) upstream.send(text);
    else if (upstream.readyState === 0) pending.push(text);
  };

  const sendDown = (text) => {
    if (!socket.destroyed) sendFrame(socket, 0x01, Buffer.from(text, 'utf8'));
  };

  const impairUp = (text) => {
    if (Math.random() < DROP_RATE) {
      stats.droppedUp += 1;
      return;
    }
    stats.up += 1;
    setTimeout(() => toUpstream(text), DELAY_MS);
  };

  upstream.onopen = () => {
    for (const text of pending.splice(0)) upstream.send(text);
  };
  upstream.onmessage = (event) => {
    const text = typeof event.data === 'string' ? event.data : String(event.data);
    if (Math.random() < DROP_RATE) {
      stats.droppedDown += 1;
      return;
    }
    stats.down += 1;
    setTimeout(() => sendDown(text), DELAY_MS);
  };
  upstream.onclose = () => socket.end();
  upstream.onerror = () => socket.end();

  socket.on('data', (chunk) => {
    session.buf = Buffer.concat([session.buf, chunk]);
    readFrames(session, impairUp);
  });
  socket.on('close', () => {
    try {
      upstream.close();
    } catch {
      // Already gone.
    }
  });
  socket.on('error', () => socket.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[proxy] :${PORT} -> ${UPSTREAM}, delay ${DELAY_MS} ms one way, drop rate ${DROP_RATE}`
  );
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
