// Chrome from version 137 ignores --load-extension, so an unpacked add-on has
// to go in over the devtools pipe. The pipe is two inherited descriptors
// carrying NUL framed JSON: fd 3 into Chrome, fd 4 back out of it. On that
// transport Extensions.loadUnpacked installs a folder and answers with the id
// Chrome derived, which is the id the room pins in its profile.
//
// The pipe only opens when Chrome starts with --enable-unsafe-extension-debugging,
// and that flag needs --remote-debugging-pipe. A room that passes only the port
// gets the port and no extensions, so a branded build takes this route instead.
import { spawn } from 'node:child_process';

export const PIPE_IN = 3;
export const PIPE_OUT = 4;
const TIMEOUT_MS = 20000;

// The two flags every branded launch needs when it carries add-ons.
export function pipeArgs() {
  return ['--enable-unsafe-extension-debugging', '--remote-debugging-pipe'];
}

// A pipe launch needs the two extra descriptors. The window stays silent,
// because a room reads no browser output.
export function pipeStdio() {
  return ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'];
}

export class PipeClient {
  constructor(input, output, { timeoutMs = TIMEOUT_MS } = {}) {
    if (!input || !output) throw new Error('the devtools pipe needs both descriptors');
    this.input = input;
    this.output = output;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.gone = null;
    output.setEncoding('utf8');
    output.on('data', (chunk) => this.absorb(chunk));
    output.on('close', () => this.fail(new Error('the devtools pipe closed')));
    output.on('error', (error) => this.fail(error));
  }

  // Messages are JSON followed by a NUL. A chunk can hold half a message or
  // several, so the tail stays here until its NUL arrives.
  absorb(chunk) {
    this.buffer += chunk;
    let cut = this.buffer.indexOf('\0');
    while (cut >= 0) {
      const text = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 1);
      cut = this.buffer.indexOf('\0');
      if (!text) continue;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      this.deliver(message);
    }
  }

  deliver(message) {
    // An event carries no id and nobody is waiting on it.
    if (!message || typeof message.id === 'undefined') return;
    const held = this.pending.get(message.id);
    if (!held) return;
    this.pending.delete(message.id);
    clearTimeout(held.timer);
    if (message.error) {
      held.reject(new Error(message.error.message || `CDP error ${message.error.code}`));
    } else {
      held.resolve(message.result || {});
    }
  }

  fail(error) {
    this.gone = error;
    for (const held of this.pending.values()) {
      clearTimeout(held.timer);
      held.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}) {
    if (this.gone) return Promise.reject(this.gone);
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(`${JSON.stringify({ id, method, params })}\0`);
    });
  }

  // One folder becomes one add-on. Chrome answers with the id it derived.
  async loadUnpacked(dir) {
    const result = await this.send('Extensions.loadUnpacked', { path: dir });
    return result && result.id ? result.id : null;
  }

  close() {
    this.fail(new Error('the devtools pipe closed'));
    try {
      this.input.end();
    } catch {
      // A closed descriptor has nothing to end.
    }
    try {
      this.output.destroy();
    } catch {
      // Same for the read side.
    }
  }
}

// A detached launch with the two descriptors wired. The caller keeps the
// client until every folder is in, then closes it or hands it on.
export function spawnPipe(bin, args, { cwd, env } = {}) {
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: pipeStdio(),
    detached: true,
    windowsHide: true,
  });
  const client = new PipeClient(child.stdio[PIPE_IN], child.stdio[PIPE_OUT]);
  return { child, client };
}

// Every folder in turn. A folder that fails does not stop the rest, because a
// room runs with whatever installed and reports the rest as missing.
export async function loadExtensions(client, dirs) {
  const ids = [];
  const errors = [];
  for (const dir of dirs) {
    try {
      ids.push(await client.loadUnpacked(dir));
    } catch (error) {
      ids.push(null);
      errors.push({ dir, error: String((error && error.message) || error) });
    }
  }
  return { ids, errors };
}
