// Draws the regular toolbar icon: a speech bubble with three dots. The app
// icon stays brosr-icon.png. Firefox paints these PNGs in the toolbar and in
// the sidebar picker, so they carry alpha and a neutral grey that reads on a
// light and on a dark toolbar.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 32, 48];
const INK = [0x6e, 0x6e, 0x78];
const SAMPLES = 4;

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encode(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The drawing is described in a 32 unit square and sampled at each size.
function inBubble(x, y) {
  const left = 4;
  const right = 28;
  const top = 5;
  const bottom = 21;
  const radius = 5;
  if (x >= left && x <= right && y >= top && y <= bottom) {
    const nearX = Math.min(Math.max(x, left + radius), right - radius);
    const nearY = Math.min(Math.max(y, top + radius), bottom - radius);
    if ((x - nearX) ** 2 + (y - nearY) ** 2 <= radius ** 2) return true;
  }
  // A tail below the left side points at the speaker.
  const ax = 10;
  const ay = 21;
  const bx = 17;
  const by = 21;
  const cx = 11;
  const cy = 28;
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const s = (y - ay) * (cx - ax) - (x - ax) * (cy - ay);
  const t = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  return area > 0 ? s >= 0 && t >= 0 && s + t <= area : s <= 0 && t <= 0 && s + t >= area;
}

const DOTS = [
  [11.5, 13],
  [16, 13],
  [20.5, 13],
];

function inDot(x, y) {
  return DOTS.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= 2 ** 2);
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const unit = 32 / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const ux = (x + (sx + 0.5) / SAMPLES) * unit;
          const uy = (y + (sy + 0.5) / SAMPLES) * unit;
          if (inBubble(ux, uy) && !inDot(ux, uy)) hits += 1;
        }
      }
      const at = (y * size + x) * 4;
      pixels[at] = INK[0];
      pixels[at + 1] = INK[1];
      pixels[at + 2] = INK[2];
      pixels[at + 3] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

function main() {
  for (const size of SIZES) {
    const out = path.join(here, `action-${size}.png`);
    fs.writeFileSync(out, encode(size, draw(size)));
    console.log(`[icons] ${path.basename(out)} ${fs.statSync(out).size} bytes`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
