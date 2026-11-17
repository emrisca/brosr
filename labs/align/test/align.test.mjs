import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aggregate, createWindowSink, quantize, windowEnvelope } from '../envelope.mjs';
import { bestFromDots, bestLag, dotAt, matchCopies } from '../correlate.mjs';
import {
  BendUnavailable,
  parseKernelOutput,
  renderKernel,
  runKernel,
  TEMPLATE_PATH,
} from '../bend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'align.mjs');

// A deterministic pseudo random programme in the range a quiet film produces.
// Noise, not a tone: a tone correlates with itself at every period and would
// make the shift tests pass for the wrong reason.
function programme(length, seed) {
  // splitmix32. A plain LCG puts consecutive seeds on the same line, so two
  // seeds a room apart correlate at 0.87 and a "different programme" test
  // passes for the wrong reason.
  let state = seed >>> 0;
  const out = new Array(length);
  for (let i = 0; i < length; i += 1) {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad) >>> 0;
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97) >>> 0;
    z ^= z >>> 15;
    out[i] = 2000 + (z % 8000);
  }
  return out;
}

// Film-like audio: noise under a slow gain envelope. Loud and quiet passages
// give the one second coarse pass something to line up, and the noise stops it
// matching on a tone. Raw noise at 20 ms is flat at one second, so no coarse
// pass can place it and the ffmpeg case would test nothing real.
function film(seconds, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad) >>> 0;
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97) >>> 0;
    z ^= z >>> 15;
    return z;
  };
  const levels = [0.08, 0.3, 0.65, 1];
  const length = Math.round(8000 * seconds);
  const out = new Int16Array(length);
  let gain = 1;
  for (let i = 0; i < length; i += 1) {
    if (i % 4000 === 0) gain = levels[next() % 4];
    out[i] = Math.round((2000 + (next() % 8000)) * gain);
  }
  return out;
}

function sine(seconds, hz, amplitude) {
  const length = Math.round(8000 * seconds);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / 8000));
  }
  return out;
}

test('one window is the root mean square of its samples', () => {
  const envelope = windowEnvelope([sine(1, 1000, 10000)]);
  assert.equal(envelope.length, 50);
  for (const value of envelope) {
    assert.ok(Math.abs(value - 7071) <= 120, `saw ${value}`);
  }
});

test('an odd split across chunks changes nothing', () => {
  const samples = sine(0.04, 400, 4000);
  const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const sink = createWindowSink();
  sink.push(bytes.subarray(0, 7));
  sink.push(bytes.subarray(7, 300));
  sink.push(bytes.subarray(300));
  assert.deepEqual(sink.end(), windowEnvelope([samples]));
});

test('a group average drops the partial tail', () => {
  assert.deepEqual(aggregate([1, 2, 3, 4, 5], 2), [2, 4]);
  assert.throws(() => aggregate([1, 2], 0), /whole factor/);
});

test('quantising fills the five bit range for each copy', () => {
  // Each copy onto its own range. The comparison is correlation, so a quieter
  // copy still aligns, and neither copy wastes bits on a shared level.
  assert.deepEqual(quantize([0, 10], [5, 7]), [[0, 31], [0, 31]]);
  assert.deepEqual(quantize([6000, 6010]), [[0, 31]]);
  // A copy with no variation has nothing to match, and must not divide by zero.
  assert.deepEqual(quantize([4, 4]), [[0, 0]]);
});

test('a lag pairs a[i] with b[i + lag]', () => {
  const a = [1, 2, 3];
  const b = [4, 5, 6];
  assert.equal(dotAt(a, b, 0), 32);
  assert.equal(dotAt(a, b, 1), 17);
  assert.equal(dotAt(a, b, -1), 23);
  assert.equal(dotAt(a, b, 9), 0);
});

test('both engines pick the same lag on the same dots', () => {
  const a = programme(60, 11);
  const b = programme(60, 12);
  const dots = new Map();
  for (let lag = -10; lag <= 10; lag += 1) dots.set(lag, dotAt(a, b, lag));
  assert.deepEqual(bestFromDots(dots, { a, b }), bestLag(a, b, -10, 10));
});

test('a tie goes to the lag nearest zero, then the smaller lag', () => {
  const dots = new Map([
    [-4, 100],
    [0, 100],
    [3, 100],
  ]);
  assert.equal(bestFromDots(dots).lag, 0);
});

test('a copy with 4.1 s of extra head reports +4100', async () => {
  const a = programme(20000, 7);
  const b = [...new Array(205).fill(0), ...a];
  const result = await matchCopies(a, b, { maxOffsetMs: 600000 });
  assert.ok(Math.abs(result.offsetMs - 4100) <= 40, `saw ${result.offsetMs}`);
  assert.ok(result.confidence > 0.9, `confidence ${result.confidence}`);
  assert.ok(result.fine, 'the fine pass should have run');
});

test('a copy with 4.1 s trimmed reports -4100', async () => {
  const a = programme(20000, 7);
  const b = a.slice(205);
  const result = await matchCopies(a, b, { maxOffsetMs: 600000 });
  assert.ok(Math.abs(result.offsetMs + 4100) <= 40, `saw ${result.offsetMs}`);
  assert.ok(result.confidence > 0.9, `confidence ${result.confidence}`);
});

test('an identical copy reports zero', async () => {
  const a = programme(12000, 21);
  const result = await matchCopies(a, a, { maxOffsetMs: 600000 });
  assert.equal(result.offsetMs, 0);
  assert.ok(result.confidence > 0.99, `confidence ${result.confidence}`);
});

test('two different programmes stay under the confidence floor', async () => {
  const a = programme(20000, 7);
  const b = programme(20000, 8);
  const result = await matchCopies(a, b, { maxOffsetMs: 600000 });
  assert.ok(result.confidence < 0.5, `confidence ${result.confidence}`);
});

test('a flat envelope does not hide a shift behind lag zero', async () => {
  // Quiet dialogue and room tone differ by a few percent from window to
  // window. A raw dot counts more terms near lag zero, and on an envelope that
  // flat the bias beats the peak, so a five window shift would read as zero.
  let state = 41;
  const flat = [];
  for (let i = 0; i < 4000; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    flat.push(3000 + (state % 3000));
  }
  const shifted = [...new Array(5).fill(0), ...flat];
  const result = await matchCopies(flat, shifted, { maxOffsetMs: 600000 });
  assert.equal(result.offsetMs, 100);
  assert.ok(result.confidence > 0.9, `confidence ${result.confidence}`);
});

test('the renderer fills every token and refuses values that are not five bit', async () => {
  const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
  const source = renderKernel(template, { a: [1, 2, 3], b: [4, 5], first: -2, last: 2 });
  assert.match(source, /return \[1, 2, 3\]/);
  assert.match(source, /scan\(a_data\(\), b_data\(\), 0, 4, 2\)/);
  assert.doesNotMatch(source, /<<[A-Z]+>>/);
  assert.throws(() => renderKernel(template, { a: [300], b: [1], first: 0, last: 0 }), /five bit/);
  assert.throws(() => renderKernel(template, { a: [1], b: [1], first: 2, last: 1 }), /lag range/);
});

test('the parser reads lag and dot and refuses a gap', () => {
  const dots = parseKernelOutput('-2 10\n-1 7\n0 4\nResult: λa (a IO/Done/tag IO/MAGIC 0)\n', {
    first: -2,
    last: 0,
  });
  assert.equal(dots.get(-2), 10);
  assert.equal(dots.get(-1), 7);
  assert.equal(dots.get(0), 4);
  assert.throws(() => parseKernelOutput('0 4\n', { first: -1, last: 0 }), /skipped/);
  assert.throws(() => parseKernelOutput('nonsense\n'), /unreadable/);
  assert.throws(() => parseKernelOutput('0 4\n0 5\n'), /twice/);
});

test('a missing Bend binary is an error, never a zero', async () => {
  const source = await fs.readFile(TEMPLATE_PATH, 'utf8');
  const rendered = renderKernel(source, { a: [1, 2], b: [1, 2], first: 0, last: 0 });
  await assert.rejects(
    runKernel({ source: rendered, bendBin: '/nonexistent/bend-for-test', first: 0, last: 0 }),
    (error) => error instanceof BendUnavailable
  );
});

test('the CLI explains itself when it has no arguments', () => {
  const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});

const hasBend = spawnSync('bend', ['--version'], { encoding: 'utf8' }).status === 0;

test(
  'the Bend kernel and the JS oracle score the same lags',
  { skip: hasBend ? false : 'Bend is not installed' },
  async () => {
    const [a, b] = quantize(programme(80, 31), programme(80, 32));
    const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
    const dots = await runKernel({
      source: renderKernel(template, { a, b, first: -5, last: 5 }),
      first: -5,
      last: 5,
    });
    const bend = bestFromDots(dots, { a, b });
    const js = bestLag(a, b, -5, 5);
    assert.equal(bend.lag, js.lag);
    assert.equal(bend.dot, js.dot);
  }
);

function wav(samples, sampleRate = 8000) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) data.writeInt16LE(samples[i], i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

test(
  'the CLI recovers a real shift through ffmpeg',
  { skip: hasFfmpeg ? false : 'ffmpeg is not installed' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brosr-align-test-'));
    try {
      const track = film(40, 31);
      const lead = Math.round(8000 * 4.1);
      const shifted = new Int16Array(track.length + lead);
      shifted.set(track, lead);
      const first = path.join(dir, 'first.wav');
      const second = path.join(dir, 'second.wav');
      await fs.writeFile(first, wav(track));
      await fs.writeFile(second, wav(shifted));

      const run = spawnSync(
        process.execPath,
        [CLI, '--a', first, '--b', second, '--engine', 'js', '--json'],
        { encoding: 'utf8' }
      );
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout);
      assert.equal(result.engine, 'js');
      assert.equal(result.matched, true);
      assert.ok(Math.abs(result.offsetMs - 4100) <= 40, `saw ${result.offsetMs}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  'auto falls back to the JS lane when Bend is missing',
  { skip: hasFfmpeg ? false : 'ffmpeg is not installed' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brosr-align-fallback-'));
    try {
      const track = film(12, 77);
      const lead = Math.round(8000 * 2);
      const shifted = new Int16Array(track.length + lead);
      shifted.set(track, lead);
      const first = path.join(dir, 'first.wav');
      const second = path.join(dir, 'second.wav');
      await fs.writeFile(first, wav(track));
      await fs.writeFile(second, wav(shifted));
      const run = spawnSync(
        process.execPath,
        [CLI, '--a', first, '--b', second, '--engine', 'auto', '--json'],
        { encoding: 'utf8', env: { ...process.env, BEND_BIN: '/nonexistent/bend-for-test' } }
      );
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout);
      assert.match(result.engine, /^js/);
      assert.ok(Math.abs(result.offsetMs - 2000) <= 40, `saw ${result.offsetMs}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  'a file with no audio fails cleanly',
  { skip: hasFfmpeg ? false : 'ffmpeg is not installed' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brosr-align-empty-'));
    try {
      const first = path.join(dir, 'first.wav');
      const second = path.join(dir, 'second.wav');
      await fs.writeFile(first, Buffer.alloc(0));
      await fs.writeFile(second, Buffer.alloc(0));
      const run = spawnSync(process.execPath, [CLI, '--a', first, '--b', second], {
        encoding: 'utf8',
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /no audio|Invalid data|shorter than one window/i);
      assert.doesNotMatch(run.stderr, /\n\s+at .*\.mjs:/, 'a clean failure has no stack trace');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  'the same inputs produce byte identical stdout',
  { skip: hasFfmpeg ? false : 'ffmpeg is not installed' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brosr-align-repeat-'));
    try {
      const track = film(12, 57);
      const lead = Math.round(8000 * 2);
      const shifted = new Int16Array(track.length + lead);
      shifted.set(track, lead);
      const first = path.join(dir, 'first.wav');
      const second = path.join(dir, 'second.wav');
      await fs.writeFile(first, wav(track));
      await fs.writeFile(second, wav(shifted));
      const run = () =>
        spawnSync(
          process.execPath,
          [CLI, '--a', first, '--b', second, '--engine', 'js', '--json'],
          { encoding: 'utf8' }
        );
      const one = run();
      const two = run();
      assert.equal(one.status, 0, one.stderr);
      assert.equal(two.status, 0, two.stderr);
      assert.equal(one.stdout, two.stdout);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  'the Bend CLI recovers a real shift through ffmpeg',
  { skip: hasFfmpeg && hasBend ? false : 'ffmpeg or Bend is not installed' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brosr-align-bend-'));
    try {
      const track = film(40, 31);
      const lead = Math.round(8000 * 4.1);
      const shifted = new Int16Array(track.length + lead);
      shifted.set(track, lead);
      const first = path.join(dir, 'first.wav');
      const second = path.join(dir, 'second.wav');
      await fs.writeFile(first, wav(track));
      await fs.writeFile(second, wav(shifted));
      const run = spawnSync(
        process.execPath,
        [CLI, '--a', first, '--b', second, '--engine', 'bend', '--json'],
        { encoding: 'utf8', timeout: 120000 }
      );
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout);
      assert.match(result.engine, /^bend/);
      assert.ok(Math.abs(result.offsetMs - 4100) <= 40, `saw ${result.offsetMs}`);
      assert.ok(result.confidence > 0.9, `confidence ${result.confidence}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
);
