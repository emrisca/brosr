// P-Stream ships a Chromium build in the Chrome Web Store. A room loads an
// unpacked folder, so setup downloads the signed CRX once and strips its header
// before the ZIP reader runs. A cached folder answers later starts without a
// network request.
import fs from 'node:fs';
import path from 'node:path';
import { unzipTo } from '../spike/unzip.mjs';

export const PSTREAM = {
  id: 'geimjiobahmbkmaigaafjnoanebpmlmj',
  name: 'P-Stream Enchanced',
  minBytes: 200000,
};

const FETCH_MS = 30000;
const FOLDER = 'p-stream-chrome';
const STORE_VERSION = '138.0.0.0';

// The store answers an update request with a redirect to the current CRX. The
// OS fields make the request look like the browser that will load the result.
function storeUrl() {
  const osName = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform] || 'linux';
  const arm = process.arch === 'arm64';
  const arch = arm ? 'arm64' : 'x64';
  const osArch = arm ? 'arm64' : 'x86_64';
  const nacl = arm ? 'arm64' : 'x86-64';
  return [
    'https://clients2.google.com/service/update2/crx?response=redirect',
    `&os=${osName}&arch=${arch}&os_arch=${osArch}&nacl_arch=${nacl}`,
    '&prod=chromiumcrx&prodchannel=unknown',
    `&prodversion=${STORE_VERSION}&acceptformat=crx2,crx3`,
    `&x=id%3D${PSTREAM.id}%26uc`,
  ].join('');
}

export function cachePath(dir) {
  return path.join(dir, 'p-stream.crx');
}

// The unpacked folder is what --load-extension takes, so the manifest is the
// marker for a complete copy.
export function pstreamCopy(dir) {
  const folder = path.join(dir, FOLDER);
  return fs.existsSync(path.join(folder, 'manifest.json')) ? folder : null;
}

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// A CRX holds a small header before the ZIP payload. CRX3 stores one header
// length, and CRX2 stores a public key and a signature length.
export function crxPayload(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'Cr24') {
    throw new Error('not a CRX file');
  }
  const version = buf.readUInt32LE(4);
  let offset;
  if (version === 3) {
    offset = 12 + buf.readUInt32LE(8);
  } else if (version === 2) {
    if (buf.length < 16) throw new Error('the CRX2 header is shorter than its fields');
    offset = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  } else {
    throw new Error(`unsupported CRX version ${version}`);
  }
  if (offset >= buf.length) throw new Error('the CRX holds no payload');
  return buf.subarray(offset);
}

// The archive may hold one wrapper folder. The manifest names the root, so the
// unpack reads that rather than guessing a folder name.
export function unpackCrx(crxPath, dir) {
  const scratch = path.join(dir, `${FOLDER}.tmp`);
  const zip = path.join(dir, 'p-stream.zip');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  fs.mkdirSync(scratch, { recursive: true });
  try {
    fs.writeFileSync(zip, crxPayload(fs.readFileSync(crxPath)));
    unzipTo(zip, scratch);
    // Chrome marks this folder as store metadata. An unpacked copy does not
    // need it, and the loader reserves names that start with an underscore.
    fs.rmSync(path.join(scratch, '_metadata'), { recursive: true, force: true });
    let root = scratch;
    if (!fs.existsSync(path.join(root, 'manifest.json'))) {
      const inner = fs
        .readdirSync(scratch, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(scratch, entry.name))
        .find((folder) => fs.existsSync(path.join(folder, 'manifest.json')));
      if (!inner) throw new Error('the archive holds no manifest');
      root = inner;
    }
    const target = path.join(dir, FOLDER);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(root, target);
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const ready = pstreamCopy(dir);
  if (!ready) throw new Error('the unpacked folder has no manifest');
  return { dir: ready, version: readVersion(ready) };
}

// One call for the start path. A folder from an earlier run answers at once,
// and a refresh option takes the current store build.
export async function stagePStream(dir, options = {}) {
  const hit = pstreamCopy(dir);
  if (hit && !options.refresh) {
    return { dir: hit, staged: false, version: readVersion(hit) };
  }
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(storeUrl(), {
    redirect: 'follow',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < PSTREAM.minBytes) throw new Error(`${body.length} bytes is too small`);
  fs.writeFileSync(cachePath(dir), body);
  const unpacked = unpackCrx(cachePath(dir), dir);
  return { ...unpacked, staged: true, bytes: body.length };
}

export function why(error) {
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `no answer in ${FETCH_MS / 1000} s`;
  }
  return String((error && error.message) || error);
}
