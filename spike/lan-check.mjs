// Windows half of a LAN room: the relay listens on every local IPv4, and the
// firewall rule that lets another machine reach it exists. Run before a Mac
// joins, then run it again after the rule is removed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const RULE = process.env.BROSR_FIREWALL_RULE || 'Brosr relay 8787';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function health(address) {
  try {
    const res = await fetch(`http://${address}:${PORT}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok ? (await res.text()).trim() : `http ${res.status}`;
  } catch {
    return 'no answer';
  }
}

async function rooms(address) {
  try {
    const res = await fetch(`http://${address}:${PORT}/stats`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function firewallRule() {
  if (process.platform !== 'win32') return null;
  const res = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$r = Get-NetFirewallRule -DisplayName '${RULE}' -ErrorAction SilentlyContinue; if ($r) { 'yes' } else { 'no' }`,
    ],
    { encoding: 'utf8', timeout: 15000 }
  );
  return String(res.stdout || '').trim() === 'yes';
}

function stop(child) {
  if (!child) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

async function main() {
  const interfaces = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal);
  const addresses = [...new Set(interfaces.map((item) => item.address))];
  if (!addresses.length) {
    console.log('[lan] no non-loopback IPv4 address');
    process.exit(1);
  }

  let relay = null;
  let started = false;
  if ((await health('127.0.0.1')) !== 'ok') {
    relay = spawn(process.execPath, ['relay.js'], {
      cwd: here,
      stdio: 'ignore',
      env: { ...process.env, HOST, PORT: String(PORT) },
    });
    started = true;
    for (let i = 0; i < 50; i += 1) {
      if ((await health('127.0.0.1')) === 'ok') break;
      await sleep(100);
    }
  }

  const rows = [];
  for (const address of addresses) {
    rows.push({ address, health: await health(address) });
  }
  const rule = firewallRule();
  const result = {
    when: new Date().toISOString(),
    host: HOST,
    port: PORT,
    started,
    addresses: rows,
    firewall: { rule: RULE, exists: rule },
    rooms: await rooms('127.0.0.1'),
  };

  console.log(`[lan] relay ${HOST}:${PORT}${started ? ' (started)' : ' (already running)'}`);
  for (const row of rows) {
    console.log(`[lan] ${row.address} health ${row.health}`);
  }
  if (rule === false) {
    console.log(`[lan] firewall rule "${RULE}" is missing`);
  } else if (rule === true) {
    console.log(`[lan] firewall rule "${RULE}" exists`);
  }
  console.log('[lan] rooms', JSON.stringify(result.rooms));

  fs.mkdirSync(path.join(here, '.runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(here, '.runtime', 'lan-check.json'),
    JSON.stringify(result, null, 2) + '\n'
  );

  stop(relay);
  const ok = rows.every((row) => row.health === 'ok');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[lan]', error.message);
  process.exit(1);
});
