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
const steps = [];

function run(name, args, timeout) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: timeout || 180000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const ok = result.status === 0;
  const ms = Date.now() - started;
  steps.push({ name, ok, exit: result.status, ms });
  process.stdout.write(`[check-all] ${ok ? 'ok  ' : 'FAIL'} ${name} (${ms} ms)\n`);
  if (!ok) process.stdout.write(output.split('\n').slice(-25).join('\n') + '\n');
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

run('zen lane', ['scripts/check-two-instance.mjs'], 240000);
run('chromium lane', ['scripts/check-two-instance.mjs', '--chrome'], 240000);

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
