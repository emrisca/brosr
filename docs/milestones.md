# Milestones

Part of the [Brosr design index](README.md).

## Milestones

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
a Nightly and Developer Edition path. Release Firefox still needs a signed XPI, as
[engines.md](engines.md) says.

One limit stays open. The drift figure is a loopback result on one machine, not a network
result. The spike closed the other two: the media test ran a real `HTMLMediaElement`, and a
token-gated loopback agent carried a trusted key beside the browser. That agent ran inside the
harness, so a start path that owns it is still M7.

M0 also settles whether the sidebar holds a room across tab switches, and whether Firefox
locks the profile while the start path updates it.

### M1 · Sync core and presence

Room state machine, protocol codec, clock estimator, cursor overlay, one tab, one URL, LAN
relay. No input, no media. Two windows show each other's cursors and scroll together.
*Done when:* four peers on one LAN stay under 80 ms cursor latency at p95 for an hour. A peer
that disconnects and rejoins returns to the same scroll position.

**As built (13 November 2026).** [core/](../core/) holds the protocol codec, the clock estimator
and the drift controller. It also holds the `HTMLMediaElement` adapter, the room state with
both rate limits, and the cursor overlay. The URL and scroll layers sit beside the client
that wires them together. The client takes its transport as an argument, so the same code runs in a
content script and in a Node test. The suites in `core/test` cover it. A four-tab room on this machine held 2 ms p95 cursor latency over 600 samples in a 60 s soak.
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

**As built (14 November 2026).** [core/media.mjs](../core/media.mjs) holds the `HTMLMediaElement`
adapter. [core/youtube.mjs](../core/youtube.mjs) holds the YouTube one. The peer path reads element
fields, so the YouTube adapter hands back a view with those fields. One path then drives both
players. `core/test/youtube-room.test.mjs` drives a fake IFrame player through the real client.
A peer that matches the host never seeks. A 20 s drift seeks once through `seekTo`, and a 200 ms
drift nudges the rate. A buffering player pauses, and the ad class pauses.

**As built (15 November 2026).** The bridge now hands the IFrame player in, so a real YouTube
tab uses the player adapter after the page loads and adopts a new one on a single-page
navigation. The tab that shows the film reports it, the room tab forwards the anchor, and the
film tab applies it to its own player. A two-browser room ran with Zen as the host and Brave as
the guest. The room carried `youtube:aqz-KE-bpKQ`, the guest film tab applied 132 frames, and
its last drift was 0.2 s. Volume stays local: the room sets the playhead and the rate, and
never the volume. The guest browser loads the bridge from an unpacked folder, which works in
Brave 157. Still missing from M2: a three-peer run, an hour-long film, and the sites in M2b.

### M2b · Other sites

YouTube is one player. The next step is the sites people already watch, which usually means a
player inside an iframe and a source that changes per quality.

- **Any `HTMLMediaElement`.** `mediaStateFromDocument` samples a plain `<video>` or `<audio>` in
  the top frame, and the key comes from the source URL. A site whose player sits in the page
  needs no new adapter.
- **Cross-origin players.** A player inside an iframe is invisible to the top frame. The bridge
  needs a content script in every frame, with the frame URL in the key, and the room tab still
  holds the socket.
- **HLS and DASH.** The source URL changes on a quality switch, so the key must come from the
  page and the player, not from the media source alone.
- **p-stream and its forks.** The same page and the same player, so one adapter covers each fork.
  The extension the user already runs is the reference.
- **The fmhy video list.** Use the [FMHY streaming wiki](https://github.com/fmhy/FMHY/wiki/Streaming)
  as the reference for site names and current domains. Check its history when a site moves, and
  treat a domain change as a review item, not an automatic redirect. Pick three sites, one of them
  iframe-embedded, and hold them in the test matrix. Ads and live streams keep the M2 policy.

**As built (15 November 2026).** [core/media-relay.mjs](../core/media-relay.mjs) names a film by the
page when the source cannot name one. A blob, a media source and an HLS or DASH manifest all hand
back the page origin and path, so a quality switch keeps the same key and both viewers open the
same URL. A plain file URL still names itself. The bridge content script runs in every frame, a
frame reports the player it holds over the same tab channel, and an apply frame reaches every
frame of that tab, where only the frame with the matching key acts. A frame never becomes a room
tab. YouTube keeps its own adapter.

**Live matrix (15 November 2026).** Brave 157 loaded the bridge and uBlock Origin Lite as two
unpacked packs. Both service workers ran, both ids stayed in `pinned_extensions` across a restart,
and the profile allows the third party cookie that Google sign-in needs. `https://cinecat.eu/` and
`https://www.movy.sx/` loaded their home pages. A playback run on a title page is still open.

**Cinecat playback (16 November 2026).** Cinecat's title page played inline in the host and guest
Brave profiles. Play, pause, seek to 60 s and resume stayed within 250 ms, and both tabs reported
the same page key.

**Miruro probe (16 November 2026).** A Miruro title page renders a `<strmcx-embed>` shadow host
around a generic `strm.cx/?embed=1` iframe. The iframe URL is the same for every episode, so the
generic page key would collide. Miruro needs a title and episode handoff before it can join the
tested list.

*Done when:* two browsers hold within 1 s on three sites from the list, one of them inside an
iframe, with at most one seek per ten minutes and no seek loop.

### M2c · A shared login

Some sites show the film only to a signed-in account, and one person in the room may hold that
account. A cookie copy between the two browsers on one machine covers it. The host reads the
cookies for one site from its own browser and writes them into the guest profile over the guest's
local debug port. Credentials never reach the relay, and a peer on another machine never receives
them. A site that rotates a session can sign one browser out, so a copy may need a repeat.

*Done when:* a signed-in page in the host browser opens signed in on the guest, and no cookie
value appears in a relay capture.

### M3 · Rooms, invites, encryption, reconnect

Invite links with the key in the fragment, sealed frames, room bar, join and leave. Host
migration runs when the host closes the lid. A snapshot sends state to a late joiner.
*Done when:* the relay log shows no URL, name or cursor text. Killing the relay for ten
seconds leaves the room intact after it returns.

The spike relay keeps one table per room, so a frame cannot cross between rooms, and a test
proves it. Killing the spike relay for 2.5 s left every peer connected again at the host's
scroll.

**As built (14 November 2026).** [core/seal.mjs](../core/seal.mjs) holds the frame cipher, the room
key and the invite codec. The cipher is plain JavaScript, so a content script and a Node test run
the same bytes. HKDF-SHA256 comes from WebCrypto, which both expose. The suite checks the draft's
HChaCha20 subkey and its full AEAD vector. It checks the RFC 8439 Poly1305 vector too. A frame also
fails after one flipped bit, in the nonce, the ciphertext or the tag. It checks a frame from another
room and a frame from another key too. One test seals a presence frame and asserts the bytes carry
neither the URL nor the peer name. That is the relay-log half of the done-when. The invite keeps its
128-bit key in the fragment, and a test proves the key never lands in the query string.

Sealing is now on the wire. [core/browser-entry.mjs](../core/browser-entry.mjs) derives the key from
the invite fragment or from stored config, sends every frame through `sealFrame`, and drops a
binary frame that fails to open. An invite with a key never falls back to plain text, and a key
that fails to derive never connects. A test spawns [spike/relay.js](../spike/relay.js) with
`RELAY_CAPTURE`, runs a two-peer room through it, and asserts the capture holds sealed frames with
no `http`, `Peer Two` or `presence` bytes. That is the relay-log half of the done-when, taken from
the relay's own witness.

The room also migrates its host. Every peer elects the smallest live peer id, so the machines
agree without a shared clock. [core/sync.mjs](../core/sync.mjs) moves the role on a bye or a pruned
peer.

The room bar now lives in the panel. It shows the seal state, the join link carries the key, and
Leave room closes the tab's socket and clears its stored identity. The live start path mints a key for
each run and puts it in the fragment.

The axum relay also runs. [relay/](../relay/) forwards text and binary frames with their own
opcode, keeps one table per room, and writes the same `RELAY_CAPTURE` lines. The core wire test
runs against it through `RELAY_BIN`, and both frame rules pass. Two M3 limits stay open. The
relay serves no range requests, so a seeking clip still needs the Node relay. A live Zen run has
not yet repeated with the seal on.

### M4 · Input relay and grants

The synthetic actuator, pointer, key and wheel capture, control grants, the origin allowlist,
element targeting with the CSS path fallback, and canvas mapping. *Done when:* a two-player
canvas game from an open-source project plays from two machines over the LAN relay, with no
visible desync over ten minutes. A relayed click on a page whose layout differs makes the
receiver show a notice instead of a click.

**As built (13 November 2026).** [core/input.mjs](../core/input.mjs) holds the 30 Hz batcher and
the grant book scoped by peer, tab and origin. It also holds the origin allowlist, the
sensitive-field guard, CSS-path targeting and canvas fractions, and replay. In the spike a granted peer
clicked a canvas, and the host drew the same point as a synthetic event. That click crossed the
LAN on 13 November 2026, where the host applied one record and dropped none. A password field
on the peer stayed local, and the host's copy stayed empty. A later window held the host's 0.5 on the peer, and the peer pressed the canvas. BiDi refused
that press because the canvas sat above the viewport, so `tall.html` now pins the canvas. A
fourth window followed 0.5 and landed the click: the host received canvas (201, 151) and
applied one record, dropped none. Still missing from M4: a two-machine game, pointer lock and a
wheel test.

### M5 · Sidebar and onboarding

Sidebar with members and grants, onboarding for the profile and uBlock Origin, the bridge
install step, per-origin settings, the actuator indicator and session restore. *Done when:* a
person who has never seen the app reaches a working room in under three minutes. The sidebar
still works after ten tab switches.

**Zen Browser path (12 November 2026).** Zen 1.24.1b is a Gecko 159 fork, and it keeps the
Firefox extension host, so the same bridge loads. [zen/](../zen/) adds a room profile with
vertical tabs and compact chrome, and a room panel wired as `sidebar_action` and
`browser_action`. A headless check installed the bridge in Zen, opened a room page and read
`source: content-script` with the socket open. The room panel reported itself live. The check drove Grant and Revoke against a second peer
tab, and that peer reported control true then false. Each peer row has its own button, and the
panel lists the last control changes. The toolbar button opens the sidebar. The manifest declares the Ctrl+Alt+B
command, but no run proved the chord. Zen stores spaces in its session store, so a
room per space is still open.

**As built later.** The room UI is the toolbar popup in both manifests, not a sidebar. The
popup and a full tab share one stylesheet, and the page names its surface in the URL.

### M6 · Packaging, signing and relay

A start path a person can install without a checkout: a Node runtime and one command. Also the
signed unlisted XPI and a relay binary with a deployment note. Then a privacy page that states
what the relay sees, and a first-run flow that survives a browser major update. *Done when:* the
start path runs from a clean install with no developer tools, and a signed bridge installs on
release Firefox. A room works between two networks through the hosted relay.

### M7 · Trusted input through the remote agent

The BiDi session beside the start path, the loopback channel, token handling, the per-grant
lifecycle, and the mapping from an input batch to `input.performActions`.

*Done when:* typing into a form arrives with `isTrusted: true`, the agent starts only while
a grant is active, and killing the room closes the session. The spike's `agent.mjs` already
covers the token, the loopback bind, the grant refusal and the revoke.

The shell came back as the Brosr app. The first Tauri window only spawned a start script for a
named room, so it was dropped for a while and the script was the whole run. The app now owns
setup and calls `host/cli.mjs`, which answers one JSON line per command. The BiDi session, the
token channel and the grant lifecycle live in a Node helper beside that start path.

**As built (15 November 2026).** [host/trust.mjs](../host/trust.mjs) owns one BiDi session beside
the start path. It finds the room tab by its `room` param, polls the member list the page
publishes, and binds a loopback agent only while a peer holds control. The agent needs a
bearer token from the room fragment, a live grant and a five minute window. `host start
--trusted` mints the token, picks a free loopback debug port, passes it to the browser and
spawns the helper. `host stop` kills the helper, and the helper closes its listener before it
exits. [core/trust.mjs](../core/trust.mjs) maps a record to pointer, key or scroll actions, and
the room page resolves each record against its own layout first. A refused batch falls back to
synthetic replay, so a closed agent never swallows a click.

[scripts/check-trusted-input.mjs](../scripts/check-trusted-input.mjs) typed `trust` into the form
fixture on Zen. Every key reported `isTrusted: true`, a call without the token got 401, the
agent refused to exist without a grant, revoke closed the listener, and SIGTERM to the helper
closed its port. The room panel now names the tab a grant types into: a ticked Trusted typing
sends that tab's URL to the room tab, the page publishes it as `trustTarget`, and the helper
resolves it through `browsingContext.getTree`. It recreates the agent when the target changes
and keeps the room tab when no tab shows the URL. The grant still comes from the panel.

### M8 · Chromium variant, and voice

The Chromium lane is built. Voice is not started.

- **Chromium variant.** Built. `host/browsers.mjs` starts Brave with its own profile, and
  `host/blockers.mjs` plus `host/pstream.mjs` stage uBlock Origin Lite and P-Stream as unpacked
  packs. It reuses the protocol, the relay and the sync core, and adds a second bridge manifest.
  The `chrome.debugger` actuator is still open.
- **Voice chat** over WebRTC audio is the last reason to open a second app during a game. No
  work has started on it.
