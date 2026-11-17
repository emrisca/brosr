// Two peers, one film, one machine. Each browser gets a room tab and a film tab,
// which is the shape the live guest runs in. The host plays a clip and the guest
// film tab has to follow it. A guest that never applies a frame fails here, and
// so does one that applies frames and still sits more than a second away.
//
//   node scripts/check-media-loopback.mjs
//
// Everything stays on loopback: its own relay, two temp profiles and three free
// ports. It never touches the app browser on 9333. The clip is
// spike/.runtime/clip.webm, which the relay already serves at /media/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiDi } from '../spike/bidi.mjs';
import { buildXpi } from '../zen/package.mjs';
import { findZen, writeProfile } from '../zen/profile.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIP = path.join(root, 'spike', '.runtime', 'clip.webm');
const ROOM = 'medialoop';
const DRIFT_LIMIT = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

function freePort(start) {
  const scan = async () => {
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
  };
  return scan();
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

// One read returns the room state, the relay counters and the element that
// holds the playhead. A check that reads only the dataset can pass while the
// video sits still, so the element is part of every sample.
const SAMPLE = `(() => {
  const video = document.querySelector('video');
  const read = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
  return JSON.stringify({
    room: read(document.documentElement.dataset.brosr),
    relay: read(document.documentElement.dataset.brosrRelay),
    error: document.documentElement.dataset.brosrError || '',
    time: video ? Number(video.currentTime) : null,
    paused: video ? Boolean(video.paused) : null,
    duration: video ? Number(video.duration || 0) : 0,
    ready: video ? Number(video.readyState) : 0,
  });
})()`;

function page(bidi, context) {
  return {
    context,
    async eval(expression) {
      return evaluate(bidi, context, expression);
    },
    async sample() {
      const raw = await evaluate(bidi, context, SAMPLE);
      const parsed = JSON.parse(raw);
      if (parsed.error) throw new Error('core error: ' + parsed.error);
      return parsed;
    },
  };
}

async function until(fn, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

async function open(bidi, url) {
  const created = await bidi.cmd('browsingContext.create', { type: 'tab' });
  await bidi.cmd('browsingContext.navigate', {
    context: created.context,
    url,
    wait: 'complete',
  });
  return page(bidi, created.context);
}

const report = { ok: false, limit: DRIFT_LIMIT, steps: {} };

async function main() {
  if (!fs.existsSync(CLIP)) {
    throw new Error(
      `no clip at ${path.relative(root, CLIP)}. The relay serves that folder at /media/, and the fixture needs a real video to seek in.`
    );
  }
  const zen = findZen();
  if (!zen) throw new Error('no Zen binary found');

  const xpi = path.join(tmpdir(), `brosr-media-check-${process.pid}.xpi`);
  const built = buildXpi(xpi);
  const relayPort = await freePort(8893);
  const hostPort = await freePort(9353);
  const guestPort = await freePort(9354);

  const relay = spawn(process.execPath, [path.join(root, 'spike', 'relay.js')], {
    cwd: path.join(root, 'spike'),
    stdio: 'ignore',
    env: { ...process.env, PORT: String(relayPort), HOST: '127.0.0.1' },
  });

  const launch = async (port) => {
    const profile = await mkdtemp(path.join(tmpdir(), 'brosr-media-'));
    writeProfile(profile, { bridge: xpi });
    const child = spawn(
      zen,
      [
        '--profile',
        profile,
        '--no-remote',
        '--new-instance',
        '--remote-debugging-port',
        String(port),
        '-headless',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );
    return { child, profile };
  };
  const hostRun = await launch(hostPort);
  const guestRun = await launch(guestPort);

  let hostBidi = null;
  let guestBidi = null;
  const close = async () => {
    hostBidi?.close?.();
    guestBidi?.close?.();
    for (const run of [hostRun, guestRun]) {
      if (run.child.exitCode === null) run.child.kill('SIGKILL');
    }
    if (relay.exitCode === null) relay.kill('SIGKILL');
    await sleep(800);
    for (const run of [hostRun, guestRun]) {
      await rm(run.profile, { recursive: true, force: true }).catch(() => {});
    }
    await rm(xpi, { force: true }).catch(() => {});
  };

  try {
    log(`[media] xpi ${built.entries} files, relay ${relayPort}`);
    await until(
      async () => (await fetch(`http://127.0.0.1:${relayPort}/health`)).ok,
      'the relay',
      20000
    );
    hostBidi = await connect(hostPort);
    guestBidi = await connect(guestPort);

    const origin = `http://127.0.0.1:${relayPort}`;
    const roomUrl = (role, peer, name) =>
      `${origin}/room-b.html?role=${role}&room=${ROOM}&peer=${peer}&name=${name}&relay=${relayPort}`;

    // The rooms come first, because a film tab can only report to one that is
    // already connected. The film tabs carry no room parameters, which is the
    // same page a person opens when they click the film.
    const hostRoom = await open(hostBidi, roomUrl('host', 'host', 'Host'));
    const guestRoom = await open(guestBidi, roomUrl('peer', 'guest', 'Guest'));
    for (const [name, peer] of [['host', hostRoom], ['guest', guestRoom]]) {
      await until(
        async () => {
          const sample = await peer.sample();
          return sample.room && sample.room.socket === 1 ? sample : null;
        },
        `the ${name} room socket`,
        40000
      );
    }

    // clip.html is a plain page on purpose. The bridge treats a page with no
    // room parameters and no room name as a film tab, and the media fixture
    // names itself a room page, so it would open a socket of its own.
    const host = await open(hostBidi, `${origin}/clip.html`);
    const guest = await open(guestBidi, `${origin}/clip.html`);
    for (const [name, peer] of [['host', host], ['guest', guest]]) {
      await until(
        async () => {
          const sample = await peer.sample();
          return sample.duration > 5 && sample.ready >= 2 ? sample : null;
        },
        `the ${name} clip`,
        20000
      );
      await until(
        async () => {
          const sample = await peer.sample();
          return sample.relay && sample.relay.key ? sample : null;
        },
        `the ${name} media hello`,
        20000
      );
    }
    // Both browsers are on the film, so the room has to name it before any act.
    await until(
      async () => {
        const sample = await guestRoom.sample();
        return sample.room && sample.room.media && sample.room.media.key ? sample : null;
      },
      'the room film',
      20000
    );
    report.steps.joined = {
      host: await hostRoom.sample().then((s) => ({ peers: s.room.peers, role: s.room.role })),
      guest: await guestRoom.sample().then((s) => ({ peers: s.room.peers, role: s.room.role })),
    };

    // One read of the host, one of the guest, then the host again. Two BiDi
    // sessions cannot be read at the same instant, so the host position is
    // taken around the guest read and averaged. A paused film needs none of
    // this, which is why the pause step below is the strict one.
    const pair = async () => {
      const first = await host.sample();
      const other = await guest.sample();
      const second = await host.sample();
      const expected = (first.time + second.time) / 2;
      return {
        host: expected,
        guest: other.time,
        drift: Math.round((other.time - expected) * 1000) / 1000,
        guestPaused: other.paused,
        hostPaused: second.paused,
        guestRelay: other.relay || {},
      };
    };

    // 1. Play from a mark. The guest has never applied a frame at join, so its
    // first act is the seed seek. Zero applies here is the failure the doc names.
    await host.eval(
      "(() => { const v = document.querySelector('video'); v.currentTime = 30; v.play().catch(() => {}); return true; })()"
    );
    const applied = await until(
      async () => {
        const sample = await guest.sample();
        return sample.relay && sample.relay.applies > 0 ? sample.relay.applies : 0;
      },
      'the guest apply count',
      15000
    ).catch(() => 0);
    if (!applied) throw new Error('the guest applied no frame (applies stayed 0)');
    await sleep(3000);
    const played = await pair();
    report.steps.play = played;
    if (!(played.guest > 30)) {
      throw new Error(`the guest stayed at ${played.guest.toFixed(3)} s while the host played`);
    }
    if (Math.abs(played.drift) > DRIFT_LIMIT) {
      throw new Error(`the guest drift read ${played.drift} s past ${DRIFT_LIMIT}`);
    }

    // 2. Pause. No clock runs here, so the two playheads compare directly.
    await host.eval("document.querySelector('video').pause(); true");
    await sleep(2000);
    const paused = await pair();
    report.steps.pause = paused;
    if (!paused.guestPaused) throw new Error('the guest kept playing through a host pause');
    if (Math.abs(paused.drift) > DRIFT_LIMIT) {
      throw new Error(`the guest sat ${paused.drift} s off a paused mark`);
    }

    // 3. A seek the host made alone. The guest has to follow it, not drift to it.
    await host.eval(
      "(() => { const v = document.querySelector('video'); v.currentTime = 52; return true; })()"
    );
    await sleep(2000);
    const seeked = await pair();
    report.steps.seek = seeked;
    if (Math.abs(seeked.drift) > DRIFT_LIMIT) {
      throw new Error(`the guest sat ${seeked.drift} s off after a host seek`);
    }

    // 4. Play on and sample the gap. The plan budgets 250 ms p95, so a run
    // reports the distribution even when it passes the one second limit.
    await host.eval("document.querySelector('video').play().catch(() => {}); true");
    const drifts = [];
    for (let index = 0; index < 10; index += 1) {
      await sleep(600);
      const reading = await pair();
      drifts.push(reading.drift);
    }
    const sorted = [...drifts].map(Math.abs).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const stats = {
      samples: sorted.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95,
      max: sorted[sorted.length - 1],
      drifts,
    };
    report.steps.playback = stats;
    report.steps.counters = (await guest.sample()).relay;
    await host.eval("document.querySelector('video').pause(); true").catch(() => {});
    if (stats.max > DRIFT_LIMIT) {
      throw new Error(`the guest drift peaked at ${stats.max} s past ${DRIFT_LIMIT}`);
    }
    if (!(report.steps.counters && report.steps.counters.sends > 0)) {
      throw new Error('the guest never sent a frame, so the room was one way');
    }

    report.ok = true;
    log(
      `[media] PASS: guest applies ${report.steps.counters.applies}, ` +
        `paused ${paused.drift} s, seek ${seeked.drift} s, ` +
        `playback p95 ${p95} s, max ${stats.max} s`
    );
  } finally {
    await close();
  }
}

main()
  .then(() => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    report.error = String((error && error.message) || error);
    console.error(`FAIL: ${report.error}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  });
