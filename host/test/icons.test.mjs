// Boundary tests for Windows vs macOS desktop app icons.
// macOS (icon.icns) keeps Apple HIG squircle padding (~80% fill), while
// Windows (icon.ico, assets/brosr.ico, and Windows PNG tiles) must trim that
// extra transparent margin so desktop and taskbar icons are full-sized.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const tauriIcons = path.join(repo, 'app', 'src-tauri', 'icons');

function parseIco(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved header must be 0');
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type must be 1');
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const width = buf.readUInt8(at) || 256;
    const height = buf.readUInt8(at + 1) || 256;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    entries.push({
      width,
      height,
      data: buf.subarray(offset, offset + size),
    });
  }
  return entries;
}

function pngFillRatio(pngBuf) {
  assert.equal(pngBuf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'expected PNG data');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks = [];
  while (pos < pngBuf.length) {
    const length = pngBuf.readUInt32BE(pos);
    const type = pngBuf.toString('ascii', pos + 4, pos + 8);
    const chunk = pngBuf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk.readUInt8(9);
    } else if (type === 'IDAT') {
      idatChunks.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
  }
  assert.equal(colorType, 6, 'expected RGBA PNG');
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowOffset = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? pixels[dst + x - bpp] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = y > 0 && x >= bpp ? pixels[dst - stride + x - bpp] : 0;
      let val = raw[rowOffset + x];
      if (filter === 1) val = (val + a) & 0xff;
      else if (filter === 2) val = (val + b) & 0xff;
      else if (filter === 3) val = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        val = (val + pr) & 0xff;
      }
      pixels[dst + x] = val;
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[y * stride + x * 4 + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    width,
    height,
    fillX: (maxX - minX + 1) / width,
    fillY: (maxY - minY + 1) / height,
  };
}

test('Windows app icon.ico includes crisp sizes and fills >= 94% of canvas (no macOS Dock padding)', () => {
  const icoPath = path.join(tauriIcons, 'icon.ico');
  const entries = parseIco(icoPath);
  const sizes = entries.map((e) => e.width).sort((a, b) => a - b);
  for (const required of [16, 24, 32, 48, 64, 128, 256]) {
    assert.ok(sizes.includes(required), `icon.ico must include ${required}x${required}, got [${sizes}]`);
  }

  const largest = entries.find((e) => e.width === 256);
  const metrics = pngFillRatio(largest.data);
  assert.ok(
    metrics.fillX >= 0.94 && metrics.fillY >= 0.94,
    `Windows icon.ico 256px fill is too small (${(metrics.fillX * 100).toFixed(1)}% x ${(metrics.fillY * 100).toFixed(1)}%), expected >= 94%`
  );
});

test('assets/brosr.ico and Windows tile/window PNGs match full-size Windows fill while macOS master keeps HIG padding', () => {
  const brosrIco = parseIco(path.join(repo, 'assets', 'brosr.ico'));
  const brosr256 = brosrIco.find((e) => e.width === 256);
  assert.ok(brosr256, 'assets/brosr.ico must include 256x256');
  const icoMetrics = pngFillRatio(brosr256.data);
  assert.ok(
    icoMetrics.fillX >= 0.94 && icoMetrics.fillY >= 0.94,
    `assets/brosr.ico fill is too small (${(icoMetrics.fillX * 100).toFixed(1)}%)`
  );

  for (const name of ['128x128@2x.png', 'Square150x150Logo.png', 'Square310x310Logo.png']) {
    const metrics = pngFillRatio(fs.readFileSync(path.join(tauriIcons, name)));
    assert.ok(
      metrics.fillX >= 0.94 && metrics.fillY >= 0.94,
      `${name} fill is too small (${(metrics.fillX * 100).toFixed(1)}%)`
    );
  }

  // macOS master preserves Apple HIG squircle padding (~80.5%) and icon.icns remains intact.
  const macMaster = pngFillRatio(fs.readFileSync(path.join(repo, 'assets', 'brosr-icon.png')));
  assert.ok(
    macMaster.fillX >= 0.78 && macMaster.fillX <= 0.84,
    `assets/brosr-icon.png macOS HIG fill drifted (${(macMaster.fillX * 100).toFixed(1)}%)`
  );
  assert.ok(fs.statSync(path.join(tauriIcons, 'icon.icns')).size > 10000);
});
