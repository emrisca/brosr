# Relay

The room relay. It forwards text and binary frames between the members of one room, keeps one
table per room, and never parses a frame. A sealed room stays sealed because the relay only
copies bytes.

## Run

```sh
cargo run --release
```

Environment:

| Name | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. A LAN test sets `0.0.0.0`. |
| `PORT` | `8787` | HTTP and WebSocket port. |
| `FIXTURES` | `../spike/fixtures` | Room pages and fixtures. |
| `ASSETS` | `../assets` | The mark and shared images. |
| `MEDIA` | `../spike/.runtime` | Clips served under `/media/`. |
| `RELAY_CAPTURE` | unset | JSONL file of every forwarded payload. |

Routes are `/health`, `/stats`, `/room` for the WebSocket, and files at the root.

## Proof

```sh
cargo build
cd ../core && RELAY_BIN="$PWD/../relay/target/debug/brosr-relay" node --test test/wire.test.mjs
```

The test seals a presence frame and sends it through this relay. It then reads the capture file.
It requires opcode 2, and it requires that the bytes hold no URL, no peer name and no message
type.

## Limits

Range requests are not served, so a clip that seeks still needs the Node relay. The relay has no
authentication, so it binds loopback by default.
