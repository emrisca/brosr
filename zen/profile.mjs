// Creates the Zen room profile. Pref names come from the shipped build's
// browser/defaults/preferences/firefox.js, so they match what Zen reads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const CANDIDATES = [
  'C:/Program Files/Zen Browser/zen.exe',
  'C:/Program Files (x86)/Zen Browser/zen.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs/Zen Browser/zen.exe'),
  '/Applications/Zen.app/Contents/MacOS/zen',
  '/usr/bin/zen-browser',
  '/opt/zen-browser/zen',
];

export function findZen() {
  const given = arg('zen', '');
  if (given && fs.existsSync(given)) return given;
  return CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

// Vertical tabs and compact chrome are the Zen shape. The rest keeps the
// profile quiet, because a room is not a browsing session.
const PREFS = [
  ['zen.tabs.vertical', true],
  ['zen.tabs.vertical.right-side', false],
  ['zen.view.compact.hide-tabbar', true],
  ['zen.view.compact.hide-toolbar', true],
  ['zen.view.compact.show-sidebar-and-toolbar-on-hover', true],
  ['zen.view.sidebar-expanded', false],
  ['zen.view.show-newtab-button-top', true],
  ['zen.workspaces.continue-where-left-off', false],
  ['zen.theme.hide-unified-extensions-button', false],
  ['browser.shell.checkDefaultBrowser', false],
  ['browser.startup.page', 0],
  ['browser.startup.homepage', 'about:blank'],
  ['datareporting.policy.dataSubmissionEnabled', false],
  ['toolkit.telemetry.enabled', false],
  ['toolkit.legacyUserProfileCustomizations.stylesheets', true],
];

function userJs() {
  const lines = [
    '// Written by apps/brosr/zen/profile.mjs. Pref names are Zen 1.24 names.',
    '// The room profile is disposable. Edit this file and rerun the script.',
    '',
  ];
  for (const [name, value] of PREFS) {
    lines.push(`user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
  }
  return lines.join('\n') + '\n';
}

export function writeProfile(dir) {
  const profile = path.resolve(dir);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'user.js'), userJs());
  return profile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = writeProfile(arg('profile', path.join(here, '.runtime', 'profile')));
  const zen = findZen();
  console.log(`[zen] profile ${profile}`);
  if (!zen) {
    console.log('[zen] no Zen binary found. Pass --zen=<path>.');
    process.exit(1);
  }
  const room = arg('room', 'zen');
  const base = arg('base', 'http://127.0.0.1:8787/room-b.html');
  const url = `${base}?role=host&room=${room}&peer=host&name=Host`;
  console.log(`[zen] binary ${zen}`);
  console.log(`[zen] launch "${zen}" --profile "${profile}" --no-remote --new-instance "${url}"`);
}
