// A lane that loses its renderer has to say what the browser was doing. On a
// hosted runner the lane output is the only record, so the devtools socket, the
// browser process and the last browser stderr lines travel with the error. A
// bare timeout cannot separate a dead process from a wedged renderer from a tab
// that went away.

// Chrome is chatty on stderr and a wedged lane can wait a long time, so the log
// keeps a bounded tail. A chunk boundary can split a line, and the split part
// is joined on the next push instead of becoming two half lines.
export function createBrowserLog(limit = 24) {
  const lines = [];
  let pending = '';
  const keep = (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    lines.push(text);
    while (lines.length > limit) lines.shift();
  };
  return {
    push(chunk) {
      pending += String(chunk);
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) keep(part);
    },
    lines() {
      const last = pending.trim();
      if (last) keep(last);
      pending = '';
      return lines.slice();
    },
  };
}

function processState(child) {
  if (!child) return 'the browser process is unknown';
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return `the browser exited with code ${child.exitCode}`;
  }
  if (child.signalCode) return `the browser was killed by ${child.signalCode}`;
  if (child.pid) return `the browser is still running as pid ${child.pid}`;
  return 'the browser process is unknown';
}

// One sentence names the wait, the socket and the process, then quotes what the
// browser last wrote. Those three ends are what the next run needs to tell the
// failures apart.
export function describeSilentRenderer({ url, elapsedMs, socketOpen, child, browserLog }) {
  const waited = Number.isFinite(elapsedMs) ? `${Math.round(elapsedMs)} ms` : 'the timeout';
  const socket = socketOpen ? 'the devtools socket is open' : 'the devtools socket is closed';
  const tail = browserLog && typeof browserLog.lines === 'function' ? browserLog.lines() : [];
  const words = tail.length
    ? `, the browser last wrote: ${tail.join(' | ')}`
    : ', the browser wrote nothing';
  return `${socket}, ${processState(child)} after ${waited} at ${url}${words}`;
}
