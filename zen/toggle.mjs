// Toggles the Brosr room panel in a running Zen window. Nothing outside the
// browser can message the extension, so this finds the Zen process on the room profile and
// posts the real Ctrl+Alt+B chord, which the bridge treats as a toggle.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(here, '.runtime');

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const PROFILE = arg('profile', '') ? path.resolve(arg('profile', '')) : '';

function fail(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  process.exit(1);
}

function found(info) {
  console.log(JSON.stringify({ ok: true, ...info }));
  process.exit(0);
}

if (process.platform !== 'darwin') fail('the panel toggle needs macOS');
if (!PROFILE) fail('pass --profile=<zen profile path>');

// Content processes carry the same profile flag, so only the window process
// can receive a key chord.
function zenPid(profile) {
  const res = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10000 });
  if (res.status !== 0) return null;
  for (const line of String(res.stdout || '').split('\n')) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(' ');
    if (space < 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const command = trimmed.slice(space + 1);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (command.includes('-contentproc') || command.includes('-childproc')) continue;
    const binary = command.split(' ')[0] || '';
    if (path.basename(binary) !== 'zen') continue;
    const flat = ` ${command} `;
    if (flat.includes(` --profile ${profile} `) || flat.includes(` --profile=${profile} `)) {
      return pid;
    }
  }
  return null;
}

function keypostPath() {
  const source = path.join(here, 'keypost.swift');
  const out = path.join(runtime, 'keypost');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(source).mtimeMs) return out;
  fs.mkdirSync(runtime, { recursive: true });
  const build = spawnSync('swiftc', ['-parse-as-library', '-O', source, '-o', out], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (build.status !== 0) return null;
  return out;
}

const pid = zenPid(PROFILE);
if (!pid) fail('no Zen window on that profile. Start the room first.', { profile: PROFILE });

const helper = keypostPath();
if (!helper) fail('cannot build the keypost helper', { pid, profile: PROFILE });

// A window behind another app still takes the chord, but activation makes the
// panel state match what the user sees.
const activate = spawnSync(helper, ['activate', String(pid)], { encoding: 'utf8', timeout: 20000 });
const chord = spawnSync(helper, ['chord', String(pid)], { encoding: 'utf8', timeout: 20000 });
const chordText = String(chord.stdout || chord.stderr || '').trim();
if (chord.status !== 0) fail('the chord did not post', { pid, chord: chordText });

found({
  pid,
  profile: PROFILE,
  activate: String(activate.stdout || '').trim(),
  chord: chordText,
});
