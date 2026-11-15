// Registers the refresh pass with the system scheduler, so the list and the
// script stay current without a manual run. The room profile is the target,
// because that is the profile a room opens. The task calls refresh.mjs, which
// records the counters, because the scheduler keeps no report of its own.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TASK = 'brosr safe browsing refresh';

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

export function refreshCommand(profile, port) {
  const script = path.join(here, 'refresh.mjs');
  return `"${process.execPath}" "${script}" --profile="${profile}" --port=${port}`;
}

// The task row holds the last run, and the status file holds the counters.
function status() {
  const shown = run(['/Query', '/TN', TASK, '/FO', 'LIST', '/V']);
  if (shown.status !== 0) {
    console.log(`[schedule] ${TASK} is not registered`);
    return 1;
  }
  const rows = (shown.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(TaskName|Status|Next Run Time|Last Run Time|Last Result|Task To Run)/i.test(line));
  for (const row of rows) console.log(`[schedule] ${row}`);
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(here, 'refresh-status.json'), 'utf8'));
  } catch {
    // No run has happened yet.
  }
  if (!doc || !Array.isArray(doc.runs) || !doc.runs.length) {
    console.log('[schedule] no refresh run recorded yet');
    return 0;
  }
  for (const one of doc.runs.slice(-5)) {
    console.log(
      `[schedule] ${one.when} ${one.ok ? 'ok' : 'fail'} blocked=${one.blocked}/${one.want} ` +
        `control=${one.control} list=${one.filters}/${one.wantFilters} script=${one.script}`
    );
  }
  return 0;
}

function run(args) {
  return spawnSync('schtasks', args, { encoding: 'utf8' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = path.resolve(arg('profile', path.join(here, '.runtime', 'live-profile')));
  const port = arg('port', '9421');
  const time = arg('time', '03:30');
  if (process.platform !== 'win32') {
    console.log('[schedule] add this line to your crontab:');
    console.log(`30 3 * * 0 ${refreshCommand(profile, port)}`);
    process.exit(0);
  }
  if (process.argv.includes('--status')) {
    process.exit(status());
  }
  if (process.argv.includes('--remove')) {
    const gone = run(['/Delete', '/TN', TASK, '/F']);
    console.log(`[schedule] ${(gone.stdout || gone.stderr || '').trim()}`);
    process.exit(gone.status === 0 ? 0 : 1);
  }
  const created = run([
    '/Create',
    '/TN',
    TASK,
    '/TR',
    refreshCommand(profile, port),
    '/SC',
    'WEEKLY',
    '/ST',
    time,
    '/F',
  ]);
  if (created.status !== 0) {
    console.log(`[schedule] the task did not land: ${(created.stderr || created.stdout || '').trim()}`);
    process.exit(1);
  }
  const shown = run(['/Query', '/TN', TASK, '/FO', 'LIST']);
  const lines = (shown.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(TaskName|Status|Next Run Time|Task To Run|Schedule Type)/i.test(line));
  console.log(`[schedule] ${TASK}`);
  for (const line of lines) console.log(`[schedule] ${line}`);
  console.log(`[schedule] profile ${profile}`);
  console.log('[schedule] node zen/schedule.mjs --status shows the last runs');
}
