#!/usr/bin/env node
// Start every Mac peer for a LAN room from one command.
//
// A hand-typed `peer.mjs ... & peer.mjs ...` is easy to get wrong. On 13 November 2026 the
// second launch ran outside spike, died at once on a missing file, and room `lan1` held three
// clients for two minutes. One process now owns every child, so a failure names the dead peer.
//
// Usage:
//   node lan-peers.mjs --relay=192.168.8.161 --room=lan1 --peers=mac1,mac2 --seconds=4200 \
//     --out-prefix=.runtime/lan1
//
// Each peer writes <out-prefix>-<peer>.json. Every child line goes to stdout with its peer id.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The plan is pure, so a test can check the commands without starting a peer.
export function planPeers({ peers, room, relay, port = 8787, seconds, outPrefix }) {
  const ids = String(peers || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error('--peers needs at least one id');
  if (new Set(ids).size !== ids.length) throw new Error('--peers names an id twice');
  const count = Number(seconds);
  if (!Number.isFinite(count) || count <= 0) throw new Error('--seconds must be a positive number');
  if (!outPrefix) throw new Error('--out-prefix needs a path');

  return ids.map((id) => ({
    id,
    out: `${outPrefix}-${id}.json`,
    argv: [
      path.join(here, 'peer.mjs'),
      `--relay=${relay}`,
      `--port=${port}`,
      `--room=${room}`,
      `--peer=${id}`,
      `--seconds=${count}`,
      `--out=${outPrefix}-${id}.json`,
    ],
  }));
}

function main() {
  const args = new Map();
  for (const raw of process.argv.slice(2)) {
    const parsed = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (parsed) args.set(parsed[1], parsed[2] === undefined ? '1' : parsed[2]);
  }

  const relay = args.get('relay') || '127.0.0.1';
  const port = Number(args.get('port') || 8787);
  const room = args.get('room') || 'lan1';
  const seconds = args.get('seconds') || 60;
  const outPrefix = args.get('out-prefix') || path.join('.runtime', `peers-${room}`);

  let plan;
  try {
    plan = planPeers({ peers: args.get('peers'), room, relay, port, seconds, outPrefix });
  } catch (error) {
    process.stderr.write(`lan-peers: ${error.message}\n`);
    process.exit(1);
  }

  const children = [];
  let failed = 0;
  let done = 0;

  for (const item of plan) {
    const child = spawn(process.execPath, item.argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const tag = `[${item.id}] `;
    const echo = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) process.stdout.write(tag + line + '\n');
      }
    };
    child.stdout.on('data', echo);
    child.stderr.on('data', echo);
    child.on('exit', (code, signal) => {
      if (code !== 0) failed += 1;
      done += 1;
      process.stdout.write(`${tag}exited code=${code} signal=${signal}\n`);
      if (done === children.length) process.exit(failed ? 1 : 0);
    });
    process.stdout.write(`${tag}started out=${item.out}\n`);
  }

  const stopAll = (signal) => {
    for (const child of children) {
      if (child.exitCode === null) child.kill(signal);
    }
  };
  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
