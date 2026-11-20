// Chrome speaks CDP, not WebDriver BiDi. The trust helper needs three commands,
// so this facade names them the BiDi way and translates each one. A Chromium
// room then types with real input events, and the page sees isTrusted true.
//
// The transport is a plain debugger socket on loopback. Every page target is
// attached flat, so one socket carries the room tab and the tab a grant names.

const TIMEOUT_MS = 20000;

const text = (error) => String((error && error.message) || error);

function isSessionGone(error) {
  return /session.*not found|target closed|target detached|no session|detached/i.test(text(error));
}

class Socket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = null;
    this.closed = false;
  }

  async open(timeoutMs = 8000) {
    if (this.closed) throw new Error('CDP socket closed');
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
    this.ws.addEventListener('close', () => {
      this.fail(new Error('CDP socket closed'));
    });
    this.ws.addEventListener('error', () => {
      this.fail(new Error('CDP socket error'));
    });
    return this;
  }

  send(method, params = {}, sessionId = null) {
    if (this.closed || !this.ws) return Promise.reject(new Error('CDP socket closed'));
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, TIMEOUT_MS);
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
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        const held = this.pending.get(id);
        this.pending.delete(id);
        if (held) held.reject(error);
      }
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(error);
    try {
      this.ws && this.ws.close();
    } catch {
      // Nothing to close.
    }
  }

  close() {
    this.fail(new Error('CDP socket closed'));
  }
}

// A BiDi key value (either a DOM key name or a W3C WebDriver PUA code point)
// becomes the fields a CDP key event needs. A single character carries its own
// text, so Chrome inserts it. A named key carries a code and a virtual key, so
// the page reads the same key it would from a hand.
const NAMED_KEYS = {
  Cancel: { key: 'Cancel', code: 'Cancel', keyCode: 3 },
  Help: { key: 'Help', code: 'Help', keyCode: 6 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  '\t': { key: 'Tab', code: 'Tab', keyCode: 9 },
  Clear: { key: 'Clear', code: 'Clear', keyCode: 12 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  '\r': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  '\n': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  NumpadEnter: { key: 'Enter', code: 'NumpadEnter', keyCode: 13, text: '\r' },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Pause: { key: 'Pause', code: 'Pause', keyCode: 19 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Spacebar: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  F1: { key: 'F1', code: 'F1', keyCode: 112 },
  F2: { key: 'F2', code: 'F2', keyCode: 113 },
  F3: { key: 'F3', code: 'F3', keyCode: 114 },
  F4: { key: 'F4', code: 'F4', keyCode: 115 },
  F5: { key: 'F5', code: 'F5', keyCode: 116 },
  F6: { key: 'F6', code: 'F6', keyCode: 117 },
  F7: { key: 'F7', code: 'F7', keyCode: 118 },
  F8: { key: 'F8', code: 'F8', keyCode: 119 },
  F9: { key: 'F9', code: 'F9', keyCode: 120 },
  F10: { key: 'F10', code: 'F10', keyCode: 121 },
  F11: { key: 'F11', code: 'F11', keyCode: 122 },
  F12: { key: 'F12', code: 'F12', keyCode: 123 },
};

// WebDriver Private Use Area code points -> canonical DOM key name.
const BIDI_PUA_TO_NAME = {
  '\uE001': 'Cancel',
  '\uE002': 'Help',
  '\uE003': 'Backspace',
  '\uE004': 'Tab',
  '\uE005': 'Clear',
  '\uE006': 'Enter',
  '\uE007': 'NumpadEnter',
  '\uE008': 'Shift',
  '\uE009': 'Control',
  '\uE00A': 'Alt',
  '\uE00B': 'Pause',
  '\uE00C': 'Escape',
  '\uE00D': 'Space',
  '\uE00E': 'PageUp',
  '\uE00F': 'PageDown',
  '\uE010': 'End',
  '\uE011': 'Home',
  '\uE012': 'ArrowLeft',
  '\uE013': 'ArrowUp',
  '\uE014': 'ArrowRight',
  '\uE015': 'ArrowDown',
  '\uE016': 'Insert',
  '\uE017': 'Delete',
  '\uE031': 'F1',
  '\uE032': 'F2',
  '\uE033': 'F3',
  '\uE034': 'F4',
  '\uE035': 'F5',
  '\uE036': 'F6',
  '\uE037': 'F7',
  '\uE038': 'F8',
  '\uE039': 'F9',
  '\uE03A': 'F10',
  '\uE03B': 'F11',
  '\uE03C': 'F12',
  '\uE03D': 'Meta',
};

// CDP Input modifier bitmask: Alt=1, Ctrl=2, Meta/Command=4, Shift=8.
const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

export function keyFor(value) {
  const raw = String(value || '');
  if (!raw) return null;
  const name = BIDI_PUA_TO_NAME[raw] || raw;
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, name)) return NAMED_KEYS[name];
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

const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
const BUTTON_BITS = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };

// One BiDi action list becomes the CDP events that carry it. Groups execute in
// WebDriver BiDi tick order so parallel modifier key sources apply to pointer
// and wheel events on the same tick.
export function cdpEvents(actions) {
  const out = [];
  const groups = (actions || []).filter((group) => group && Array.isArray(group.actions));
  const pointer = { x: 0, y: 0, buttons: 0 };
  let modifiers = 0;

  const withMods = (params) => (modifiers ? { ...params, modifiers } : params);
  const mouse = (type, extra) =>
    out.push({
      method: 'Input.dispatchMouseEvent',
      params: withMods({ type, x: pointer.x, y: pointer.y, ...extra }),
    });

  const maxTicks = groups.reduce((max, group) => Math.max(max, group.actions.length), 0);
  for (let tick = 0; tick < maxTicks; tick += 1) {
    for (const group of groups) {
      const step = group.actions[tick];
      if (!step || step.type === 'pause') continue;

      if (group.type === 'pointer') {
        if (step.type === 'pointerMove') {
          pointer.x = Number.isFinite(Number(step.x)) ? Number(step.x) : 0;
          pointer.y = Number.isFinite(Number(step.y)) ? Number(step.y) : 0;
          mouse('mouseMoved', { buttons: pointer.buttons });
        } else if (step.type === 'pointerDown') {
          const idx = Number(step.button);
          const button = (Number.isInteger(idx) && BUTTONS[idx]) || 'left';
          pointer.buttons |= BUTTON_BITS[button];
          mouse('mousePressed', { button, buttons: pointer.buttons, clickCount: 1 });
        } else if (step.type === 'pointerUp') {
          const idx = Number(step.button);
          const button = (Number.isInteger(idx) && BUTTONS[idx]) || 'left';
          pointer.buttons &= ~BUTTON_BITS[button];
          mouse('mouseReleased', { button, buttons: pointer.buttons, clickCount: 1 });
        }
      } else if (group.type === 'key') {
        const held = keyFor(step.value);
        if (!held) continue;
        const modBit = MODIFIER_BITS[held.key] || 0;
        if (step.type === 'keyDown') {
          if (modBit) modifiers |= modBit;
          // When Ctrl or Meta is held, dispatch rawKeyDown without text so
          // Chrome triggers shortcuts instead of inserting a literal character.
          const shortcut = Boolean(modifiers & (2 | 4)) && !modBit;
          const sendText = Boolean(held.text) && !shortcut;
          out.push({
            method: 'Input.dispatchKeyEvent',
            params: withMods({
              type: sendText ? 'keyDown' : 'rawKeyDown',
              key: held.key,
              code: held.code,
              windowsVirtualKeyCode: held.keyCode,
              nativeVirtualKeyCode: held.keyCode,
              ...(sendText ? { text: held.text, unmodifiedText: held.text } : {}),
            }),
          });
        } else if (step.type === 'keyUp') {
          if (modBit) modifiers &= ~modBit;
          out.push({
            method: 'Input.dispatchKeyEvent',
            params: withMods({
              type: 'keyUp',
              key: held.key,
              code: held.code,
              windowsVirtualKeyCode: held.keyCode,
              nativeVirtualKeyCode: held.keyCode,
            }),
          });
        }
      } else if (group.type === 'wheel' || group.type === 'scroll') {
        if (step.type !== 'scroll') continue;
        pointer.x = Number.isFinite(Number(step.x)) ? Number(step.x) : 0;
        pointer.y = Number.isFinite(Number(step.y)) ? Number(step.y) : 0;
        const deltaX = Number.isFinite(Number(step.deltaX)) ? Number(step.deltaX) : 0;
        const deltaY = Number.isFinite(Number(step.deltaY)) ? Number(step.deltaY) : 0;
        out.push({
          method: 'Input.dispatchMouseEvent',
          params: withMods({
            type: 'mouseWheel',
            x: pointer.x,
            y: pointer.y,
            deltaX,
            deltaY,
          }),
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
    this.attaching = new Map();
    if (typeof socket.onEvent !== 'undefined') {
      socket.onEvent = (message) => {
        if (message.method === 'Target.detachedFromTarget') {
          const goneSession = message.params && message.params.sessionId;
          const goneTarget = message.params && message.params.targetId;
          if (goneTarget) this.sessions.delete(goneTarget);
          if (goneSession) {
            for (const [targetId, sessionId] of this.sessions) {
              if (sessionId === goneSession) this.sessions.delete(targetId);
            }
          }
        } else if (message.method === 'Target.targetDestroyed') {
          const goneTarget = message.params && message.params.targetId;
          if (goneTarget) this.sessions.delete(goneTarget);
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
  // headless runner, where the page reports itself unfocused. Concurrent callers
  // share one in-flight attach so we never leak duplicate target sessions.
  async session(targetId) {
    if (!targetId) throw new Error('a Chrome command needs a target');
    const held = this.sessions.get(targetId);
    if (held) return held;
    const inflight = this.attaching.get(targetId);
    if (inflight) return inflight;

    const task = (async () => {
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
    })();
    this.attaching.set(targetId, task);
    try {
      return await task;
    } finally {
      this.attaching.delete(targetId);
    }
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
    const targetId = params.target && params.target.context;
    const evalParams = {
      expression: String(params.expression || ''),
      returnByValue: true,
      awaitPromise: params.awaitPromise !== false,
    };
    const wasCached = this.sessions.has(targetId);
    let sessionId = await this.session(targetId);
    let result;
    try {
      result = await this.socket.send('Runtime.evaluate', evalParams, sessionId);
    } catch (error) {
      if (!wasCached || !isSessionGone(error)) throw error;
      this.sessions.delete(targetId);
      sessionId = await this.session(targetId);
      result = await this.socket.send('Runtime.evaluate', evalParams, sessionId);
    }
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
    const events = cdpEvents(params.actions);
    const needsActivate = events.some((event) => event.method === 'Input.dispatchKeyEvent');

    const dispatch = async (allowRetry) => {
      const wasCached = this.sessions.has(targetId);
      const sessionId = await this.session(targetId);
      if (needsActivate) {
        await this.socket.send('Target.activateTarget', { targetId }).catch(() => {});
      }
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        try {
          await this.socket.send(event.method, event.params, sessionId);
        } catch (error) {
          if (isSessionGone(error)) {
            this.sessions.delete(targetId);
            // Retry once only if the very first event failed on a stale cached
            // session, so we never duplicate partially delivered input.
            if (allowRetry && wasCached && i === 0) {
              return dispatch(false);
            }
          }
          throw error;
        }
      }
      return {};
    };

    return dispatch(true);
  }

  async cmd(method, params = {}) {
    if (method === 'browsingContext.getTree') return this.getTree();
    if (method === 'script.evaluate') return this.evaluate(params);
    if (method === 'input.performActions') return this.perform(params);
    return this.socket.send(method, params);
  }

  close() {
    this.sessions.clear();
    this.attaching.clear();
    this.socket.close();
  }
}
