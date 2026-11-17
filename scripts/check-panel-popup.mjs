// Measures the room panel in the toolbar popup on a real window. The headless
// lane opens the same document in a tab, which says nothing about the surface a
// person clicks. This run builds the working-tree XPI, starts a window, opens a
// host room, sends the panel chord and reads the popup document.
//
//   node scripts/check-panel-popup.mjs
//
// A window that refuses the chord falls back to the same document at popup
// width in a tab, and the report says which surface it measured.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { buildXpi } from '../zen/package.mjs';
import { findZen, writeProfile } from '../zen/profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const runtime = path.join(root, '.runtime');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

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
  throw new Error(`no free port between ${start} and ${start + 39}`);
}

async function connect(port, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      return await new BiDi(`ws://127.0.0.1:${port}/session`).connect();
    } catch (error) {
      last = error;
      await sleep(400);
    }
  }
  throw new Error(`no BiDi on ${port}: ${last ? last.message : 'unknown'}`);
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

// A tab with a player publishes its own media state under this key. The room
// tab publishes the socket state under brosr, so the two reads stay apart.
async function readRelay(bidi, context) {
  const raw = await evaluate(
    bidi,
    context,
    'document.documentElement.dataset.brosrRelay || ""'
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function waitFor(fn, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(300);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

// The panel shortcut is a browser command, so only a real chord opens the
// toolbar popup. This helper posts that chord to the browser process.
function keypostPath() {
  if (process.platform !== 'darwin') return null;
  const source = path.join(root, 'zen', 'keypost.swift');
  const out = path.join(runtime, 'keypost');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(source).mtimeMs) return out;
  fs.mkdirSync(runtime, { recursive: true });
  const build = spawnSync('swiftc', ['-parse-as-library', '-O', source, '-o', out], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (build.status !== 0) return null;
  return out;
}

function postChord(pid) {
  const helper = keypostPath();
  if (!helper) return { ok: false, err: 'no keypost helper' };
  const res = spawnSync(helper, ['chord', String(pid)], { encoding: 'utf8', timeout: 20000 });
  return { ok: res.status === 0, err: String(res.stderr || '').trim() };
}

async function main() {
  const zen = findZen();
  if (!zen || !fs.existsSync(zen)) throw new Error('no Zen binary found');
  fs.mkdirSync(runtime, { recursive: true });

  const built = buildXpi(path.join(runtime, 'bridge-popup.xpi'));
  const profile = await mkdtemp(path.join(tmpdir(), 'brosr-popup-'));
  writeProfile(profile, { bridge: false });
  log(`[popup] xpi ${built.entries} files, profile ${profile}`);

  const relayPort = await freePort(8795);
  const relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
    cwd: path.join(root, 'spike'),
    stdio: 'ignore',
    env: { ...process.env, PORT: String(relayPort), HOST: '127.0.0.1' },
  });

  const port = await freePort(9490);
  const browser = spawn(
    zen,
    [
      '--profile',
      profile,
      '--no-remote',
      '--new-instance',
      '--remote-debugging-port',
      String(port),
      '--width',
      '1280',
      '--height',
      '900',
      'about:blank',
    ],
    { stdio: 'ignore', env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } }
  );

  let bidi = null;
  const contexts = [];
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${relayPort}/health`)).ok, 'relay');
    bidi = await connect(port);
    // The engine installs the built XPI the same way a person would, so this
    // lane runs a real add-on rather than a folder it found on disk.
    const installed = await bidi.cmd('webExtension.install', {
      extensionData: { type: 'archivePath', path: built.out },
    });
    log('[popup] installed', JSON.stringify(installed.extension));

    const created = await bidi.cmd('browsingContext.create', { type: 'tab' });
    const context = created.context;
    contexts.push(context);
    const room = `panelpopup-${port}`;
    const url =
      `http://127.0.0.1:${relayPort}/room-b.html?role=host&room=${room}` +
      `&peer=host&name=Host&relay=${relayPort}`;
    await bidi.cmd('browsingContext.navigate', { context, url, wait: 'complete' });

    const data = await waitFor(
      async () => {
        const seen = await readDataset(bidi, context).catch(() => null);
        return seen && seen.socket === 1 ? seen : null;
      },
      'the room tab connected',
      40000
    ).catch(async (error) => {
      const seen = await evaluate(
        bidi,
        context,
        `JSON.stringify({
          url: location.href,
          title: document.title,
          ready: document.readyState,
          dataset: Object.keys(document.documentElement.dataset),
          error: document.documentElement.dataset.brosrError || null,
          text: (document.body ? document.body.textContent : '').trim().slice(0, 160),
        })`
      ).catch(() => null);
      throw new Error(`${error.message}, page ${seen}`);
    });
    if (!data.panelUrl) throw new Error('the room tab published no panel URL');
    log(`[popup] room ${room}, panel ${data.panelUrl}`);

    // The Watch card grows when this browser has a tab on the film, and the
    // popup has to survive the taller card. The film tab is a plain page, so
    // the bridge treats it as a film and not as a second room.
    const film = await bidi.cmd('browsingContext.create', { type: 'tab' });
    contexts.push(film.context);
    await bidi.cmd('browsingContext.navigate', {
      context: film.context,
      url: `http://127.0.0.1:${relayPort}/clip.html`,
      wait: 'complete',
    });
    const filmKey = await waitFor(
      async () => {
        const seen = await readDataset(bidi, context).catch(() => null);
        return seen && seen.media && seen.media.key ? seen.media.key : null;
      },
      'the room film',
      30000
    );
    log(`[popup] film ${filmKey}`);
    // The reading comes from that tab, so the run waits until it reports. A
    // clip that never loaded leaves the Watch card without a reading and the
    // failure says so rather than blaming the panel.
    await waitFor(
      async () => {
        const seen = await readRelay(bidi, film.context).catch(() => null);
        return seen && seen.key ? seen.key : null;
      },
      'the film tab report',
      20000
    ).catch(async (error) => {
      const seen = await evaluate(
        bidi,
        film.context,
        `JSON.stringify({
          url: location.href,
          ready: document.readyState,
          video: (() => {
            const node = document.querySelector('video');
            if (!node) return null;
            return { state: node.readyState, src: node.currentSrc, error: node.error ? node.error.code : null, muted: node.muted };
          })(),
          dataset: Object.keys(document.documentElement.dataset),
        })`
      ).catch(() => null);
      throw new Error(`${error.message}, film tab ${seen}`);
    });
    log('[popup] film tab reporting');

    // Focus the window so the chord reaches it, then post the chord.
    await bidi.cmd('browsingContext.activate', { context }).catch(() => {});
    await sleep(600);
    const chord = postChord(browser.pid);
    log('[popup] chord', JSON.stringify(chord));

    // A popup is not a normal browsing context, so it never appears in the
    // tree. The panel reports its own frame through the room tab, which is the
    // same path a headless run reads.
    const readPanelState = async () => {
      const seen = await readDataset(bidi, context).catch(() => null);
      return seen && seen.panelState ? seen.panelState : null;
    };

    const waitPopup = async (ms) => {
      const end = Date.now() + ms;
      let last = null;
      while (Date.now() < end) {
        last = await readPanelState();
        if (last && last.surface === 'popup' && last.state === 'live') return last;
        await sleep(300);
      }
      return null;
    };

    let report = await waitPopup(12000);
    if (!report) {
      // The room page carries a button for the same popup, so a window that
      // loses the chord on its first start still gets one more attempt.
      log('[popup] no popup report from the chord, asking the room page button');
      const clicked = await evaluate(
        bidi,
        context,
        `(() => {
          const button = document.getElementById('brosr-panel-button');
          if (!button) return 'no button';
          button.click();
          return 'clicked';
        })()`
      ).catch(() => 'error');
      log('[popup] button', clicked);
      report = await waitPopup(10000);
    }
    if (!report) throw new Error('the toolbar popup never reported itself to the room tab');

    // The reading comes from the film tab through the background page, so it
    // lands a beat after the panel's first status pass.
    const readEnd = Date.now() + 15000;
    while (Date.now() < readEnd && !report.readingText) {
      await sleep(500);
      const next = await readPanelState();
      if (next && next.state === 'live') report = next;
    }
    if (!report.readingText) {
      throw new Error(
        'the panel showed no film reading: ' +
          JSON.stringify({ reading: report.reading, reply: report.readingReply })
      );
    }
    if (!/applied/.test(report.readingText)) {
      throw new Error(`the panel reading read: ${report.readingText}`);
    }

    const frame = report.geometry || {};
    log(
      '[popup] report',
      JSON.stringify({
        state: report.state,
        surface: report.surface,
        width: report.width,
        height: report.height,
        scrollW: frame.scrollW,
        overflowX: frame.overflowX,
        footer: frame.footer,
        reading: report.reading,
        readingText: report.readingText,
        watch: report.watch,
      })
    );
    if (report.surface !== 'popup') throw new Error(`the panel opened as ${report.surface}`);
    if (report.width !== 360) throw new Error(`the popup is ${report.width} wide, not 360`);
    if (frame.overflowX) {
      throw new Error(`the popup scrolls sideways: ${frame.scrollW} in ${report.width}`);
    }
    if (!frame.footer) throw new Error('the popup reported no footer');
    // The report gives a top and a height, so the end of the frame is the sum.
    const footerBottom = frame.footer.top + frame.footer.h;
    if (footerBottom > report.height + 1) {
      throw new Error(`the footer ends at ${footerBottom} in a ${report.height} popup`);
    }
    log(
      `[popup] PASS: ${report.width}x${report.height}, footer ends at ` +
        `${footerBottom}, no sideways scroll`
    );
  } finally {
    for (const context of contexts) {
      await bidi?.cmd('browsingContext.close', { context }).catch(() => {});
    }
    bidi?.close?.();
    if (browser.exitCode === null) browser.kill('SIGKILL');
    if (relay.exitCode === null) relay.kill('SIGKILL');
    await sleep(800);
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
