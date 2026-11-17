// Audio envelopes for the alignment lane.
//
// ffmpeg decodes the first audio track to mono signed 16 bit at 8 kHz and this
// file reduces it on arrival to one RMS value per 20 ms window. The PCM is
// never kept: a two hour film is about 115 MB of samples and 360,000 windows,
// and only the windows are useful downstream.
import { spawn } from 'node:child_process';
import { quantize } from './correlate.mjs';

export const SAMPLE_RATE = 8000;
export const WINDOW_MS = 20;
export const SAMPLES_PER_WINDOW = (SAMPLE_RATE * WINDOW_MS) / 1000;

// Chunk boundaries do not line up with windows, and stdout can hand over an
// odd number of bytes. The sink keeps the leftover sum and the leftover byte,
// so the envelope does not depend on how the pipe was sliced.
export function createWindowSink({ windowSamples = SAMPLES_PER_WINDOW } = {}) {
  if (!Number.isInteger(windowSamples) || windowSamples < 1) {
    throw new Error('a window needs a whole number of samples');
  }
  const values = [];
  let sum = 0;
  let count = 0;
  let carry = null;

  function push(buffer) {
    let bytes = buffer;
    if (carry) {
      bytes = Buffer.concat([carry, buffer]);
      carry = null;
    }
    const whole = bytes.length - (bytes.length % 2);
    if (whole !== bytes.length) carry = bytes.subarray(whole);
    for (let offset = 0; offset < whole; offset += 2) {
      const sample = bytes.readInt16LE(offset);
      sum += sample * sample;
      count += 1;
      if (count === windowSamples) {
        values.push(Math.round(Math.sqrt(sum / count)));
        sum = 0;
        count = 0;
      }
    }
  }

  // A trailing partial window is dropped. It is under 20 ms of film and it
  // would carry less evidence than the window it failed to complete.
  function end() {
    carry = null;
    sum = 0;
    count = 0;
    return values;
  }

  return { push, end, values };
}

// A chunk is bytes on the pipe and samples in a test, so both are accepted and
// neither is copied unless the view is not a Buffer already.
function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error('a chunk must be a Buffer or a typed array of samples');
}

export function windowEnvelope(chunks, options = {}) {
  const sink = createWindowSink(options);
  for (const chunk of chunks) sink.push(toBuffer(chunk));
  return sink.end();
}

export function decodeEnvelope(file, { ffmpegPath = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-nostdin',
      '-i', file,
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      '-',
    ];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const sink = createWindowSink();
    let errors = '';
    let settled = false;

    function fail(message) {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(message));
    }

    child.stdout.on('data', (chunk) => sink.push(chunk));
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString('utf8');
      if (errors.length > 4096) errors = errors.slice(-4096);
    });
    child.on('error', (error) => {
      const hint = error.code === 'ENOENT'
        ? `ffmpeg was not found at ${ffmpegPath}. Install ffmpeg or pass --ffmpeg.`
        : `could not start ${ffmpegPath}: ${error.message}`;
      fail(hint);
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const tail = errors.trim().split('\n').slice(-3).join(' ').trim();
        fail(tail || `${file} has no decodable audio (ffmpeg exit ${code})`);
        return;
      }
      settled = true;
      const values = sink.end();
      if (!values.length) {
        reject(new Error(`no audio in ${file}, or it is shorter than one window`));
        return;
      }
      resolve(values);
    });
  });
}

// Whole groups only, matching core/align semantics elsewhere in the repo.
export function aggregate(values, factor) {
  if (!Number.isInteger(factor) || factor < 1) throw new Error('aggregate needs a whole factor');
  const out = [];
  for (let i = 0; i + factor <= values.length; i += factor) {
    let sum = 0;
    for (let k = 0; k < factor; k += 1) sum += values[i + k];
    out.push(Math.round(sum / factor));
  }
  return out;
}

// The reference implementation lives in correlate.mjs. Re-export it here so
// callers that already import the envelope helpers share one rule.
export { quantize } from './correlate.mjs';
