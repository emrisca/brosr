// Writes every Brosr icon from the 1024 pixel master. The PNG copies in
// assets/ keep the macOS squircle padding for the extension manifest and room
// pages. Windows desktop, taskbar, Start tile and ICO assets trim that extra
// macOS Dock margin (cropping the 1024 px master centered to 848 px, ~97.2%
// visible fill) so the Windows icon matches native Windows app icon sizes
// while app/src-tauri/icons/icon.icns keeps its macOS HIG padding untouched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const MASTER = path.join(here, 'brosr-icon.png');
const TAURI_ICONS = path.join(repo, 'app', 'src-tauri', 'icons');
const SIZES = [16, 32, 48, 96, 128, 256];
const WINDOWS_CROP_PX = 848; // 824 px squircle inside 848 px (~97.2% fill)
const ASSETS_ICO_SIZES = [16, 24, 32, 48, 64, 96, 128, 256];
const TAURI_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TAURI_PNG_TARGETS = [
  ['32x32.png', 32],
  ['64x64.png', 64],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
  ['Square30x30Logo.png', 30],
  ['Square44x44Logo.png', 44],
  ['Square71x71Logo.png', 71],
  ['Square89x89Logo.png', 89],
  ['Square107x107Logo.png', 107],
  ['Square142x142Logo.png', 142],
  ['Square150x150Logo.png', 150],
  ['Square284x284Logo.png', 284],
  ['Square310x310Logo.png', 310],
  ['StoreLogo.png', 50],
];

// A Vista era ICO holds PNG data per entry, so a PNG needs no re-encode.
function writeIco(entries, out) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    // A 256 pixel side stores zero in the byte wide field.
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(entry.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  const body = entries.map((entry) => entry.data);
  fs.writeFileSync(out, Buffer.concat([header, dir, ...body]));
  return out;
}

function resizePng(source, size, out) {
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', out], {
    stdio: 'ignore',
  });
}

function main() {
  if (!fs.existsSync(MASTER)) {
    console.error('[icons] no master at assets/brosr-icon.png');
    process.exit(1);
  }
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('[icons] sips is missing. Run this on macOS.');
    process.exit(1);
  }

  const made = [];
  for (const size of SIZES) {
    const out = path.join(here, `icon-${size}.png`);
    resizePng(MASTER, size, out);
    made.push({ name: path.basename(out), bytes: fs.statSync(out).size });
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-win-icons-'));
  try {
    const winMaster = path.join(scratch, 'win-master.png');
    execFileSync(
      'sips',
      ['-c', String(WINDOWS_CROP_PX), String(WINDOWS_CROP_PX), MASTER, '--out', winMaster],
      { stdio: 'ignore' }
    );

    const winCache = new Map();
    const winPngData = (size) => {
      if (!winCache.has(size)) {
        const tmp = path.join(scratch, `win-${size}.png`);
        resizePng(winMaster, size, tmp);
        winCache.set(size, fs.readFileSync(tmp));
      }
      return winCache.get(size);
    };

    const assetsIco = writeIco(
      ASSETS_ICO_SIZES.map((size) => ({ size, data: winPngData(size) })),
      path.join(here, 'brosr.ico')
    );

    const tauriIco = writeIco(
      TAURI_ICO_SIZES.map((size) => ({ size, data: winPngData(size) })),
      path.join(TAURI_ICONS, 'icon.ico')
    );

    for (const [name, size] of TAURI_PNG_TARGETS) {
      const out = path.join(TAURI_ICONS, name);
      resizePng(winMaster, size, out);
    }

    for (const item of made) console.log(`[icons] ${item.name} ${item.bytes} bytes`);
    console.log(`[icons] ${path.basename(assetsIco)} ${fs.statSync(assetsIco).size} bytes`);
    console.log(
      `[icons] app/src-tauri/icons/${path.basename(tauriIco)} ${fs.statSync(tauriIco).size} bytes`
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
