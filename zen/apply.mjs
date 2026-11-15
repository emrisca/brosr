// Applies the safe browsing set to a Zen profile that the user already browses
// with. A dry run lists the changes and writes nothing. The list and the script
// need one headless pass on that profile, so the pass waits until Zen is closed.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXTENSIONS,
  cachedCopy,
  prepareSafeBrowsing,
  readExtensions,
  readMarker,
} from './safe-browsing.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

// Zen keeps the same layout as Firefox. Windows uses APPDATA, macOS uses
// Application Support, and both store a profiles.ini beside the profiles.
export function zenHome(home = os.homedir()) {
  if (process.env.ZEN_HOME) return process.env.ZEN_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'zen');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'zen');
  return path.join(home, '.zen');
}

// profiles.ini holds one section per profile and one Install section that names
// the profile the shortcut opens.
export function readProfiles(iniPath) {
  let text = '';
  try {
    text = fs.readFileSync(iniPath, 'utf8');
  } catch {
    return { profiles: [], defaultPath: null, iniPath };
  }
  const profiles = [];
  let installDefault = null;
  for (const chunk of text.split(/^\[/m).slice(1)) {
    const lines = chunk.split('\n');
    const head = lines[0].replace(/\]\s*$/, '').trim();
    const body = {};
    for (const line of lines.slice(1)) {
      const at = line.indexOf('=');
      if (at > 0) body[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    if (head.startsWith('Install') && body.Default) installDefault = body.Default;
    if (head.startsWith('Profile') && body.Path) {
      profiles.push({
        section: head,
        name: body.Name || head,
        path: body.Path,
        relative: body.IsRelative === '1',
        isDefault: body.Default === '1',
      });
    }
  }
  const wanted = installDefault || (profiles.find((one) => one.isDefault) || {}).path || null;
  const match = profiles.find((one) => one.path === wanted) || profiles[0] || null;
  return {
    profiles,
    defaultPath: match ? path.join(path.dirname(iniPath), match.relative ? match.path : '') : null,
    iniPath,
  };
}

function hash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

// Each row says what the copy would do. A file with the same hash stays, so a
// rerun does not touch an add-on the user already runs.
export function planProfile(profile) {
  const installed = readExtensions(profile);
  return EXTENSIONS.map((entry) => {
    const source = cachedCopy(entry);
    const dest = path.join(profile, 'extensions', entry.file);
    const same = source && fs.existsSync(dest) && hash(source) === hash(dest);
    let action = 'add';
    if (!source) action = 'no-source';
    else if (same) action = 'keep';
    else if (fs.existsSync(dest)) action = 'replace';
    return {
      id: entry.id,
      name: entry.name,
      action,
      installed: installed[entry.id] ? installed[entry.id].version : null,
      active: installed[entry.id] ? installed[entry.id].active : null,
    };
  });
}

// A running Zen holds the profile. The file copies are still safe, because the
// browser reads them at the next start. The headless pass is not safe, so it
// waits for a free profile.
export function zenRunning() {
  if (process.platform === 'win32') {
    const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq zen.exe', '/NH'], { encoding: 'utf8' });
    return /zen\.exe/i.test(res.stdout || '');
  }
  const res = spawnSync('pgrep', ['-f', 'zen'], { encoding: 'utf8' });
  return Boolean((res.stdout || '').trim());
}

export async function applySet(profile, options = {}) {
  const log = options.log || (() => {});
  const rows = planProfile(profile);
  const report = {
    profile,
    dryRun: Boolean(options.dryRun),
    rows,
    copied: [],
    marker: readMarker(profile),
    blocked: null,
    safeBrowsing: null,
  };
  if (options.dryRun) return report;
  const dest = path.join(profile, 'extensions');
  fs.mkdirSync(dest, { recursive: true });
  report.locked = [];
  for (const row of rows) {
    if (row.action !== 'add' && row.action !== 'replace') continue;
    const entry = EXTENSIONS.find((one) => one.id === row.id);
    try {
      fs.copyFileSync(cachedCopy(entry), path.join(dest, entry.file));
      report.copied.push(row.id);
      log(`${row.action} ${row.name}`);
    } catch (error) {
      // A running Zen holds the add-on file open, so the write waits.
      report.locked.push({ name: row.name, why: error.code || error.message });
      log(`${row.action} ${row.name} failed: ${error.code || error.message}`);
    }
  }
  if (!options.configure) return report;
  if (zenRunning()) {
    report.blocked = 'Zen is open on this machine. Close it and run again for the list.';
    return report;
  }
  report.safeBrowsing = await prepareSafeBrowsing(profile, {
    configure: true,
    refresh: Boolean(options.refresh),
    force: Boolean(options.force),
    port: options.port,
    log,
  });
  report.marker = report.safeBrowsing.marker;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = zenHome();
  const found = readProfiles(path.join(home, 'profiles.ini'));
  if (process.argv.includes('--list')) {
    console.log(`[apply] ini ${found.iniPath}`);
    for (const one of found.profiles) {
      const dir = one.relative ? path.join(path.dirname(found.iniPath), one.path) : one.path;
      console.log(`[apply] ${one.name}  ${dir}${dir === found.defaultPath ? '  (default)' : ''}`);
    }
    process.exit(0);
  }
  const profile = path.resolve(arg('profile', found.defaultPath || ''));
  if (!profile || !fs.existsSync(profile)) {
    console.log('[apply] no profile. Pass --profile=<dir> or use --list.');
    process.exit(1);
  }
  const report = await applySet(profile, {
    dryRun: !process.argv.includes('--apply'),
    configure: process.argv.includes('--apply'),
    refresh: process.argv.includes('--refresh'),
    force: process.argv.includes('--force'),
    port: arg('port', '9351'),
    log: (line) => console.log(`[apply] ${line}`),
  });
  console.log(`[apply] profile ${report.profile}`);
  for (const row of report.rows) {
    const now = row.installed ? ` (has ${row.installed}, active ${row.active})` : ' (not installed)';
    console.log(`[apply] ${row.action.padEnd(9)} ${row.name}${now}`);
  }
  console.log(`[apply] mode ${report.dryRun ? 'dry run, nothing written' : 'write'}`);
  for (const one of report.locked || []) {
    console.log(`[apply] ${one.name} is open in Zen (${one.why}). Close Zen and run again.`);
  }
  if (report.dryRun) console.log('[apply] add --apply to copy the files and run the setup pass.');
  if (report.blocked) {
    console.log(`[apply] ${report.blocked}`);
    process.exitCode = 1;
  }
  if (report.marker) console.log('[apply] a setup marker is present, so the pass is skipped.');
  if (report.safeBrowsing && report.safeBrowsing.error) {
    console.log(`[apply] the setup pass failed: ${report.safeBrowsing.error}`);
    process.exitCode = 1;
  }
}
