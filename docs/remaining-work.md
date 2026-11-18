# What is left, 18 November 2026

This is the working list beside [the design](design.md). The plan holds the design and the
per-milestone done-when. This file holds what is still open, what was measured, and what to do
next. It is not a replacement for the plan and it is not a status claim about shipping.

## Where things stand today

- Release `v0.3.28` is the latest, cut on 18 November from `3416dd7`. The workflow run
  `44411237677` built all three platforms and `latest.json` is signed for `darwin-aarch64`,
  `darwin-x86_64` and `windows-x86_64`. The earlier cuts that matter here are `v0.3.13` and
  `v0.3.17` (commit `1676127`).
- The version stamp is in a built release. It reads `getVersion()` and draws bottom right, so a
  window names the build it runs. The install on this Mac runs `0.3.28`.
- Notes carries co-typing. Two people can type in one note and neither save takes the other
  hand's words away.
- The Zen room starts without Marionette unless `--dock` asks for the dock. Google accepts the
  sign-in in the room window, so the panel and the sign-in no longer exclude each other.
- The landing page links Notes and Play (chess) beside Canvas, and the Watch tile carries a live
  FMHY directory with a filter instead of the word `Soon`.
- The room apps hold their layout in a narrow window and in a light room. The chess board keeps
  its rank heights, a dragged piece lands where it is dropped, and the waiting list keeps the
  guest who has waited longest.
- The relay's file server knows html, js, json, png, webm and the icon types, so a room app opens
  as a page rather than as a download.
- The core suite reads 296 tests, all passing, with `node --test core/test/*.test.mjs`.

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

Five tests were added at those boundaries, and the suite now reads 296 passing. The rows are in
[regressions](regressions.md).

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

## Open in the plan

### Media

- [x] Mac guest following a Windows host. Passed on 16 November, numbers above.
- [x] Loopback two-peer lane under `scripts/`. It fails when `applies` stays 0 and when drift
      passes one second.
- [x] The clock offset stays out of the expected position, and the frame names the instant its
      position was read. Proved at the unit boundary on 18 November.
- [ ] The same cross-machine window again with the fix in. This is part of the LAN hour.
- [ ] Rejoin seek. The first applied frame seeks when the gap is over 0.25 s. Never run against
      a host mark Cinecat does not restore by itself.
- [ ] Three-peer run, and a 40 minute film. M2 done-when asks for 250 ms p95 and at most one
      seek per ten minutes.
- [ ] One deliberate 600 ms delay, to prove it causes one seek rather than a loop.
- [ ] Cinecat cross-machine again, with the fix and a fresh room.
- [ ] Movy playback. The home page loaded, no film has played.
- [ ] Cinejoy playback. The link is recorded, nothing was probed past it.
- [ ] Miruro. The embed URL is the same for every episode, so it needs a title and episode
      handoff before it can join the list.
- [ ] At least one site whose player sits inside an iframe, held in the test matrix.
- [ ] An HLS or DASH page through a quality switch, to show the page key survives it.
- [ ] A p-stream fork, if one is still reachable.
- [ ] M2b done-when: three sites within 1 s on two browsers, one of them an iframe, at most one
      seek per ten minutes and no seek loop.
- [ ] M2c shared login. The host copies one site's login into the guest profile over the local
      debug port. It needs a signed-in page on the guest and a relay capture that shows no
      cookie value.

### Room, relay and reconnect

- [ ] M1 done-when: four peers on one LAN under 80 ms p95 for an hour. The plan below is that
      run. Two peers for 420 s was the longest window, at 6 ms p95.
- [ ] Host migration after the host closes its lid, on a live room rather than in the suite.
- [ ] A live Zen run with the seal on, after a relay restart, with every peer back on the same
      scroll.
- [ ] The axum relay serves no range requests. A seeking clip still needs the Node relay.
- [ ] Site toggle with a 15 s dwell. The 21:57 window is invalid because the guest browser
      restarted inside it.
- [ ] The 96 px cursor gate. Changed but never measured on a live animation.
- [ ] A cursor on a Cinecat page. The site in a presence frame is the tab under the pointer, so
      a count on the room tab says nothing about the film tab.
- [ ] The fourth peer entry. The Mac peers counted four once Windows joined and the host
      counted three. `peer.mjs` now journals `peerIds`, and the LAN hour should name the entry.

### Input and grants

- [ ] A two-machine canvas game, ten minutes, no visible desync. Both presses so far were on
      one machine.
- [ ] Wheel events through the relay.
- [ ] Pointer lock, which is local by design and needs the refusal written down.
- [ ] The grant UI in the panel end to end: grant a peer, relay a click, revoke, and show the
      bar in both places.

### App, install and onboarding

- [x] The version stamp in a built release. `0.3.17` proved it and `0.3.28` carries it.
- [ ] First run from a clean install with no checkout. The dmg path is the closest thing tested.
- [ ] Onboarding under three minutes for a person who has not seen the app.
- [ ] Sidebar survives ten tab switches.
- [ ] `Ctrl+Alt+B` is declared in the manifest and no run has proved the chord.
- [ ] A room per Zen space. Zen stores spaces in its session store, so this is still open.
- [ ] A signed bridge on release Firefox. The Mac guest still uses a working-tree XPI because
      Zen will not swap an unsigned build unless the version rises.
- [ ] Hosted relay across two networks. Every test so far is loopback, LAN or tailnet.
- [ ] A privacy page that states what the relay sees.
- [ ] A first-run flow that survives a browser major update.

### Later

- [ ] M8 Chromium variant. The plan commits to neither M8 job.
- [ ] Voice over WebRTC.
- [ ] Screen share viewer, as a separate tab and never the page-sync path.
- [ ] Rename the room, per-person colours, custom cursors from `cursors-4u.com`, own-cursor
      toggle.

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

Two terminals on this Mac, one command each:

```
node spike/peer.mjs --relay=<ip> --port=8787 --room=lanhour --peer=mac1 --name=Mac1 \
  --host=host --seconds=3660 --probe=60 --out=.runtime/lanhour-mac1.json
```

```
node spike/peer.mjs --relay=<ip> --port=8787 --room=lanhour --peer=mac2 --name=Mac2 \
  --host=host --seconds=3660 --probe=60 --out=.runtime/lanhour-mac2.json
```

Each prints `[peer] joined ws://<ip>:8787/room room=lanhour peer=mac1`. Both host pages must
read four peers before the window starts. If a page reads three, stop and fix that first,
because a count that is wrong at the start is not a result at the end.

`--seconds=3660` gives a minute of margin so the peers do not leave before the host page does.
`--probe=60` reads the relay table from the Mac once a minute, which is the witness beside the
page's own sample.

### 4. Start the window at a whole minute

Note the UTC start. The 13 November run used 18:30:02 UTC, and a whole minute makes every table
row easy to line up afterwards.

### 5. Drive the room from the host page

One person drives, and the marks are fixed so a later reader can compare windows:

| At | Act |
| --- | --- |
| 00:05 | Scroll the host page to 0.2 |
| 00:20 | Scroll to 0.6 |
| 00:40 | Scroll to 0.35 |
| 00:55 | Scroll to 0.2 |
| 00:58 | Media annexe: open the clip on the host page, pause at 30 s, seek to 50 s |

Do not do anything else on that page. A second tab on the same room makes the presence numbers
about the tab and not the room.

### 6. Read the relay table once a minute

On the Windows box, in a second terminal:

```
curl -s http://127.0.0.1:8787/stats
```

The `rooms.lanhour` count must read 4 at every read. Write the minute and the count in a column.
A 3 on any minute names the drop, and the hour then has a finding even if everything else
passes.

### 7. Stop at 60:00

`peer.mjs` writes its journal on its own timer, on `Ctrl+C`, or on `SIGTERM`. Let it write. Then
close the two Windows pages.

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
- Both Mac peers followed all four scroll marks.
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
3. **Add Movy next in the site matrix.** Two sites, one of them a plain `<video>`, is the
   shortest path to the M2b done-when.
4. **Take one measurement per claim.** The plan's numbers section asks for p95 drift, seeks per
   ten minutes and relay bytes. A run that reports "it felt fine" closes nothing.
5. **Rejoin seek against a site that restores its own mark.** Cinecat does not, and a check
   against it proves the page and not the room.

## Files that change for this

- `core/sync.mjs`: the expected position, `sendHostMedia`, and the frame handoff.
- `core/clock.mjs`: which sample wins.
- `core/browser-entry.mjs`: what a film report carries and what the room passes on.
- `core/media-relay.mjs`: `RemoteMediaSync`, the first-frame seed and the sign-off comparison.
- `bridge/content.js` and `bridge/background.js`: the frame handoff and the room channel.
- `bridge/panel/room.js`: the panel line that shows the drift.
- `scripts/check-media-loopback.mjs`: the one-machine lane.
- `spike/peer.mjs`, `spike/relay.js` and `spike/README.md`: the LAN hour.
- `.runtime/`: journals and profiles. Not committed.
