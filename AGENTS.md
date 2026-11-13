# Agent notes

## The handoff bus

The two machines talk through `handoff.mjs`. `HANDOFF.md` is a record and not a channel.

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
`SKILL.md` vanished a second time anyway, so a delete can also arrive from the other machine.
Check that both folder roots map to `brosr/` before you trust a sync.

Run `node handoff.mjs tidy` to clear temps older than 15 minutes. `tidy --dry-run` lists them
and clears nothing. `git checkout -- <file>` brings back a tracked file that goes missing.
