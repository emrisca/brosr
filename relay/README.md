# Relay

The room relay. It forwards text and binary frames between the members of one room, keeps one
table per room, evicts rooms when the last client leaves, and never parses a frame. A sealed room
stays sealed because the relay only copies bytes.

## Run

```sh
cargo run --release
```

Environment:

| Name | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. A LAN test sets `0.0.0.0`. |
| `PORT` | `8787` | HTTP and WebSocket port. |
| `LANDING` | `../landing` | Room landing page and built-in apps (`/`, `/canvas`, `/notes`, `/chess`, `/docs-client.js`). |
| `FIXTURES` | `../spike/fixtures` | Room test fixtures served as fallback (or first when `FIXTURES` is set without `LANDING`). |
| `ASSETS` | `../assets` | The mark and shared images under `/assets/`. |
| `MEDIA` | `../spike/.runtime` | Clips served under `/media/` with HTTP `Range` (`206`) support. |
| `BROSR_DOCS_DIR` | `../spike/.runtime/docs` | Host document library folder for `/docs` and `/docs/:id`. |
| `BROSR_DOCS_TOKEN` | unset | Required `?token=` for `/docs`. When unset, only loopback requests are allowed. |
| `RELAY_CAPTURE` | unset | JSONL file of every forwarded payload. |

Routes: `/health`, `/stats`, `/status`, `/room` (WebSocket with `room`, `role`, `peer`), `/docs`,
`/docs/:id`, `/media/*`, `/assets/*`, landing apps, and fixtures.

## Proof and parity

```sh
cargo test --manifest-path relay/Cargo.toml
cargo build --manifest-path relay/Cargo.toml
RELAY_BIN="$PWD/relay/target/debug/brosr-relay" node --test core/test/wire.test.mjs spike/relay.test.mjs
```

`wire.test.mjs` seals a presence frame, sends it through this relay, and verifies the capture holds
opcode 2 bytes with no URL, peer name, or message type. `spike/relay.test.mjs` verifies room
isolation, `/status` role and people counting, empty-room cleanup, `/media/` byte ranges, landing
routes, and `/docs` CRUD and token gating against both `spike/relay.js` and `brosr-relay`.

## Limits

The relay has no room authentication, so it binds loopback by default.
