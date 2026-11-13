# Brosr, a multi-user browser

A room of people loads the same page, and each person's actions land on everyone else's copy
of it. No screen capture, no recording, no video stream. Two people press play on the same
video and it stays in step. Both cursors are visible on the page. Either of them can drive a
browser game. The browser is Firefox, so full uBlock Origin runs.

Short answer to "is this possible": yes, for pages whose state can be reproduced on another
machine, which is most pages people actually share. No, for anything that needs identical
pixels. Section 2 states the line.

Status: **M0 passed, and the M1 core runs.** The spike and its results live in
[spike/](spike/), and the shared code lives in [core/](core/). Nothing ships yet.

## 1. The idea, and the thing it must not become

The request is to invite someone into the same browser window. Their mouse, keyboard, scroll,
navigation and video controls then show up in your window as if they sat at your desk. The
browser must keep its extensions, including the ad blocker people already trust.

Three existing products look close and are not this:

| Product | What it does | Why it is not this |
| --- | --- | --- |
| Screen share (Discord, Meet, Teams) | Sends encoded frames of one screen | Costs bandwidth that a bad link cannot pay. Text turns to mush, and only the sharer can act. |
| Cobrowse (Cobrowse.io, Surfly) | A reverse proxy serves one rewritten page to everyone | Needs a server that terminates TLS for every site. It is a hosted service, not a browser. |
| Watch-together sites (Kosmi, Watch2Gether, Syncplay) | Pipe a player and a chat room into one page | Watches video. Cannot drive a game or show a cursor on an arbitrary page. |

The honest competition for the user's actual complaint is a screen share that fails on a bad
link. Against that, Brosr moves about 10 KB/s instead of 2 Mbps. Its cost is that it cannot
show a page it cannot reproduce.

The plan leaves out streaming pixels as a fallback, voice chat, and remote cookie or password
sharing. It also does not run on top of a browser the app did not start.

## 2. What is possible, per use case

A web page is not a document. Two machines that load the same URL get different ads,
different feeds, different A/B variants, different login state and often a different DOM. So
Brosr never copies the page. It copies the *intent* that produced the page and lets each
machine render its own.

| Use case | Works? | Why |
| --- | --- | --- |
| Watch a YouTube video together | Yes | One video element, one clock. Both sides set `currentTime` and call `play()`. The peer adjusts for drift against the host. |
| Read or scroll a long article together | Yes | URL plus scroll offset plus live cursors. |
| Two-player browser game on one page | Yes, when the page listens for ordinary DOM events | Input replay at the event level. A deterministic page stays in step because the room copies no page state. |
| Type into a form for someone | Yes, with the BiDi actuator | The trusted path exists in Firefox through the remote agent. Section 8 covers it. |
| Netflix, Disney+, Prime Video | No | The DRM layer controls the media pipeline. Script calls on `currentTime` fail. |
| Live streams (Twitch, YouTube Live) | Partly | Play and pause sync. There is no shared playhead to seek to. |
| A page where only one person logs in | No | Auth is per machine by design. Each person signs in on their own copy. |
| A page that checks `event.isTrusted` | Yes, with the BiDi actuator | The trusted actuator enters through the browser's input pipeline. |

## 3. The engine is Firefox, because of the extension list

The extension requirement is the one that cannot be negotiated, so it decides the engine.

| Engine | Full uBlock Origin | Why |
| --- | --- | --- |
| **Firefox** | **Yes** | Mozilla keeps both manifest versions, and full uBlock Origin is Manifest V2 |
| Chrome, Edge, Brave | No | Chrome 138 disabled MV2 for all users, Chrome 139 removed the last policy, and the store removed the remaining MV2 items on 31 August 2026. Only uBlock Origin Lite runs |
| WebView2 (a Tauri window) | No | The Edge runtime follows the same MV2 end, and its extension support loads unpacked folders with no toolbar |
| WKWebView (a Tauri window) | No | It runs Safari extensions, not Firefox or Chrome ones |
| A Gecko build of our own | Yes, in theory | Mozilla ended desktop embedding. A fork is years of work |

**Decision: the browser is Firefox, and the app starts it with a Brosr profile.** The
launcher, the bridge extension and the relay are ours. The rendering, tabs, address bar,
add-on manager and updates belong to Firefox.

Two consequences follow, and both shape the rest of this document.

1. **The app no longer draws browser chrome.** Firefox draws the tabs and the address bar.
   Brosr adds a sidebar, a profile, an extension and a room. That removes a milestone.
2. **Trusted input needs a second channel.** Firefox has no `chrome.debugger` equivalent, so
   the extension alone cannot type into a page. The browser's remote agent provides the
   trusted path, and Section 8 makes it optional so v1 can ship without it.

A Chromium variant stays possible. It gives up full uBlock Origin, so it is M8, and the plan
does not pretend the two are equal.

### 3.1 Firefox against Chromium, side by side

Both builds share the launcher, the protocol, the relay and the media policy. They differ in
three places: the engine, the trusted actuator, and the extension catalogue.

| Question | Firefox build | Chromium build |
| --- | --- | --- |
| Full uBlock Origin | Yes, and every other MV2 add-on | No. Chromium retired Manifest V2 |
| Other extensions | The Firefox add-on catalogue | The Chrome Web Store catalogue |
| Trusted actuator | BiDi through the launcher, M7 | `chrome.debugger` in the bridge, with M8 |
| Trusted input in v1 | Synthetic events only | Synthetic events plus the debugger |
| Visible cost of a grant | The sidebar indicator | The browser's debug bar for the whole grant |
| Bridge install | Signed XPI, or a temporary add-on in development | Unpacked folder with developer mode on |
| Automatic bridge install | `policies.json` in a shipped Firefox | CDP `Extensions.loadUnpacked`, or a store listing |
| Profile start | `--profile` and `--no-remote` beside the daily browser | `--user-data-dir`, one process per profile |
| Background lifetime | Manifest V2 page, alive all session | Manifest V3 worker, held by the room socket |
| Room UI | `sidebar_action` | `chrome.sidePanel` |
| Loading the bridge in tests | WebDriver and geckodriver. Playwright cannot | Playwright, in its bundled Chromium |
| Remote protocol | BiDi | CDP |
| Media control and DRM | The same adapters and the same refusals | The same adapters and the same refusals |

**What the Firefox build loses.**

- Trusted typing arrives at M7, not in v1. Until then a relayed click cannot press a
  control that checks `isTrusted`, and pointer lock stays local.
- Chrome-only extensions. Some workplace tools ship for Chromium alone.
- A fast test loop for the extension. Playwright cannot load the bridge, so those tests run
  through WebDriver and take longer to write.
- Reach. Some people will not install a second browser to join a room.
- Per-tab control. Firefox has no per-tab debugger, so the remote agent is browser-wide and the
  grant model has to constrain it.

**What the Chromium build loses.**

- Full uBlock Origin, and every other MV2 add-on. uBlock Origin Lite is the ceiling.
- A quiet grant. The debug bar shows for as long as a grant is active.
- A small permission set. `debugger` reaches any tab and bypasses `host_permissions`, so our
  allowlist is the only guard.
- Simple loading. `--load-extension` left branded Chrome in 137.
- Simple keepalive. MV3 workers sleep when idle, so the room socket has to hold one open.

**Where the two are equal.** The protocol, the relay, the clock and the media policy do not
change. Neither do the cursor overlay, the allowlists, the profile isolation or the refusal to
move credentials. That is why the Chromium build stays cheap: one sync core, two thin adapters.

**Cost of keeping both.** One extra bridge, about two to three weeks, plus a second test
harness and a second install story. The launcher, the relay and the protocol stay as they are.

## 4. Extensions, in detail

### 4.1 Full uBlock Origin still works on Firefox

That is the reason for the engine choice, so the mechanics belong in the plan.

Mozilla supports Manifest V2 and Manifest V3 side by side. Full uBlock Origin is MV2 and
stays available on addons.mozilla.org. Its MV3 sibling, uBlock Origin Lite, also works. A
Firefox room profile can therefore run the blocker the person already uses, with the same
filter lists and the same options page.

Chromium has no such option. Chrome 138 disabled MV2 for all users on all channels on 24 July
2025. Chrome 139 removed the `ExtensionManifestV2Availability` enterprise policy. The store
removed the remaining MV2 items on 31 August 2026. Reinstalling full uBlock Origin cannot
work there, and the plan does not suggest it.

### 4.2 The bridge is the second extension

| Build | How it installs | Notes |
| --- | --- | --- |
| Development | `about:debugging` temporary add-on | It disappears when Firefox restarts, so every dev run reloads it |
| Release | Signed unlisted XPI from AMO | Release and Beta Firefox require a Mozilla signature. `web-ext sign --channel unlisted` returns a signed XPI in minutes |
| Shipped profile | `policies.json` with `ExtensionSettings` and `force_installed` | It installs with no user action, but the file lives beside the Firefox binary. That needs write access or a shipped Firefox |
| Local testing | Developer Edition or Nightly with `xpinstall.signatures.required` off | Release and Beta have no override, so this is a test-only path |

The bridge declares `browser_specific_settings.gecko.id`, because signing needs a stable id.
Each submission consumes a version number, so the build script bumps it.

The plan never bundles uBlock Origin. It is GPLv3, it is already signed on AMO, and the person
installs it from the add-on page in one click. Bundling adds a licence obligation and a stale
copy to update.

### 4.3 Coexistence with uBlock and with the page

Both extensions inject a content script into every page. Firefox runs each content script in
its own sandbox, so neither can read the other's variables and neither depends on load order.
uBlock cancels requests and the bridge never blocks one, so they do not conflict by design.

Three rules keep it that way:

1. The bridge draws only inside one closed shadow root, pinned to the viewport, with pointer
   events off. It adds no global CSS, no `style` element on the document and no wrapper node.
2. Element targeting skips the bridge's own nodes and any shadow root it did not create. A
   relayed click must not resolve to a cursor.
3. The bridge registers no request filter. If a later feature needs request data, it uses the
   browser's remote agent instead of a second blocker.

### 4.4 What the bridge asks for

`<all_urls>` for content scripts, because a room can be on any page. `tabs` for the tab list.
`storage` for room settings. `sidebar_action` for the room UI. Firefox has no `debugger`
permission, so the trusted actuator does not live in the extension at all. That is a smaller
permission set than the Chromium version of this plan needed, and it is a real advantage.

The browsing data, cookies and logins stay in the room profile. Nothing crosses the relay.

## 5. What syncs, and at what fidelity

Five layers. Each one is independent, so a page can use layers 0 and 3 while ignoring 4.

| Layer | What moves | Mechanism | Breaks when |
| --- | --- | --- | --- |
| 0 Presence | Name, colour, cursor position, focus, idle | 30 Hz cursor messages, coalesced | Never. It is the one layer that always works |
| 1 Navigation | Tab set, URL, back and forward | The host broadcasts the URL. Each peer navigates its own tab | A page needs a POST body or a login redirect chain |
| 2 View | Scroll offset, zoom | Scroll ratio plus a viewport fingerprint | The two window sizes differ enough to change the layout |
| 3 Media | Playhead, play and pause, rate, volume | A site adapter over `HTMLMediaElement` or the YouTube player | DRM, ads, live streams |
| 4 Input | Pointer sequence, keys, wheel, text | Event relay through the actuator | The page needs pointer lock, or renders per user |

**Layer 2 detail.** Scroll travels as a ratio of document height, and the receiver clamps it
to its own maximum. The receiver sends back a fingerprint of `innerWidth`, `innerHeight`,
`devicePixelRatio` and `scrollWidth`. When the fingerprint differs by more than 5%, the room
shows a notice. The layouts are not the same, so a relayed click may hit a different element.

**Layer 4 detail.** Pointer positions travel in two forms. Page coordinates for ordinary
pages, and canvas-relative fractions when the event target sits inside a `<canvas>`. The
second form makes games work across different window sizes, because the game's coordinate
space is the canvas and not the window.

## 6. Architecture

```
+---------------------------------------------------------------+
| Launcher (Tauri v2, React)                                    |
|  lobby | invite link | relay host | profile manager | BiDi     |
+------------------------------+--------------------------------+
                               | starts Firefox with a profile
+------------------------------v--------------------------------+
| Firefox                                                      |
|                                                               |
|  room profile: uBlock Origin, the bridge, anything else      |
|                                                               |
|  tab A ......... room tab                                     |
|    content script: cursors, scroll, media, input capture      |
|  sidebar ....... room UI                                      |
|    members, grants, playback, "Alice has control"              |
|  background page . sync core, sealing, relay client, ordering |
+------------------------------+--------------------------------+
                               | sealed frames
                     +---------v----------+
                     | Relay (axum)       |
                     | LAN in-app, or a   |
                     | hosted instance    |
                     +--------------------+
```

**Four parts.**

1. **Launcher.** Tauri v2 with React 19 and Vite, like the other apps here. It finds Firefox
   and manages the room profile. It starts the browser, writes the invite link, hosts the relay
   for LAN rooms, and shows the lobby. It never renders a page.
2. **Bridge.** A Firefox WebExtension in Manifest V2, so its background page stays alive for
   the length of a room. Content scripts handle the page, a sidebar holds the room UI, and the
   background page holds the sync core, the transport and the sealing.
3. **Remote agent helper.** When the room wants a trusted actuator, the launcher starts Firefox with
   `--remote-debugging-port` and owns one WebDriver BiDi session. The bridge asks the launcher
   for actions over a loopback socket with a one-time token. Section 8 has the detail.
4. **Relay.** One Rust binary with axum. It forwards sealed frames between the members of a
   room and stores nothing.

**Authority.** The room has one host, the person who created it. The host sequences layers 1
and 3, so two people pressing play at once is not a race. Layer 4 has no single authority,
because both players must press a key at the same moment. Each peer numbers its own input
stream, and receivers apply them in per-peer order.

**Late join.** A joiner receives a snapshot: URL, tab list, scroll ratio, media position with
its room timestamp, and the member list with colours. Then it applies the live stream from the
snapshot's sequence number. A rejoining peer resumes the same way, and the relay keeps no
state.

## 7. Protocol

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

## 8. Input, trusted and synthetic

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

**M7 adds the trusted actuator.** The launcher starts Firefox with `--remote-debugging-port`
on a random loopback port, opens one WebDriver BiDi session, and reads the port Firefox
announces on stdout. The bridge sends hover, press, release, key and text actions to the
launcher over a loopback socket with a one-time token. The launcher translates them into
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

## 9. The browser surface we do not draw

Firefox owns the tabs, the address bar, the add-on manager, the downloads and the devtools.
The app owns everything around the room.

- **Room profile.** `%APPDATA%/Brosr/profile` on Windows, the equivalent elsewhere, created by
  the launcher with `-CreateProfile` on first run. The launcher starts it with
  `--profile <path> --no-remote`, which runs a separate instance beside the person's daily
  Firefox. The cost is that logins and add-ons do not carry over, and the app says so during
  onboarding.
- **Sidebar.** `sidebar_action` holds the room UI: members with colours, who holds a grant,
  playback state, relay status and the invite link. The launcher opens it on each start.
- **Add-ons.** Full uBlock Origin installs from its add-on page in one click. The bridge needs
  a signed build or a temporary add-on, and the onboarding shows which.
- **Onboarding.** Three steps: create the room profile, install uBlock Origin, install the
  bridge. The launcher opens the right pages in the right order and checks each step before it
  continues.
- **Not in v1:** our own tab strip, our own address bar, bookmarks, a password manager, and
  profile import from the daily Firefox.

## 10. Safety, because remote input is a foot-gun

Replaying a stranger's click is one bad message away from a purchase, a destructive action or a post. The
room treats input as a privilege, not a default.

1. **Control grants.** A peer can move a cursor and scroll freely. Clicking, typing and media
   control need a grant from the host. The grant names one peer, one tab and one origin, and
   it ends when the tab closes. A bar in the page and in the sidebar reads "Alice has control
   of this tab", with a Revoke button. It cannot be hidden while a grant is active.
2. **Origin allowlist.** The receiver refuses injection on password fields, on fields with
   `autocomplete` credential hints, and inside cross-origin iframes. It also refuses a list of
   payment and banking origins that ships in code and updates with the app. The sender has no
   say in this.
3. **No credential material moves.** Cookies, local storage, tokens and passwords never leave
   the machine. Each person signs in on their own copy. This is a security property and a
   legal convenience.
4. **The relay sees sealed frames.** The room key is 128 random bits in the invite link
   fragment, expanded with HKDF and used with XChaCha20-Poly1305. The fragment never reaches
   the relay. The relay sees a room id, peer ids and frame sizes, and no URL, no cursor, no
   key.
5. **The page is hostile.** The bridge's content scripts run in a sandbox, so page scripts
   cannot read their variables or call their functions. The remote agent is the one channel
   that reaches the browser itself, which is why it starts per grant and closes with it.
6. **Rate limits.** The sync core drops more than 120 input batches per second per peer, and
   more than one navigation per second per room. A hostile peer must not be able to make the
   app unusable.

## 11. Transport

| Option | Works over the internet | Our cost | Notes |
| --- | --- | --- | --- |
| Relay in the launcher, on the LAN | No | None | Room code plus LAN address. Good for a house, useless for a friend in another city |
| Relay in the launcher plus a tunnel | Yes, poorly | None | Works, and nobody will do it |
| Hosted relay on a small VPS (axum, one binary) | Yes | A few dollars a month | The same code as the LAN relay. Rooms are rows in memory |
| Hosted relay on a serverless realtime platform | Yes | Free tier at this scale | Less code, one more vendor, and the seal means the vendor learns nothing |

**Decision: write one axum relay binary, run it in the launcher for LAN rooms, and deploy the
same binary for internet rooms.** The app needs no vendor to work. A hosted platform stays an
option if running a VPS becomes annoying. The Gravity Index catalogue has no realtime relay
service that fits this shape, so the plan does not pick one.

Sizing: a sealed cursor frame is about 60 bytes. A 30 Hz stream is about 2 KB/s per peer sent
and 14 KB/s received in an 8-person room. An input batch peaks at 16 KB. Two hours of a
four-person room is a few megabytes. That number is why the idea works on a bad link.

The room runs over a WebSocket from the bridge's background page. A content script inherits
the page's origin and its CSP, and `ws://` from an `https` page counts as mixed content. The
background page has the extension's origin and no such limit, and a Manifest V2 page stays
alive for the whole session.

## 12. Milestones

### M0 · Spike: four questions, two days

No design work starts until the spike answers these. Each question kills or reshapes a
milestone.

1. **Profile beside the daily browser.** Firefox runs a Brosr profile next to the daily
   browser. Create the profile. Start it with `--profile` and `--no-remote`. Open a room URL.
   Check that the daily Firefox keeps its window and add-ons.
   *Kill criteria:* if a second instance cannot run on Windows, the room profile opens only
   when the daily browser is not running. Onboarding says so.
2. **Does the bridge load and reach a real page?** Load it as a temporary add-on. Prove that a
   content script sees the page, that the sidebar opens, and that the background page holds a
   WebSocket.
   *Kill criteria:* if temporary add-ons break too often across restarts, the dev loop moves to
   a signed unlisted XPI earlier than M6.
3. **Does full uBlock Origin block ads with the bridge running?** Install it from AMO in the
   room profile, then load a fixture page with a known ad URL. Repeat with the sidebar open.
   *Kill criteria:* if the overlay interferes with the blocker, the overlay is wrong. Repair it
   before M1.
4. **Do two Firefox windows hold a video in sync over the LAN relay?** Use an
   `HTMLMediaElement` fixture, not YouTube, so ads cannot confuse the result. Measure drift for
   ten minutes. Also test one BiDi key action and record what `isTrusted` says.
   *Kill criteria:* drift above 500 ms with no recovery path means the media adapter needs a
   different mechanism before M2, not after. If the BiDi action reports `isTrusted: false`, the
   plan cancels M7 and the synthetic actuator is the only one.

**As built (13 November 2026).** The spike ran on Firefox 162.0a1 from the Nightly archive.
This machine had no system Firefox, and the unsigned bridge needed a channel that accepts it.
Two profiles started as separate instances, and both reached a WebDriver BiDi session. The
bridge installed as a temporary XPI, and its content script loaded the core from the
extension origin. Full uBlock Origin 1.76.0 blocked a Taboola request that loaded in the
profile without it. One BiDi key action produced `isTrusted: true` and typed the character.
Two windows played one encoded clip through a real `HTMLMediaElement`. The peer joined 2.4 s
behind, used one seek and one rate nudge, then settled by 4.5 s. It held 84 samples at
15 ms p95 across 25 s, with both cursors drawn.

Two findings matter for the code. A Firefox match pattern cannot contain a port, so the
bridge matches `http://127.0.0.1/*`, not `http://127.0.0.1:8787/*`. And a temporary install is
a Nightly and Developer Edition path. Release Firefox still needs a signed XPI, as Section 4
says.

One limit stays open. The drift figure is a loopback result on one machine, not a network
result. The spike closed the other two: the media test ran a real `HTMLMediaElement`, and a
token-gated loopback agent carried a trusted key through the launcher's channel. That agent
ran inside the harness, not in a Tauri process, so the launcher half is still M7.

M0 also settles whether the sidebar holds a room across tab switches, and whether Firefox
locks the profile while the launcher updates it.

### M1 · Sync core and presence

Room state machine, protocol codec, clock estimator, cursor overlay, one tab, one URL, LAN
relay. No input, no media. Two windows show each other's cursors and scroll together.
*Done when:* four peers on one LAN stay under 80 ms cursor latency at p95 for an hour. A peer
that disconnects and rejoins returns to the same scroll position.

**As built (13 November 2026).** [core/](core/) holds the protocol codec, the clock estimator
and the drift controller. It also holds the `HTMLMediaElement` adapter, the room state with
both rate limits, and the cursor overlay. The URL and scroll layers sit beside the client
that wires them together. The client takes its transport as an argument, so the same code runs in a
content script and in a Node test. 53 unit tests cover it. A four-tab room on this machine held 2 ms p95 cursor latency over 600 samples in a 60 s soak.
It survived a relay restart with every peer back on the same scroll, followed a navigation,
and matched the host's scroll exactly. One hop crossed a real LAN on 13 November 2026: a
Windows host and a Mac peer. The Windows side measured 3 ms p95 and the Mac side 10 ms p95. A
later window held the host's 0.5 scroll on the peer. Still missing from M1: an hour-long run,
more than two peers on a LAN, and the axum relay. That relay still needs the room table the
spike relay now has.

### M2 · Media adapters

`HTMLMediaElement` adapter and a YouTube adapter. Drift controller with seek and rate nudge.
Ad detection and pause. Buffering policy. *Done when:* a 40-minute video holds within 250 ms
p95 across three peers, with at most one seek per ten minutes. A deliberate 600 ms network
delay then causes one seek rather than a loop.

### M3 · Rooms, invites, encryption, reconnect

Invite links with the key in the fragment, sealed frames, room bar, join and leave. Host
migration runs when the host closes the lid. A snapshot sends state to a late joiner.
*Done when:* the relay log shows no URL, name or cursor text. Killing the relay for ten
seconds leaves the room intact after it returns.

The spike relay keeps one table per room, so a frame cannot cross between rooms, and a test
proves it. Killing the spike relay for 2.5 s left every peer connected again at the host's
scroll. Invites, sealing and the axum relay are still to come.

### M4 · Input relay and grants

The synthetic actuator, pointer, key and wheel capture, control grants, the origin allowlist,
element targeting with the CSS path fallback, and canvas mapping. *Done when:* a two-player
canvas game from an open-source project plays from two machines over the LAN relay, with no
visible desync over ten minutes. A relayed click on a page whose layout differs makes the
receiver show a notice instead of a click.

**As built (13 November 2026).** [core/input.mjs](core/input.mjs) holds the 30 Hz batcher and
the grant book scoped by peer, tab and origin. It also holds the origin allowlist, the
sensitive-field guard, CSS-path targeting and canvas fractions, and replay. In the spike a granted peer
clicked a canvas, and the host drew the same point as a synthetic event. That click crossed the
LAN on 13 November 2026, where the host applied one record and dropped none. A password field
on the peer stayed local, and the host's copy stayed empty. A later window held the host's 0.5 on the peer, and the peer pressed the canvas. BiDi refused
the press because the canvas sat above the viewport. `tall.html` now pins the canvas,
and the same click path passed on loopback. Still missing from M4: a two-machine game, a LAN
click that pairs with a followed scroll, pointer lock, a wheel test, and the grant UI.

### M5 · Sidebar and onboarding

Sidebar with members and grants, onboarding for the profile and uBlock Origin, the bridge
install step, per-origin settings, the actuator indicator and session restore. *Done when:* a
person who has never seen the app reaches a working room in under three minutes. The sidebar
still works after ten tab switches.

**Zen Browser path (12 November 2026).** Zen 1.24.1b is a Gecko 159 fork, and it keeps the
Firefox extension host, so the same bridge loads. [zen/](zen/) adds a room profile with
vertical tabs and compact chrome, and a room panel wired as `sidebar_action` and
`browser_action`. A headless check installed the bridge in Zen, opened a room page and read
`source: content-script` with the socket open. The room panel reported itself live. The check drove Grant and Revoke against a second peer
tab, and that peer reported control true then false. Each peer row has its own button, and the
panel lists the last control changes. The toolbar button opens the sidebar. The manifest declares the Ctrl+Alt+B
command, but no run proved the chord. Zen stores spaces in its session store, so a
room per space is still open.

### M6 · Packaging, signing and relay

Launcher installer and updater, following the
[tauri-releases](../../.agents/skills/tauri-releases/SKILL.md) procedure. Also the signed
unlisted XPI and a relay binary with a deployment note. Then a privacy page that states what
the relay sees, and a first-run flow that survives a Firefox major update. *Done when:* an
update installs over the previous version, and a signed bridge installs on release Firefox. A
room works between two networks through the hosted relay.

### M7 · Trusted input through the remote agent

The BiDi session in the launcher, the loopback channel, token handling, the per-grant
lifecycle, and the mapping from an input batch to `input.performActions`.

*Done when:* typing into a form arrives with `isTrusted: true`, the agent starts only while
a grant is active, and killing the room closes the session. The spike's `agent.mjs` already
covers the token, the loopback bind, the grant refusal and the revoke.

### M8 · Optional Chromium variant, and voice

Two separate optional jobs, and the plan commits to neither.

- **A Chromium variant**, for people who want the debugger actuator and accept uBlock Origin
  Lite. It reuses the protocol and the relay, and adds a second bridge.
- **Voice chat** over WebRTC audio, which is the last reason to open a second app during a
  game.

## 13. Numbers to hold, and how to measure them

| Measure | Target | How |
| --- | --- | --- |
| Cursor latency, LAN | 80 ms p95 | The sender stamps room time, the receiver logs arrival and render |
| Cursor latency, WAN | 200 ms p95 | The same, through the hosted relay |
| Playhead drift, 40 min | 250 ms p95 | A fixture video with a real element, sampled every 5 s |
| Seeks per 10 min | 1 or fewer | A counter in the media adapter |
| Relay traffic, 4 peers | 15 KB/s per peer | A relay byte counter |
| Input to visible response, LAN | 60 ms p50 | The game fixture timestamps the keydown |
| Onboarding to first room | 3 min | A stopwatch, on a person who has not seen the app |

A speed or smoothness claim without one of these counters does not ship.

## 14. Tests

- **Unit, Node.** Protocol encode and decode, snapshot merge, and per-peer ordering. Clock
  estimator against a fake clock with constant delay and jitter. Drift controller against
  scripted playhead sequences. Permission gate and the allowlist matcher. The drift controller
  is the one place a bug ruins a film, so it gets the most cases.
- **Extension, geckodriver.** Firefox started with a test profile and a signed XPI, driven
  through WebDriver. Fixture pages cover the cases. `media.html` plays an encoded clip through
  a real `HTMLMediaElement`. `canvas-game.html` records every pointer and key event it receives.
  `ad.html` requests a known ad URL so the uBlock Origin assertion is real. `layout-diff.html`
  reflows at one of the two window widths.
- **Core harness, Playwright.** The sync core has no browser API in its transport layer, so
  Playwright can run it in two Chromium contexts against a local relay. That covers timing,
  reconnect and ordering, and it does not cover the extension. Playwright cannot load an
  extension into Firefox, and the plan does not pretend otherwise.
- **BiDi harness.** One test starts Firefox with `--remote-debugging-port`, sends a key action,
  and asserts `isTrusted` and the field value. The suite skips it on a build without the remote
  agent.
- **Failure injection.** 200 ms delay, 5% loss and reorder. Also a peer that ignores pings, a
  bridge background page the browser restarted, and a page that navigates inside an input
  batch.
- **Manual.** The launcher, the install flow and the sidebar get a written script. Playwright
  cannot drive a Tauri window or Firefox's own chrome.

## 15. Risks that could sink it

| Risk | Why it bites | Early signal | Fallback |
| --- | --- | --- | --- |
| Firefox only | Fewer people have it, and the app depends on Mozilla's roadmap | Onboarding | A Chromium variant at M8, without full uBlock Origin |
| Signed XPI churn | Release Firefox refuses the bridge without a signature | M6 | Unlisted signing in CI, and a dev build with checks off |
| BiDi input is not trusted | The whole trusted actuator rests on it | M0 question 4 | Synthetic actuator only, and no typing into native controls |
| A remote agent is a control channel | It can drive the whole browser | M7 | Per-grant lifetime, loopback bind, random port, token |
| Sidebar quirks | It behaves differently per window and per version | M5 | A popup window for the room UI |
| Firefox updates break the profile | A major version can migrate or reset things | M6 | Pin the profile layout and test each ESR |
| Profile locked by the launcher | Firefox refuses a second instance on one profile | M0 | One room window per profile, and a clear message |
| Layout differs across peers | A relayed click lands on the wrong element | `layout-diff.html` fixture | Element-path targeting only, with drops |
| A site refuses synthetic input | Games and some apps check `isTrusted` | M0 | BiDi actuator, when M7 lands |
| DRM video | No script control of the pipeline | First Netflix test | State the limit in the UI |
| YouTube ads | Per-user ads break a shared playhead | M2 | Pause sync during ads |
| uBlock and the overlay disagree | Cosmetic filtering can hide an injected node | M0 question 3 | Keep the overlay inside one closed shadow root |
| The relay is a new service | Someone must pay for and patch it | M3 | LAN-only default, hosted as opt-in |
| A relayed click on a bank page | The app becomes a fraud vector | Before M4 | Allowlist and grants, enforced on the receiver |

## 16. Scope for v1

Windows 11 first, because the repo's other apps ship Windows first and the Firefox profile
code is best tested there. macOS follows once the same code works, and Linux is last.

v1 is a launcher and a room profile with full uBlock Origin and the bridge. It gives rooms of
up to eight people one shared tab set and synced scroll. Synced video with two adapters, live
cursors, and input relay with grants follow. It is not a screenshare replacement, the trusted
actuator is not in v1, and the first screen of the app says both.

## 17. Open questions

1. Should the room use a fresh profile, or borrow the daily Firefox profile so logins and
   add-ons are already there? A borrowed profile needs the daily browser closed first.
2. Does the room ship as a Manifest V2 bridge with a persistent page, or as Manifest V3 with
   an event page? MV2 fits v1, and MV3 is the migration path if Mozilla sets an end date.
3. Is the sidebar the right home for the room, or does a small popup window travel better with
   a shared tab?
4. Does the host see who is looking at which part of the page? Or does presence stay limited
   to the cursor that peer chooses to show?
5. Is a Chromium variant worth a second bridge, given it cannot run full uBlock Origin?
6. When two people type in the same field, does the room need a lock, or is last-writer-wins
   acceptable? Last-writer-wins is cheaper and wrong more often.
