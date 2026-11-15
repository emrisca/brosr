// A Chromium room ships the Lite build of uBlock Origin. The full build is a
// Firefox add-on and Chromium has no Manifest V2 support, so the Lite build is
// the one that installs here. The release zip is fetched at setup and unpacked
// once. A later start reads the folder beside the bridge and needs no network.
import fs from 'node:fs';
import path from 'node:path';
import { unzipTo } from '../spike/unzip.mjs';

export const BLOCKER = {
  id: 'uBOL',
  name: 'uBlock Origin Lite',
  repo: 'uBlockOrigin/uBOL-home',
  // The release holds one Chromium asset, and its name carries the version.
  // An older release named the same asset .chromium.mv3.zip, so both forms
  // match and a pinned release still installs.
  asset: /\.chromium(\.mv3)?\.zip$/i,
  minBytes: 200000,
};

const FETCH_MS = 30000;
const FOLDER = 'ublock-lite';

// A stall must not hold the setup, so each request has a deadline.
function why(error) {
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `no answer in ${FETCH_MS / 1000} s`;
  }
  return String((error && error.message) || error);
}

export function cachePath(dir) {
  return path.join(dir, 'ublock-lite.zip');
}

// The unpacked folder is what --load-extension takes, so the manifest is the
// marker for a complete copy.
export function blockerCopy(dir) {
  const folder = path.join(dir, FOLDER);
  return fs.existsSync(path.join(folder, 'manifest.json')) ? folder : null;
}

export async function fetchRelease() {
  const res = await fetch(`https://api.github.com/repos/${BLOCKER.repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'brosr' },
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const asset = (body.assets || []).find((entry) => BLOCKER.asset.test(entry.name || ''));
  if (!asset || !asset.browser_download_url) {
    throw new Error('the release holds no Chromium build');
  }
  return { tag: body.tag_name || asset.name, url: asset.browser_download_url };
}

// The archive may hold one wrapper folder. The manifest names the root, so the
// unpack reads that rather than guessing a folder name.
function unpack(zip, dir) {
  const scratch = path.join(dir, `${FOLDER}.tmp`);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  unzipTo(zip, scratch);
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
  fs.rmSync(scratch, { recursive: true, force: true });
}

// One call for the start path. A folder from an earlier run answers at once,
// and a refresh option takes the current release.
export async function stageBlocker(dir, options = {}) {
  const hit = blockerCopy(dir);
  if (hit && !options.refresh) return { dir: hit, staged: false, tag: null };
  fs.mkdirSync(dir, { recursive: true });
  const { tag, url } = await fetchRelease();
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < BLOCKER.minBytes) throw new Error(`${body.length} bytes is too small`);
  fs.writeFileSync(cachePath(dir), body);
  unpack(cachePath(dir), dir);
  const ready = blockerCopy(dir);
  if (!ready) throw new Error('the unpacked folder has no manifest');
  return { dir: ready, staged: true, tag, bytes: body.length };
}

export { why };
