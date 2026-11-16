// Chrome speaks CDP, not WebDriver BiDi. The trust helper needs three commands,
// so this facade names them the BiDi way and translates each one. A Chromium
// room then types with real input events, and the page sees isTrusted true.
//
// The transport is a plain debugger socket on loopback. Every page target is
// attached flat, so one socket carries the room tab and the tab a grant names.

const TIMEOUT_MS = 20000;

const text = (error) => String((error && error.message) || error);

class Socket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = null;
  }

  async open(timeoutMs = 8000) {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout opening ${this.url}`)), timeoutMs);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`cannot open ${this.url}`));
      });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.id) {
        // A closed target drops its session. The next command attaches again.
        if (this.onEvent) this.onEvent(message);
        return;
      }
      const held = this.pending.get(message.id);
      if (!held) return;
      this.pending.delete(message.id);
      if (message.error) held.reject(new Error(`${message.error.message || message.error.code}`));
      else held.resolve(message.result);
    });
    return this;
  }

  send(method, params = {}, sessionId = null) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.ws.send(JSON.stringify(message));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, TIMEOUT_MS);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Nothing to close.
    }
  }
}

// A BiDi key value becomes the fields a CDP key event needs. A single
// character carries its own text, so Chrome inserts it. A named key carries a
// code and a virtual key, so the page reads the same key it would from a hand.
const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

export function keyFor(value) {
  const name = String(value || '');
  if (!name) return null;
  if (NAMED_KEYS[name]) return NAMED_KEYS[name];
  const chars = Array.from(name);
  if (chars.length !== 1) return { key: name, code: name, keyCode: 0 };
  const char = chars[0];
  const upper = char.toUpperCase();
  const letter = /^[a-z]$/i.test(char);
  const digit = /^[0-9]$/.test(char);
  return {
    key: char,
    code: letter ? `Key${upper}` : digit ? `Digit${char}` : '',
    keyCode: upper.charCodeAt(0),
    text: char,
  };
}

const BUTTONS = ['left', 'middle', 'right'];
const BUTTON_BITS = { left: 1, right: 2, middle: 4 };

// One BiDi action list becomes the CDP events that carry it. The pointer keeps
// its place across groups, because a press without a point lands where the last
// move left it.
export function cdpEvents(actions) {
  const out = [];
  const pointer = { x: 0, y: 0, buttons: 0 };
  const mouse = (type, extra) =>
    out.push({
      method: 'Input.dispatchMouseEvent',
      params: { type, x: pointer.x, y: pointer.y, ...extra },
    });

  for (const group of actions || []) {
    if (!group || !Array.isArray(group.actions)) continue;
    if (group.type === 'pointer') {
      for (const step of group.actions) {
        if (step.type === 'pointerMove') {
          pointer.x = Number(step.x) || 0;
          pointer.y = Number(step.y) || 0;
          mouse('mouseMoved', { buttons: pointer.buttons });
        } else if (step.type === 'pointerDown') {
          const button = BUTTONS[Number(step.button) || 0] || 'left';
          pointer.buttons |= BUTTON_BITS[button];
          mouse('mousePressed', { button, buttons: pointer.buttons, clickCount: 1 });
        } else if (step.type === 'pointerUp') {
          const button = BUTTONS[Number(step.button) || 0] || 'left';
          pointer.buttons &= ~BUTTON_BITS[button];
          mouse('mouseReleased', { button, buttons: pointer.buttons, clickCount: 1 });
        }
      }
    } else if (group.type === 'key') {
      for (const step of group.actions) {
        const held = keyFor(step.value);
        if (!held) continue;
        if (step.type === 'keyDown') {
          out.push({
            method: 'Input.dispatchKeyEvent',
            params: {
              type: held.text ? 'keyDown' : 'rawKeyDown',
              key: held.key,
              code: held.code,
              windowsVirtualKeyCode: held.keyCode,
              nativeVirtualKeyCode: held.keyCode,
              ...(held.text ? { text: held.text, unmodifiedText: held.text } : {}),
            },
          });
        } else if (step.type === 'keyUp') {
          out.push({
            method: 'Input.dispatchKeyEvent',
            params: {
              type: 'keyUp',
              key: held.key,
              code: held.code,
              windowsVirtualKeyCode: held.keyCode,
              nativeVirtualKeyCode: held.keyCode,
            },
          });
        }
      }
    } else if (group.type === 'scroll') {
      for (const step of group.actions) {
        if (step.type !== 'scroll') continue;
        pointer.x = Number(step.x) || 0;
        pointer.y = Number(step.y) || 0;
        out.push({
          method: 'Input.dispatchMouseEvent',
          params: {
            type: 'mouseWheel',
            x: pointer.x,
            y: pointer.y,
            deltaX: Number(step.deltaX) || 0,
            deltaY: Number(step.deltaY) || 0,
          },
        });
      }
    }
  }
  return out;
}

// The facade the trust helper holds. It answers the three BiDi commands the
// watcher and the agent use, and forwards anything else untouched.
export class ChromeCdp {
  constructor(socket) {
    if (!socket) throw new Error('a CDP facade needs a socket');
    this.socket = socket;
    this.sessions = new Map();
    if (typeof socket.onEvent !== 'undefined') {
      socket.onEvent = (message) => {
        if (message.method === 'Target.detachedFromTarget') {
          const gone = message.params && message.params.sessionId;
          for (const [targetId, sessionId] of this.sessions) {
            if (sessionId === gone) this.sessions.delete(targetId);
          }
        }
      };
    }
  }

  static async connect(port, timeoutMs = 60000) {
    const end = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < end) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        const info = await res.json();
        if (info && info.webSocketDebuggerUrl) {
          return new ChromeCdp(await new Socket(info.webSocketDebuggerUrl).open());
        }
        last = new Error('no debugger socket in /json/version');
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`no CDP on ${port}: ${last ? text(last) : 'unknown'}`);
  }

  // One flat session per target. Focus emulation keeps injected keys alive on a
  // headless runner, where the page reports itself unfocused.
  async session(targetId) {
    if (!targetId) throw new Error('a Chrome command needs a target');
    const held = this.sessions.get(targetId);
    if (held) return held;
    const attached = await this.socket.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = attached && attached.sessionId;
    if (!sessionId) throw new Error(`no session for ${targetId}`);
    this.sessions.set(targetId, sessionId);
    await this.socket
      .send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
      .catch(() => {});
    return sessionId;
  }

  async getTree() {
    const result = await this.socket.send('Target.getTargets');
    const infos = (result && result.targetInfos) || [];
    return {
      contexts: infos
        .filter((info) => info.type === 'page' && !String(info.url).startsWith('devtools://'))
        .map((info) => ({ context: info.targetId, url: info.url, children: null })),
    };
  }

  async evaluate(params = {}) {
    const sessionId = await this.session(params.target && params.target.context);
    const result = await this.socket.send(
      'Runtime.evaluate',
      {
        expression: String(params.expression || ''),
        returnByValue: true,
        awaitPromise: params.awaitPromise !== false,
      },
      sessionId
    );
    if (result && result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(
        `${detail.text || 'evaluate failed'} ${(detail.exception && detail.exception.description) || ''}`.trim()
      );
    }
    return { result: { value: result && result.result ? result.result.value : null } };
  }

  async perform(params = {}) {
    const targetId = params.context;
    const sessionId = await this.session(targetId);
    const events = cdpEvents(params.actions);
    // A background tab drops injected keys, so a batch with typing raises its
    // tab first. A pointer batch moves without taking the window.
    if (events.some((event) => event.method === 'Input.dispatchKeyEvent')) {
      await this.socket.send('Target.activateTarget', { targetId }).catch(() => {});
    }
    for (const event of events) {
      await this.socket.send(event.method, event.params, sessionId);
    }
    return {};
  }

  async cmd(method, params = {}) {
    if (method === 'browsingContext.getTree') return this.getTree();
    if (method === 'script.evaluate') return this.evaluate(params);
    if (method === 'input.performActions') return this.perform(params);
    return this.socket.send(method, params);
  }

  close() {
    this.sessions.clear();
    this.socket.close();
  }
}
