// Minimal WebDriver BiDi client. Node 22 and later ship a WebSocket client.
export class BiDi {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    // A client whose session is gone says so at once. Every command after a
    // timeout reads this flag, so nothing waits on a queue that will not move.
    this.closed = false;
  }

  async connect() {
    if (this.closed) throw new Error('session closed');
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout opening ${this.url}`)), 8000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`cannot open ${this.url}`));
      };
    });

    this.ws.onmessage = (event) => this.receive(event);

    // Firefox usually accepts commands straight after the socket opens. A
    // session command is harmless when one already exists.
    try {
      await this.cmd('session.new', { capabilities: {} });
    } catch (error) {
      // A timeout already retired the client, so the caller needs that reason
      // and not a session message it would read as harmless.
      if (this.closed) throw error;
      if (!/session/i.test(String(error.message))) throw error;
    }
    return this;
  }

  // One incoming frame settles the command it answers. A frame with no id or
  // an unknown id is an event the client does not use here.
  receive(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error}: ${message.message}`));
      else resolve(message.result);
    }
  }

  // A screenshot can wait on a paint that never comes, so a caller that needs a
  // shorter bound passes its own. Everything else keeps the 20 s default.
  //
  // Firefox answers one session in order, so a command that never settles holds
  // every later one. A timeout therefore retires the client: the waiting work
  // is rejected and the socket closed, and a caller that wants to continue
  // opens a new session instead of queueing behind a stalled command.
  cmd(method, params = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('session closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The timer goes with the answer. A capture run at 30 fps would otherwise
      // keep one live timer for every frame it ever took.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.fail(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Reject every waiter with one reason, then close the socket. A second call
  // is a no-op, so a timeout and a caller's close do not fight over the same
  // socket.
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(error);
    try {
      this.ws.close();
    } catch {
      // Nothing to close.
    }
  }

  close() {
    // A caller that walks away from a command still needs its promise settled,
    // or the capture loop would wait on a socket that is already gone.
    this.fail(new Error('session closed'));
  }
}
