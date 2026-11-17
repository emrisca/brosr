# What is left, 16 November 2026

This is the working list beside [plan.md](plan.md). The plan holds the design and the
per-milestone done-when. This file holds what is still open, what was measured today, and what
to do next. It is not a replacement for the plan and it is not a status claim about shipping.

## Where things stand today

- Release `v0.3.13` is published from the Windows side. The workflow built all three platforms
  and `latest.json` is signed for `darwin-aarch64`, `darwin-x86_64` and `windows-x86_64`.
- This Mac now runs `Brosr 0.3.13` from that release, installed clean over `0.3.10`. The ad hoc
  signature verifies, the bundle is thin arm64, and the app launches.
- The version stamp is written in `app/src/App.tsx` and is not in any release yet. It reads
  `getVersion()` and draws bottom right. The `0.3.13` dmg predates it, so that window cannot
  show it.
- The retest guest is in `retest-0390` as `guest-2e76`, loading the working-tree bridge, whose
  `bridge/manifest.json` reads `0.4.3`, the same as the host.
- The live retest runs in room `retest-0390` on the Windows relay at
  `http://[fd7a:115c:a1e0::e035:dc19]:8788/`. The host is paused on the Cinecat film and the guest
  is `guest-2e76`. The older `retest-0369` room on 8793 is empty and can be ignored.

### The media retest today

What passed, measured on this Mac at about 15:35 local time:

| Check | Result |
| --- | --- |
| Guest joined the room | `role=peer`, `peerId=guest-b1f1`, room name `Retest 0369` |
| Guest opened the host film page | `https://cinecat.eu/media/tmdb-movie-969681-spider-man-brand-new-day`, title `Spider-Man: Brand New Day` |
| Player found in the guest tab | yes, one `<video>` element |
| Guest film key | `page:https://cinecat.eu/media/tmdb-movie-969681-spider-man-brand-new-day` |
| Host film key from the last Windows report | identical string |
| Media frames sent from the guest tab | 3 |

So a key mismatch is ruled out for this film. The guest names the same film the Windows host
named. That was the cheapest explanation for "the Mac joins but the film does not follow".

### The cross-machine half, 15:55 to 15:59

Windows opened `retest-0390` on relay 8788 with the film paused at 120 s. This Mac joined as
`guest-2e76` and opened the same URL. I sampled the room tab and the film tab every 3 s, 141
unique samples over 4 min 54 s. Two samplers ran by mistake for part of the window, so these
counts are deduplicated by timestamp. The counters live on `document.documentElement.dataset`, `brosr` on the
room tab and `brosrRelay` on the film tab, which is why an earlier read of `document.body` came
back empty.

| Reading | Value |
| --- | --- |
| Room peers | 2 in all 141 samples |
| `rtt` | 6 to 12 ms |
| `applies` | 82 to 1,258 |
| `sends` | 1,359 to 1,654 |
| Guest key | identical to `host_key` |
| Paused on the host mark | 55 samples at 120.000 s, drift 0 except one -0.221 s |
| About a minute of play | guest went 120 to 180 |
| Host seek of two minutes | 179.916 to 300.140 at 15:58:24, guest followed inside one sample |
| Resume | guest played on to 336.7 s |
| Drift on the 79 moving samples | median 0.626 s, p95 1.252 s, max 1.317 s, 13 within 0.25 s |
| Correction seeks | 17 in about three minutes of playback, drift -1.0 to -1.32 s |
| `brosrRelay.playing` | read `False` in all 141 samples while the video advanced |

So the half that kept failing now works. The guest took the host's paused mark with zero drift,
followed the play, followed a two minute seek and kept playing. That is the first cross-machine
media pass in this project.

It does not meet the budget. The plan asks for 250 ms p95 and at most one seek per ten minutes.
This run read 1.252 s p95 and 17 seeks in about three minutes.

### The host side of the same window

Windows sent its own timeline. Play at `23:57:24.132Z` from 120.120, pause at `23:58:24.395Z` at
180.140, one explicit seek to 300.140 at `23:58:24.397Z`, resume at 300.260 at `23:58:25.307Z`.
Its counters for the window read `seeks` 0, `nudges` 0, `corrections` 0, `stuckSeeks` 0,
`mediaEcho` 0, `relayed` 0, `film_applies` 0, no buffering, `in_sync` true. It paused at
435.689333 and left the tab live.

So the host never seeked, stalled, or applied a guest action. All 17 correction seeks were the
guest correcting itself, which removes the relay and the host as explanations.

### What the code says about those seeks

`core/media-relay.mjs` picks its seek limit by state. It is `RELAY_NUDGE_SECONDS` 0.25 while
paused or on the first frame, and `RELAY_DRIFT_SECONDS` 1 while playing. A five percent nudge is
the middle tier, and a seek needs 700 ms of settle time on an element that is not already seeking.

Every seek row read drift between -1.0 and -1.32 s, so each one cleared the 1 s playing limit,
seeked, landed, then fell behind again. That is 17 seeks over about 180 s of playback, one every
ten seconds on average. A systematic offset looks more likely than jitter, and one candidate is in
the room tab's own reading: `clockOffset` read 1811 ms early in the session and 1931 ms at 16:55.
A 90 s sample held at 1931 ms with rtt flat at 3 ms, so the offset is large and steady rather
than noisy. The expected position is extrapolated from the anchor through that offset, so if the estimate enters that
arithmetic instead of cancelling out, the error is a fixed number of seconds rather than jitter.
Not yet confirmed. The next read is how the anchor and `clockOffset` meet inside
`RemoteMediaSync`.

The paired rows line up to about a second, not finer. Each row costs three round trips to the
page, so a row's timestamp runs ahead of the video it reports, and the two machines keep separate
wall clocks. The seek act still pairs cleanly: the host moved to 300.140 at `23:58:24.397Z` and
the guest read 300.140 in the same second. The play act does not pair as cleanly, because the
guest already read 121.018 in the row stamped a second before the host's play. That gap is a
measurement limit, not an applied frame ahead of its time.

Separately, the `playing` field of the same dataset read `False` in all 141 samples while the
video advanced from 120 to 422, so that field is stale on its own and should not be trusted as a
playback indicator.

### Why syncing was slow, measured

Three causes, all dealt with today:

- `.runtime` was synced. It held four Zen browser profiles, 7,699 files and 1.8 GB, and rewrote
  about eleven files a minute. That forced a rescan every ten to thirty seconds. `brosr/.stignore`
  now carries `/.runtime`.
- A second `Syncthing.app` ran beside the Homebrew daemon and logged `Failed to acquire lock`
  every ten seconds. The app is quit and the daemon stayed up.
- Eleven `delete dir: directory has been deleted on a remote device but is not empty` errors sat
  in the kilgharrah folder under `.agents/skills/*`. `.agents` is now ignored and the error list
  is empty.

The brosr share is now 3,690 files and 873 MB, down from 11,311 files and 2.82 GB, with
`pullErrors` 0 and no error list.

A fresh push of one 200 MB file to the peer, with outbound bytes sampled every 0.5 s:

| Reading | Value |
| --- | --- |
| Elapsed | 74.95 s |
| Moved | 209,747,694 bytes |
| Average over the window | 2,733 KB/s |
| Median of the active samples | 3,572 KB/s |
| Peak sample | 12,269 KB/s |

The probe directory was removed and the folder went back to `idle`, `needFiles` 0.

That average is about fourteen times the 195 KB/s of the earlier 1.87 GB session. The link is not
the limit. It is a direct LAN `tcp-client`, TLS 1.3, `isLocal` true, with `maxSendKbps` and
`maxRecvKbps` both 0, and the peak shows far more headroom than the average used. Note the
caveat: one 200 MB file is the best case for this share, so a run of small files will read lower.
What is still unmeasured is the pull direction from Windows, and a transfer taken while a live
browser profile sits inside the share.

## Open in the plan

### Media

- [x] Mac guest following a Windows host. Passed at 15:55 in `retest-0390`, numbers above. What
      is left is quality, not reach: drift p95 1.25 s and 17 correction seeks in about three
      minutes.
- [ ] Rejoin seek. The first applied frame now seeks when the gap is over 0.25 s. Never run
      against a host mark Cinecat does not restore by itself.
- [ ] Three-peer run, and a 40 minute film. M2 done-when asks for 250 ms p95 and at most one
      seek per ten minutes.
- [ ] One deliberate 600 ms delay, to prove it causes one seek rather than a loop.
- [ ] Cinecat cross-machine. The 16 November window was two browsers on one machine.
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
- [ ] Watch tile copy still says `Soon` for a path that now plays. The list and the tile
      disagree.

### Room, relay and reconnect

- [ ] M1 done-when: four peers on one LAN under 80 ms p95 for an hour. Two peers for 420 s was
      the longest window, at 6 ms p95.
- [ ] Host migration after the host closes its lid, on a live room rather than in the suite.
- [ ] A live Zen run with the seal on, after a relay restart, with every peer back on the same
      scroll.
- [ ] The axum relay serves no range requests. A seeking clip still needs the Node relay.
- [ ] Site toggle with a 15 s dwell. The 21:57 window is invalid because the guest browser
      restarted inside it.
- [ ] The 96 px cursor gate. Changed but never measured on a live animation.
- [ ] A cursor on a Cinecat page. The site in a presence frame is the tab under the pointer, so
      a count on the room tab says nothing about the film tab.

### Input and grants

- [ ] A two-machine canvas game, ten minutes, no visible desync. Both presses so far were on
      one machine.
- [ ] Wheel events through the relay.
- [ ] Pointer lock, which is local by design and needs the refusal written down.
- [ ] The grant UI in the panel end to end: grant a peer, relay a click, revoke, and show the
      bar in both places.

### App, install and onboarding

- [ ] The version stamp in a built release. It needs a `0.3.14` cut after the `App.tsx` change.
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

## Suggestions, in the order I would take them

1. **Finish the media retest before changing any media code.** One host, one guest, one paused
   mark. Without that reading every later change is a guess. The guest is already sitting in
   the room.
2. **Put the media state on the panel.** Done on 17 November and measured in the real toolbar
   popup, not only in a tab. The Watch card carries one line: the film, the frames this
   browser's film tab applied, the drift on the last frame, and the gap between this tab and
   the room. The reading comes from the film tab through the background page, so a person can
   send it with no BiDi session on their machine. `scripts/check-panel-popup.mjs` opened a
   window at 360x408 and read `127.0.0.1 · 0 applied · 0.00 s from the room` with the footer
   ending at 397 and no sideways scroll. The read needed a promise from the film page: a bare
   object is not an answer in Gecko, so the page returned `undefined` and the panel line stayed
   empty until it did.
3. **Cut `0.3.14` with the version stamp** once the retest is done. The stamp is the only way a
   person can tell which build they are on, and that was the complaint that started this.Cut on 16 November from the Windows side as `1676127`, and the tree now reads `0.3.17`.
4. **Add a loopback two-peer media check** under `scripts/` that opens a host film and a guest
   film on one machine and fails when `applies` stays 0 or drift passes 1 s. It would have
   caught a broken apply path without Windows in the room. Done on 17 November as
   `scripts/check-media-loopback.mjs`: two browsers, a room tab and a film tab each, one clip
   on its own relay port. A first run read 64 applies at the guest, a median drift of 0.001 s,
   p95 0.022 s, max 0.022 s, and a pause and an 18 s seek both inside a second.
5. **Take one measurement per claim.** The plan's numbers section asks for p95 drift, seeks per
   ten minutes and relay bytes. A retest that reports "it felt fine" does not close a done-when.
6. **Keep the Cinecat row in the matrix and add Movy next.** Two sites, one of them a plain
   `<video>`, is the shortest path to the M2b done-when.

## The next live test, step by step

1. Windows opens a host room and sends the join link with its key.
2. Windows opens the Cinecat film, pauses at a mark the site will not restore, and reports the
   URL and the position.
3. Mac joins as `guest-b1f1` and opens the same URL in its film tab.
4. Read `key`, `sends`, `applies` and `last` in the guest film tab every 3 s. A key that
   differs from the host URL is a fail before any playhead is compared.
5. Windows plays for 60 s, pauses, seeks about two minutes forward, then resumes. Read the
   guest playhead beside the host position after each action.
6. Record drift at each step and the seek count. One seek per ten minutes is the budget.

## Files that change for this

- `core/media-relay.mjs`: `RemoteMediaSync`, the first-frame seed and the sign-off comparison.
- `bridge/content.js` and `bridge/background.js`: the frame handoff and the room channel.
- `bridge/panel/room.js`: the panel that would show the media reading.
- `app/src/App.tsx`: the version stamp.
- `.runtime/retest/`: the guest supervisor, hub and probes. Not committed.
