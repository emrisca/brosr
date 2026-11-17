#!/usr/bin/env node
// Command line for the alignment lane.
//
//   node labs/align/align.mjs --a first.mkv --b second.mkv
//   node labs/align/align.mjs --a a.mkv --b b.mkv --engine js --json
//
// The offset is milliseconds to add to room time to get this peer's local
// media position. A copy with 4.1 s of extra titles at the head reports +4100.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { decodeEnvelope, WINDOW_MS } from './envelope.mjs';
import { CONFIDENCE_FLOOR, bestLag, matchCopies } from './correlate.mjs';
import {
  BendUnavailable,
  DEFAULT_RUNNER,
  DEFAULT_TIMEOUT_MS,
  TEMPLATE_PATH,
  probeBend,
  renderKernel,
  runKernel,
} from './bend.mjs';

export { BendUnavailable };

function usage() {
  return [
    'usage: node labs/align/align.mjs --a FILE --b FILE [options]',
    '',
    '  --a, --b            the two copies to compare',
    '  --engine auto|js|bend   default auto, Bend when it is installed',
    '  --max-offset-ms N   search window, default 600000 (ten minutes)',
    '  --ffmpeg PATH       ffmpeg binary, default ffmpeg on PATH',
    '  --json              one JSON object on stdout',
    '  --keep DIR          keep the generated .bend sources',
    '',
    'exit 0 matched, 3 no confident match, 2 usage, 1 input or tool failure',
  ].join('\n');
}

async function pickEngine({ engine, bendBin, runner, timeoutMs, keep }) {
  if (engine !== 'auto' && engine !== 'js' && engine !== 'bend') {
    throw new Error(`unknown engine ${engine}`);
  }
  if (engine === 'js') return { label: 'js', kind: 'js', best: bestLag };

  const version = await probeBend(bendBin);
  if (!version) {
    if (engine === 'bend') {
      throw new BendUnavailable(`${bendBin} did not answer --version`);
    }
    return { label: 'js (bend not found)', kind: 'js', best: bestLag };
  }

  const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
  let workspace = null;
  let counter = 0;
  const best = async (a, b, first, last) => {
    if (!workspace) workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'brosr-align-'));
    counter += 1;
    const name = `pass-${counter}`;
    const source = renderKernel(template, { a, b, first, last });
    if (keep) {
      await fs.mkdir(keep, { recursive: true });
      await fs.writeFile(path.join(keep, `${name}.bend`), source, 'utf8');
    }
    const dots = await runKernel({
      source,
      bendBin,
      runner,
      workspace,
      name,
      timeoutMs,
      first,
      last,
    });
    return { lag: 0, dot: 0, dots };
  };

  return {
    label: `bend (${version})`,
    kind: 'bend',
    best: async (a, b, first, last) => {
      const scored = await best(a, b, first, last);
      const { bestFromDots } = await import('./correlate.mjs');
      return bestFromDots(scored.dots, { a, b });
    },
    cleanup: async () => {
      if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    },
  };
}

export async function analyze({
  a,
  b,
  engine = 'auto',
  maxOffsetMs = 600000,
  ffmpegPath = 'ffmpeg',
  bendBin = process.env.BEND_BIN || 'bend',
  runner = DEFAULT_RUNNER,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  keep = null,
} = {}) {
  if (!a || !b) throw new Error('both --a and --b are required');
  if (path.resolve(a) === path.resolve(b)) throw new Error('A and B are the same file');

  const envelopeA = await decodeEnvelope(a, { ffmpegPath });
  const envelopeB = await decodeEnvelope(b, { ffmpegPath });
  const chosen = await pickEngine({ engine, bendBin, runner, timeoutMs, keep });

  try {
    const result = await matchCopies(envelopeA, envelopeB, {
      maxOffsetMs,
      windowMs: WINDOW_MS,
      best: chosen.best,
    });
    return {
      ...result,
      engine: chosen.label,
      matched: result.confidence >= CONFIDENCE_FLOOR,
      threshold: CONFIDENCE_FLOOR,
      a,
      b,
    };
  } finally {
    if (chosen.cleanup) await chosen.cleanup();
  }
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        a: { type: 'string' },
        b: { type: 'string' },
        engine: { type: 'string', default: 'auto' },
        'max-offset-ms': { type: 'string' },
        ffmpeg: { type: 'string', default: 'ffmpeg' },
        json: { type: 'boolean', default: false },
        keep: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }

  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (!values.a || !values.b) {
    console.error(usage());
    return 2;
  }

  const maxOffsetMs = values['max-offset-ms']
    ? Number(values['max-offset-ms'])
    : 600000;
  if (!Number.isFinite(maxOffsetMs) || maxOffsetMs < 1000) {
    console.error('--max-offset-ms needs a number of at least 1000');
    return 2;
  }

  try {
    const result = await analyze({
      a: values.a,
      b: values.b,
      engine: values.engine,
      maxOffsetMs,
      ffmpegPath: values.ffmpeg,
      keep: values.keep,
    });
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.matched) {
      console.log(
        `offset ${result.offsetMs} ms  confidence ${result.confidence.toFixed(2)}  ` +
          `engine ${result.engine}  windows ${result.windows}`
      );
    } else {
      console.error(
        `no confident match: best ${result.offsetMs} ms at confidence ` +
          `${result.confidence.toFixed(2)}, floor ${result.threshold}`
      );
    }
    return result.matched ? 0 : 3;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
