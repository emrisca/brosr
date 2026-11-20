// Minimal WebDriver BiDi client. Node 22 and later ship a WebSocket client.
export class BiDi {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
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

    this.ws.onmessage = (event) => {
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
    };

    // Firefox usually accepts commands straight after the socket opens. A
    // session command is harmless when one already exists.
    try {
      await this.cmd('session.new', { capabilities: {} });
    } catch (error) {
      if (!/session/i.test(String(error.message))) throw error;
    }
    return this;
  }

  // A screenshot can wait on a paint that never comes, so a caller that needs a
  // shorter bound passes its own. Everything else keeps the 20 s default.
  cmd(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  close() {
    // A caller that walks away from a command still needs its promise settled,
    // or the capture loop would wait on a socket that is already gone.
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(new Error('session closed'));
    }
    try {
      this.ws.close();
    } catch {
      // Nothing to close.
    }
  }
}
