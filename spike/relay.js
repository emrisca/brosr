'use strict';
// Spike relay: static fixtures plus a minimal RFC 6455 text-frame fan-out.
// No dependencies. Text frames only, no fragmentation, one room.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
// Loopback by default. A LAN test sets HOST=0.0.0.0, and this relay has no
// authentication, so never do that on a network you do not trust.
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, 'fixtures');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// One table per room. A frame never crosses from one room to another.
const rooms = new Map();
const stats = { forwarded: 0 };

function leave(client) {
  const room = rooms.get(client.room);
  if (!room) return;
  room.delete(client);
  if (!room.size) rooms.delete(client.room);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (url.pathname === '/stats') {
    const body = JSON.stringify({
      rooms: Object.fromEntries([...rooms].map(([name, set]) => [name, set.size])),
      forwarded: stats.forwarded,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  if (url.pathname === '/media/clip.webm') {
    serveMedia(path.join(__dirname, '.runtime', 'clip.webm'), req, res);
    return;
  }
  const rel = url.pathname === '/' ? '/sync.html' : url.pathname;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  serve(file, res);
});

// A video element seeks with range requests, so the fixture clip serves them.
function serveMedia(file, req, res) {
  fs.stat(file, (err, stat) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || end < start) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-type': 'video/webm',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'content-length': end - start + 1,
        'cache-control': 'no-store',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': 'video/webm',
      'accept-ranges': 'bytes',
      'content-length': stat.size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function serve(file, res) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/room')) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const room = url.searchParams.get('room') || 'default';
  const client = { socket, buf: Buffer.alloc(0), room };
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(client);
  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    readFrames(client);
  });
  socket.on('close', () => leave(client));
  socket.on('error', () => leave(client));
});

function readFrames(client) {
  let buf = client.buf;
  for (;;) {
    if (buf.length < 2) break;
    const b0 = buf[0];
    const b1 = buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
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
    if (opcode === 1) {
      const text = payload.toString('utf8');
      const room = rooms.get(client.room);
      if (room) {
        for (const other of room) {
          if (other !== client) {
            sendFrame(other, 0x01, Buffer.from(text, 'utf8'));
            stats.forwarded += 1;
          }
        }
      }
    } else if (opcode === 8) {
      leave(client);
      client.socket.end();
    } else if (opcode === 9) {
      sendFrame(client, 0x0a, payload);
    }
  }
  client.buf = buf;
}

function sendFrame(client, opcode, payload) {
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
  client.socket.write(Buffer.concat([header, payload]));
}

server.listen(PORT, HOST, () => {
  console.log(`[relay] http://${HOST}:${PORT} ws://${HOST}:${PORT}/room`);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
