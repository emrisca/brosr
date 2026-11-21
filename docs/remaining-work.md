# What is left, 20 November 2026

This is the working list beside [the design](design.md). The plan holds the design and the
per-milestone done-when. This file holds what is still open, what was measured, and what to do
next. It is not a replacement for the plan and it is not a status claim about shipping.

## Where things stand today

- Release `v0.3.48` is the next release tag (after `v0.3.47` at `e1185f0`), matching
  `app/package.json`, `app/src-tauri/tauri.conf.json`, and `app/src-tauri/Cargo.toml`. The
  bridge manifest (`bridge/manifest.json`) is at `0.4.11`. Earlier milestone releases include
  `v0.3.13`, `v0.3.17` (`1676127`), and `v0.3.28` (`3416dd7`, workflow run `44411237677`
  signing `latest.json` for `darwin-aarch64`, `darwin-x86_64`, and `windows-x86_64`).
- The version stamp is in a built release. It reads `getVersion()` and draws bottom right, so a
  window names the build it runs.
- Notes carries co-typing. Two people can type in one note and neither save takes the other
  hand's words away.
- The Zen room starts without Marionette unless `--dock` asks for the dock. Google accepts the
  sign-in in the room window, so the panel and the sign-in no longer exclude each other.
- The landing page links Notes and Play (chess) beside Canvas, and the Watch tile carries a live
  FMHY directory with a filter instead of the word `Soon`. Live tabs are offered instead of
  forced, with own-row listing, playback state, and stop/resume controls.
- The room apps hold their layout in a narrow window and in a light room. The chess board keeps
  its rank heights, a dragged piece lands where it is dropped, and the waiting list keeps the
  guest who has waited longest.
- The Rust axum relay (`relay/src/main.rs`) now has full parity with `spike/relay.js`:
  per-room WebSocket fan-out with empty-room eviction, `/health`, `/stats`, `/status` (excluding
  `panel` and `cursor` sockets from peer/people counts), HTTP `Range` (`206`/`416`) media
  streaming under `/media/*`, landing and room apps (`/`, `/canvas`, `/notes`, `/chess`,
  `/docs-client.js`), and token/loopback-guarded `/docs` CRUD. `host/room.mjs` auto-discovers
  a staged `../relay/brosr-relay(.exe)` (with `RELAY_BIN` override and `spike/relay.js`
  fallback), `app/scripts/stage-host.mjs` stages `host/trust.mjs`, `host/chrome-cdp.mjs`, and
  `brosr-relay` into `resources/relay/` (listed in `app/src-tauri/tauri.conf.json`),
  `.github/workflows/release.yml` compiles `brosr-relay` for every matrix target before
  bundling, and `scripts/check-all.mjs` runs `spike/relay.test.mjs` and `core/test/wire.test.mjs`
  against the compiled binary.
- Generic cross-origin iframe episode handoff (`brosr:tab-url` in `bridge/background.js` plus
  canonical episode query params in `pageKey`), HLS/DASH/blob quality-switch key persistence,
  and deliberate 600 ms frame-delay recovery are verified at the unit and bridge boundary
  (`core/test/iframe-handoff.test.mjs`).
- Mid-playback rejoin against a non-restoring player at `0 s`, SPA key-swap re-seeding,
  buffer-wait cooldown preservation, playback-rate extrapolation, rate-nudge hysteresis,
  deterministic 10-minute three-peer cross-clock sync, and synchronous `open-room-panel`
  (`Ctrl+Alt+B`) popup handling across MV2 and MV3 are verified at the unit and bridge boundary
  (`core/test/media-rejoin-three-peer.test.mjs`).
- Wheel event capture/replay (`wheelRecord`), structured pointer-lock refusal policy
  (`pointerLockDecision`, `inputCaptureDecision`, `GrantBook.decide`, `originDecision` under
  Guardrail #5), and BiDi/CDP action and special-key parity are verified across
  `core/test/input-trust-parity.test.mjs`, `host/test/chrome-cdp.test.mjs`, and
  `host/test/trust.test.mjs`, with the local-by-design pointer-lock refusal recorded in
  [safety.md](safety.md).
- Privacy documentation is written in [privacy.md](privacy.md), verified against
  `core/seal.mjs`, `core/browser-entry.mjs`, `relay/src/main.rs`, `host/trust.mjs`, and
  `bridge/background.js`.
- Verified automated suites on 20 November 2026:
  - Combined JS unit and boundary suites (`core/test/*.test.mjs`, `host/test/*.test.mjs`,
    `spike/*.test.mjs`, `labs/align/test/*.test.mjs`, `handoff.test.mjs`): 555 passing, 0
    failing (2 skipped Bend 1 align tests).
  - Rust relay parity suite (`RELAY_BIN=relay/target/debug/brosr-relay node --test
    spike/relay.test.mjs core/test/wire.test.mjs`): 13 passing, 0 failing.
  - Rust relay unit/HTTP tests (`cargo test --manifest-path relay/Cargo.toml`): 4 passing.
  - Canvas proofs (`bend landing/canvas/PROOF.bend`): `ALL PROOFS CHECK`.

### What shipped since 16 November

| Day | Change | Where |
| --- | --- | --- |
| 17 November | Media state on the panel, read in the real popup | `bridge/panel/room.js`, `scripts/check-panel-popup.mjs` |
| 17 November | Loopback two-peer media lane | `scripts/check-media-loopback.mjs` |
| 17 November | Notes empty width, light room, narrow window | `landing/notes/notes.css`, `scripts/check-room-apps-layout.mjs` |
| 17 November | Chess ranks, drag, queue, seat labels | `landing/chess/`, `scripts/check-chess-play.mjs` |
| 18 November | Notes co-typing | `landing/notes/`, `scripts/check-notes-cotyping.mjs`, `3416dd7` |
| 18 November | Canvas keeps its room name | `landing/canvas/canvas.js` |
| 18 November | Zen room keeps Google sign in | `zen/live.mjs`, `zen/profile.mjs`, `d7323af` |
| 18 November | Release `0.3.28` | `35a6531` |
| 19–20 November | Live-tab offers, own-row listing, stop/resume, Chrome worker replay persistence, rate/nudge cleanup (`v0.3.40`–`v0.3.43`) | `bridge/background.js`, `core/media-relay.mjs`, `core/live-tabs.mjs` |
| 20 November | Per-person cursor colours, `cursors-4u.com` cursor sets, signed bridge `0.4.10` (`v0.3.44`–`v0.3.46`) | `bridge/panel/room.js`, `dc9b4ae`, `591ccf4`, `e969ff6` |
| 20 November | Pointer socket excluded from `/status` counts, stalled BiDi session retirement, release `v0.3.47` | `ae56e90`, `e1185f0` |
| 20 November | Rust axum relay parity (`/status`, HTTP `Range`, landing apps, `/docs`, empty-room eviction), desktop staging (`host/trust.mjs`, `host/chrome-cdp.mjs`, `resources/relay/brosr-relay`), and release workflow build | `relay/src/main.rs`, `host/room.mjs`, `app/scripts/stage-host.mjs`, `app/src-tauri/tauri.conf.json`, `.github/workflows/release.yml`, `spike/relay.test.mjs`, `host/test/stage-host.test.mjs` |
| 20 November | Generic cross-origin iframe episode handoff (`brosr:tab-url`), HLS/DASH quality-switch, mid-playback rejoin, 3-peer cross-clock sync, and MV2/MV3 `open-room-panel` gesture handling | `bridge/background.js`, `core/media-relay.mjs`, `core/sync.mjs`, `core/test/iframe-handoff.test.mjs`, `core/test/media-rejoin-three-peer.test.mjs` |
| 20 November | Wheel event relay, local pointer-lock refusal policy (Guardrail #5), BiDi/CDP action & key parity, host-takeover UI offer tests, and privacy page | `core/input.mjs`, `core/trust.mjs`, `host/trust.mjs`, `host/chrome-cdp.mjs`, `core/test/input-trust-parity.test.mjs`, `core/test/host-takeover.test.mjs`, `docs/privacy.md`, `docs/safety.md` |

## The media drift, fixed on 18 November

The 16 November window left a steady gap of about a second and 17 correction seeks in three
minutes. The suspicion in the last version of this file was that the clock estimate entered the
expected position instead of cancelling. A probe on 18 November settled that part first.

The probe ran one host and one guest in one process, with the guest's wall clock set 1900 ms
ahead of the host's. One ping and one pong gave the guest the offset. One host frame then
arrived at the guest. The guest read `offset -1900`, `roomNow` equal to `messageRoomTime`, and
`expected 40`. The offset cancelled exactly, so the room-time arithmetic was not adding the
clock difference.

Two defects in the same seam did add error.

1. **The frame was stamped at the send, not at the read.** A film tab samples its player every
   250 ms and posts the state. The room stamped `roomTime` from the moment that report arrived,
   while the position inside it belonged to the sample. Every guest then extrapolated from an
   instant after the position, and the gap was the age of the report. A hidden tab throttles
   that interval to a second, which is the size of the observed gap.
2. **One clock sample held the session.** `ClockEstimator` kept the first sample that held the
   smallest round trip. When every later path ties on round trip, as it does on a quiet LAN,
   the first sample stays the answer forever. A sample taken across a clock step therefore
   held its wrong offset for the whole room, and a fixed offset is a fixed error in every
   playhead that reads room time.

The fix has four small parts. A report carries `at`, the instant its position was read.
`sendHostMedia` carries a stale report forward to the send and stamps that same send, and a
report with no `at` is taken as current, so a tab from an older build behaves as it did. A room
frame keeps the anchor instant it arrived with instead of stamping a fresh one at the handoff.
A later sample with an equal round trip replaces the best one.

Five tests were added at those boundaries on 18 November (the combined suite has since grown to
555 passing). The rows are in [regressions](regressions.md).

### The loopback re-measure

`node scripts/check-media-loopback.mjs` on 18 November, two headless Zen browsers on one
relay:

| Step | Reading |
| --- | --- |
| Guest applied frames | 64 |
| Paused mark | 0 s drift |
| Host seek | 0 s drift |
| Playback median | 0.04 s |
| Playback p95 | 0.06 s |
| Playback max | 0.06 s |

The earlier run read a median of 0.001 s and a p95 of 0.022 s. Both runs sit far inside the
250 ms budget and the lane's own one second limit. The 0.06 s is the message hop under a fresh
browser, and the rows are all negative, so the guest sits 40 to 60 ms behind the anchor rather
than jittering around it.

The loopback lane cannot prove the clock fix. Two browsers on one machine share a clock, so the
offset is near zero and a wrong sample looks like a right one. The cross-machine re-run is the
LAN hour below, and until it runs the one second gap is diagnosed, not closed.

### The cross-machine record, 16 November

Kept for comparison. Room `retest-0390` on the Windows relay at 8788, host paused on Cinecat,
Mac guest `guest-2e76`, 141 samples over 4 min 54 s.

| Reading | Value |
| --- | --- |
| Room peers | 2 in all 141 samples |
| `rtt` | 6 to 12 ms |
| Guest key | identical to `host_key` |
| Paused on the host mark | 55 samples at 120.000 s, drift 0 except one -0.221 s |
| Host seek of two minutes | 179.916 to 300.140, guest followed inside one sample |
| Drift on 79 moving samples | median 0.626 s, p95 1.252 s, max 1.317 s |
| Correction seeks | 17 in about three minutes |
| `clockOffset` | 1811 ms early, 1931 ms later, held at 1931 ms for 90 s |

The host never seeked, stalled or applied a guest action, so all 17 corrections were the guest
correcting itself.

The cross-machine window has not been re-run yet. The Windows machine and Cinecat have not been
paired for a fresh run since the fix, so the one second gap is proved at the unit boundary and
on the loopback lane only, and both of those share one clock.

## Open in the plan

Items marked `[x]` below note whether proof is at the unit/bridge boundary or from a live run.
Items that require a second machine, live third-party sites, or manual human testing remain open
and are tagged explicitly.

### Media

- [x] Mac guest following a Windows host. Passed on 16 November, numbers above.
- [x] Loopback two-peer lane under `scripts/`. It fails when `applies` stays 0 and when drift
      passes one second.
- [x] The clock offset stays out of the expected position, and the frame names the instant its
      position was read. Proved at the unit boundary on 18 November.
- [x] Movy playback (loopback). On 18 November the title page `/movie/1561726` named the film
      and rendered one top-page `<video>` with a blob source and no iframe. Two headless Zen
      browsers on one Mac, joined through a loopback relay, held pause within 0.058 s, seek at
      0 s and playback at 0.02 s p95 with 92 applies. The key was the page URL. No
      cross-machine window yet.
- [x] Miruro / generic cross-origin iframe episode handoff (unit and bridge boundary).
      `bridge/background.js` answers `brosr:tab-url` with `sender.tab.url` and pushes URL
      updates on SPA navigation, `framePageHref` prefers it for generic embeds while keeping
      YouTube embeds intact, and `pageKey` keeps canonical episode query params
      (`core/test/iframe-handoff.test.mjs`). Live two-browser Miruro playback remains open.
- [x] HLS/DASH/blob quality-switch sync (unit boundary). Switching mid-playback across `.m3u8`,
      `.mpd`, and `blob:` keeps the same `pageKey` with no spurious seek
      (`core/test/iframe-handoff.test.mjs`). Live-site confirmation remains open.
- [x] Deliberate 600 ms frame delay and deterministic 10-minute three-peer cross-clock sync
      (unit boundary). Settled within 250 ms p95 and at most one seek per ten minutes with zero
      seek loops (`core/test/iframe-handoff.test.mjs`,
      `core/test/media-rejoin-three-peer.test.mjs`). Live cross-machine confirmation remains
      part of the LAN hour.
- [x] Rejoin seek against a non-restoring player starting at 0 s (unit boundary). Preserves
      initial seed seek across buffer waits and SPA key swaps without looping
      (`core/test/media-rejoin-three-peer.test.mjs`). Live third-party site verification
      remains open.
- [ ] **(Hardware / two-machine)** The same cross-machine window again with the clock fix in.
      This is part of the LAN hour.
- [ ] **(Live site)** Live rejoin seek against a host mark Cinecat does not restore by itself.
- [ ] **(Hardware / multi-peer)** Live three-peer run over a 40 minute film on real browsers.
- [ ] **(Hardware / live site)** Cinecat cross-machine again, with the fix and a fresh room.
- [ ] **(Live site)** Cinejoy playback. The link is recorded, nothing was probed past it.
- [ ] **(Live site)** Live Miruro two-browser playback and live HLS/DASH quality switch on a
      real streaming page.
- [ ] **(Live site)** At least one live site whose player sits inside an iframe, held in the
      cross-browser test matrix.
- [ ] **(Live site)** A p-stream fork, if one is still reachable.
- [ ] **(Hardware / live sites)** M2b done-when: three live sites within 1 s on two browsers,
      one of them an iframe, at most one seek per ten minutes and no seek loop.
- [ ] **(Hardware / live)** M2c shared login. The host copies one site's login into the guest
      profile over the local debug port. It needs a signed-in page on the guest and a relay
      capture that shows no cookie value.

### Room, relay and reconnect

- [x] Rust axum relay parity (`relay/src/main.rs`) and desktop bundle packaging. Now serves
      HTTP `Range` (`206`/`416`) under `/media/*`, matches `spike/relay.js` across `/status`,
      landing and room apps, token/loopback-guarded `/docs`, and empty-room eviction, and is
      staged under `resources/relay/` by `app/scripts/stage-host.mjs` and
      `.github/workflows/release.yml` with `host/room.mjs` auto-discovery. Verified by
      `cargo test --manifest-path relay/Cargo.toml`, `host/test/stage-host.test.mjs`, and
      `RELAY_BIN=... node --test core/test/wire.test.mjs spike/relay.test.mjs`.
- [ ] **(Hardware / two-machine)** M1 done-when: four peers on one LAN under 80 ms p95 for an
      hour. A 45 s four-peer rehearsal ran on one machine on 18 November at 1 to 2 ms p95, with
      four relay sockets and zero reconnects. That checks the runner, the relay table and the
      peer journal. It is not an hour and not a LAN, so the hour still needs the Windows box.
      The plan below is that run.
- [ ] **(Hardware / live)** Host migration / takeover after the host closes its lid, on a live
      room rather than in the suite. (The landing-page takeover offer when `hosts === 0` is
      covered at the unit boundary in `core/test/host-takeover.test.mjs`.)
- [ ] **(Live)** A live Zen run with the seal on, after a relay restart, with every peer back on
      the same scroll.
- [ ] **(Live)** Site toggle with a 15 s dwell. The 21:57 window is invalid because the guest
      browser restarted inside it.
- [ ] **(Live)** The 96 px cursor gate. Changed but never measured on a live animation.
- [ ] **(Live site)** A cursor on a Cinecat page. The site in a presence frame is the tab under
      the pointer, so a count on the room tab says nothing about the film tab.
- [ ] **(Hardware / two-machine)** The fourth peer entry. Pointer sockets are now excluded from
      `/status` counts (`ae56e90`) and `peer.mjs` journals `peerIds`; the LAN hour should
      confirm four entries with no extra entry across Windows and Mac.

### Input and room apps

- [x] Wheel events through synthetic replay, BiDi, and CDP (unit and actuator boundary).
      `wheelRecord` and `replayInput` handle deltas, `deltaMode`, coordinates, and modifiers;
      `core/trust.mjs` and `host/chrome-cdp.mjs` translate wheel actions and special keys with
      parity (`core/test/input-trust-parity.test.mjs`, `host/test/chrome-cdp.test.mjs`,
      `host/test/trust.test.mjs`). Live two-browser confirmation remains open.
- [x] Pointer lock refusal written down and enforced under Guardrail #5. Documented in
      [safety.md](safety.md) and enforced with structured `{ allow: false, reason, message }`
      decisions across capture, batching, replay, and trusted helpers
      (`core/test/input-trust-parity.test.mjs`).
- [ ] **(Hardware / two-machine)** A two-machine canvas game, ten minutes, no visible desync.
      Both presses so far were on one machine.
- [ ] **(Live)** Wheel events through the relay on a live room.
- [ ] **(Live)** A room app edit on two peers, with no duplicate cursor or key injection.

### App, install and onboarding

- [x] The version stamp in a built release. `0.3.17` proved it and `0.3.47` carries it.
- [x] A privacy page that states what the relay sees. Added in [privacy.md](privacy.md) and
      linked from [docs/README.md](README.md) and `README.md`.
- [x] `open-room-panel` (`Ctrl+Alt+B` / `MacCtrl+Alt+B` in MV2, `Ctrl+Shift+B` /
      `Command+Shift+B` in MV3) synchronous user-gesture popup invocation verified at the bridge
      boundary (`core/test/media-rejoin-three-peer.test.mjs`). Live browser chord confirmation
      remains open.
- [ ] **(Hardware / clean machine)** First run from a clean install with no checkout. The dmg
      path is the closest thing tested.
- [ ] **(User test)** Onboarding under three minutes for a person who has not seen the app.
- [ ] **(Live)** Sidebar/panel survives ten tab switches.
- [ ] **(Live)** `Ctrl+Alt+B` (`MacCtrl+Alt+B` on macOS) live browser chord test.
- [ ] **(Live)** A room per Zen space. Zen stores spaces in its session store, so this is still
      open.
- [ ] **(Release / AMO)** A signed bridge on release Firefox. The Mac guest still needs a live
      verification against the signed AMO build (`0.4.10` was signed in `e969ff6`; manifest is
      now `0.4.11`).
- [ ] **(Network)** Hosted relay across two networks. Every test so far is loopback, LAN or
      tailnet.
- [ ] **(Platform build)** Linux build and `.AppImage`. The release workflow currently builds
      macOS and Windows only.
- [ ] **(Live)** A first-run flow that survives a browser major update.

### Later

- [x] Rename the room, per-person colours, custom cursors from `cursors-4u.com`, and own-cursor
      toggle (`bridge/panel/room.html`, `bridge/panel/room.js`, `dc9b4ae`, `591ccf4`).
- [ ] M8 Chromium variant. The plan commits to neither M8 job.
- [ ] M8 Voice over WebRTC.
- [ ] Screen share viewer, as a separate tab and never the page-sync path.

## The four-peer LAN hour, step by step

One sitting, about 75 minutes: 15 minutes of setup, 60 minutes of window, 10 minutes of reading
and writing down. Four peers: the host and `win2` on Windows, `mac1` and `mac2` from this Mac.
The relay runs on the Windows machine. The window is fixed at 3600 s.

Run it from a clean shell and keep every command as written. Do not start a second relay on a
port the standalone already holds.

### 0. Preflight, 15 minutes before

1. On Windows, start the relay from the checkout:

   ```
   cd brosr\spike
   set HOST=0.0.0.0
   set PORT=8787
   node relay.js
   ```

   The relay prints `[relay] http://0.0.0.0:8787 ws://0.0.0.0:8787/room`.

2. Find the LAN address on Windows with `ipconfig`, and take the IPv4 of the adapter that
   carries the LAN. Call it `<ip>` from here.

3. On this Mac, prove the path before anything joins:

   ```
   curl -s http://<ip>:8787/health
   curl -s http://<ip>:8787/stats
   ```

   `health` prints `ok` and `stats` prints `{"rooms":{}}`. A refused connection here is the one
   failure that costs the whole sitting, so fix it now.

4. Prefer Ethernet on both machines. If the Mac is on Wi-Fi, write down the band, channel and
   signal from the menu bar or `system_profiler SPAirPortDataType`, because the 13 November
   table carries that line and a later hour should compare like for like.

5. Close every other window on both machines, and quit any second browser. A room hour is
   mostly a count of dropped frames, and a machine under load makes that number about the load.

6. Confirm the clip for the media annexe is on this Mac:

   ```
   ls -l spike/.runtime/clip.webm
   ```

7. Keep the two Windows room pages on `127.0.0.1`, not on `<ip>`. The bridge that starts the
   room is matched by a Firefox pattern that cannot carry a port or a LAN address, so a page at
   `http://<ip>:8787/` loads the fixture and no room. The relay still binds `0.0.0.0`, which is
   how the Mac reaches it. This is also why the 13 November table calls the Windows presence
   figure a loopback number.

### 1. Open the host room, three minutes before

On Windows, open:

```
http://127.0.0.1:8787/board.html?role=host&room=lanhour&peer=host&name=Host
```

The panel should read role `host` and one peer, which is the host itself.

### 2. Open the second Windows peer, two minutes before

```
http://127.0.0.1:8787/board.html?role=peer&room=lanhour&peer=win2&name=Win2
```

Both Windows pages should now read two peers.

### 3. Start the two Mac peers, one minute before

Single-command launcher on this Mac (recommended; `lan-peers.mjs` owns both child processes,
prefixes each peer's output, forwards `--probe` to every peer, and writes
`.runtime/lanhour-mac1.json` and `.runtime/lanhour-mac2.json`):

```
node spike/lan-peers.mjs --relay=<ip> --port=8787 --room=lanhour --peers=mac1,mac2 --seconds=3660 --probe=60 --out-prefix=.runtime/lanhour
```

Or run them in two terminals on this Mac, one command each:

```
node spike/peer.mjs --relay=<ip> --port=8787 --room=lanhour --peer=mac1 --name=Mac1 \
  --host=host --seconds=3660 --probe=60 --out=.runtime/lanhour-mac1.json
```

```
node spike/peer.mjs --relay=<ip> --port=8787 --room=lanhour --peer=mac2 --name=Mac2 \
  --host=host --seconds=3660 --probe=60 --out=.runtime/lanhour-mac2.json
```

Each peer prints `[peer] joined ws://<ip>:8787/room room=lanhour peer=<id>` (prefixed with
`[mac1]` / `[mac2]` under `lan-peers.mjs`). Both Windows pages must read four peers before the
window starts. If a page reads three, stop and fix that first, because a count that is wrong at
the start is not a result at the end.

`--seconds=3660` gives a minute of margin so the peers do not leave before the host page does.
`--probe=60` reads the relay table from the Mac once a minute, which is the witness beside the
page's own sample.

### 4. Start the window at a whole minute

Note the UTC start. The 13 November run used 18:30:02 UTC, and a whole minute makes every table
row easy to line up afterwards.

### 5. Drive the room from the host page

One person drives, and the marks are fixed so a later reader can compare windows. Commit
`6d0b899` intentionally removed host-to-guest scroll mirroring, so the four scroll marks check
**independent scrolling** (scrolling on the host stays local and does not yank `win2` or change
`scroll` in the Mac journals), while presence, clock exchange, and the `00:58` media annexe
stay synced:

| At | Act |
| --- | --- |
| 00:05 | Scroll the host page to 0.2 (verify `win2` does not move; independent scrolling) |
| 00:20 | Scroll the host page to 0.6 (verify `win2` does not move; independent scrolling) |
| 00:40 | Scroll the host page to 0.35 (verify `win2` does not move; independent scrolling) |
| 00:55 | Scroll the host page to 0.2 (verify `win2` does not move; independent scrolling) |
| 00:58 | Media annexe: open the clip on the host page, pause at 30 s, seek to 50 s |

Do not do anything else on that page. A second tab on the same room makes the presence numbers
about the tab and not the room. The media annexe stays a page action. `lan-peers.mjs` runs Node
peers with no video element, and a second host tab would fight the room for the host role, so the
runner cannot drive a film.

### 6. Read the relay table once a minute

On the Windows box, in a second terminal:

```
curl -s http://127.0.0.1:8787/stats
```

The `rooms.lanhour` count must read 4 at every read. Write the minute and the count in a column.
A 3 on any minute names the drop, and the hour then has a finding even if everything else
passes.

### 7. Stop at 60:00

`peer.mjs` writes its journal on its own timer, on `Ctrl+C`, or on `SIGTERM` (and
`lan-peers.mjs` forwards `Ctrl+C` / `SIGTERM` to both peers). Let them write. Then close the
two Windows pages.

### 8. Read the two journals

On this Mac:

```
node -e "for (const p of ['mac1','mac2']) { const j = require('./.runtime/lanhour-'+p+'.json'); const s = j.samples || []; const last = s[s.length-1] || {}; console.log(p, 'samples', s.length, 'reconnects', j.reconnects, 'peerIds', JSON.stringify(last.peerIds), 'p95', last.latency && last.latency.p95, 'rtt', last.rtt, 'clock', last.clockOffset, 'probes', j.probes.length); }"
```

From each journal take the reconnect count, the peer list, the probe count and the latency
percentiles. `peerIds` sits on each sample, not at the root. `peer.mjs` keeps a rolling summary,
so the percentiles are over its own samples and not over the raw ones. Each probe row also
carries `roomSockets`, so the relay's own count sits beside the page's count.

### 9. Acceptance

- Four peers at every minute read, on the host page, on `win2`, and in both Mac journals.
- Zero reconnects in both journals.
- Presence p95 under 80 ms on the page column, with the clock round trip beside it. If presence
  reads tens of milliseconds while the clock holds 3 ms, say so and do not call it a transit
  time, because the 13 November table made exactly that mistake.
- Independent scrolling held across all four host scroll marks (`6d0b899` intentionally removed
  host-to-guest scroll mirroring): scrolling on the host did not yank `win2` or change `scroll`
  (stays `0`) in either Mac journal, while presence frames, clock exchange, and the `00:58`
  media annexe remained synced.
- `peerIds` names four entries with no extra entry.
- Media annexe: pause drift 0, seek drift under 0.25 s, and no seek loop in the next minute.
- The clock offset recorded at the start and at the end, so a step during the hour is visible.

### 10. Write it down

Add a dated table to `spike/README.md` with four peer columns, the window, the relay table
counts, the presence percentiles, the clock round trip, the reconnects and the media annexe.
Then move the M1 line in this file and name whatever failed, in the same words a reader would
use to reproduce it.

## Suggestions, in the order I would take them

1. **Run the LAN hour.** It closes M1 and it is the only run that can show whether the clock fix
   moved the cross-machine gap. The plan above is written to finish in one sitting.
2. **Fold the media annexe into the same hour.** The clip is already on the Mac and the relay
   already serves it, so the media reading costs five minutes instead of a second session.
3. **Add Movy and Miruro next in the live site matrix.** Movy (plain `<video>`) plus a live
   iframe embed (Miruro or Cinecat) is the shortest path to the M2b done-when.
4. **Take one measurement per claim.** The plan's numbers section asks for p95 drift, seeks per
   ten minutes and relay bytes. A run that reports "it felt fine" closes nothing.
5. **Rejoin seek against a site that restores its own mark.** Cinecat does not, and a check
   against it proves the page and not the room.

## Files that change for this

- `core/sync.mjs`: the expected position, `sendHostMedia`, and the frame handoff.
- `core/clock.mjs`: which sample wins.
- `core/browser-entry.mjs`: what a film report carries and what the room passes on.
- `core/media-relay.mjs`: `RemoteMediaSync`, `framePageHref`, `pageKey`, the first-frame seed
  and the sign-off comparison.
- `core/input.mjs` and `core/trust.mjs`: wheel capture/replay, local pointer-lock refusal
  policy, and BiDi action translation.
- `host/trust.mjs` and `host/chrome-cdp.mjs`: trusted actuator loopback agent and CDP parity.
- `bridge/content.js` and `bridge/background.js`: the frame handoff, `brosr:tab-url`, and the
  room channel.
- `bridge/panel/room.js`: the panel line that shows the drift.
- `relay/src/main.rs`: the Rust axum relay parity implementation.
- `app/scripts/stage-host.mjs` and `app/src-tauri/tauri.conf.json`: desktop staging for the
  host, trust runtime, and Rust relay binary.
- `scripts/check-media-loopback.mjs`: the one-machine lane.
- `spike/peer.mjs`, `spike/relay.js` and `spike/README.md`: the LAN hour.
- `.runtime/`: journals and profiles. Not committed.
