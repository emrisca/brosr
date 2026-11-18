# Agent notes

## Room guardrails

These six rules are not style preferences. Each one has a test, and a fix that
crosses one of these seams needs a test at that seam too. `docs/regressions.md`
records the bug that taught each rule.

1. **One schema at every boundary.** The app and `host/cli.mjs` use the panel
   schema in `core/panel.mjs`. An unknown field is an error, not a silent no-op.
2. **Draw local truth before optional I/O.** A visible surface renders the room
   first. Every remote read gets a deadline.
3. **One request, one owner, one answer.** A film read names one tab before it
   asks, and a listener that does not own the player stays silent.
4. **Build identity travels with the room.** The bridge manifest version and
   protocol travel in the hello and the panel, so a stale guest is named.
5. **Every policy returns allow plus a reason.** Cursor sites, grants and tab
   sharing say why a thing was refused. A boolean is not a diagnosis.
6. **Every fix gets a failing test at the boundary that failed.** Add the case to
   `docs/regressions.md` when the fix lands.

## The handoff bus

The two machines talk through `handoff.mjs`. `docs/HANDOFF.md` is a record and not a channel.

Start every turn with:

```
node handoff.mjs check --side=mac
```

The command exits 3 when a message waits, and it claims nothing. Then run
`node handoff.mjs claim --side=mac` and do the work. Answer with
`node handoff.mjs reply --side=mac --id=<id> --type=result --payload-file=<path>`, and the tool
moves the original into `done/mac`.

Never edit a message after it has its final name. `inbox/`, `processing/`, `done/` and `locks/`
stay out of git.

`node handoff.mjs status` lists what waits and what sits claimed, with an age in minutes.

## Syncthing temp files

Syncthing writes `.syncthing.<name>.tmp` beside a file while it copies it. This Mac ran two
Syncthing installs at once, so one instance orphaned a partial write. The duplicate is gone, and
`docs/SKILL.md` vanished a second time anyway, so a delete can also arrive from the other machine.
Check that both folder roots map to `brosr/` before you trust a sync.

Run `node handoff.mjs tidy` to clear temps older than 15 minutes. `tidy --dry-run` lists them
and clears nothing. `git checkout -- <file>` brings back a tracked file that goes missing.
