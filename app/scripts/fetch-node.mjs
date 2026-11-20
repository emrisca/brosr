// Downloads and verifies the official Node.js runtime binary for a desktop
// release target so installed Brosr builds run with zero system Node.js
// prerequisite on fresh Windows and macOS machines.
//
//   node app/scripts/fetch-node.mjs --target x86_64-pc-windows-msvc --out /tmp/node.exe
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipEntry } from '../../spike/unzip.mjs';

export const NODE_VERSION = '22.23.5';

export const NODE_TARGETS = {
  'aarch64-apple-darwin': {
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    entry: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
    sha256: 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d',
    binary: 'node',
    format: 'macho-arm64',
  },
  'x86_64-apple-darwin': {
    archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    entry: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
    sha256: 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422',
    binary: 'node',
    format: 'macho-x64',
  },
  'x86_64-pc-windows-msvc': {
    archive: `node-v${NODE_VERSION}-win-x64.zip`,
    entry: `node-v${NODE_VERSION}-win-x64/node.exe`,
    sha256: '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3',
    binary: 'node.exe',
    format: 'pe-x64',
  },
};

export function targetSpec(target) {
  const spec = NODE_TARGETS[target];
  if (!spec) {
    throw new Error(
      `unsupported target "${target}". Expected one of: ${Object.keys(NODE_TARGETS).join(', ')}`
    );
  }
  return spec;
}

// Verify the extracted binary matches the requested OS and CPU architecture so
// cross-compiled builds (such as x86_64-apple-darwin built on an arm64 runner)
// can never bundle the host runner's CPU binary by mistake.
export function verifyBinaryHeader(buffer, expectedFormat) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    throw new Error(`binary is too small to inspect (${buffer?.length ?? 0} bytes)`);
  }

  if (expectedFormat === 'pe-x64') {
    if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
      throw new Error('expected Windows PE executable starting with MZ');
    }
    if (buffer.length < 64) {
      throw new Error('Windows PE header is truncated before e_lfanew');
    }
    const peOffset = buffer.readUInt32LE(60);
    if (peOffset + 6 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
      throw new Error('expected PE\\0\\0 signature in Windows binary');
    }
    const machine = buffer.readUInt16LE(peOffset + 4);
    if (machine !== 0x8664) {
      throw new Error(`expected Windows x64 PE machine 0x8664, got 0x${machine.toString(16)}`);
    }
    return;
  }

  if (expectedFormat === 'macho-arm64' || expectedFormat === 'macho-x64') {
    const magic = buffer.readUInt32LE(0);
    if (magic !== 0xfeedfacf) {
      throw new Error(`expected 64-bit Mach-O binary (0xfeedfacf), got 0x${magic.toString(16)}`);
    }
    const cputype = buffer.readUInt32LE(4);
    const wanted = expectedFormat === 'macho-arm64' ? 0x0100000c : 0x01000007;
    if (cputype !== wanted) {
      throw new Error(
        `Mach-O CPU type mismatch for ${expectedFormat}: expected 0x${wanted.toString(16)}, got 0x${cputype.toString(16)}`
      );
    }
    return;
  }

  throw new Error(`unknown binary format "${expectedFormat}"`);
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function downloadFile(url, dest) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      }
    }
  }
  throw new Error(`failed to download ${url}: ${lastError?.message || lastError}`);
}

export async function fetchNodeBinary({
  target,
  outPath,
  baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`,
  cacheDir = '',
}) {
  const spec = targetSpec(target);
  const resolvedOut = path.resolve(outPath);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'brosr-fetch-node-'));

  try {
    const archivePath = cacheDir
      ? path.join(path.resolve(cacheDir), spec.archive)
      : path.join(scratch, spec.archive);

    if (!fs.existsSync(archivePath) || sha256File(archivePath) !== spec.sha256) {
      const url = `${baseUrl.replace(/\/$/, '')}/${spec.archive}`;
      await downloadFile(url, archivePath);
    }

    const actualHash = sha256File(archivePath);
    if (actualHash !== spec.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${spec.archive}: expected ${spec.sha256}, got ${actualHash}`
      );
    }

    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

    if (spec.archive.endsWith('.zip')) {
      const data = zipEntry(archivePath, spec.entry);
      if (!data) {
        throw new Error(`archive ${spec.archive} does not contain ${spec.entry}`);
      }
      verifyBinaryHeader(data, spec.format);
      fs.writeFileSync(resolvedOut, data);
    } else if (spec.archive.endsWith('.tar.gz')) {
      const extractDir = path.join(scratch, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });
      const tar = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir, spec.entry], {
        encoding: 'utf8',
      });
      if (tar.status !== 0) {
        throw new Error(`tar failed extracting ${spec.entry}: ${(tar.stderr || tar.stdout || '').trim()}`);
      }
      const extracted = path.join(extractDir, spec.entry);
      if (!fs.existsSync(extracted)) {
        throw new Error(`tar did not produce ${spec.entry}`);
      }
      const header = Buffer.alloc(128);
      const fd = fs.openSync(extracted, 'r');
      try {
        fs.readSync(fd, header, 0, header.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      verifyBinaryHeader(header, spec.format);
      fs.copyFileSync(extracted, resolvedOut);
      if (process.platform !== 'win32') {
        fs.chmodSync(resolvedOut, 0o755);
      }
    } else {
      throw new Error(`unsupported archive format: ${spec.archive}`);
    }

    const stat = fs.statSync(resolvedOut);
    return { target, version: NODE_VERSION, path: resolvedOut, bytes: stat.size };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function argValue(name) {
  const flag = `--${name}`;
  const hit = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  if (hit) return hit.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : '';
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) {
  const target = argValue('target');
  const outPath = argValue('out');
  const cacheDir = argValue('cache');
  if (!target || !outPath) {
    console.error('[fetch-node] usage: node app/scripts/fetch-node.mjs --target <triple> --out <path>');
    process.exit(2);
  }
  try {
    const info = await fetchNodeBinary({ target, outPath, cacheDir });
    const mb = (info.bytes / (1024 * 1024)).toFixed(1);
    console.log(`[fetch-node] Node v${info.version} (${info.target}, ${mb} MB) -> ${info.path}`);
  } catch (error) {
    console.error(`[fetch-node] ${error.message || error}`);
    process.exit(1);
  }
}
