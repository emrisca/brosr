import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, 'fixtures', 'answer-child.mjs');

// The app waits for the process to exit before it reads the answer, so a CLI
// that keeps a handle open turns every poll into a ten second wait. This runs
// the real file in a real child process, because that is the boundary that
// failed: the module answering correctly in process proves nothing about exit.
test('the host answers and exits while a handle still holds the loop', async () => {
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const run = spawn(process.execPath, [child], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    run.stdout.on('data', (chunk) => {
      out += chunk;
    });
    run.stderr.on('data', (chunk) => {
      err += chunk;
    });
    const guard = setTimeout(() => {
      run.kill('SIGKILL');
      reject(new Error(`the host did not exit within 5 s. It wrote ${out.trim()}`));
    }, 5000);
    run.on('error', (error) => {
      clearTimeout(guard);
      reject(error);
    });
    run.on('exit', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, out, err });
    });
  });
  const took = Date.now() - started;
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trim(), JSON.stringify({ ok: true, marker: 'answer-child', rooms: [] }));
  assert.ok(took < 3000, `the answer took ${took} ms to reach an exit`);
});
