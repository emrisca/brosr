// A local build. The bundler refuses to finish while bundle.createUpdaterArtifacts
// is on and no signing key is set, so a plain `tauri build` writes parts of a
// bundle and then exits with a failure. This reads the key beside the repository
// when the environment holds none, and leaves a release to the repository
// secrets, which name the same key.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');
const keyFile = path.join(app, '..', '.secrets', 'brosr-updater.key');

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  let key = '';
  try {
    key = fs.readFileSync(keyFile, 'utf8').trim();
  } catch {
    key = '';
  }
  if (!key) {
    console.error(
      `No updater key. Set TAURI_SIGNING_PRIVATE_KEY or put the key at ${path.relative(app, keyFile)}.`
    );
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = key;
  // An unencrypted key takes an empty password. A key with a password still
  // reads the one the environment names.
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
  }
  console.log(`[brosr] signing with ${path.relative(app, keyFile)}`);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(npx, ['tauri', 'build', ...process.argv.slice(2)], {
  cwd: app,
  env,
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error(`[brosr] ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[brosr] the build stopped on ${signal}`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
