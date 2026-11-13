// Proof for the panel shortcut. A browser command never receives a page key,
// so this run needs a real window and a real chord. It starts Zen headful,
// installs the bridge, opens one room tab, sends Ctrl+Alt+B through Windows,
// and reads the command back from the room dataset.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { makeZip } from '../spike/zip.mjs';
import { findZen, writeProfile } from './profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = path.join(here, '..', 'spike');
const core = path.join(here, '..', 'core');
const runtime = path.join(here, '.runtime');
const PORT = Number(process.env.BROSR_SHORTCUT_BIDI || 9335);
const RELAY = 8787;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

const CORE = [
  'protocol.mjs',
  'clock.mjs',
  'drift.mjs',
  'media.mjs',
  'room.mjs',
  'overlay.mjs',
  'input.mjs',
  'sync.mjs',
  'browser-entry.mjs',
];

function buildXpi() {
  fs.mkdirSync(runtime, { recursive: true });
  const out = path.join(runtime, 'bridge-shortcut.xpi');
  const panel = ['room.html', 'room.css', 'room.js'];
  fs.writeFileSync(
    out,
    makeZip([
      { name: 'manifest.json', data: fs.readFileSync(path.join(spike, 'bridge', 'manifest.json')) },
      { name: 'content.js', data: fs.readFileSync(path.join(spike, 'bridge', 'content.js')) },
      {
        name: 'background.js',
        data: fs.readFileSync(path.join(spike, 'bridge', 'background.js')),
      },
      ...CORE.map((name) => ({ name: `core/${name}`, data: fs.readFileSync(path.join(core, name)) })),
      ...panel.map((name) => ({
        name: `panel/${name}`,
        data: fs.readFileSync(path.join(here, 'panel', name)),
      })),
    ])
  );
  return out;
}

function readIni(zen) {
  for (const base of [path.dirname(zen), path.join(path.dirname(zen), '..')]) {
    const file = path.join(base, 'application.ini');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const grab = (key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] || null;
    return { version: grab('Version'), buildId: grab('BuildID'), source: grab('SourceStamp') };
  }
  return { version: null, buildId: null, source: null };
}

function killTree(child) {
  if (!child) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function waitHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${RELAY}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }
  throw new Error('relay did not answer on 8787');
}

async function connect(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${PORT}/session`).connect();
    } catch (error) {
      last = error;
      await sleep(400);
    }
  }
  throw new Error(`no BiDi on ${PORT}: ${last ? last.message : 'unknown'}`);
}

async function evaluate(bidi, context, expression) {
  const res = await bidi.cmd('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  if (res.type === 'exception') {
    throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  }
  return res.result ? res.result.value : undefined;
}

async function readDataset(bidi, context) {
  const raw = await evaluate(
    bidi,
    context,
    'JSON.stringify({ data: document.documentElement.dataset.brosr || "", error: document.documentElement.dataset.brosrError || "" })'
  );
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error('core error: ' + parsed.error);
  return parsed.data ? JSON.parse(parsed.data) : null;
}

async function waitForDataset(bidi, context, predicate, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await readDataset(bidi, context).catch(() => null);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  return null;
}

function pressShortcut() {
  const script = `
$ErrorActionPreference = 'Stop'
$p = Get-Process zen -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Brosr*' } | Select-Object -First 1
if (-not $p) { $p = Get-Process zen -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
if (-not $p) { Write-Output 'no-window'; exit 3 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BrosrFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint id);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
"@
$handle = $p.MainWindowHandle
if ($handle -eq 0) { Write-Output 'no-handle'; exit 5 }
[void][BrosrFocus]::ShowWindow($handle, 9)
$foreground = [BrosrFocus]::GetForegroundWindow()
$foregroundPid = 0
$foregroundThread = [BrosrFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
$mine = [BrosrFocus]::GetCurrentThreadId()
[void][BrosrFocus]::AttachThreadInput($mine, $foregroundThread, $true)
$focused = [BrosrFocus]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 900
[BrosrFocus]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[BrosrFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[BrosrFocus]::keybd_event(0x42, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[BrosrFocus]::keybd_event(0x42, 0, 2, [UIntPtr]::Zero)
[BrosrFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[BrosrFocus]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
[void][BrosrFocus]::AttachThreadInput($mine, $foregroundThread, $false)
Write-Output ('focused ' + $focused + ' handle ' + $handle)
`;
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return {
    ok: res.status === 0,
    out: String(res.stdout || '').trim(),
    err: String(res.stderr || '').trim(),
  };
}

async function main() {
  const zen = findZen();
  if (!zen || !fs.existsSync(zen)) throw new Error('no Zen binary');
  const profile = path.join(runtime, 'shortcut-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  writeProfile(profile);
  const xpi = buildXpi();
  const relay = spawn(process.execPath, ['relay.js'], { cwd: spike, stdio: 'ignore' });
  const browser = spawn(
    zen,
    [
      '--profile',
      profile,
      '--no-remote',
      '--new-instance',
      '--remote-debugging-port',
      String(PORT),
      '--width',
      '1280',
      '--height',
      '900',
      'about:blank',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    }
  );

  let result = { zen: readIni(zen), check: { ok: false, error: 'not run' }, shortcut: null };
  try {
    await waitHealth();
    const bidi = await connect();
    const installed = await bidi.cmd('webExtension.install', {
      extensionData: { type: 'archivePath', path: xpi },
    });
    log('[shortcut] installed', installed.extension);

    // Headful create hangs on this build, so reuse the window's own tab.
    const tree = await bidi.cmd('browsingContext.getTree', {});
    if (!tree.contexts.length) throw new Error('no window context');
    const context = tree.contexts[0].context;
    const url = `http://127.0.0.1:${RELAY}/room-b.html?role=host&room=shortcut&peer=host&name=Host&panel=1`;
    await bidi.cmd('browsingContext.navigate', { context, url, wait: 'complete' });
    const data = await waitForDataset(bidi, context, (d) => d.socket === 1);
    if (!data) throw new Error('the room tab did not connect');

    let panelContext = null;
    for (let i = 0; i < 20 && !panelContext; i += 1) {
      const now = await bidi.cmd('browsingContext.getTree', {});
      const panel = now.contexts.find((item) => String(item.url || '').includes('/panel/room.html'));
      if (panel) panelContext = panel.context;
      else await sleep(300);
    }
    if (panelContext) {
      const list = await evaluate(
        bidi,
        panelContext,
        'browser.commands.getAll().then((list) => JSON.stringify(list))'
      ).catch((error) => 'ERR ' + error.message);
      log('[shortcut] commands', list);
    }

    const sent = pressShortcut();
    log('[shortcut] keys', JSON.stringify(sent));
    const hit = await waitForDataset(bidi, context, (d) => d.command === 'open-room-panel', 15000);
    if (!sent.ok) {
      throw new Error(`the key chord did not send (${sent.out || sent.err || 'no output'})`);
    }
    if (!hit || hit.command !== 'open-room-panel') {
      throw new Error('the key chord reached Windows but not the bridge');
    }
    result = {
      zen: result.zen,
      check: { ok: true, error: null },
      shortcut: {
        key: 'Ctrl+Alt+B',
        proven: true,
        command: hit.command,
        via: 'Windows SendKeys to a headful Zen window',
        sent,
      },
    };
    log('[shortcut] proven:', JSON.stringify(result.shortcut));
  } catch (error) {
    result.check.error = error.message;
    log('[shortcut] failed:', error.message);
  } finally {
    killTree(browser);
    killTree(relay);
    await sleep(300);
  }

  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, 'shortcut.json'),
    JSON.stringify({ when: new Date().toISOString(), ...result }, null, 2) + '\n'
  );
  process.exit(result.check.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[shortcut]', error.message);
  process.exit(1);
});
