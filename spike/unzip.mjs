// Minimal ZIP reader for the Firefox archive. Handles stored and deflate entries.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function findEndOfCentralDirectory(buf) {
  const stop = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('no end of central directory record');
}

// One walk over the central directory. A signed XPI holds a manifest and a
// signature block beside twenty payload files, and a caller that needs two
// names should not unpack the rest.
function* centralEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  let cursor = centralOffset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`bad central directory entry at ${cursor}`);
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    yield { buf, method, compressedSize, localOffset, name };
  }
}

function entryData(entry) {
  const { buf, method, compressedSize, localOffset, name } = entry;
  const localNameLength = buf.readUInt16LE(localOffset + 26);
  const localExtraLength = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const raw = buf.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return Buffer.from(raw);
  if (method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${method} for ${name}`);
}

// One named file, or null when the archive holds no such name.
export function zipEntry(zipPath, wanted) {
  const buf = fs.readFileSync(zipPath);
  for (const entry of centralEntries(buf)) {
    if (entry.name === wanted) return entryData(entry);
  }
  return null;
}

export function unzipTo(zipPath, dest) {
  const buf = fs.readFileSync(zipPath);
  const root = path.resolve(dest);
  let written = 0;

  for (const entry of centralEntries(buf)) {
    const { name } = entry;
    if (name.endsWith('/')) continue;

    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) throw new Error(`path escapes archive: ${name}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entryData(entry));
    written += 1;
  }

  return written;
}
