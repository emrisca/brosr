// The Bend side of the alignment lane.
//
// The envelope arrives as a literal list, so Bend never opens a file, never
// parses text and never sees a path. This file renders a template with those
// literals, runs it in a throwaway directory, and reads back `lag dot` lines.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestFromDots } from './correlate.mjs';

export const TEMPLATE_PATH = fileURLToPath(new URL('./align.bend', import.meta.url));
export const DEFAULT_RUNNER = 'run-c';
export const DEFAULT_TIMEOUT_MS = 120000;

const TOKENS = ['<<A>>', '<<B>>', '<<LAST>>', '<<LAST_INDEX>>', '<<BIAS>>'];

export class BendUnavailable extends Error {
  constructor(detail) {
    super(
      `Bend is not usable here: ${detail}. Install Bend inside WSL2, or run with --engine js.`
    );
    this.name = 'BendUnavailable';
  }
}

function literal(values) {
  if (!values.length) throw new Error('an envelope needs at least one value');
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > 31) {
      throw new Error(`envelope values must be five bit, saw ${value}`);
    }
  }
  return values.join(', ');
}

// One pass, one source file. The generated file is deterministic given the
// same numbers, so a kept copy is a reproducible record of the input.
export function renderKernel(template, { a, b, first, last }) {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first > last) {
    throw new Error('the lag range must be two whole numbers with first <= last');
  }
  // Bend 0.2.38 has no signed integer in this grammar, so the kernel walks a
  // non-negative index and subtracts this bias in the wrapper. A range that
  // starts at or above zero needs no shift.
  const bias = Math.max(0, -first);
  const lastIndex = last - first;
  const source = template
    .replaceAll(TOKENS[0], literal(a))
    .replaceAll(TOKENS[1], literal(b))
    .replaceAll(TOKENS[2], String(last))
    .replaceAll(TOKENS[3], String(lastIndex))
    .replaceAll(TOKENS[4], String(bias));
  const left = TOKENS.filter((token) => source.includes(token));
  if (left.length) throw new Error(`template still holds ${left.join(', ')}`);
  return source;
}

export function parseKernelOutput(text, { first, last } = {}) {
  const dots = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // The installed Bend 1 runner appends a readback footer after the program's
    // own output. It is not a scored lag and must not reach the parser.
    if (line.startsWith('Result:')) continue;
    const match = /^(-?\d+)\s+(\d+)$/.exec(line);
    if (!match) throw new Error(`unreadable kernel line: ${line.slice(0, 60)}`);
    const lag = Number(match[1]);
    const dot = Number(match[2]);
    if (dots.has(lag)) throw new Error(`kernel scored lag ${lag} twice`);
    dots.set(lag, dot);
  }
  if (!dots.size) throw new Error('the kernel printed nothing');
  if (Number.isInteger(first) && Number.isInteger(last)) {
    const missing = [];
    for (let lag = first; lag <= last; lag += 1) if (!dots.has(lag)) missing.push(lag);
    if (missing.length) {
      throw new Error(`the kernel skipped ${missing.length} lags, first at ${missing[0]}`);
    }
  }
  return dots;
}

export function probeBend(bendBin = 'bend', { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(bendBin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = text.trim().split('\n')[0] || '';
      resolve(code === 0 && line ? line : null);
    });
  });
}

// A missing binary, a compile error and a timeout all end the same way: an
// error the caller can catch, never a zero. A wrong offset that looks like a
// real one is worse than no offset at all.
export async function runKernel({
  source,
  bendBin = process.env.BEND_BIN || 'bend',
  runner = DEFAULT_RUNNER,
  workspace = null,
  name = 'kernel',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  first,
  last,
} = {}) {
  if (!source) throw new Error('runKernel needs rendered source');
  const own = workspace === null;
  const dir = own ? await fs.mkdtemp(path.join(os.tmpdir(), 'brosr-align-')) : workspace;
  const file = path.join(dir, `${name}.bend`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, source, 'utf8');
    const text = await spawnKernel({ bendBin, runner, file, timeoutMs });
    const lastIndex = Number.isInteger(first) && Number.isInteger(last) ? last - first : undefined;
    const raw = parseKernelOutput(text, { first: 0, last: lastIndex });
    const dots = new Map();
    for (const [index, dot] of raw) dots.set(index + (Number.isInteger(first) ? first : 0), dot);
    return dots;
  } finally {
    if (own) await fs.rm(dir, { recursive: true, force: true });
  }
}

function spawnKernel({ bendBin, runner, file, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // The generated source is rendered from one reviewed template and tested by
    // the parity case. Skipping the compiler's type pass keeps a two hour
    // coarse search near the wall clock budget. A broken template still fails
    // here, and the JS lane remains the reference.
    const args = runner === 'run-c' || runner === 'run-rs'
      ? [runner, '-O', 'no-type-check', file]
      : [runner, file];
    const child = spawn(bendBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error(`the kernel did not finish in ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
      if (err.length > 8192) err = err.slice(-8192);
    });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new BendUnavailable(`${bendBin} was not found on PATH`));
        return;
      }
      reject(new Error(`could not start Bend: ${error.message}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = err.trim().split('\n').slice(-6).join('\n').trim();
        reject(new Error(`Bend exited ${code}${tail ? `:\n${tail}` : ''}`));
        return;
      }
      resolve(out);
    });
  });
}

// A convenience for callers that already hold a dots map.
export { bestFromDots };
