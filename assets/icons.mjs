// Writes every Brosr icon from the 1024 pixel master. The PNG copies feed the
// extension manifest and the room pages. The ICO carries the same art for a
// Windows shortcut. macOS ships sips, so this needs no dependency.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MASTER = path.join(here, 'brosr-icon.png');
const SIZES = [16, 32, 48, 96, 128, 256];
const ICO_SIZES = [16, 32, 48, 96, 128, 256];

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

function main() {
  if (!fs.existsSync(MASTER)) {
    console.error('[icons] no master at assets/brosr-icon.png');
    process.exit(1);
  }
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
  } catch (error) {
    console.error('[icons] sips is missing. Run this on macOS.');
    process.exit(1);
  }
  const made = [];
  for (const size of SIZES) {
    const out = path.join(here, `icon-${size}.png`);
    execFileSync('sips', ['-z', String(size), String(size), MASTER, '--out', out], {
      stdio: 'ignore',
    });
    made.push({ name: path.basename(out), bytes: fs.statSync(out).size });
  }
  const entries = ICO_SIZES.map((size) => ({
    size,
    data: fs.readFileSync(path.join(here, `icon-${size}.png`)),
  }));
  const ico = writeIco(entries, path.join(here, 'brosr.ico'));
  for (const item of made) console.log(`[icons] ${item.name} ${item.bytes} bytes`);
  console.log(`[icons] ${path.basename(ico)} ${fs.statSync(ico).size} bytes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
