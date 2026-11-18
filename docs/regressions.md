# Regression rules

A fix ships with a test at the boundary that failed. A unit test that never
crosses that boundary does not count.

| Symptom | Cause | Test |
| --- | --- | --- |
| Grant and tab controls do nothing in the app | The app sent `--peerId`, `--allowed` and `--tabId`; the CLI read `--peer`, `--allow` and `--tab` | `core/test/panel.test.mjs`, `host/test/panel-contract.test.mjs` |
| The room panel stays blank | The panel waited for the optional film-tab read before drawing the room | `core/test/panel.test.mjs` |
| A video-less frame answers the film read | Every frame answered `brosr:relay-reading` and a frame without a video won | `core/test/panel.test.mjs`, `core/test/film-owner.test.mjs` |
| A guest runs an old bridge and looks out of sync | The bridge version never travelled with the room | `core/test/panel.test.mjs`, `zen/check-chrome.mjs` |
| A site toggle hides pointers with no explanation | The cursor filter returned a boolean and kept no reason | `core/test/cursor-policy.test.mjs` |
| A grant or tab refusal only says something failed | The app message dropped the reason before the CLI saw it | `host/test/panel-reason.test.mjs` |
| The welcome screen never lists a live room | The one-shot host printed its answer but a fetch pool held the process open for ten seconds, and the app reads the answer only after exit | `host/test/cli-answer.test.mjs` |
| The host film stops following a peer after that peer loses control, and a film-tab reload is the only cure | The release of a hold was one frame. A revoked peer could no longer send its recovery, and the host ignored a stutter from an ungranted peer, so a lost release left the film tab paused for the session because a hold had no deadline | `core/test/fate.test.mjs` |
| The room elects a guest as host while the host is playing a film | The room tab sits behind the film tab, so its presence timer is throttled; the guest prunes a live host after fifteen seconds and elects itself | `core/test/entry-capture.test.mjs` |
| A release builds every platform but publishes no `latest.json` | The updater job passed `--dir <value>`, and the script parsed only `--dir=<value>`, so every value read as empty and the job exited with a usage error after the builds finished | `host/test/updater-feed.test.mjs` |
| A large eraser rubs out every layer | The sheet held one flattened bitmap, so an erase could not tell layers apart | `scripts/check-canvas-tools.mjs` |
| Two-finger scroll zooms instead of panning | The wheel handler treated every wheel event as a zoom, and Chrome reports a small synthetic delta as a full -120 notch | `scripts/check-canvas-tools.mjs` |
| Undo takes back another person's stroke | The history collected every stroke and clear that arrived, and Clear and layer Clear wiped the whole layer | `scripts/check-canvas-tools.mjs` |
| A peer's image is credited to whoever replayed it | The image frame dropped `owner`, so a late joiner learned the sender and not the page that placed the picture | `scripts/check-canvas-tools.mjs` |
| The Pick button is half hidden in the rail | The colour row gave its label a greedy flex and a fixed 82 px hex field, so three controls asked for more width than the rail gave | `scripts/check-canvas-layout.mjs` |
| Images and Files cannot be reached in a narrow window | The media query kept the body at one screen height with a 60vh sheet, so the last sections painted under the status line | `scripts/check-canvas-layout.mjs` |
| Two status labels read as one sentence | The status parts sat in a bare 16 px gap and the room count joined them with a middle dot | `scripts/check-canvas-layout.mjs` |
| The busy words for a GIF search still take a line | The hidden status kept a 16 px minimum height while the busy rule set its height to 1 px | `scripts/check-canvas-layout.mjs` |
| Cards in one row put the open link at two heights | Notes kept its natural height while every other card pushed its link to the bottom | `scripts/check-landing-layout.mjs` |
| A landing card holds empty space under its heading | The shared 152 px minimum height left Play and Canvas as a heading with a link 77 px lower | `scripts/check-landing-layout.mjs` |
| A site host line is too small to read | The host name sat at 10.5 px and the group heading at 10 px | `scripts/check-landing-layout.mjs` |
| Notes scrolls sideways in a narrow window | The editor kept a 760 px width and the header kept one row at every size, so the sheet ran past the window | `scripts/check-room-apps-layout.mjs` |
| Notes stays dark in a light room | The page carried one colour scheme and no light rules, so the sheet sat on a black stage | `scripts/check-room-apps-layout.mjs` |
| A notes toolbar letter is too small to hit | The letter buttons shrank to their glyph and the row gave one of them 23 px of width | `scripts/check-room-apps-layout.mjs` |
| Chess seats and move counts sit at 10 px | The seat label, the session state and the move count used a size meant for the board coordinates | `scripts/check-room-apps-layout.mjs` |
| Chess squares change size between ranks | The board declared eight columns and no rows, so each implicit auto row sized to the pieces inside it and the ranks holding pieces grew taller than the empty ones | `scripts/check-room-apps-layout.mjs` |

## The rules

1. One schema at every boundary. Unknown fields are errors.
2. Draw local truth before optional I/O. Every remote read has a deadline.
3. One request, one owner, one answer.
4. Build identity travels with the room.
5. Every policy returns allow plus a reason.
6. Every fix gets a failing test at the boundary that failed.
