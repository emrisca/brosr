// The scheduled refresh has no window to report in, so this wrapper runs the
// pass and records the counters. The record sits outside the ignored runtime
// folder, so Syncthing copies it and the other machine reads the result.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readMarker } from './safe-browsing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATUS = path.join(here, 'refresh-status.json');
const KEEP = 20;

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

// One flat row per run. A pass counts as ok only when every probe was blocked
// and the control still loaded, so a run that lost its list cannot read as ok.
export function statusRun(marker, exit, seconds) {
  const verified = marker ? marker.verified : null;
  if (!verified) {
    return {
      when: new Date().toISOString(),
      ok: false,
      exit,
      blocked: 0,
      want: 0,
      control: 'none',
      filters: 0,
      wantFilters: 0,
      script: 'none',
      took: seconds,
    };
  }
  const blocked = Number(verified.blocked || 0);
  const want = verified.probes ? verified.probes.length : 0;
  const control = verified.control ? verified.control.state : 'none';
  return {
    when: new Date().toISOString(),
    ok: exit === 0 && blocked === want && control === 'resolved',
    exit,
    blocked,
    want,
    control,
    filters: Number(verified.filters || 0),
    wantFilters: Number(verified.wantFilters || 0),
    script: verified.scripts && verified.scripts.length ? verified.scripts.join('|') : 'none',
    took: seconds,
  };
}

export function appendRun(file, run, keep = KEEP) {
  let doc = { runs: [] };
  try {
    const seen = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (seen && Array.isArray(seen.runs)) doc = seen;
  } catch {
    // The first run has no record yet.
  }
  doc.runs.push(run);
  doc.runs = doc.runs.slice(-keep);
  doc.updated = run.when;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return doc;
}

export function statusLine(run) {
  return (
    `${run.when} ${run.ok ? 'ok' : 'fail'} blocked=${run.blocked}/${run.want} ` +
    `control=${run.control} list=${run.filters}/${run.wantFilters} script=${run.script} took=${run.took}s`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = path.resolve(arg('profile', path.join(here, '.runtime', 'live-profile')));
  const port = arg('port', '9421');
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    [path.join(here, 'profile.mjs'), `--profile=${profile}`, '--refresh', `--port=${port}`],
    { encoding: 'utf8' }
  );
  const row = statusRun(readMarker(profile), run.status, Math.round((Date.now() - started) / 1000));
  appendRun(arg('status', STATUS), row);
  console.log(`[refresh] ${statusLine(row)}`);
  if (!row.ok) {
    const tail = `${run.stdout || ''}${run.stderr || ''}`.trim().split('\n').slice(-5).join('\n');
    if (tail) console.log(tail);
  }
  process.exit(row.ok ? 0 : 1);
}
