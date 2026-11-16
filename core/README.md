# Brosr core

The shared code behind a room. It holds no socket, no timer and no browser API, so a content
script and a Node test drive the same modules.

| Module | Job |
| --- | --- |
| `protocol.mjs` | Message types including page app messages, validation, the 16 KB frame ceiling, input splitting |
| `clock.mjs` | Four-timestamp offset, smallest round trip wins, a re-measure every 30 s |
| `drift.mjs` | Seek over 300 ms, rate nudge over 40 ms, pause for buffering and ads |
| `media.mjs` | `HTMLMediaElement` adapter keyed by a source URL |
| `youtube.mjs` | YouTube IFrame player adapter, with an element view for the room |
| `room.mjs` | Peers, sequence, URL, scroll ratio, viewport drift, both rate limits |
| `overlay.mjs` | Cursor overlay inside one closed shadow root |
| `input.mjs` | Batcher, grants, origin allowlist, sensitive fields, targeting, replay |
| `trust.mjs` | Record to BiDi action mapping and the page-side trusted client |
| `seal.mjs` | Room key, HKDF-SHA256 expansion, XChaCha20-Poly1305 frames, invite link |
| `sync.mjs` | The client that wires the rest, relays app messages, with an injected transport |
| `browser-entry.mjs` | Content-script entry: relay socket, reconnect, ticks, `dataset.brosr` |

## Use

```js
import { createRoomClient } from '@brosr/core';

const client = createRoomClient({
  role: 'peer',
  peerId: 'alice',
  hostId: 'host',
  document,
  now: () => Date.now(),
  viewport: () => ({ url: location.href, scroll: 0, fingerprint }),
  navigate: (url) => location.assign(url),
  scrollTo: (ratio) => window.scrollTo(0, ratio * maxScroll),
  input: { capture: true, grantTo: null, tabId: 'tab-1', origin: location.origin },
  send: (frame) => socket.send(frame),
});

socket.onmessage = (event) => client.receive(event.data, Date.now());
setInterval(() => client.tick(Date.now()), 50);
```

## Five rules the code depends on

Each one cost a spike run to learn.

1. One wall clock per side. `now` feeds the clock, the media stamps and presence. Each
   machine stamps the exchange from its wall clock, because `performance.now()` starts at zero
   in each process. Mixing the two makes every round trip negative.
2. Room time belongs to the host. The host stamps `roomTime` with its own local time, and a
   peer converts its local time with the offset it measured. Only a peer pings.
3. A seek gets a settle window. Deciding again inside it stacks seeks, and the player never
   reaches any of the targets. A seek can also leave the element paused.
4. The host announces the page, not the tab. Room parameters stay out of the followed URL, or
   every peer reloads with the host's role.
5. An input frame names its sender. The receiver looks up the grant by peer, and it refuses a
   frame without `peerId`.

`npm test` runs 167 tests with the Node test runner and no dependencies. The wire test also runs
against the axum relay when `RELAY_BIN` names its binary.

A room whose invite carries a key seals every frame it sends, and it drops an unsealed frame
instead of trusting it. A key that fails to derive refuses the connection rather than falling
back to plain text.

Nothing here opens a socket, draws outside the shadow root, or reads a cookie. Input and grants
live in `input.mjs`. `trust.mjs` turns one record into one browser action, and `host/trust.mjs`
owns the loopback agent that applies it while a grant is active.
