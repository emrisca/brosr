# What syncs: layers, protocol and input

Part of the [Brosr design index](README.md).

## What syncs, and at what fidelity

Five layers. Each one is independent, so a page can use layers 0 and 3 while ignoring 4.

| Layer | What moves | Mechanism | Breaks when |
| --- | --- | --- | --- |
| 0 Presence | Name, colour, cursor position, focus, idle | 30 Hz cursor messages, coalesced | Never. It is the one layer that always works |
| 1 Navigation | Tab set, URL, back and forward | The host broadcasts the URL. Each peer navigates its own tab | A page needs a POST body or a login redirect chain |
| 2 View | Scroll offset, zoom | Scroll ratio plus a viewport fingerprint | The two window sizes differ enough to change the layout |
| 3 Media | Playhead, play and pause, rate, volume | A site adapter over `HTMLMediaElement` or the YouTube player | DRM, ads, live streams |
| 4 Input | Pointer sequence, keys, wheel, text | Event relay through the actuator | The page needs pointer lock, or renders per user |

**Layer 0 detail.** A cursor stays inside the room tab. A plain tab carries the film and
nothing else, so a person's mouse never appears on a page the room did not open. Cross-tab
cursors were removed on 15 November 2026 because a cursor on a YouTube tab made no sense
to the people testing it.

**Layer 2 detail.** Scroll travels as a ratio of document height, and the receiver clamps it
to its own maximum. The receiver sends back a fingerprint of `innerWidth`, `innerHeight`,
`devicePixelRatio` and `scrollWidth`. When the fingerprint differs by more than 5%, the room
shows a notice. The layouts are not the same, so a relayed click may hit a different element.

**Layer 4 detail.** Pointer positions travel in two forms. Page coordinates for ordinary
pages, and canvas-relative fractions when the event target sits inside a `<canvas>`. The
second form makes games work across different window sizes, because the game's coordinate
space is the canvas and not the window.


## Protocol

One binary frame format, sealed end to end, one WebSocket per peer. Every message carries a
room time in milliseconds, so a receiver can schedule a replay instead of applying it late.

| Message | From | Payload |
| --- | --- | --- |
| `hello` / `welcome` | both | Peer id, name, colour, protocol version, capability flags |
| `snapshot` | host | Tabs, active tab, URL, scroll, media state, peers, sequence |
| `nav` | host | Tab id, URL, history action |
| `view` | any | Tab id, scroll ratio, viewport fingerprint |
| `media` | host | Media id, action, position ms, room time |
| `input` | any | Tab id, batch of pointer, key, wheel or text records |
| `presence` | any | Cursor point, down state, focused field, idle flag |
| `control` | host | Grant or revoke of input rights for a peer |
| `ping` / `pong` | both | Four timestamps for clock offset and round trip |
| `bye` | any | Reason |

**Clock.** The host sets the room time base when it creates the room. Each peer measures the
offset with the four-timestamp exchange, keeps the sample with the smallest round trip, and
re-measures every 30 seconds. Everything time-sensitive uses room time, never the local wall
clock, because two machines never agree on the hour.

**Media policy.** The host is the timekeeper, and a peer computes the drift between its own
playhead and the host's expected playhead.

- Drift above 300 ms: seek once.
- Drift between 40 ms and 300 ms: nudge `playbackRate` to 1.00 ± 0.05 until the drift closes,
  then restore 1.0. This is inaudible and avoids the stutter a seek causes.
- Drift under 40 ms: do nothing.
- Buffering peer: the room pauses for everyone, or the room lets the peer fall behind and
  resync. v1 pauses the room, because people expect the film to wait.
- Ad playing on the host: media sync pauses until the ad ends, then the room resyncs at the
  first frame. Per-user ad targeting makes any other choice worse.
-The adapter identifies media by a stable key derived from the element's `src`, not by DOM
index. A re-render then does not detach the room from the player.

The spike ran this policy over a link with 120 ms each way and 5 percent loss. The peer made
one seek, settled in 4.0 s, and then held 18 ms p95.

**Input batches.** The bridge coalesces pointer moves to 30 Hz and drops one when a newer move
exists. It never drops down and up. Keys keep their order and carry modifier state. A batch
cannot exceed 16 KB, and the bridge splits a larger one. Replay treats each batch as atomic
per peer.

## Input, trusted and synthetic

A DOM event made with `new MouseEvent(...)` and `dispatchEvent` has `isTrusted: false`.
Firefox runs no default action for an untrusted key event, so it does not type. Many canvas
games do not care, because they read `clientX`, `clientY` and `code` from their own listeners.
Forms, native controls and sites that check the flag do care.

| Method | Trusted | Notes |
| --- | --- | --- |
| `dispatchEvent` with constructed events | No | Works for canvas games, custom handlers and most single-page apps. Always available |
| Native value setter plus `input` event | No, but accurate | Mirrors typing into a text field the way React and Vue expect |
| BiDi `input.performActions` through the remote agent | Yes | The browser's input pipeline. It needs Firefox started with `--remote-debugging-port` |

**v1 uses the synthetic actuator.** It covers cursors, scroll, media, canvas games and typing
through the value setter. It needs nothing beyond the extension, so it works on any Firefox.

**M7 adds the trusted actuator.** The helper starts Firefox with `--remote-debugging-port`
on a random loopback port, opens one WebDriver BiDi session, and reads the port Firefox
announces on stdout. The bridge sends hover, press, release, key and text actions to the
helper over a loopback socket with a one-time token. The helper translates them into
`input.performActions` for the tab's browsing context.

Three rules for that channel:

1. Bind to `127.0.0.1` only, on a random port, with a token the page cannot read.
2. Close the session when the last grant ends, and on app exit. A remote agent left open is a
   browser control channel without a guard.
3. Refuse to start the agent at all when a room has no trusted-input grant. The default state
   of a room has no such channel.

M0 measured whether a page sees `isTrusted: true` from a BiDi key action, and it does. The
spike also ran the channel itself. A grant started an agent on `127.0.0.1` with a random port
and a token. A request without the token got a 401, and the request with it typed a trusted
character. Revoking the grant closed the socket. The plan keeps both paths behind the
actuator interface either way.

Two things to design around:

- Clicking by coordinates is fragile across layouts. The bridge resolves the element under the
  sender's point, sends its CSS path plus a text fingerprint, and the receiver clicks that
  element's centre. If the path does not resolve uniquely, the receiver drops the click and
  the room shows "could not target element". A dropped click beats a wrong one on a page with
  a button that does something irreversible.
- Element paths are not the same as viewport coordinates. A page with a sticky header moves
  the same element under a different point, so the element path wins whenever it resolves.
