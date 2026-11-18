// One job for the browser check: the signed guard when the signed copy is
// present, both lanes, then the tests. A hosted runner has no signed copy in
// zen/.runtime, so the guard reports skipped there instead of failing. The
// relay must already be built.
//
//   node scripts/check-all.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const relay = path.join(root, 'relay', 'target', 'debug', 'brosr-relay');
const signed = path.join(root, 'zen', '.runtime', 'bridge-signed.xpi');
const logs = path.join(root, 'zen', '.runtime');
const steps = [];

// The layout lanes read a browser's pixels. A hosted runner installs Chrome
// for Testing under zen/.runtime/cft, and puppeteer nests it under a build
// folder, so the search walks the tree instead of guessing one path.
function findChromeForTesting(dir, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findChromeForTesting(file, depth + 1);
      if (found) return found;
    } else if (entry.name === 'Google Chrome for Testing') {
      return file;
    }
  }
  return null;
}

function run(name, args, timeout, extraEnv) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: timeout || 180000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  // A failing lane names its state in the last lines, and a hosted job keeps
  // nothing else. Each step writes its whole output here, and the workflow
  // uploads these files when the job fails.
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, `check-${name.replace(/[^a-z0-9]+/gi, '-')}.log`);
  fs.writeFileSync(file, output);
  const ok = result.status === 0;
  const ms = Date.now() - started;
  steps.push({ name, ok, exit: result.status, ms });
  process.stdout.write(`[check-all] ${ok ? 'ok  ' : 'FAIL'} ${name} (${ms} ms)\n`);
  // The lane prints the failing state at the end, and twenty five lines cut the
  // diagnosis out of it. Eighty keeps the form state a timeout names.
  if (!ok) process.stdout.write(output.split('\n').slice(-80).join('\n') + '\n');
  return ok;
}

if (!fs.existsSync(relay)) {
  console.error(
    `[check-all] no relay at ${path.relative(root, relay)}. Run cargo build --manifest-path relay/Cargo.toml.`
  );
  process.exit(1);
}

if (fs.existsSync(signed)) {
  run('signed guard', ['zen/profile.mjs', '--guard'], 60000);
} else {
  steps.push({ name: 'signed guard', ok: true, skipped: true, reason: 'no signed copy in zen/.runtime' });
  process.stdout.write('[check-all] skip signed guard, no signed copy in zen/.runtime\n');
}

run('relay files', ['scripts/check-relay-files.mjs'], 60000);
run('zen lane', ['scripts/check-two-instance.mjs'], 240000);
run('chromium lane', ['scripts/check-two-instance.mjs', '--chrome'], 240000);

const browser = process.env.BROSR_CHECK_BROWSER || findChromeForTesting(path.join(root, 'zen', '.runtime', 'cft'));
const layout = browser ? { BROSR_CHECK_BROWSER: browser } : {};
if (browser) process.stdout.write(`[check-all] layout lanes use ${browser}\n`);
run('canvas layout', ['scripts/check-canvas-layout.mjs'], 240000, layout);
run('landing layout', ['scripts/check-landing-layout.mjs'], 240000, layout);
run('room apps layout', ['scripts/check-room-apps-layout.mjs'], 240000, layout);
run('chess play', ['scripts/check-chess-play.mjs'], 240000, layout);

const tests = ['core/test', 'host/test'].flatMap((dir) =>
  fs
    .readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join(dir, name))
);
run('tests', ['--test', ...tests], 180000);

const failed = steps.filter((step) => !step.ok);
console.log(JSON.stringify({ ok: failed.length === 0, steps }, null, 2));
process.exit(failed.length ? 1 : 0);
