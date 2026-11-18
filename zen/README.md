# Brosr in Zen Browser

Zen Browser is a Firefox fork with vertical tabs, spaces, compact mode and its own sidebar. This
folder makes a Brosr room feel native there. It does not open a stock Firefox window.

Nothing here forks Zen. The room is the same bridge and the same core. Only the profile, the
panel and the way the browser starts change.

## What the shipped build says

Read on 12 November 2026 from `C:\Program Files\Zen Browser`, with no source checkout.

| Fact | Value | Source |
| --- | --- | --- |
| Version | 1.24.1b | `application.ini` |
| Build | 20261106124806 | `application.ini` |
| Engine | Gecko 159.0.1 | `application.ini` |
| Source | `zen-browser/desktop` at `b12eaef` | `application.ini` |
| Zen prefs | 150 under `zen.*` | `browser/defaults/preferences/firefox.js` in `browser/omni.ja` |
| Spaces | `modules/zen/ZenSpaceManager.mjs` and 8 more | `browser/omni.ja` |
| Compact mode | `zen-components/ZenCompactMode.mjs` | `browser/omni.ja` |
| Split view | `zen-components/ZenViewSplitter.mjs` | `browser/omni.ja` |
| Mods | `@mozilla.org/zen/mods-backend;1`, styles rebuilt into the profile | `ZenMods.mjs` |
| Theme tokens | `--zen-primary-color`, `--zen-colors-primary`, `--zen-border-radius` | `zen-styles/zen-theme.css` |

The build keeps the Firefox extension host. That matters twice. Manifest V2 still loads, so full
uBlock Origin still works. `browser_action` still exists, so the room window
needs no Zen patch.

The Chromium lane uses the same bridge source with `manifest.chrome.json`, a service worker and
the `action` name. `zen/package.mjs` writes that build as a folder at `zen/.runtime/bridge-chrome`,
because Chromium loads an unpacked folder and not an XPI.

## The experience

1. **A room profile.** `profile.mjs` makes a Zen profile with vertical tabs, an expanded sidebar
   and telemetry off. It seeds `xulstore.json` with a 320 pixel sidebar width, because Zen
   restores the width from there and its own macOS default is 230. The same store marks the
   window `maximized`, so a room opens zoomed to the screen instead of at Zen's stored size.
   Then it prints the command that starts Zen on that profile. The room gets the window, not the
   toolbar.
2. **A room panel.** The bridge gains a panel at `bridge/panel/room.html`. It shows the room id, each peer by name, whether that
   person holds control, the socket state and the latency. It asks the active tab for the same
   numbers the harness reads from `dataset.brosr`, so one renderer serves both. Host controls live
   in the Brosr app's Room controls dialog; the panel keeps the room name, people, media and cursor
   appearance.
3. **One entry point.** The toolbar opens the panel as an anchored popup, and the Ctrl+Alt+B
   command asks for that same popup. Both need a click, so nothing else offers to show one.
   The panel keeps the same page as a tab, which the check lane opens to read it headlessly.
4. **Spaces stay manual.** Zen stores spaces in its session store. A start path cannot write that
   store safely, so the profile does not fake one. A room per space is the natural next step, and
   it belongs with the M5 sidebar work.

## The panel

`bridge/panel/room.html` is the room panel. It asks the room tab for `brosr:status`, so the
popup and a plain tab share one renderer. The popup can be denied the tab channel, and a tab
id can arrive as the placeholder -1. The room tab also publishes its status to the background
each second, and the panel reads that copy when the tab call fails.

**Surface.** The toolbar opens the panel as an anchored popup inside the browser window. The
Gecko manifest declares it as `default_popup`, and the Chromium manifest declares it the same
way. One click reaches the room, and no code opens a window outside the browser. The popup takes
its 360 pixel width and its 560 pixel height cap from the panel stylesheet, and the browser draws
the frame. Closing the panel from its menu closes the popup, and a tab that hosts the panel
closes itself. The check lane opens that page in a tab, because a message cannot press the
toolbar. That run on 14 November 2026 read the panel live with a 14.13 contrast, the room name,
the people, the film card and the cursor settings. A host alone read its room in the header.

**Theme.** The panel asks the theme API for the toolbar and text colours. It resolves both to
plain rgb triples and mixes its own surface from them, so every computed colour is readable.
The panel rejects a pair under 4.5 to 1 and moves the text to near black or near white,
whichever the surface can carry. A theme without colours falls back to the system canvas pair.

**Spacing.** Gaps and pads use 6, 8 or 10 pixels only. The docked panel fills the expanded
sidebar, which starts at 320 pixels and follows the splitter between 240 and 640. The panel keeps a 240
pixel floor, so the menu and a peer row keep their place. The footer sits at the bottom edge,
and a peer row keeps its badge on one line.

**Menu.** The header holds one control, a room menu. It opens on click, closes on Escape or an
outside click, and returns focus to the button. Refresh, copy join link and hide live there, so
no action sits behind a clipped edge.

**Skeleton.** Two placeholder rows hold the height of the peer list until the first reply
lands. The rows are `aria-hidden`, so a reader hears the status line only.

**Empty state.** A room with no peers shows a short hint and a Refresh button. The peer count
stays visible above the list.

**Invite.** The join link sits beside a Copy button. A copy turns the button label to Copied for a
moment, and the room menu keeps the same action.

**Watch together.** A card reports the playback state and holds a Sync playback button that stays
off until the media bridge lands. The caption says so, so the control never looks broken. A tab
without media reads No media.

**Latency.** A peer row shows its own p95 from `presenceByPeer` in tabular figures. A peer
without a sample shows no time, not a dash.

**Focus.** Buttons carry an `aria-label` with the peer name and the action, plus a
`:focus-visible` ring. The status line and notice use `role="status"` and `aria-live`.

**Top bar.** Single toolbar is off, so the URL bar is its own row. The row is a strip across the
whole window, and the left column starts under it. The bar sits at the window edge and spans it
whether the column is open or collapsed. A spacer keeps its row height, so the page still starts
under it. Hiding one leaves the other where it was. The bar keeps 88 pixels free at its left end, so the
window controls never land on the Back button. Windows and Linux keep the same room at the right
end. The field itself takes the free width, so it grows with the window instead of keeping Zen's
62rem cap. The compact mode toggle moves out of the tab strip and into this row. Zen hides that
button, so the dock shows it.

**Essentials.** An Essentials heading names the strip, and the tiles are the essentials row. The
heading takes the same place the space name had. YouTube and fmhy.net ship as the defaults.
The strip keeps its own row, so a tile never sits under the window controls. The tabs share the row evenly. Each one is a 32 pixel row with a 16
pixel favicon and the page title beside it. A page with no title keeps its host name. The star in
the URL bar sits left of the site data icon, and it shows whether the page in view is in the row. A
click on the star adds or removes that page. It takes its fill and its corner from the variables Zen
paints a tab with. The strip then reads as part of the column. A tab stays clear until hover, then
takes the hover tint. The tab that holds the selected page takes the selected tint and edge. A click selects the tab
that already holds that site, and only a missing tab opens one. A modified click opens a background
tab, and Enter or Space follows the same rule. A drag reorders the row. A drop on the room panel
hands the page to the panel hand off list, and a drop anywhere else removes it. The order lives in
`brosr.sites`, so it survives a reload. A right click opens a menu with Open, Open in New Tab,
Edit and Remove. Edit swaps the link in the same one row form. Ctrl+Alt+A opens the add form from
anywhere in the window. A first run writes the shipped pair before the first read.

**Foot row.** The space name is hidden, so the essentials row sits alone above the tab list. The
foot row holds the library button, one dot per space and the new tab button. It pins just above
the room panel, so the panel never covers it, and it drops to the window edge when the panel is
shut. Zen hides the dots in this layout, so the dock turns the strip back on.

**Basics.** Zen's welcome flow creates a `zen basics` folder. The room profile marks the welcome
seen and clears the session files that carry the folder before each start; the dock also hides
the folder if Zen restores one.

**Column.** The tab column starts under the top bar and owns the left edge down to the window
bottom. The bar drags the window, and the tabs, the tiles and the panel keep the pointer.
Whatever Zen keeps at the column top keeps its room, so the Essentials heading never sits under a
control. A compact window lays the compact mode buttons under the essentials row, so the heading
keeps to the bar there. macOS keeps its lights on the left, and Windows
and Linux keep their buttons on the right. The platform draws their shape too, so the box only
reads `data-brosr-os` and takes its side from it. The column keeps a 315 pixel floor, starts at
320 pixels and Zen's own splitter resizes it up to 640. The dock reads the column width on every
pass and never writes it, so a drag stays put.

**Docked split.** The dock places the panel under the tab column. A 12 pixel bar above the
panel resizes it on drag. The height stays between 120 pixels and the window height minus 220.
A drag flag stops the 500 millisecond layout pass from writing the stored height mid drag. The
bar keeps the pointer through a drag and saves the height on release.

The sidebar box lives inside the tab box, and that box carries a `translate`. A fixed child then
takes the tab box as its containing block, so the panel starts at the tab edge instead of the
window edge. The dock moves the box under the document body and puts the fixed edge back.

The panel floats inside the column. It keeps 8 pixels clear on each side. A 1 pixel border and an
8 pixel radius make it read as a surface beside the tabs. A drag bar fills the gap above it. The
column pads by the panel height plus 16 pixels, so the last tab stays reachable.

**Column only.** The card measures the column and the page edge on every pass. It sits between
them, so a narrow column or a customize run parks it. The bar and the chip park with it, and no
Brosr surface touches the page. A compact window slides the column over the page, so the page
edge sits behind it. The card keeps the column edge then and slides in with the column.

**Card surface.** The panel page paints its own background, mixed 6 percent toward the text
colour, so it lifts off the column like the media bar. The dock leaves the sidebar box
transparent, so the page fills the rounded corner and the border draws on top.

**Translucency.** The window surface paints at 90 percent when the platform draws a material
behind it, so a hint of the desktop shows through the chrome. The page keeps its own paint,
so text never sits on the desktop. A compact window slides the column over the page, and the
column paints a solid surface there, so no page shows through it. A window without a material
keeps a solid surface.
The dock reports the flag, the alpha and the layer count, and the headless run checks all three.

**Per-room height.** The panel writes its room id into its own URL. The dock reads that id from
the sidebar browser, so each room keeps its own `brosr.panel.height.<room>` pref. A room without
a stored height falls back to `brosr.panel.height`. A drag writes both keys.

**Join link.** The dock reads the room tab's own URL, drops the host identity and builds a peer
link with a guest id. Copy writes the link to the clipboard. Without clipboard access the panel
selects the field, so Command C finishes the copy.

**Room state.** The header counts the peers. The footer shows playback, relay state and p95
latency. The relay label carries the reconnect count after a dropped socket.

**Show chip.** Hide in the panel header closes the sidebar. A closed panel shows a Brosr room
chip inside the column, at its left edge. A click calls `SidebarController.show` for the saved
sidebar id. The chip hides only when the column is gone, so Customize Toolbar stays clear. It
carries the peer count while the panel stays shut. The panel writes that count into its own title,
and the sidebar republishes it. The sidebar wrapper page has no title, so the dock reads the title
one level in. A closed sidebar unloads the page, so the chip keeps the last count it read. The
toolbar button and Ctrl+Alt+B open the panel too.

**Motion.** The card rises 6 pixels over 180 milliseconds, and the chip fades in over 120. A live
peer pulses a small ring, and a waiting row shimmers. Buttons and rows ease their background over
120 milliseconds. A reduced motion setting turns every one of these off.

**Headless dock proof.** `check.mjs` opens a second headless window with `--marionette`. The
Marionette listener stops BiDi from reading tab content on this build, so the dock gets a window
of its own. That window opens the bookmarks sidebar, which fills the same box as the room panel.
The run reads the box rectangle there. It fails when the panel is not inset by its own margin.
It also fails on a panel under 240 pixels wide or a column over 440. Single toolbar on, a hidden
splitter, a missing drag bar or a lost corner radius each stop the run. The sites bar must hold
the shipped pair under the bar. The pair needs two tabs at least 80 wide and 28 to 44 tall. The run adds a link through the add form and removes
it again. An emptied bar must keep its add card. It also needs a foot
row above the panel, at least one space dot and a visible space name. The address field must reach within 260 pixels of
the right edge. That window also
hides the sidebar and clicks the show chip, so the toggle runs in the same pass. It then resizes
to 900 by 820, where the bar must still span the window and the panel must stay inside the
column. Last, it drops one tile on the panel, drops the other off the bar and restores the pair
through `window.__brosrSites`. The add form opens on Ctrl+Alt+A and closes on Escape. A tile must
select the tab it already has, not add a copy, and that tab marks its tile as current. The room pass checks the join link, the copy row, the watch card,
the peer count, the playback label and the relay label.

**Entry points.** A room page shows a small Room panel button at its bottom edge. A click asks
the browser for the popup, so it never opens a window of its own.

## Run it

One command starts a room from the `brosr` directory. It builds the profile, starts the relay,
installs the bridge, opens the host room and opens the room panel.

```sh
node zen/live.mjs --room=demo
```

The window starts without Marionette, so `navigator.webdriver` stays false and a Google sign in
works in the room. Pass `--dock` to dock the panel into the sidebar, which starts Zen with
`--marionette` and turns sign in off for that window.

It leaves the browser and the relay running, so the window stays usable by hand, and it writes
`zen/.runtime/live.json`. `--bridge=built` uses the unsigned build in
`zen/.runtime/bridge.xpi`. `--no-configure` skips the safe browsing pass on a throwaway profile.

`node zen/toggle.mjs --profile=<dir>` posts the panel chord to a running window, so a shut panel
opens again.

The two lower level scripts stay available:

```sh
node zen/profile.mjs
node zen/check.mjs
```

`profile.mjs` writes the room profile and prints the command line. `check.mjs` starts the spike
relay and builds the XPI with the panel inside. It starts Zen headless on port 9334 with
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, installs the bridge through WebDriver BiDi, and opens a
host room and a second peer tab. It drives the panel's Grant and Revoke buttons, then reads both
tab datasets and the panel's own DOM. A second headless window on Marionette port 2834 proves the
dock, because the listener stops BiDi from reading tab content on this build. It writes `zen/.runtime/results.json`, then it
kills the browser processes. The check clears the default profile first, because a restored
panel also drives control. `shortcut.mjs` is a separate headful proof of the Ctrl+Alt+B chord. On the Mac it posted the
chord to the Zen process with `keypost.swift`. The room page then recorded
`command: open-room-panel`. At the Windows console it sent the chord to a foreground window and
the room recorded `open-room-panel`. The page records no keydown in either case, because the
browser consumes the chord. A spawned Mac window still does not take activation, so the Mac has
no proof from a frontmost window.

`live.mjs` does that hand setup in one step. It starts the relay and a headful Zen window on a
persistent profile, installs the bridge, opens a host room and sends Ctrl+Alt+B. With `--dock` it
then docks the panel through Marionette, which starts Zen with `--marionette`, and a window
without that flag keeps Google sign in. The panel reports its own width, so the run records
`mode` as `popup` or `tab`. It falls back to a panel tab when no report arrives. It leaves both
processes running and writes `zen/.runtime/live.json`.

`node assets/icons.mjs` rebuilds the 16 to 256 pixel copies and `brosr.ico` from
`assets/brosr-icon.png`. Those files are the app icon. `assets/windows-shortcut.ps1` writes a
Desktop shortcut with that ICO, which also feeds the Start entry and a pinned tile. Icons inside
the app stay regular UI icons.

To use the room by hand, start the relay, then run the command `profile.mjs` prints. The profile
writer copies the bridge in, so a new profile needs no step in `about:debugging`.

AMO signs each new bridge version. `node zen/package.mjs` writes `zen/.runtime/bridge.xpi`, and an
upload of that file to the add-on's page at AMO returns a signed copy. Name the signed copy
`zen/.runtime/bridge-signed.xpi` and run `profile.mjs` again. The newer file wins, so a build made
after the last signature lands with `xpinstall.signatures.required` off. A signed copy that lags
the source reads as `stale` in the log.
`node zen/profile.mjs --guard` reads the shipped files and exits nonzero when the signed copy is
missing, unsigned, or behind the source manifest. A release can refuse the gap that way.

## Limits

- AMO signs the bridge. `zen/package.mjs` builds the file, and `profile.mjs` copies the newer of
  the two bridge files into the profile. A signed copy turns
  `xpinstall.signatures.required` on, and an unsigned build turns it off, so a new profile takes
  either one with no prompt. `check.mjs` still asks for `{ bridge: false }` on its BiDi path.
- A signed bridge whose version lags the source still runs, and `bridgeSource()` reports the
  mismatch. A build newer than the signed copy wins, so upload the new version to AMO when a
  room should carry the signature.
- The check opens the panel in a tab inside Zen and drives its Grant and Revoke buttons against
  a second peer tab. It cannot draw the toolbar popup. A separate headless
  window measures the dock with the bookmarks sidebar, so the room panel's own geometry is
  untested there. Zen may host the sidebar panel differently from Firefox.
- The check reads the panel page through BiDi, which needs `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` when
  Zen starts. Without it BiDi refuses the extension context. The run uses one host and one
  peer on this machine, so a real LAN run is still open.
- The panel's Ctrl+Alt+B command registers, and `browser.commands.getAll()` returns it. The
  Windows console proved the chord from a foreground window. The Mac run posted it to the Zen
  process and opened the panel. A Mac window that takes activation is still untested.
- A window starts without Marionette, so `navigator.webdriver` stays false and Google sign in
  works. The dock needs Marionette, and Gecko sets that flag while the listener runs, so a docked
  panel turns sign in off. `dom.webdriver.enabled` was removed in Gecko 88, and clearing
  `marionette.enabled` after the dock leaves the port listening, so one window cannot have both.
- A room does not create a space. That needs the session store format, and the plan does not guess at it.
- A tile dropped on the room panel lands in `brosr.sites.panel`. The panel page runs in the
  extension and cannot read that pref. The dock hands the list to the panel as a URL parameter
  and reloads only the extension sidebar. A reload can lag by up to 4s.
- Compact mode could not be exercised headless. A toggle leaves the column at its full width in
  that run, so the panel had no reason to park. The collapse test hides the column instead. The
  dock parks the card in that pass.
- The room profile carries a safe browsing set: uBlock Origin, SponsorBlock, AdGuard Extra,
  P-Stream and Skip Redirect. `zen/safe-browsing.mjs` stages the five signed XPIs and copies
  them into the profile, so a new room starts blocked. No profile starts with toolbar
  bookmarks. The landing page is the site list. The `brosr.sites` pref still carries the two
  pages the essentials strip seeds on the first start.
- A headless pass writes the FMHY list into uBlock Origin. A second window reads the list back
  and counts blocked probe requests. The marker holds those counters.
- Setup needs network once. The XPIs and the list text stay in `zen/.runtime/`, so they are never
  committed. A machine with no network keeps its old cache, and a room still starts.
- A finished profile records its inputs in `brosr-profile.json`. A later prepare with the same
  bridge, XPIs, prefs and bookmarks returns at once and copies nothing. The second room of a
  session opens on the profile that is already there.
- `node zen/profile.mjs --profile=<dir> --refresh` pulls the list again. The profile stays as it
  is, so no room is rebuilt.
- `node zen/apply.mjs --profile=<dir>` prints what the set would change in a profile you already
  browse with. Add `--apply` to run it. The list waits while Zen holds that profile, because the
  headless pass needs the profile free.
- `node zen/prove.mjs --profile=<dir>` loads a probe page and counts blocked requests. A bare
  profile with no list gives the comparison, so a blocked count has a cause.
- `node zen/audit.mjs --list=<dir> --bare=<dir>` runs every rule shape through the same check.
  A host that fails on both profiles gets a DNS lookup and a TCP probe. That way a default list
  block does not look like a dead address. The audit counts and names cosmetic rules, because a
  request probe cannot see them. Rows land in `zen/.runtime/audit.json`.
- `node zen/schedule.mjs` registers a weekly refresh with the system task scheduler. `--remove`
  takes the task out of the scheduler. `--status` prints the task row and the last runs.
- `zen/refresh.mjs` runs one refresh and records the counters in `zen/refresh-status.json`.
  Syncthing copies that file, so the other machine reads the result.
