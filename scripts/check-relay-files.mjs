// The shipped relay serves the pages itself, and a browser refuses a
// stylesheet, module or icon whose type it cannot trust. This lane reads the
// relay the way a browser does: ask for the chess page, then ask for every
// file the page names and check the type on each answer.
//
//   node scripts/check-relay-files.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const relay = path.join(root, 'relay', 'target', 'debug', 'brosr-relay');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const open = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (open) return port;
  }
  throw new Error(`no free port from ${start}`);
}

async function waitFor(fn, label, timeout = 8000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`  FAIL ${message}`);
};
const pass = (message) => console.log(`  ok ${message}`);

const WANT = [
  ['chess/index.html', 'text/html'],
  ['chess/chess.css', 'text/css'],
  ['chess/chess.js', 'text/javascript'],
  ['chess/chess-engine.mjs', 'text/javascript'],
  ['favicon.svg', 'image/svg+xml'],
];

if (!fs.existsSync(relay)) {
  console.error(
    `no relay at ${path.relative(root, relay)}. Run cargo build --manifest-path relay/Cargo.toml.`
  );
  process.exit(1);
}

let server = null;
try {
  const port = await freePort(9660);
  const base = `http://127.0.0.1:${port}`;
  server = spawn(relay, [], {
    cwd: root,
    env: {
      ...process.env,
      FIXTURES: path.join(root, 'landing'),
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 'relay');
  console.log(`relay ${base}`);

  for (const [file, want] of WANT) {
    const answer = await fetch(`${base}/${file}`);
    const type = (answer.headers.get('content-type') || '').toLowerCase();
    if (!answer.ok) fail(`${file} answers ${answer.status}`);
    else if (!type.startsWith(want)) fail(`${file} arrives as ${type || 'no type'}, not ${want}`);
    else pass(`${file} arrives as ${type}`);
  }

  // Every file the page names must load, so a rename cannot ship a page that
  // asks for something the relay never serves.
  const pageUrl = `${base}/chess/index.html`;
  const html = await (await fetch(pageUrl)).text();
  const refs = [...html.matchAll(/<(?:link|script)\b[^>]*?(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref) => !ref.startsWith('http') && !ref.startsWith('data:'));
  for (const ref of refs) {
    const url = new URL(ref, pageUrl);
    const answer = await fetch(url);
    if (!answer.ok) fail(`the page asks for ${ref} and gets ${answer.status}`);
    else pass(`the page can load ${ref}`);
  }

  if (failures.length) {
    throw new Error(`${failures.length} relay file fault${failures.length === 1 ? '' : 's'}`);
  }
  console.log('PASS: the relay names every file the chess page needs');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server) {
    server.kill('SIGTERM');
    await sleep(300);
    server.kill('SIGKILL');
  }
}
