# Privacy and what the relay sees

Part of the [Brosr design index](README.md).

Brosr syncs a room through a relay process (`relay/src/main.rs` in Rust or `spike/relay.js` in Node). A host normally runs that relay on its own machine over loopback, LAN, or Tailscale. This page states what stays sealed between browsers, what the relay process can observe, and what never leaves the local machine.

## What stays end-to-end sealed

Every room started by `host/room.mjs` creates a 128-bit random room key (`newRoomKey()` in `core/seal.mjs`) and places it in the invite URL fragment (`#k=<base64url>`).

- **Key derivation:** Each browser expands the 16-byte invite key into a 32-byte frame key with HKDF-SHA256 (`salt = "brosr/v1"`, `info = "room frame key"`). Both SHA-256 and HKDF run in plain JavaScript inside `core/seal.mjs`, so sealing works even on plain HTTP LAN or tailnet origins where `crypto.subtle` is unavailable.
- **Per-frame authenticated encryption:** Every outgoing WebSocket message is sealed with XChaCha20-Poly1305 (`sealFrame()`), a fresh 24-byte random nonce from `crypto.getRandomValues`, a 16-byte Poly1305 tag, and associated data `brosr/v1/<room>` so a frame sealed for one room cannot open in another.
- **Sealed payload contents:** Inside those binary WebSocket frames (opcode 2) stay shared tab URLs and titles, display names, cursor coordinates and custom cursor URLs, scroll ratios, media keys and playhead positions, and room-app state updates (Canvas strokes, Notes edits, Chess moves).
- **No plaintext fallback when sealed:** When a room tab holds a `sealKey` (`core/browser-entry.mjs`), every outgoing frame leaves as sealed binary, and any incoming non-binary frame or frame that fails authentication (`openFrame()`) is dropped rather than accepted. Unsealed text frames are only used if a room is opened explicitly without a `#k=` fragment key (for example, in local fixture tests).
- **Opaque forwarding:** Neither `relay/src/main.rs` nor `spike/relay.js` parses forwarded WebSocket payloads; both copy the raw bytes to the other sockets in the same room with the original opcode intact.

## What the relay sees

Even with end-to-end sealing on, the relay process sees transport metadata and the HTTP endpoints it serves:

| Surface | What the relay sees |
| --- | --- |
| WebSocket upgrade (`/room`) | Query parameters `room`, `role` (`host`, `peer`, `panel`, or `cursor`), and `peer` id, plus the client's transport IP address. |
| Forwarded WebSocket frames | Frame opcode (`1` text or `2` binary), ciphertext byte length, arrival and forwarding timing, and aggregate counters (`forwarded`, `text`, `binary`) on `/stats`. |
| Room status (`/status`, `/stats`) | Active room ids, socket counts per room, per-room `peers`, `hosts`, and distinct `people` counts (excluding `panel` and `cursor` sockets), and process `uptime`. |
| Optional capture log (`RELAY_CAPTURE`) | Off by default. If an operator sets `RELAY_CAPTURE=<file>`, the relay appends JSONL lines (`room`, `opcode`, `bytes`, `hex`) of forwarded bytes. In a sealed room those hex payloads remain ciphertext. |
| Host document library (`/docs`, `/docs/:id`) | Canvas and Notes documents are written to `BROSR_DOCS_DIR` (`0o600` files on Unix) only when the host stores them through `landing/docs-client.js`. Access requires a matching `?token=` when `BROSR_DOCS_TOKEN` is set (generated per host start by `host/room.mjs`, verified in constant time) or a loopback client (`127.0.0.1` / `::1`) when no token is configured. Guests never receive the docs token (`#dt=`). |
| Local static and media HTTP requests | Requests for landing and room-app files (`/`, `/canvas`, `/notes`, `/chess`), fixtures, `/assets/*`, and byte-range clips under `/media/*`. |

## What never crosses the relay

- **The room key (`#k=...`):** URL fragments are never sent by browsers in HTTP request lines or WebSocket upgrades.
- **Browser cookies, logins, and credentials:** `bridge/background.js` and `bridge/content.js` never read or relay cookies, `localStorage`, session tokens, or passwords. Each person signs in on their own isolated room browser profile. `bridge/background.js` blocks non-HTTP/HTTPS schemes (`chrome:`, `chrome-extension:`, `moz-extension:`, `edge:`, `about:`, `view-source:`, `file:`, `data:`, `blob:`, `javascript:`) from tab sharing, and the `brosr:tab-url` message used for cross-origin player embeds stays strictly inside the local browser between the background script and its own frame.
- **Sensitive targets stay refused:** As documented in [safety.md](safety.md), the guards in `core/input.mjs` refuse password fields, fields with credential `autocomplete` hints, cross-origin iframes, and the built-in list of blocked payment/banking origins. A current room relays no DOM input, so these guards are a second line behind the refusal itself.
- **The trusted input loopback bearer token (`#t=...`, `#tp=...`):** Created by `host/room.mjs` only when `--trusted` is requested, passed to the host room tab in the URL fragment (never in `guestInvite()`), and written to `room.json` with `0o600` permissions. `host/trust.mjs` refuses to bind without an active trusted-input session, binds strictly to `127.0.0.1` on an ephemeral port, checks `Authorization: Bearer <token>` with `crypto.timingSafeEqual`, and closes the listener when the session ends, expires, or the room stops.
- **Host-only control tokens:** Both the host document token (`#dt=...`) and the local app control token (`panel=<token>`) are omitted from guest invites generated by `guestInvite()` in `host/room.mjs`.
- **Unshared tabs by default:** Tab sharing is offer-based (`bridge/background.js`). A guest does not broadcast its own tabs until it shares one. Any member may share a tab and becomes its host, and peers only open a copy of an offered tab when they choose to.

## How this is verified

- `core/test/seal.test.mjs` checks the XChaCha20-Poly1305, HChaCha20, Poly1305, SHA-256, and HKDF-SHA256 primitives, room-bound associated data, and tamper rejection.
- `core/test/wire.test.mjs` sends a sealed frame through both `spike/relay.js` and `relay/target/debug/brosr-relay` (`RELAY_BIN`) with `RELAY_CAPTURE` enabled and asserts the capture contains opcode 2 bytes with no URL, peer name, or message type.
- `spike/relay.test.mjs` and `cargo test --manifest-path relay/Cargo.toml` check `/docs` token gating, bad document id rejection, `/status` counts, and empty-room eviction.
- `host/test/trust.test.mjs` checks that the trusted input agent stays closed without a session, keeps `#t=` in the fragment, binds loopback only, rejects bad or missing bearer tokens with `401`, and closes when the session ends.
