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
  for (const base of [
    path.dirname(zen),
    path.join(path.dirname(zen), '..'),
    path.join(path.dirname(zen), '..', 'Resources'),
  ]) {
    const file = path.join(base, 'application.ini');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const grab = (key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] || null;
    return { version: grab('Version'), buildId: grab('BuildID'), source: grab('SourceStamp') };
  }
  return { version: null, buildId: null, source: null };
}

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // Zen starts child processes. One signal to the group stops all of them.
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
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
  if (process.platform === 'darwin') return pressShortcutMac();
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

function focusZenWindow() {
  // A browser command needs a frontmost window with the page focused. This is
  // setup; the proof is the chord.
  if (process.platform !== 'darwin') return { ok: true, out: 'not-mac', err: '', status: 0 };
  const script = `
tell application "Zen" to activate
delay 0.8
tell application "System Events"
  set p to first process whose frontmost is true
  set frontName to name of p
  tell p
    set frontmost to true
    try
      perform action "AXRaise" of window 1
    end try
    set pos to position of window 1
    set sz to size of window 1
  end tell
  delay 0.3
  click at {(item 1 of pos) + (item 1 of sz) / 2, (item 2 of pos) + (item 2 of sz) / 2}
end tell
return frontName & " " & (item 1 of pos) & "," & (item 2 of pos) & " " & (item 1 of sz) & "x" & (item 2 of sz)
`;
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 15000 });
  return {
    ok: res.status === 0,
    out: String(res.stdout || '').trim(),
    err: String(res.stderr || '').trim(),
    status: res.status,
  };
}

function pressShortcutMac() {
  // key code 11 is the physical B key. keystroke "b" with Option composes a
  // character, so the command matcher never sees a plain b.
  // A global chord needs the window to be key. Targeting the process posts the
  // chord straight to Zen's event queue instead.
  const script = `
tell application "System Events"
  tell process "zen"
    set frontmost to true
    key code 11 using {control down, option down}
  end tell
end tell
`;
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 15000 });
  return {
    ok: res.status === 0,
    out: String(res.stdout || '').trim(),
    err: String(res.stderr || '').trim(),
    status: res.status,
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
      // killTree() kills a POSIX process group, so the browser needs its own.
      detached: process.platform !== 'win32',
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
    log(
      '[shortcut] contexts',
      JSON.stringify(
        tree.contexts.map((item) => ({
          id: item.context,
          url: item.url,
          active: item.active,
          window: item.clientWindow,
        }))
      )
    );
    // A launched window can carry a background context. The key chord only
    // reaches the active one, so the room page goes into that.
    const context = (tree.contexts.find((item) => item.active) || tree.contexts[0]).context;
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

    // The room tab records the chord itself, so a failed proof separates OS
    // delivery from command registration.
    await evaluate(
      bidi,
      context,
      'window.__brosrKeys = []; window.addEventListener("keydown", (e) => window.__brosrKeys.push({ key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }), true); "armed"'
    );
    // Activation is test setup, not the proof: it puts the cursor in the page
    // so the operating system chord has a focused window to reach.
    await bidi.cmd('browsingContext.activate', { context }).catch((error) =>
      log('[shortcut] activate failed', error.message)
    );
    await sleep(400);
    const windowFocus = focusZenWindow();
    log('[shortcut] window', JSON.stringify(windowFocus));
    await sleep(400);
    const focus = await evaluate(
      bidi,
      context,
      'JSON.stringify({ focus: document.hasFocus(), active: document.activeElement && document.activeElement.tagName })'
    ).catch((error) => 'read failed: ' + error.message);
    log('[shortcut] focus', focus);
    // A plain key proves the window accepts System Events input at all. It
    // never matches a command, so it cannot pass the proof on its own.
    if (process.platform === 'darwin') {
      const plain = spawnSync('osascript', ['-e', 'tell application "System Events" to key code 0'], {
        encoding: 'utf8',
        timeout: 15000,
      });
      log('[shortcut] plain key', plain.status, String(plain.stderr || '').trim());
    }
    const sent = pressShortcut();
    log('[shortcut] keys', JSON.stringify(sent));
    const pageKeys = await evaluate(
      bidi,
      context,
      'JSON.stringify(window.__brosrKeys || [])'
    ).catch((error) => 'read failed: ' + error.message);
    log('[shortcut] page keys', pageKeys);
    result.diag = { focus, sent, pageKeys };
    const hit = await waitForDataset(bidi, context, (d) => d.command === 'open-room-panel', 15000);
    if (!sent.ok) {
      throw new Error(`the key chord did not send (${sent.out || sent.err || 'no output'})`);
    }
    if (!hit || hit.command !== 'open-room-panel') {
      throw new Error(
        `the key chord did not reach the bridge (frontmost: ${sent.out || 'unknown'})`
      );
    }
    result = {
      zen: result.zen,
      check: { ok: true, error: null },
      shortcut: {
        key: 'Ctrl+Alt+B',
        proven: true,
        command: hit.command,
        via:
          process.platform === 'darwin'
            ? 'macOS System Events key code to a frontmost Zen window'
            : 'Windows SendKeys to a headful Zen window',
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
