// Finds the browsers on this machine. A room runs in its own profile, so any
// Firefox build can carry the bridge. This module holds the paths, the version
// read and the launch arguments.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The app seals this folder, so a measured start may not be written beside the
// source. The app points BROSR_STATE at the user data folder, and a dev run
// keeps the old layout.
const STATE = process.env.BROSR_STATE ? path.resolve(process.env.BROSR_STATE) : path.join(here, '.run');
const HISTORY = path.join(STATE, 'starts.json');

const PLATFORM = process.platform;
const HOME = os.homedir();

const localAppData = () => process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const roaming = () => process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

// One entry per build. A missing path is normal, so every list is a set of
// places to try and the first hit wins.
const CATALOGUE = [
  {
    id: 'zen',
    name: 'Zen',
    vendor: 'Zen',
    native: true,
    bins: {
      darwin: ['/Applications/Zen.app/Contents/MacOS/zen'],
      win32: [
        path.join(localAppData(), 'Programs', 'Zen Browser', 'zen.exe'),
        'C:\\Program Files\\Zen Browser\\zen.exe',
        'C:\\Program Files (x86)\\Zen Browser\\zen.exe',
      ],
      linux: ['/usr/bin/zen-browser', '/opt/zen-browser/zen', '/usr/lib/zen-browser/zen'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'zen', 'Profiles'),
      win32: path.join(roaming(), 'zen', 'Profiles'),
      linux: path.join(HOME, '.zen'),
    },
  },
  {
    id: 'firefox',
    name: 'Firefox',
    vendor: 'Mozilla',
    native: false,
    bins: {
      darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
      win32: [
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
        path.join(localAppData(), 'Mozilla Firefox', 'firefox.exe'),
      ],
      linux: ['/usr/bin/firefox', '/usr/lib/firefox/firefox', '/snap/bin/firefox'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'Firefox', 'Profiles'),
      win32: path.join(roaming(), 'Mozilla', 'Firefox', 'Profiles'),
      linux: path.join(HOME, '.mozilla', 'firefox'),
    },
  },
  {
    id: 'firefox-developer',
    name: 'Firefox Developer Edition',
    vendor: 'Mozilla',
    native: false,
    bins: {
      darwin: ['/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox'],
      win32: ['C:\\Program Files\\Firefox Developer Edition\\firefox.exe'],
      linux: ['/usr/bin/firefox-developer-edition', '/opt/firefox-developer-edition/firefox'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'Firefox', 'Profiles'),
      win32: path.join(roaming(), 'Mozilla', 'Firefox', 'Profiles'),
      linux: path.join(HOME, '.mozilla', 'firefox'),
    },
  },
  {
    id: 'librewolf',
    name: 'LibreWolf',
    vendor: 'LibreWolf',
    native: false,
    bins: {
      darwin: ['/Applications/LibreWolf.app/Contents/MacOS/librewolf'],
      win32: ['C:\\Program Files\\LibreWolf\\librewolf.exe'],
      linux: ['/usr/bin/librewolf', '/usr/lib/librewolf/librewolf', '/snap/bin/librewolf'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'librewolf', 'Profiles'),
      win32: path.join(roaming(), 'librewolf', 'Profiles'),
      linux: path.join(HOME, '.librewolf'),
    },
  },
  {
    id: 'floorp',
    name: 'Floorp',
    vendor: 'Floorp',
    native: false,
    bins: {
      darwin: ['/Applications/Floorp.app/Contents/MacOS/floorp'],
      win32: ['C:\\Program Files\\Floorp\\floorp.exe'],
      linux: ['/usr/bin/floorp', '/opt/floorp/floorp'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'Floorp', 'Profiles'),
      win32: path.join(roaming(), 'Floorp', 'Profiles'),
      linux: path.join(HOME, '.floorp'),
    },
  },
  {
    id: 'waterfox',
    name: 'Waterfox',
    vendor: 'Waterfox',
    native: false,
    bins: {
      darwin: ['/Applications/Waterfox.app/Contents/MacOS/waterfox'],
      win32: ['C:\\Program Files\\Waterfox\\waterfox.exe'],
      linux: ['/usr/bin/waterfox', '/opt/waterfox/waterfox'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'Waterfox', 'Profiles'),
      win32: path.join(roaming(), 'Waterfox', 'Profiles'),
      linux: path.join(HOME, '.waterfox'),
    },
  },
];

// A Chromium build has no application.ini and no XPI folder, so it reads its
// version from the bundle. It still appears in the list, because a machine that
// has Chrome should see Chrome and the reason it cannot host a room yet.
const CHROMIUM = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    vendor: 'Google',
    supported: false,
    reason: 'Chrome ignores --load-extension from version 137',
    bins: {
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(localAppData(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ],
      linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
    },
    plists: {
      darwin: ['/Applications/Google Chrome.app/Contents/Info.plist'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome'),
      win32: path.join(localAppData(), 'Google', 'Chrome', 'User Data'),
      linux: path.join(HOME, '.config', 'google-chrome'),
    },
  },
  {
    id: 'brave',
    name: 'Brave',
    vendor: 'Brave Software',
    supported: true,
    reason: null,
    bins: {
      darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      win32: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      ],
      linux: ['/usr/bin/brave-browser', '/opt/brave.com/brave/brave'],
    },
    plists: {
      darwin: ['/Applications/Brave Browser.app/Contents/Info.plist'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
      win32: path.join(localAppData(), 'BraveSoftware', 'Brave-Browser', 'User Data'),
      linux: path.join(HOME, '.config', 'BraveSoftware', 'Brave-Browser'),
    },
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    vendor: 'Microsoft',
    supported: true,
    reason: null,
    bins: {
      darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      win32: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    },
    plists: {
      darwin: ['/Applications/Microsoft Edge.app/Contents/Info.plist'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'Microsoft Edge'),
      win32: path.join(localAppData(), 'Microsoft', 'Edge', 'User Data'),
      linux: path.join(HOME, '.config', 'microsoft-edge'),
    },
  },
  {
    id: 'chrome-for-testing',
    name: 'Chrome for Testing',
    vendor: 'Google',
    supported: true,
    reason: null,
    bins: {
      darwin: [
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ],
      win32: [
        'C:\\Program Files\\Google\\Chrome for Testing\\Application\\chrome.exe',
        path.join(localAppData(), 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
      ],
      linux: ['/usr/bin/google-chrome-for-testing', '/opt/google/chrome-for-testing/chrome'],
    },
    plists: {
      darwin: ['/Applications/Google Chrome for Testing.app/Contents/Info.plist'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome for Testing'),
      win32: path.join(localAppData(), 'Google', 'Chrome for Testing', 'User Data'),
      linux: path.join(HOME, '.config', 'google-chrome-for-testing'),
    },
  },
  {
    id: 'chromium',
    name: 'Chromium',
    vendor: 'Chromium',
    supported: true,
    reason: null,
    bins: {
      darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      win32: ['C:\\Program Files\\Chromium\\Application\\chrome.exe'],
      linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    },
    plists: {
      darwin: ['/Applications/Chromium.app/Contents/Info.plist'],
    },
    profiles: {
      darwin: path.join(HOME, 'Library', 'Application Support', 'Chromium'),
      win32: path.join(localAppData(), 'Chromium', 'User Data'),
      linux: path.join(HOME, '.config', 'chromium'),
    },
  },
];

// The Gecko bridge is a Manifest V2 add-on with a background page. Firefox 140
// is the first build this bridge targets.
export const MIN_GECKO = 140;

function readIni(text) {
  const sections = {};
  let current = sections;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = sections[header[1]] = sections[header[1]] || {};
      continue;
    }
    const pair = line.split('=');
    if (pair.length < 2) continue;
    current[pair[0].trim()] = pair.slice(1).join('=').trim();
  }
  return sections;
}

// The version sits beside the binary. A macOS bundle keeps it one folder up in
// Resources, and the other platforms put it next to the executable.
function iniPath(bin) {
  const dir = path.dirname(bin);
  const near = path.join(dir, 'application.ini');
  if (fs.existsSync(near)) return near;
  const bundled = path.join(dir, '..', 'Resources', 'application.ini');
  return fs.existsSync(bundled) ? bundled : null;
}

function geckoMajor(text) {
  const hit = String(text || '').match(/^(\d+)/);
  return hit ? Number(hit[1]) : 0;
}

function inspect(entry) {
  const candidates = (entry.bins[PLATFORM] || []).filter(Boolean);
  const bin = candidates.find((file) => fs.existsSync(file));
  if (!bin) return null;
  const ini = iniPath(bin);
  const sections = ini ? readIni(fs.readFileSync(ini, 'utf8')) : {};
  const app = sections.App || {};
  const gecko = sections.Gecko || {};
  const version = app.Version || null;
  const build = gecko.MaxVersion || version;
  const major = geckoMajor(build);
  return {
    id: entry.id,
    name: entry.name,
    vendor: entry.vendor,
    native: entry.native,
    family: 'gecko',
    path: bin,
    version,
    gecko: build || null,
    geckoMajor: major,
    supported: major >= MIN_GECKO,
    reason: major >= MIN_GECKO ? null : `Needs Gecko ${MIN_GECKO}`,
    profileRoot: entry.profiles[PLATFORM] || null,
    signature: `${entry.id}@${version || 'unknown'}`,
  };
}

// A Chromium bundle names its version in the plist. KSVersion is the full build
// number, and the bundle key is the fallback.
function plistVersion(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const hit =
      text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/) ||
      text.match(/<key>KSVersion<\/key>\s*<string>([^<]+)<\/string>/);
    return hit ? hit[1] : null;
  } catch {
    return null;
  }
}

// The bridge ships a Manifest V3 build for these browsers. Google Chrome is the
// one build that refuses the flag which loads an unpacked add-on, so it keeps an
// entry and a reason. Every other build still reads the flag.
function inspectChromium(entry) {
  const candidates = (entry.bins[PLATFORM] || []).filter(Boolean);
  const bin = candidates.find((file) => fs.existsSync(file));
  if (!bin) return null;
  const plist = (entry.plists[PLATFORM] || [])[0];
  const version = plist ? plistVersion(plist) : null;
  return {
    id: entry.id,
    name: entry.name,
    vendor: entry.vendor,
    native: false,
    family: 'chromium',
    path: bin,
    version,
    gecko: null,
    geckoMajor: 0,
    supported: entry.supported,
    reason: entry.supported ? null : entry.reason,
    profileRoot: entry.profiles[PLATFORM] || null,
    signature: `${entry.id}@${version || 'unknown'}`,
  };
}

// The last measured start for each build. A room records the time a peer first
// answered, which is the wait a person actually feels.
export function readStarts() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

export function rememberStart(id, liveMs) {
  if (!id || !Number.isFinite(liveMs) || liveMs <= 0) return;
  const starts = readStarts();
  starts[id] = Math.round(liveMs);
  try {
    fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
    fs.writeFileSync(HISTORY, JSON.stringify(starts, null, 2) + '\n');
  } catch {
    // A read only host keeps the catalogue order.
  }
}

// A build with a measurement comes first, fastest first. A build with none
// keeps its catalogue place after the measured ones.
function byStart(entries) {
  const starts = readStarts();
  const measured = entries.filter((entry) => Number.isFinite(starts[entry.id]));
  const rest = entries.filter((entry) => !Number.isFinite(starts[entry.id]));
  measured.sort((a, b) => starts[a.id] - starts[b.id]);
  return [...measured, ...rest];
}

// Every installed build, fastest measured first. A build that cannot load the
// bridge still appears, so the setup screen can say why.
export function detect() {
  const found = [...CATALOGUE.map(inspect), ...CHROMIUM.map(inspectChromium)].filter(Boolean);
  return byStart(found);
}

// A saved room names one build. If it is gone, the error says so and a rescan
// on the same screen offers the rest.
export function find(id) {
  const shown = detect().find((entry) => entry.id === id);
  if (!shown) {
    const known = [...CATALOGUE, ...CHROMIUM].find((entry) => entry.id === id);
    if (!known) throw new Error(`unknown browser: ${id}`);
    throw new Error(`${known.name} is not installed, or its path moved`);
  }
  return shown;
}

// A separate profile keeps the room out of the daily browsing profile.
// A handoff goes to an instance that is already running, so it must not ask
// for a new remote session or a second instance.
export function launchArgs(browser, { profile, url, headless = false, handoff = false, extension = null }) {
  if (!profile) throw new Error('a room needs a profile path');
  // Chromium names the profile root with one flag. It has no remote option and
  // it refuses no-remote, so the Gecko flags would stop it from starting.
  if (browser && browser.family === 'chromium') {
    const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'];
    // The bridge is an unpacked folder here. Both flags name it, so the build
    // starts with the bridge and with nothing else from the daily profile.
    if (extension) {
      args.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
    }
    if (headless) args.push('--headless=new');
    if (url) args.push(url);
    return args;
  }
  const args = ['--profile', profile];
  if (!handoff) args.push('--no-remote', '--new-instance');
  if (headless) args.push('-headless');
  if (url) args.push(url);
  return args;
}

export { PLATFORM };
