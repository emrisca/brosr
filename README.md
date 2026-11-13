# Brosr

Brosr is a room of people in one Firefox page. Each person's cursor, scroll, navigation and
media controls show up in every other window. Brosr sends no video. A room costs about
10 KB/s per peer. A screen share needs 2 Mbps on a bad link.

The browser must keep its extensions, including full uBlock Origin. Full uBlock Origin is a
Manifest V2 add-on. Firefox still runs Manifest V2, and Chromium removed it, so Firefox is the
engine. Brosr starts Firefox with its own profile and adds a bridge extension, a sidebar and a
relay.

Status: the M0 spike passed and the M1 core runs. Nothing ships yet.

## What the repository holds

| Path | Contents |
| --- | --- |
| `plan.md` | The design. What syncs, what cannot, the protocol, safety and the milestones. |
| `core/` | The shared room code: protocol, clock, drift policy, media adapter, cursor overlay, input guards and the client. It holds no socket and no browser API. |
| `spike/` | The M0 harness and the M1, M3 and M4 checks. It downloads its own Firefox. |
| `docs/m0-results.md` | What the M0 spike measured. |

## Check the core

`core/` has no dependencies. It runs in Node and in a content script.

```bash
cd core
npm test
```

The suite covers protocol encode and decode, the clock estimator, the drift controller, the
overlay, the room state and the input guards.

## Run the spike

The harness needs Node and ffmpeg. It downloads Firefox Nightly and uBlock Origin into
`spike/.runtime/`, encodes a 120 second test clip, starts a relay on `127.0.0.1:8787` and
writes `spike/results.json`.

```bash
cd spike
node run.mjs
```

`--only=ad,bidi,media,room` runs a subset of the checks. `--soak=3600` runs the one hour
reconnect soak. A full run takes about four minutes.

The `.runtime` directory stays out of git, because a run rebuilds it.

## What a room cannot do

| Case | Why |
| --- | --- |
| Netflix, Disney+ and Prime Video | The DRM layer controls the media pipeline, so a script cannot set the playhead. |
| Identical pixels | Each person renders the page on their own machine, so a different window size gives a different layout. |
| One shared login | Each person signs in on their own copy. Cookies never cross the relay. |
| Trusted input in v1 | v1 relays synthetic events. Typing into a native control needs the Firefox remote agent, which is M7. |

## Where to read the detail

- [plan.md](plan.md) states the design and the limits, with the number each claim must meet.
- [core/README.md](core/README.md) explains the modules and the five rules the code depends on.
- [spike/README.md](spike/README.md) records the last run and the findings that changed the code.
- [docs/m0-results.md](docs/m0-results.md) summarises the M0 measurements.
