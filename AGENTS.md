# Agent notes

## The handoff bus

The two machines talk through `handoff.mjs`. `HANDOFF.md` is a record and not a channel.

Start every turn with:

```
node handoff.mjs list --side=mac
```

When `count` is above 0, run `node handoff.mjs claim --side=mac` and do the work. Answer with
`node handoff.mjs reply --side=mac --id=<id> --type=result --payload-file=<path>`, and the tool
moves the original into `done/mac`.

Never edit a message after it has its final name. `inbox/`, `processing/`, `done/` and `locks/`
stay out of git.
