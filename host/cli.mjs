// The one shot host. The app shells out to this file and reads one JSON line
// from stdout, so every command answers the same way. Progress goes to stderr.
//
//   node host/cli.mjs detect
//   node host/cli.mjs prepare --browser=zen
//   node host/cli.mjs start --browser=zen --room=demo --name=Host
//   node host/cli.mjs status
//   node host/cli.mjs panel
//   node host/cli.mjs stop
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect } from './browsers.mjs';
import { freePort, prepare, showPanel, start, status, stop } from './room.mjs';

const arg = (name, fallback = '') => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const COMMANDS = {
  // The list the setup screen draws. A fresh scan on every call keeps it true
  // after someone installs a build with the app still open.
  async detect() {
    const found = detect();
    return {
      ok: true,
      platform: process.platform,
      browsers: found,
      ready: found.filter((entry) => entry.supported).length,
    };
  },

  // Everything a room needs except the relay. The app shows one row per step.
  async prepare() {
    const browser = arg('browser');
    if (!browser) throw new Error('pass --browser=<id>. Run detect to list the builds');
    // Each stage goes to stderr as one line, so the app can follow the build
    // while it waits for the single JSON answer on stdout.
    const report = await prepare({
      browser,
      onProgress: (update) => {
        process.stderr.write(`progress:${JSON.stringify(update)}\n`);
      },
    });
    return {
      ok: true,
      browser: report.browser,
      profile: report.profile,
      bridge: report.bridge,
      extensions: report.extensions,
      blocker: report.blocker,
      reused: Boolean(report.reused),
    };
  },

  async start() {
    const browser = arg('browser');
    if (!browser) throw new Error('pass --browser=<id>. Run detect to list the builds');
    const run = await start({
      browser,
      room: arg('room') || undefined,
      name: arg('name') || 'Host',
      port: arg('port') ? Number(arg('port')) : undefined,
      headless: flag('headless'),
    });
    return run;
  },

  async status() {
    const state = await status();
    return { ok: true, ...state };
  },

  async stop() {
    return stop();
  },

  // Show the room window again in a browser that is already open.
  async panel() {
    return showPanel();
  },

  // The app asks for a port before it opens the setup screen, so the room
  // address it shows is the one the relay will bind.
  async port() {
    return { ok: true, port: await freePort(arg('start') ? Number(arg('start')) : 8787) };
  },
};

async function main() {
  const name = process.argv[2] || '';
  const command = COMMANDS[name];
  if (!command) {
    const known = Object.keys(COMMANDS).join(', ');
    process.stderr.write(`brosr host: unknown command "${name}". Try ${known}\n`);
    process.stdout.write(JSON.stringify({ ok: false, error: `unknown command: ${name}` }) + '\n');
    process.exit(1);
  }
  try {
    const result = await command();
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(`brosr host: ${error.message}\n`);
    process.stdout.write(
      JSON.stringify({ ok: false, error: String((error && error.message) || error) }) + '\n'
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
