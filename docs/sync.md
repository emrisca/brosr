# What syncs: layers, protocol and input

Part of the [Brosr design index](README.md).

## What syncs, and at what fidelity

Five layers. Each one is independent, so a page can use layers 0 and 3 while ignoring 4.

| Layer | What moves | Mechanism | Breaks when |
| --- | --- | --- | --- |
| 0 Presence | Name, colour, cursor position, focus, idle | 30 Hz cursor messages, coalesced | Never. It is the one layer that always works |
| 1 Navigation | Tab offers, URL, back and forward | A person hosting a tab publishes it. A peer opens a copy from the landing page, and that copy follows the tab | A page needs a POST body or a login redirect chain |
| 2 View | Viewport fingerprint (scrolling stays local) | Viewport size and DPR check (> 5% layout mismatch warning) | The two window sizes differ enough to change the layout |
| 3 Media | Playhead, play and pause, rate, volume | A site adapter over `HTMLMediaElement` or the YouTube player | DRM, ads, live streams |
| 4 Room apps | Canvas strokes, Notes edits, Chess moves | App messages that carry data, never DOM events | A page needs raw pointer or keyboard fidelity |

**Layer 0 detail.** A cursor stays inside the room tab. A plain tab carries the film and
nothing else, so a person's mouse never appears on a page the room did not open. Cross-tab
cursors were removed on 15 November 2026 because a cursor on a YouTube tab made no sense
to the people testing it.

**Layer 1 detail.** A shared tab is an offer, never an instruction. Any member may share a tab, and
the person who shares it hosts it. Only that host changes the active video or source URL, while
everyone holding the tab may play, pause and seek. The landing page's Live tabs section is the single
source of truth, grouped dynamically under each person's name. A peer opens a copy by clicking a row,
and closing that copy leaves the sync without closing anyone else's tab. A tab that someone shares
reaches the room as an offer, and no other browser opens a copy of it by itself: landing tiles, Watch
directory links, `_blank` links, middle-clicks, and new-tab shortcuts (`Ctrl/Meta+T`, `Ctrl/Meta+N`)
all stay local. A joined row says Synced and offers Stop (which detaches the copy and leaves the tab
open) and Focus. A row whose tab has a player shows Playing/Paused and updates titles in place on SPA
video changes. Anyone holding the tab can drive playback from their player or directly from inline
`-10s` / Play/Pause / `+10s` controls on local and joined Live tabs rows. Joining a tab after it is
already open requests live playback state from the tab host (with a background cached-state fallback
and `brosr:media-mounted` re-apply for late-mounting cross-origin player iframes and peer-to-peer
joins). A copy this browser stopped stays in the room panel's stopped list, the panel header shows
how many are waiting, and Resume puts that same tab back in the room without opening a second copy.
For pages where state sync is not possible, see [tab-share-plan.md](tab-share-plan.md).

**Layer 2 detail.** Scrolling is kept local in both directions. Host scrolling is not
mirrored to guests, and a peer's wheel or scroll is not relayed to the host or to any other
peer, so each person scrolls independently. Viewport fingerprints (`innerWidth`, `innerHeight`,
`devicePixelRatio`, and `scrollWidth`) still detect layout mismatches (> 5% drift) so the overlay
and the panel describe the same layout.

The host can still name the sites where the cursor and scroll views appear. No list means every
site, and an empty list means none. These lists never open a path for a click or a key.

**Layer 4 detail.** Canvas, Notes and Chess keep their state in application messages. A Canvas
stroke travels as a vector path with its brush and layer, a Notes edit travels as a text operation,
and a Chess move travels as a discrete move. No raw click, drag or keystroke is replayed into
another browser, so two people editing at once cannot inject a duplicate cursor or key. The room
still keeps pointer presence for the cursor overlay, but presence is display state and never input.


## Protocol

One binary frame format, sealed end to end, one WebSocket per peer. Every message carries a
room time in milliseconds, so a receiver can schedule a replay instead of applying it late.

| Message | From | Payload |
| --- | --- | --- |
| `hello` / `welcome` | both | Peer id, name, colour, protocol version, capability flags |
| `snapshot` | host | Tabs, active tab, URL, media state, `mediaRev`, peers, sequence (host-authenticated) |
| `nav` | host | Tab id, URL, history action (host-authenticated; never force-navigates the room tab) |
| `view` | any | Tab id, page URL, viewport fingerprint (layout-mismatch check only; never scrolls) |
| `media` | host or any peer holding the tab | Media id, action, position ms, rate, `rev`, room time |
| `input` | none | Deprecated. A receiver refuses it with `input-disabled`, and no DOM event is replayed |
| `app` | any | Page/room app envelope (`tabs`, `align.offset`, sealed `brosr-panel`, room apps) |
| `presence` | any | Cursor point, down state, focused field, idle flag |
| `scrollpolicy` | host | Allowed sites for the cursor and scroll views, or null for every site |
| `ping` / `pong` | both | Four timestamps for clock offset and round trip |
| `bye` | any | Reason |

**Clock.** The host sets the room time base when it creates the room. Each peer measures the
offset with the four-timestamp exchange, keeps the sample with the smallest round trip, and
re-measures every 30 seconds. Everything time-sensitive uses room time, never the local wall
clock, because two machines never agree on the hour.

**Media policy.** The host is the timekeeper, and a peer computes the drift between its own
playhead and the host's expected playhead.

- Drift above 300 ms: seek once. A film tab whose target sits outside its buffered range pauses, waits up to 2.5 s for the range, then seeks and resumes. It reports the wait as buffering so the panel can show it locally, and other peers keep playing.
- Drift between 40 ms and 300 ms: nudge `playbackRate` between 0.95 and 1.05 until the drift closes,
  then restore 1.0. This is inaudible and avoids the stutter a seek causes. `RemoteMediaSync`
  tracks active and recent nudge/reset rates so delayed async `ratechange` events from YouTube
  or HLS players cannot leak back as a new room rate and compound into slow motion, and every
  explicit seek clears any active nudge back to the room rate.
- Drift under 40 ms: do nothing.
- Buffering peer: buffering is local. Only that peer shows the wait and holds its own player.
  Other peers keep playing unless someone explicitly pauses. A peer that falls behind seeks back to
  the room playhead when its buffer recovers, so a slow connection never freezes the room.
- Ad playing on the host: media sync pauses until the ad ends, then the room resyncs at the
  first frame. Per-user ad targeting makes any other choice worse.
- Playhead and seek authority: media actions carry a monotonic Lamport `rev` (propagated on
  `snapshot` so a late-joining peer starts on the current revision). Active scrubber drags
  (`seeking`) ignore routine ticks while still yielding to strictly newer remote explicit seeks,
  and multi-peer hand-offs bump `rev` cleanly without dropping as stale.
- A peer's play, pause or rate act applies at the host's current playhead (tracked via
  `hostKnownMedia` even when the host's `<video>` lives in a separate film tab), not at the
  peer's lagged playhead. A seek carries a new position, so a seek uses that peer's position.
The adapter identifies media by a stable key derived from the element's `src`, not by DOM
index. A re-render then does not detach the room from the player.


The spike ran this policy over a link with 120 ms each way and 5 percent loss. The peer made
one seek, settled in 4.0 s, and then held 18 ms p95.

**Input batches.** The bridge coalesces pointer moves to 30 Hz and drops one when a newer move
exists. It never drops down and up. Keys keep their order and carry modifier state. A batch
cannot exceed 16 KB, and the bridge splits a larger one. Replay treats each batch as atomic
per peer.

## Room apps

Canvas, Notes and Chess run their own protocol inside the `app` envelope. Each app sends the
smallest fact that changes its document, and each receiver applies that fact to its own copy.

- Canvas sends a stroke as a vector path with its brush, width, opacity and layer. A late joiner
  asks for the document and replays the stored strokes.
- Notes sends a text operation against the shared document.
- Chess sends one move, from square to square, with the turn it answers.

The room never mirrors a DOM event into another browser. A click, a drag and a keystroke stay in
the browser where they happened, so an app cannot inject a second cursor or type a key twice.
Pointer presence still travels for the cursor overlay, but presence is display state and never
input.

The protocol keeps the `input` message type only so an older peer receives a clear refusal. A
receiver answers `input-disabled` and drops the frame.
