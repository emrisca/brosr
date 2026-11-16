'use strict';
// Spike relay: static fixtures plus a minimal RFC 6455 text-frame fan-out.
// No dependencies. Text frames only, no fragmentation, one room.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const STARTED = Date.now();
// Loopback by default. A LAN test sets HOST=0.0.0.0, and this relay has no
// authentication, so never do that on a network you do not trust.
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, 'fixtures');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// One table per room. A frame never crosses from one room to another.
const rooms = new Map();
const stats = { forwarded: 0, text: 0, binary: 0 };
// A proof reads this file to show what the relay saw. It stays off by default,
// because a capture holds every frame the room carried.
const CAPTURE = process.env.RELAY_CAPTURE || '';

// Documents. A canvas or a note is one small JSON file in this folder, which
// lives on the host machine. The host tab reads the library over this API. A
// guest never calls it: the room carries the library, so a peer needs no token.
const DOCS_DIR = process.env.BROSR_DOCS_DIR
  ? path.resolve(process.env.BROSR_DOCS_DIR)
  : path.join(__dirname, '.runtime', 'docs');
const DOCS_TOKEN = process.env.BROSR_DOCS_TOKEN || '';
const DOC_KINDS = new Set(['canvas', 'note']);
const DOC_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DOC_MAX = 4 * 1024 * 1024;

function capture(room, opcode, payload) {
  if (!CAPTURE) return;
  fs.appendFileSync(
    CAPTURE,
    JSON.stringify({ room, opcode, bytes: payload.length, hex: payload.toString('hex') }) + '\n'
  );
}

// A count says a room changed. The address says which machine changed it, and
// a leave with no join beside it is easier to spot than a number that fell.
function addressOf(socket) {
  const raw = (socket && socket.remoteAddress) || '';
  return raw.replace(/^::ffff:/, '') || 'unknown';
}

function note(action, client, peers) {
  if (process.env.RELAY_QUIET) return;
  console.error(
    `[relay] ${action} ${client.remote} room=${client.room} peers=${peers} uptime=${
      Date.now() - STARTED
    }ms`
  );
}

function leave(client) {
  const room = rooms.get(client.room);
  if (!room) return;
  if (!room.delete(client)) return;
  if (!room.size) rooms.delete(client.room);
  note('leave', client, room.size);
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
      text: stats.text,
      binary: stats.binary,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  // The app asks how many people are in the room. One small read keeps that
  // number out of the frame path and gives the webview no new transport.
  if (url.pathname === '/status') {
    const room = url.searchParams.get('room') || '';
    const body = JSON.stringify({
      room,
      peers: room && rooms.has(room) ? rooms.get(room).size : 0,
      rooms: Object.fromEntries([...rooms].map(([name, set]) => [name, set.size])),
      uptime: Math.round((Date.now() - STARTED) / 1000),
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(body);
    return;
  }
  // The docs client and the notes app ship beside the canvas, so one relay
  // serves every room app without a second front door.
  if (url.pathname === '/docs-client.js') {
    serve(path.join(__dirname, '..', 'landing', 'docs-client.js'), res);
    return;
  }
  if (url.pathname === '/notes' || url.pathname.startsWith('/notes/')) {
    const name =
      url.pathname === '/notes' || url.pathname === '/notes/'
        ? 'index.html'
        : path.basename(url.pathname);
    serve(path.join(__dirname, '..', 'landing', 'notes', name), res);
    return;
  }
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
    handleDocs(req, res, url);
    return;
  }
  // Any clip in the runtime folder, so a long fixture needs no new route.
  // The base name strips a traversal attempt before it reaches the disk.
  if (url.pathname.startsWith('/media/')) {
    serveMedia(path.join(__dirname, '.runtime', path.basename(url.pathname)), req, res);
    return;
  }
  // The mark lives in one folder, so a room page needs no copy.
  if (url.pathname.startsWith('/assets/')) {
    serve(path.join(__dirname, '..', 'assets', path.basename(url.pathname)), res);
    return;
  }
  // The landing page is the room front door, with one tile per Brosr app. It
  // sits beside the fixtures so a room and its apps ship together.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serve(path.join(__dirname, '..', 'landing', 'index.html'), res);
    return;
  }
  if (url.pathname === '/landing.css') {
    serve(path.join(__dirname, '..', 'landing', 'landing.css'), res);
    return;
  }
  if (url.pathname === '/canvas' || url.pathname.startsWith('/canvas/')) {
    const name =
      url.pathname === '/canvas' || url.pathname === '/canvas/'
        ? 'index.html'
        : path.basename(url.pathname);
    serve(path.join(__dirname, '..', 'landing', 'canvas', name), res);
    return;
  }
  const file = path.join(ROOT, url.pathname);
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

// ---------------------------------------------------------------------------
// Documents

function docsDir() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  return DOCS_DIR;
}

// A token is set by the app. Without one, only a request from this machine can
// read the library, so a bare dev relay still keeps the folder to the host.
function docsAllowed(req, url) {
  if (DOCS_TOKEN) return url.searchParams.get('token') === DOCS_TOKEN;
  const raw = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return raw === '127.0.0.1' || raw === '::1';
}

function docsAnswer(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function docFile(id) {
  return path.join(docsDir(), id + '.json');
}

function docRead(id) {
  if (!DOC_ID.test(String(id || ''))) return null;
  try {
    return JSON.parse(fs.readFileSync(docFile(id), 'utf8'));
  } catch {
    return null;
  }
}

function docLabel(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function docText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function docPreview(doc) {
  if (doc.kind === 'note') return docText(doc.body).slice(0, 140);
  const layers = doc.body && Array.isArray(doc.body.layers) ? doc.body.layers : [];
  let count = 0;
  for (const layer of layers) {
    if (layer && Array.isArray(layer.strokes)) count += layer.strokes.length;
  }
  return count === 1 ? '1 stroke' : count + ' strokes';
}

// The list reads every file, which is cheap for a personal library and keeps
// the preview honest without a second index to fall out of step.
function docList(kind) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(docsDir());
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const doc = docRead(name.slice(0, -5));
    if (!doc || !DOC_KINDS.has(doc.kind)) continue;
    if (kind && doc.kind !== kind) continue;
    out.push({
      id: doc.id,
      kind: doc.kind,
      name: docLabel(doc.name) || 'Untitled',
      at: Number(doc.at) || 0,
      hidden: doc.hidden === true,
      stored: doc.stored !== false,
      preview: docPreview(doc),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

// A temp file then a rename, so a page that saves every second never leaves a
// half written document behind a crash.
function docWrite(doc) {
  const file = docFile(doc.id);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readBody(req, limit, done) {
  const chunks = [];
  let size = 0;
  let closed = false;
  req.on('data', (chunk) => {
    if (closed) return;
    size += chunk.length;
    if (size > limit) {
      closed = true;
      done(new Error('too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (closed) return;
    closed = true;
    try {
      done(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      done(error);
    }
  });
  req.on('error', (error) => {
    if (closed) return;
    closed = true;
    done(error);
  });
}

function handleDocs(req, res, url) {
  if (!docsAllowed(req, url)) {
    docsAnswer(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  const rest = url.pathname === '/docs' ? '' : url.pathname.slice('/docs/'.length);
  const id = rest ? decodeURIComponent(rest) : '';

  if (req.method === 'GET' && !id) {
    docsAnswer(res, 200, { ok: true, docs: docList(url.searchParams.get('kind') || '') });
    return;
  }
  if (req.method === 'GET' && id) {
    const doc = docRead(id);
    if (!doc) {
      docsAnswer(res, 404, { ok: false, error: 'not found' });
      return;
    }
    docsAnswer(res, 200, { ok: true, doc });
    return;
  }
  if (req.method === 'PUT' && id) {
    if (!DOC_ID.test(id)) {
      docsAnswer(res, 400, { ok: false, error: 'bad id' });
      return;
    }
    readBody(req, DOC_MAX, (error, body) => {
      if (error || !body || typeof body !== 'object') {
        docsAnswer(res, 400, { ok: false, error: 'bad body' });
        return;
      }
      const doc = {
        id,
        kind: DOC_KINDS.has(body.kind) ? body.kind : 'note',
        name: docLabel(body.name) || 'Untitled',
        at: Number(body.at) || Date.now(),
        hidden: body.hidden === true,
        stored: body.stored !== false,
        body: body.body === undefined ? null : body.body,
      };
      try {
        docWrite(doc);
      } catch {
        docsAnswer(res, 500, { ok: false, error: 'write failed' });
        return;
      }
      docsAnswer(res, 200, { ok: true, id });
    });
    return;
  }
  if (req.method === 'DELETE' && id) {
    try {
      fs.unlinkSync(docFile(id));
    } catch {
      // A file that is already gone is the state the caller wanted.
    }
    docsAnswer(res, 200, { ok: true });
    return;
  }
  docsAnswer(res, 405, { ok: false, error: 'method' });
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
  const client = { socket, buf: Buffer.alloc(0), room, remote: addressOf(socket) };
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(client);
  note('join', client, rooms.get(room).size);
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
    // A sealed frame is binary. The relay parses neither kind and forwards the
    // opcode with the bytes, so a seal holds end to end.
    if (opcode === 1 || opcode === 2) {
      const out = opcode === 1 ? Buffer.from(payload.toString('utf8'), 'utf8') : payload;
      if (opcode === 1) stats.text += 1;
      else stats.binary += 1;
      capture(client.room, opcode, out);
      const room = rooms.get(client.room);
      if (room) {
        for (const other of room) {
          if (other !== client) {
            sendFrame(other, opcode, out);
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

// A busy port must fail loudly. A caller that only waits for /health would
// otherwise measure against whatever already holds the port.
server.on('error', (err) => {
  console.error(`[relay] cannot listen on ${HOST}:${PORT}: ${err.code || err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] http://${HOST}:${PORT} ws://${HOST}:${PORT}/room`);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
