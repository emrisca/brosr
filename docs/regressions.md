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

## The rules

1. One schema at every boundary. Unknown fields are errors.
2. Draw local truth before optional I/O. Every remote read has a deadline.
3. One request, one owner, one answer.
4. Build identity travels with the room.
5. Every policy returns allow plus a reason.
6. Every fix gets a failing test at the boundary that failed.
