# Brosr spike

This harness answers the M0 questions in [../plan.md](../plan.md) and exercises the M1, M3 and
M4 work in [../core/](../core/) on this machine. It is a spike, not the app.

Run it with `node run.mjs`. The harness downloads Firefox Nightly and uBlock Origin into
`.runtime/` and encodes a 120 s test clip with ffmpeg. Then it starts a relay on
`127.0.0.1:8787`, four headless instances, and writes `results.json`. The `.gitignore` in this
repository excludes `.runtime`, so the downloaded browser and the profiles never reach a
commit.

`--only=` takes a comma list of `ad`, `bidi`, `media`, `room`, `jitter`, `input`, `agent`,
`game` and `soak`. `--soak=3600` adds the one-hour reconnect soak. `--game=SECONDS` runs the
two-window canvas game. The ten-check run takes about four minutes.

## Result, 13 November 2026

Environment: Windows, Node 24.22.0, Firefox 162.0a1 from the Nightly archive, ffmpeg 8.1.1,
no system Firefox on the machine.

| Check | Result | Evidence |
| --- | --- | --- |
| Q1 profile | Pass | Four separate profiles ran as separate instances. All opened a BiDi session. |
| Q2 bridge | Pass | A temporary XPI with the nine core modules installed on all four. The content script imported the core from the extension origin and reported `source: content-script`. |
| Q3 uBlock Origin | Pass | Full uBO 1.76.0, active and signed. It blocked a Taboola request in profile A. Profile B, without uBO, loaded the same request. |
| Q4 BiDi input | Pass | One key action produced `isTrusted: true` and set the field to `a`. |
| Q5 media | Pass | Two windows played one encoded clip through a real `HTMLMediaElement`. The peer joined 2.4 s behind, used one seek and one rate nudge, then held 85 samples at 8 ms p95 and 11 ms worst. Both windows drew the other cursor. |
| Q6 token channel | Pass | The agent refused to start without a grant and bound `127.0.0.1` on a random port. No token gave 401, a wrong token gave 401, the right token typed a trusted `t`, and revoke closed the socket. |
| Q7 four-peer room | Pass | Four tabs in one room. 527 presence samples across three peers at 2 ms p95 and 6 ms worst. Each peer drew three cursors, all three followed the host to the second page, and every window landed at the same 0.55 scroll ratio. |
| Q8 jitter link | Pass | The proxy added 120 ms each way and dropped 5 percent, which cost 38 messages up and 17 down. The peer converged with one seek, then held 57 samples at 35 ms p95 and 43 ms worst. |
| Q9 input relay | Pass | A granted peer clicked the canvas at its centre. The host drew the same point as a synthetic event at (201, 151) and applied one record. A password field on the peer stayed local, so the host's copy stayed empty. |
| Soak 60 s | Pass | Four peers scrolled together while the relay restarted in the middle. 600 presence samples at 2 ms p95. Every peer reconnected and came back to the host's 0.6 scroll ratio. |

## macOS, 12 November 2026

Environment: macOS on arm64, Node 23.9.0, ffmpeg 9.0.2, Firefox Nightly 162.0a1 from the
macOS DMG. The harness unpacks the build into `.runtime/firefox-mac.app`, so the system keeps
no Firefox install.

`ensureFirefox()` downloads a Windows build, so macOS passes a binary instead:

```
node run.mjs --only=bidi,ad --firefox="$PWD/.runtime/firefox-mac.app/Contents/MacOS/firefox"
```

| Check | Result | Evidence |
| --- | --- | --- |
| Q1 profile | Pass | Four profiles as four instances, each on a BiDi session. |
| Q2 bridge | Pass | The temporary XPI installed on all four profiles, and the content script reported from the room tabs. |
| Q3 uBlock Origin | Pass | uBlock Origin 1.76.0 blocked the Taboola request, active with `signedState: 2`. |
| Q4 BiDi key | Pass | `isTrusted: true`, and the field held `a`. |
| Q7 four-peer room | Pass | 467 presence samples at 3 ms p95. Each peer drew three cursors and reported the host's 0.55 scroll ratio. |

The room lane ran as a regression check for the LAN changes below, not as a ten-check run.
`results-macos.json` holds this run. `results-win11.json` holds the Windows ten-check run.
`results.json` holds the last run.

## Loopback hour, 13 November 2026

Environment: macOS 26.6.2 on arm64, Node 23.9.0, Firefox Nightly 162.0a1 from the macOS DMG.
One Mac ran four headless windows in room `soak` on `127.0.0.1:8787`. The lane restarted the
relay at the midpoint.

```
cd spike && node run.mjs --soak=3600 --only=soak \
  --firefox="$PWD/.runtime/firefox-mac.app/Contents/MacOS/firefox"
```

| Item | Result |
| --- | --- |
| Presence samples | 600 |
| Presence p50, p95, worst, ms | 0, 2, 3 |
| Reconnects, peer 2, 3, 4 | 5, 4, 5 |
| Sockets after a reconnect | 1 on every peer |
| Scroll ratio | 0.2 on every peer |
| Relay restart | Every peer reconnected and reported `relayRestarted: true` |

p50 rounds to 0 ms at this sample rate. The run wrote `when: 2026-11-13T10:08:47Z`. This is one
hour on one machine over loopback. It is not a LAN hour, and it is not a two-machine hour.

## The LAN changes

Three pieces blocked a second machine. All three now accept a LAN address:

- `relay.js` reads `HOST` and defaults to `127.0.0.1`. `HOST=0.0.0.0 node relay.js` listens on
  the LAN. The relay has no authentication, so use that only on a trusted network.
- `core/browser-entry.mjs` dials `ws://${location.hostname}:${relayPort}`. A loopback page still
  dials `127.0.0.1`, and `relay=` still overrides the port for the jitter proxy.
- The bridge match is `http://*/*`, because a Firefox match pattern cannot carry a port.

## The game channel

A page cannot reach the content script, so `browser-entry.mjs` carries page messages over the
room as an `app` frame. A page posts `{source: 'brosr-app', type: 'send', name, data}` to its
own window. The room relays it, and the other page receives
`{source: 'brosr-app', type: 'message', from, name, data}`. The protocol requires a name and an
object payload, and the 16 KB frame ceiling still applies.

`fixtures/game.html` is a two-player canvas game on that channel. The host simulates the ball
and sends state at 15 Hz. The peer sends its paddle target and draws the state it receives.

```
node run.mjs --only=game --game=600
```

### Game result, 13 November 2026

Two windows on macOS 26.6.2, Node 23.9.0 and Firefox Nightly 162.0a1 joined room `game` over
`127.0.0.1:8787`. The host simulated for 600 s, and the peer moved its paddle every 2 s.

| Item | Result |
| --- | --- |
| Verdict | Pass, `game.ok: true` |
| Peer state frames received | 8955, about 15 per second |
| Host paddles received | 5667 of 5667 sent, 0 dropped |
| State frames | 8977 sent, 8955 received, 22 sent frames not counted as received |
| Scores on both windows | 95 to 0, `scoresMatch: true` |
| Sequence on both windows | 8978 |
| Frames drawn | 36302 on the host, 36215 on the peer |
| Peers | 1 on the host, 2 on the peer |

The host never counts itself, so 1 and 2 are the right counts for two pages. The host won 95 to
0 because the peer paddle only moved between two positions. The scores still match on both
windows, which is the check that matters.

## LAN game, 13 November 2026

The Mac peer ran `spike/peer.mjs` in room `game`. The Windows host opened `game.html` at
`http://192.168.8.161:8787/` and held it for 600 s.

| Item | Windows | Mac |
| --- | --- | --- |
| Window | 17:38:59 to 17:49:00 UTC | 17:38:59 to 17:49:00 UTC |
| Peers | 1 visible (`mac`) | 2 |
| State frames | 8658 sent | 8645 received, 14.4 per second |
| Paddles | 5969 received | 5960 sent |
| Dropped | 0 | 0 |
| Sequence at the end | 8658 | 8656 |
| Score at the end | 97 to 0 | 97 to 0 |
| Frames drawn | 86585 | not counted |
| Presence latency | not read, the page reported `null` | 200 samples, p50 3 ms, p95 4 ms, max 5 ms |

The two scores match, so `scoresMatch` is true. The host sent 13 more states than the Mac
received. A host restart earlier in the strip dropped the sequence to 3757, but that drop sits
before 17:38:59, and the window itself has no regression. The Mac peer counted two entries
where the host counted one. The first early host run covered a room where the Mac peer dropped,
so it is not a row.

A second 600 s game ran at 18:11 UTC, after the Mac restarted its peer. The host saw the peer at
18:11:54 UTC.

| Item | Windows | Mac |
| --- | --- | --- |
| Window | 18:11:54 to 18:21:55 UTC | 18:11:54 to 18:21:55 UTC |
| Peers | 1 visible (`mac`) | 1 visible (`host`) |
| State frames | 8648 sent | 8641 received, 14.4 per second |
| Paddles | 5958 received | 5957 sent |
| Dropped | 0 | 0 |
| Sequence at the end | 8649 | 8650 |
| Score at the end | 111 to 0 | 111 to 0 |
| Frames drawn | 86488 | not counted |
| Presence latency | 200 samples, p50 0 ms, p95 8 ms, max 44 ms | 200 samples, p50 43 ms, p95 44 ms, max 44 ms |

The two scores match, so `scoresMatch` is true. The host sent 7 more states than the Mac
received, and the paddle counts differ by one, so the sides are not frame exact. The host p95
read 2189 ms at 18:14 and 8 ms at the end. The final row uses the last 200 samples. The Mac's 43
ms is the same figure the hour shows: the clock exchange held 3 ms, so it is not a transit time.

## LAN hour, 13 November 2026

The Mac peers `mac1` and `mac2` joined room `soak` at 18:27 UTC. The Windows host and `win2`
opened at 18:30:01 and started at 18:30:02.885 UTC.

| Item | Windows host | Windows peer `win2` | Mac `mac1` | Mac `mac2` |
| --- | --- | --- | --- | --- |
| Window | 18:30:02 to 19:30:03 UTC | same | 18:30:00 to 19:30:00 UTC | 18:30:00 to 19:30:00 UTC |
| Peers | 3 | 4 | 1 then 4 | 1 then 4 |
| Presence samples | 200, the page cap | 200, the page cap | 3596 | 3596 |
| Presence p50, ms | 0 | 1 | 46 | 46 |
| Presence p95, ms | 1 | 2 | 158 | 161 |
| Presence max, ms | 1 | 3 | 4920 | 4984 |
| Scroll | 0.2, 0.6 at 18:50, 0.35 at 19:10 | followed both | reported 0.2, 0.6, 0.35 | reported 0.2, 0.6, 0.35 |
| Applied and dropped input | 0 and 0 | 0 and 0 | no input sent | no input sent |
| Reconnects | 0 | 0 | 1 at 18:31:16 | 1 at 18:31:16 |

The page keeps the last 200 latency samples, so its p95 covers the last 200 samples. The Mac
journal keeps a rolling summary rather than each sample, so each Mac row is a percentile of the
peer's own 200-sample percentiles. The Mac peers report the host ratio rather than scrolling a
page. The Mac max lands on the reconnect minute. The Mac peers counted four entries once
Windows joined, and the host counted three. `peer.mjs` now journals `peerIds`, which will name
the extra entry.

The two latency columns measure different hops. The Windows pages talk to a relay on their own
host, so 1 to 2 ms is a loopback figure and not a LAN one. The Mac column crosses Wi-Fi: 802.11ax
on channel 56 at -49 dBm. That column is not a transit time either. The room's own clock
exchange held 3 to 4 ms round trip for the whole hour, while presence read 46 ms p50. No frame
takes 46 ms one way on a path with a 3 ms round trip. The presence figure carries a bias of
about 40 ms. No row here names it. The peer journal now carries each sender's presence p50
beside the clock offset. A TCP connect from the Mac to the relay took 4.5 to 13 ms over six
tries.

## LAN, two machines, 13 November 2026

The first two-machine run joined a Windows host and a Mac peer over the Ethernet LAN at
`192.168.8.161:8787`, room `lan`. The Mac peer joined at 07:54:56 UTC, followed the host to
`board.html`, and clicked the canvas centre at 07:54:59 UTC. The Windows window ran from
07:44:42 to 07:54:59 UTC.

| Item | Windows | Mac |
| --- | --- | --- |
| Peers in the room | 1 visible (`mac`), 2 with the host | 2 (`mac` and `host`) |
| Presence latency samples | 29 | 31 |
| Presence p95, ms | 3 (p50 2, worst 4) | 10 (p50 4, worst 10) |
| Scroll ratio | 0 | 0 |
| Click coordinates | canvas (201, 151), relayed, `trusted: false` | canvas (201, 151), viewport (225, 244), `trusted: true` |
| Applied and dropped input | 1 and 0 | not read |

Environment: Windows with headless Zen 1.24.1b, and macOS 26.6.2 on arm64 with Firefox
Nightly 162.0a1. The Windows host loaded `zen/.runtime/bridge-host.xpi`. The Mac loaded
`spike/.runtime/bridge.xpi`.

The two sides measured different windows and directions. Windows held 29 samples at 3 ms p95.
The Mac held 31 samples at 10 ms p95. Keep both columns and do not combine them.

A second window measured the view layer. The host scrolled `tall.html` to 0.5, and the peer
followed the ratio and held it.

| Item | Windows | Mac |
| --- | --- | --- |
| Peers in the room | 1 visible (`mac`), 2 with the host | 2 |
| Presence latency samples | 200 | 200, the journal cap |
| Presence p95, ms | 1 (p50 0, worst 4) | 7 (p50 7, worst 11) |
| Scroll ratio | 0.5 | 0.5 |
| Click coordinates | none | none |
| Applied and dropped input | 0 and 0 | not applied |

The Mac held 0.5 from 08:26:42 to its last two-peer sample at 08:39:12 UTC. The Windows row
covers its first window, 08:26:38 to 08:30:43 UTC. No canvas click happened in either window,
because the host opened `tall.html` and the peer driver then pressed only `board.html`.

A third window paired the two. The Windows host opened `tall.html?grant=mac` at 09:05:31 UTC,
the Mac joined at 09:05:32, and the host scrolled to 0.5 at 09:05:35. The Mac's last sample
holds 0.5 with two peers and the grant active. The click did not land. At 0.5 the `#board`
canvas sat above the viewport, so BiDi refused the press at (225, -986) in a 935 by 815
viewport. The driver stopped on that error after 1184 samples, so this window gives no click
row. `tall.html` now pins the canvas so a later window can land one.

The same click path passed on loopback after that change. A local relay, a fake host at 0.5
and the same driver produced `clickAt.scroll: 0.5` and `{ x: 201, y: 151, trusted: true }` in
38 samples. The relay forwarded 1402 frames. That is loopback evidence, not a LAN number.

A fourth window landed the click. The host opened `tall.html?grant=mac` at 09:29:09 UTC, the
peer followed 0.5, and the host received the click at 09:29:15.

| Item | Windows | Mac |
| --- | --- | --- |
| Peers in the room | 1 visible (`mac`), 2 with the host | 2 |
| Presence latency samples | 134 | 47 at the click |
| Presence p95, ms | 10 (p50 3, worst 17) | 4 (p50 2, worst 6) |
| Scroll ratio | 0.5 | 0.5 |
| Click coordinates | canvas (201, 151), `trusted: false` | canvas (201, 151), viewport (225, 151), `trusted: true` |
| Applied and dropped input | 1 and 0 | not read |
| Layout mismatch | false | true |

The two sides agree on 0.5 and on the canvas point. The host applied the click and dropped
none. This closes the LAN click that pairs with a followed scroll.

This window proves a LAN grant, a followed scroll, a canvas click and one applied record. It
does not prove a WAN, an hour, or more than two machines.

## What it does not prove

- Release Firefox. The temporary bridge install needs Nightly or Developer Edition. A release
  build needs a signed XPI, which is M6.
- A WAN. The two-machine windows crossed the Ethernet LAN on 13 November 2026. No window
  crossed the internet.
- A LAN latency number. The Windows column is loopback, and the Mac column disagrees with the
  room's own 3 to 4 ms clock exchange. This document does not quote either column as the LAN hop.
- A peer that closes a tab and returns. The reconnect path was tested by restarting the relay,
  not by closing and reopening a tab.
- The production relay. Room isolation runs in the spike's Node relay. The axum relay is M3.
- The launcher. The token agent ran inside the harness, not in a Tauri process. The harness
  minted the token and the grant, and no UI showed either.
- The grant UI. The spike grants control with a query parameter, and it has no Revoke button.
- A frame-exact game. Both sides ended at 111 to 0, but the host sent 8648 states against
  8641 received, and the paddle counts differ by one.
- Input beyond a click and a paddle. No pointer lock, no wheel test, and no typing into an
  ordinary field.
- Media beyond one 120 s clip: no ad, no DRM, no live stream, no 40-minute run.

## Findings that changed the code

- A Firefox match pattern cannot contain a port. `http://127.0.0.1:8787/*` silently skipped
  the content script. `http://127.0.0.1/*` works.
- A Manifest V2 content script can `import()` a module that appears in
  `web_accessible_resources`. The page origin and its CSP do not apply to that URL.
- One time base per side. Mixing `Date.now()` with `performance.now()` made every round trip
  negative, so the clock rejected each sample and the offset stayed zero. The two videos then
  looked converged because a clock error and a position error cancelled each other out.
- A page clock inside one process. Two Windows pages reported clock offsets of 0 and 154 ms
  against the same Mac peer. The Mac peer read -1794600007694 ms. Both came from
  `performance.now()`, which starts at zero in each process. The page now stamps the exchange
  with `Date.now()`, so the offset is a real clock difference.
- Room time belongs to the host. When the host stamped room time through its own offset, the
  time pointed at the peer's base and every comparison was seconds off.
- A seek must settle before the next decision. A decision every 250 ms stacked seeks, each one
  cancelling the last, and the peer never caught up.
- A seek can leave the element paused, so the correction has to start playback again.
- A followed URL must not carry the room parameters. The host announced its own tab URL, with
  `role=host` in it, so every peer reloaded as a host and the clock stopped. The announced URL
  is now the page alone, and identity survives a navigation in `sessionStorage`.
- An input frame must name its sender. Without `peerId`, the receiver looked up a grant for
  `undefined` and refused every click.
- A per-room table needs the room parsed in the upgrade handler. Reading it from the request
  handler's scope crashed the relay on the first socket.
- A 401 that answers before the server reads the body resets the socket. Draining the body
  first turns the caller's connection error into a status code.
- uBlock Origin sideloads from an AMO XPI into a fresh profile. Firefox reports `active: true`
  and `signedState: 2`.
- A stray page makes a phantom room. Two browsers left by the 01:37 media demo stayed open and
  re-dialled `demo` on every relay restart, so `/stats` listed `demo: 2` beside `soak: 4` for
  the whole hour. The harness now waits for its own relay line, and a busy port stops the run
  with `port 8787 is in use` instead of answering `/health` from another process.

## Files

| File | Job |
| --- | --- |
| `relay.js` | Static fixtures, one WebSocket table per room, and range requests for the clip |
| `relay.test.mjs` | Two rooms on one relay, and a room table that empties itself |
| `proxy.mjs` | A WebSocket proxy with one-way delay and message loss in both directions |
| `run.mjs` | The harness: download, profiles, BiDi, ten checks, results |
| `bidi.mjs` | A minimal WebDriver BiDi client over the Node WebSocket |
| `agent.mjs` | The loopback token channel from Section 8 of the plan |
| `agent.test.mjs` | Seven tests for the token, the grant, expiry and revoke |
| `unzip.mjs` | A minimal ZIP reader, because GNU tar cannot open a zip |
| `zip.mjs` | A minimal stored ZIP writer, for the XPI |
| `bridge/manifest.json` | Manifest V2 bridge with a content script and the core modules |
| `bridge/content.js` | Content script that loads the core and starts a room |
| `fixtures/` | Media, form, ad, sync, board, game, tall and the two room pages |
| `../core/` | Protocol, clock, drift, media, room, overlay, input and the sync client |
| `results.json` | The last run's output |
