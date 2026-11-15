// Finds the Zen binary for this machine. It sits apart from the profile builder
// so the setup pass can ask without importing the file that imports it.
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Zen Browser/zen.exe',
  'C:/Program Files (x86)/Zen Browser/zen.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs/Zen Browser/zen.exe'),
  '/Applications/Zen.app/Contents/MacOS/zen',
  '/usr/bin/zen-browser',
  '/opt/zen-browser/zen',
];

export function findZen(given = '') {
  if (given && fs.existsSync(given)) return given;
  return CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}
