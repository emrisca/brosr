# Progress log

Part of the [Brosr design index](README.md).

## Progress log

Newest first. Each line names what changed, not what was planned.

- **15 November 2026.** The check job runs on a runner. A branch and a draft pull request ran
  `Brosr check` on GitHub: the signed guard skips because the artifact is local, both browser
  lanes pass on the tree build, and the tests pass. GitHub refuses the macos-14 image for this
  repository, so the job uses macos-15. The Chromium lane had to focus the page before injected
  keys, because a headless runner dropped them, and the release script now fetches the signed
  file AMO already holds when a sign fails. The form diagnosis prints the active element, the
  page focus and the visibility state, and a failing lane prints more of its output.

- **15 November 2026.** Bridge 0.4.2 signed, and both browser lanes sealed. AMO accepted the
  0.4.2 upload but held the signature past the sign timeout, so the signed file is fetched from
  the existing version instead of rebuilt, and the recovered bytes match the tree except for the
  manifest whitespace AMO rewrites. The Zen and Chromium lanes now bind the relay to the private
  address and join with a keyed invite, which proves the seal on a plain HTTP page. A wrong key
  opens no frame and stays invisible to the room. `scripts/check-all.mjs` runs the guard, both
  lanes and the tests, and the release script takes `BROSR_SIGN_TIMEOUT_MS`.

- **15 November 2026.** M7 trusted input. A Node helper beside the start path owns one BiDi
  session, polls the room member list, and binds a token-gated loopback agent only while a peer
  holds a grant. A relayed record becomes a browser pointer, key or scroll action, so a form
  reports `isTrusted: true` and a synthetic click is no longer the only path. `host start
  --trusted` opens the channel, `host trust` reports it without the token, and `host stop`
  closes it. The check typed into Zen, refused a missing token with 401, and proved the
  listener closes on revoke and on helper exit. 209 tests pass.

- **15 November 2026.** Trusted typing follows a shared tab. The Control section gains a Trusted
  typing switch. It sends the active non-room tab's URL to the room tab, which publishes
  `trustTarget` beside its peer list. The helper resolves that URL on the same browser, moves
  the agent to that context, and keeps the room tab when the target closes or no tab shows the
  URL. Two new host cases cover the lookup and the move. 213 tests pass.

- **16 November 2026.** The pointer lives on the pages Brosr hosts. The cross-tab cursor path
  is gone from the bridge and the background, so a plain tab carries media only and no dot
  follows anyone onto an unrelated site. Canvas draws remote pointers itself, from its own socket,
  in sheet coordinates inside the paper clip, so pan, zoom and window size no longer move another
  person's dot. The Listen tile is live on `music.youtube.com`: the track keys on `v`, the page
  element path reads the ad class, and the music host runs through the same adapter and drift
  policy as Watch.

- **16 November 2026.** The canvas room line names who is drawing. Each page sends a
  presence frame on open and every three seconds, so the line counts canvas pages rather than
  sockets and lists up to three names. A page that stops sending presence is dropped after nine
  seconds. The host staging list now copies the pipe client and the hold helper, and a build stops
  when a staged module imports a file that never landed.

- **15 November 2026.** Canvas is endless, and a cursor lands where the pointer is. The fixed
  sheet is gone, so the warm surface fills the window, a world grid follows the view, Fit frames
  the ink and the PNG export takes the visible view. Presence now carries a viewport share and the
  core turns it into pixels against its own window, once, so a remote cursor lands on the same
  part of the page in any window size. Read and Browse leave the tile grid for now, and the plan
  records the Watch site list, Listen on YouTube Music, and the backlog from the room notes.

- **15 November 2026.** The room opens on the landing page. A room tab is `/` with the room
  params, so the first page a room shows is the tile grid. The bridge and the panel read a
  room page by its params as well as by its name, and the fixture pages stay for the harness.

- **15 November 2026.** The landing page replaces Room page B. The relay serves a tile grid
  at `/`, with Canvas live and seven placeholders for the apps that come next. Canvas is a
  custom drawing surface with five brushes, a stabilizer, symmetry, two layers, undo and a
  PNG export. No page loads a font or a script from the network.

- **15 November 2026.** Landing page and Canvas on the wire. The room tab opens a tile grid for
  the apps built for Brosr. Canvas shares its strokes, its undo and its clear as app frames on
  the room, and the landing page reads the live count from /status.

- **15 November 2026.** Other-site media. A blob, an HLS manifest or a cross-origin player now
  names a film by its page, and the bridge runs in every frame so an embedded player reaches the
  room. A host command copies one site's login into the guest browser over the local debug port,
  so no credential touches the relay. The two browsers restarted on the new bridge.
- **15 November 2026.** Two browsers, one room, one film. Zen hosts and Brave joins. The room
  carries `youtube:aqz-KE-bpKQ`, the guest film tab follows the host playhead, and volume stays
  local. Cross-tab cursors are removed, so a plain tab carries media only. The Brave profile
  pins the bridge on the toolbar, and the launcher opens the film in the host browser because
  the host is the anchor.
- **14 November 2026.** YouTube adapter and the bridge hand-in. Sealed frames on the wire, host
  migration, and the room panel with the seal state and the invite key.
- **13 November 2026.** Sync core, cursor overlay, clock, room state, input and grants. A LAN
  hop measured 3 ms p95 on Windows and 10 ms p95 on the Mac.
- **13 November 2026.** M0 spike. Two profiles, a temporary XPI, uBlock Origin, a trusted BiDi
  key, and one synced `HTMLMediaElement`.
- **12 November 2026.** Zen profile, bridge install in Zen, room panel, and grant plus revoke.
