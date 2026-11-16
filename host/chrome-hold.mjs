// Chrome closes when its devtools pipe closes, and that pipe is the only route
// that installs an add-on in a branded build. So this helper owns both: it
// starts the window with the two descriptors, installs every unpacked folder,
// reports the ids and the browser pid where the room reads them, then stays
// alive beside the window. The room kills the browser, Chrome exits, and the
// helper leaves with it.
//
// The room spawns this file detached. A launch that never reports is a failed
// launch, and the room closes the helper.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadExtensions, spawnPipe } from './chrome-pipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_AS_HELPER = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// The room writes a plan, starts this file, then reads the report. The holder
// removes both files, so a stopped room leaves no plan behind.
export async function holdChrome({ bin, args, dirs = [], state, waitMs = 25000 }) {
  fs.mkdirSync(state, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const plan = path.join(state, `chrome-plan-${stamp}.json`);
  const report = path.join(state, `chrome-hold-${stamp}.json`);
  fs.writeFileSync(plan, JSON.stringify({ bin, args, dirs, report }), { mode: 0o600 });
  const holder = spawn(process.execPath, [fileURLToPath(import.meta.url), plan], {
    detached: true,
    stdio: 'ignore',
    cwd: here,
  });
  holder.unref();

  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      const body = JSON.parse(fs.readFileSync(report, 'utf8'));
      if (body && body.done) {
        fs.rmSync(report, { force: true });
        return {
          pid: body.pid || null,
          holderPid: holder.pid,
          ids: body.ids || [],
          errors: body.errors || [],
        };
      }
    } catch {
      // The window is still opening.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return {
    pid: null,
    holderPid: holder.pid,
    ids: [],
    errors: [{ dir: null, error: `Chrome did not report its add-ons within ${waitMs} ms` }],
  };
}

async function hold(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  fs.rmSync(planPath, { force: true });
  const write = (body) =>
    fs.writeFileSync(plan.report, JSON.stringify(body), { mode: 0o600 });

  const { child, client } = spawnPipe(plan.bin, plan.args, { env: process.env });
  const loaded = await loadExtensions(client, plan.dirs || []);
  write({
    done: true,
    pid: child.pid,
    ids: loaded.ids,
    errors: loaded.errors,
  });

  // The pipe handles keep this process alive. Chrome closing the pipe or
  // exiting ends the helper, and the room reads the browser pid, not this one.
  child.on('exit', () => {
    client.close();
    process.exit(0);
  });
  child.on('error', () => process.exit(1));
}

if (RUN_AS_HELPER) {
  hold(process.argv[2]).catch((error) => {
    process.stderr.write(`chrome-hold: ${(error && error.message) || error}\n`);
    process.exit(1);
  });
}
