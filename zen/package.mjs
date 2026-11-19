// Builds the bridge XPI for AMO signing and for a room profile. One file list,
// so the artifact that gets signed is the artifact the profile installs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../spike/zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bridge = path.join(root, 'bridge');
const core = path.join(root, 'core');
const MANIFEST = path.join(bridge, 'manifest.json');
const CHROME_MANIFEST = path.join(bridge, 'manifest.chrome.json');

// The file list is derived from the imports instead of kept by hand. A hand
// kept list already shipped a bundle one module short: the injected core failed
// at its import, and every room page lost its dataset and its socket. The walk
// starts at every module the bridge loads as an entry, and a module the entries
// cannot reach, such as the host side friends.mjs, stays out.
const ENTRIES = ['browser-entry.mjs', 'page-entry.mjs', 'panel.mjs'];

export function coreFiles() {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    const file = path.join(core, name);
    if (!fs.existsSync(file)) return;
    seen.add(name);
    const source = fs.readFileSync(file, 'utf8');
    for (const hit of source.matchAll(/from\s+'\.\/([\w-]+\.mjs)'/g)) walk(hit[1]);
    for (const hit of source.matchAll(/import\s+'\.\/([\w-]+\.mjs)'/g)) walk(hit[1]);
  };
  for (const name of ENTRIES) walk(name);
  return [...seen].sort();
}

const CORE = coreFiles();
const PANEL = ['room.html', 'room.css', 'sync-report.js', 'room.js'];
const ICONS = [16, 32, 48, 96, 128];
const ACTIONS = ['action-16.png', 'action-32.png', 'action-48.png'];

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const read = (file) => fs.readFileSync(file);

export function bridgeEntries(manifest = MANIFEST) {
  return [
    { name: 'manifest.json', data: read(manifest) },
    { name: 'content.js', data: read(path.join(bridge, 'content.js')) },
    { name: 'bridge-youtube.js', data: read(path.join(bridge, 'bridge-youtube.js')) },
    { name: 'background.js', data: read(path.join(bridge, 'background.js')) },
    ...CORE.map((name) => ({ name: `core/${name}`, data: read(path.join(core, name)) })),
    ...PANEL.map((name) => ({ name: `panel/${name}`, data: read(path.join(bridge, 'panel', name)) })),
    ...ICONS.map((size) => ({
      name: `assets/icon-${size}.png`,
      data: read(path.join(root, 'assets', `icon-${size}.png`)),
    })),
    ...ACTIONS.map((name) => ({ name: `assets/${name}`, data: read(path.join(root, 'assets', name)) })),
  ];
}

export function buildXpi(out = path.join(here, '.runtime', 'bridge.xpi')) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const entries = bridgeEntries();
  fs.writeFileSync(out, makeZip(entries));
  return { out, entries: entries.length };
}

// Chromium loads an unpacked folder, and it reads the V3 manifest. The file set
// is the same one the XPI holds, so a fix lands in both builds.
export function buildChrome(out = path.join(here, '.runtime', 'bridge-chrome')) {
  const target = path.resolve(out);
  fs.rmSync(target, { recursive: true, force: true });
  const entries = bridgeEntries(CHROME_MANIFEST);
  for (const entry of entries) {
    const file = path.join(target, entry.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.data);
  }
  return { dir: target, entries: entries.length };
}

// web-ext signs a directory, so this writes the same files an XPI holds.
export function stageBridge(dir) {
  const target = path.resolve(dir);
  const entries = bridgeEntries();
  for (const entry of entries) {
    const file = path.join(target, entry.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.data);
  }
  return { dir: target, entries: entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const { out, entries } = buildXpi(arg('out', path.join(here, '.runtime', 'bridge.xpi')));
  const id = manifest.browser_specific_settings.gecko.id;
  console.log(`[brosr] ${manifest.name} ${manifest.version} ${id}`);
  console.log(`[brosr] ${entries} files -> ${out}`);
  console.log(`[brosr] ${fs.statSync(out).size} bytes`);
  const stage = arg('stage', '');
  if (stage) console.log(`[brosr] staged for web-ext -> ${stageBridge(stage).dir}`);
  console.log(`[brosr] profile copy needs the name ${id}.xpi`);
}
