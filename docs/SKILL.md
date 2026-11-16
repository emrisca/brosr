---
name: agent-handoff
description: Automated file-based communication between CLI agents on different machines (Mac and Windows) using an existing Syncthing share. Use when setting up, sending, receiving, or diagnosing cross-machine agent handoffs, multi-computer agent coordination, or replacing manual handoff files.
---

Agent Handoff

Reliable, zero-API-key communication between CLI agents running on separate machines (typically Mac + Windows) via a Syncthing-synced folder.
When to use

    Two or more machines need to exchange structured requests, reviews, results, or status.
    You already have Syncthing running and sharing a folder.
    You want automatic pickup instead of manually feeding a handoff file.
    App tests must remain fully local (no network required for the test loop).

Core protocol
Directory layout (inside the Syncthing root)

HANDOFF_ROOT/
  inbox/
    mac/          # Windows writes messages for the Mac agent here
    win/          # Mac writes messages for the Windows agent here
  processing/
    mac/
    win/
  done/
    mac/
    win/
  locks/          # optional

Each side only reads its own inbox and only writes into the other side’s inbox.
Message format

Filename: YYYYMMDD-HHMMSS-<from>-<seq>.json
Example: 20261113-141822-win-0001.json

{
  "id": "20261113-141822-win-0001",
  "from": "win",
  "to": "mac",
  "type": "request",
  "created": "2026-11-13T14:18:22Z",
  "status": "pending",
  "payload": {}
}

Allowed type values: request, review, result, status, setup, cancel.
Atomic write rules (mandatory)

    Write the complete JSON to a temporary file ending in .tmp in the target directory.
    Rename the .tmp file to the final .json name (atomic on both macOS and Windows).
    Never edit a file after it has its final name.
    When you start processing a message, immediately move it into processing/<your-side>/ (or update status + create a lock).
    After finishing, write any reply into the other side’s inbox, then move the original into done/<your-side>/.

Ownership

    Mac agent owns inbox/mac, processing/mac, done/mac.
    Windows agent owns inbox/win, processing/win, done/win.

Setup instructions

    Locate the existing Syncthing shared folder (the one already used for the old handoff file). Call it HANDOFF_ROOT.
    Create the directory tree shown above if it does not exist.
    Implement or enable a watcher that only monitors your own inbox.
    Prefer chokidar (Node), a 1–2 s poll loop, watchexec, or fswatch. Debounce short bursts.
    On first setup, send a type: "setup" message to the other side explaining the new layout and rules. Ask for an explicit acknowledgement (type: "result" or type: "status").

Sending a message

    Generate a unique id using the filename convention.
    Write the full JSON to inbox/<other-side>/<id>.json.tmp.
    Rename to inbox/<other-side>/<id>.json.
    Do not keep a local copy that you later mutate.

Receiving and processing

    Watch only your own inbox for new .json files (ignore .tmp).
    On new file: immediately move it to processing/<your-side>/.
    Parse and handle according to type.
    Write any reply into the other side’s inbox using the atomic pattern.
    Move the processed message to done/<your-side>/.

Local testing

Point both sides at temporary directories (or two subfolders of one temp dir). No Syncthing and no real network are required. The full request → process → reply cycle must still work.
Diagnostics

    List pending messages in your inbox and the other side’s inbox.
    Check for stuck files in processing/.
    Verify Syncthing is actually syncing (file timestamps or a simple heartbeat file).
    Prefer moving files over deleting them so history remains available for debugging.

References

    See references/protocol.md for the full schema and edge-case rules.
    See scripts/ for helper utilities (atomic write, status checker, etc.).

============================================================ FILE: references/protocol.md
Agent Handoff Protocol – Detailed Reference
Message schema

interface HandoffMessage {
  id: string;                    // must match filename without .json
  from: "mac" | "win";
  to: "mac" | "win";
  type: "request" | "review" | "result" | "status" | "setup" | "cancel";
  created: string;               // ISO-8601
  status: "pending" | "processing" | "done" | "cancelled" | "error";
  payload: Record<string, unknown>;
  // optional
  in_reply_to?: string;          // id of the message this is answering
  error?: string;
}

Filename rules

    Pattern: YYYYMMDD-HHMMSS-<from>-<seq>.json
    seq is a zero-padded counter local to that second (or a short random suffix).
    Never reuse an id.

Atomic write procedure (must be followed)

# Pseudocode
tmp = target_path + ".tmp"
write_full_json(tmp, message)
rename(tmp, target_path)          # atomic on both platforms when same filesystem

On Windows, MoveFileEx / fs.rename is atomic when source and destination are on the same volume. Keep the Syncthing share on a single volume per machine.
Processing state machine

pending (in inbox/<side>/)
   ↓  (agent claims it)
processing (in processing/<side>/)
   ↓  (success)
done (in done/<side>/)

   or

processing → error (still in processing/ or moved to done/ with status=error)

Recommended watcher behaviour

    Debounce / awaitWriteFinish of at least 200–300 ms.
    Ignore any path ending in .tmp.
    Only act on files that appear in your inbox.
    After claiming a message, the original path in inbox should no longer exist.

Heartbeats (optional but useful)

Each side may periodically write:

HANDOFF_ROOT/status/<side>.json

{
  "side": "mac",
  "updated": "2026-11-13T14:22:01Z",
  "pid": 12345,
  "watching": true
}

Update every 30–60 seconds while the agent is alive.
Setup message template

When introducing the new system, send a message of type: "setup" whose payload contains:

    title
    message (human-readable explanation of the layout and rules)
    action_required (what the other side must do and how to acknowledge)

The receiving side should reply with type: "result" or type: "status" confirming it understands and has updated its watcher.
Error handling

    If a message cannot be parsed, move it to done/<side>/ with status: "error" and an error field, and optionally notify the other side.
    Never leave a corrupted or half-written file in inbox/.

Compatibility with old single-file handoff

Once both sides are running the new protocol, stop writing to the old single handoff file. Keep it for a short transition period if needed, then remove it.
============================================================ FILE: scripts/atomic-write.js

#!/usr/bin/env node /**

    Atomic write helper for agent-handoff messages.
    Usage: node atomic-write.js <target.json> <json-string-or-file>
    Writes to target.tmp then renames to target. */

const fs = require('fs'); const path = require('path');

const [,, target, source] = process.argv;

if (!target || !source) { console.error('Usage: node atomic-write.js <target.json> json-string-or-@file'); process.exit(1); }

let data; if (source.startsWith('@')) { data = fs.readFileSync(source.slice(1), 'utf8'); } else { data = source; }

// Validate it is valid JSON JSON.parse(data);

const dir = path.dirname(target); const tmp = target + '.tmp';

fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(tmp, data, 'utf8'); fs.renameSync(tmp, target);

console.log('Wrote', target);
============================================================ FILE: scripts/status.js

#!/usr/bin/env node /**

    Quick status of the agent-handoff directories.
    Usage: node status.js [HANDOFF_ROOT] */

const fs = require('fs'); const path = require('path');

const root = process.argv[2] || process.env.HANDOFF_ROOT || path.join(process.env.HOME || process.env.USERPROFILE || '', 'agent-handoff');

function list(dir) { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; } }

function section(title, files) { console.log(\n${title} (${files.length})); if (files.length === 0) { console.log('  (empty)'); } else { files.forEach(f => console.log('  ' + f)); } }

console.log('HANDOFF_ROOT:', root);

['mac', 'win'].forEach(side => { section(inbox/${side}, list(path.join(root, 'inbox', side))); section(processing/${side}, list(path.join(root, 'processing', side))); section(done/${side}, list(path.join(root, 'done', side)).slice(-5)); // last 5 });Agent Handoff

Reliable, zero-API-key communication between CLI agents running on separate machines (typically Mac + Windows) via a Syncthing-synced folder.
When to use

    Two or more machines need to exchange structured requests, reviews, results, or status.
    You already have Syncthing running and sharing a folder.
    You want automatic pickup instead of manually feeding a handoff file.
    App tests must remain fully local (no network required for the test loop).

Core protocol
Directory layout (inside the Syncthing root)

HANDOFF_ROOT/
  inbox/
    mac/          # Windows writes messages for the Mac agent here
    win/          # Mac writes messages for the Windows agent here
  processing/
    mac/
    win/
  done/
    mac/
    win/
  locks/          # optional

Each side only reads its own inbox and only writes into the other side’s inbox.
Message format

Filename: YYYYMMDD-HHMMSS-<from>-<seq>.json
Example: 20261113-141822-win-0001.json

{
  "id": "20261113-141822-win-0001",
  "from": "win",
  "to": "mac",
  "type": "request",
  "created": "2026-11-13T14:18:22Z",
  "status": "pending",
  "payload": {}
}

Allowed type values: request, review, result, status, setup, cancel.
Atomic write rules (mandatory)

    Write the complete JSON to a temporary file ending in .tmp in the target directory.
    Rename the .tmp file to the final .json name (atomic on both macOS and Windows).
    Never edit a file after it has its final name.
    When you start processing a message, immediately move it into processing/<your-side>/ (or update status + create a lock).
    After finishing, write any reply into the other side’s inbox, then move the original into done/<your-side>/.

Ownership

    Mac agent owns inbox/mac, processing/mac, done/mac.
    Windows agent owns inbox/win, processing/win, done/win.

Setup instructions

    Locate the existing Syncthing shared folder (the one already used for the old handoff file). Call it HANDOFF_ROOT.
    Create the directory tree shown above if it does not exist.
    Implement or enable a watcher that only monitors your own inbox.
    Prefer chokidar (Node), a 1–2 s poll loop, watchexec, or fswatch. Debounce short bursts.
    On first setup, send a type: "setup" message to the other side explaining the new layout and rules. Ask for an explicit acknowledgement (type: "result" or type: "status").

Sending a message

    Generate a unique id using the filename convention.
    Write the full JSON to inbox/<other-side>/<id>.json.tmp.
    Rename to inbox/<other-side>/<id>.json.
    Do not keep a local copy that you later mutate.

Receiving and processing

    Watch only your own inbox for new .json files (ignore .tmp).
    On new file: immediately move it to processing/<your-side>/.
    Parse and handle according to type.
    Write any reply into the other side’s inbox using the atomic pattern.
    Move the processed message to done/<your-side>/.

Local testing

Point both sides at temporary directories (or two subfolders of one temp dir). No Syncthing and no real network are required. The full request → process → reply cycle must still work.
Diagnostics

    List pending messages in your inbox and the other side’s inbox.
    Check for stuck files in processing/.
    Verify Syncthing is actually syncing (file timestamps or a simple heartbeat file).
    Prefer moving files over deleting them so history remains available for debugging.

References

    See references/protocol.md for the full schema and edge-case rules.
    See scripts/ for helper utilities (atomic write, status checker, etc.).

============================================================ FILE: references/protocol.md
Agent Handoff Protocol – Detailed Reference
Message schema

interface HandoffMessage {
  id: string;                    // must match filename without .json
  from: "mac" | "win";
  to: "mac" | "win";
  type: "request" | "review" | "result" | "status" | "setup" | "cancel";
  created: string;               // ISO-8601
  status: "pending" | "processing" | "done" | "cancelled" | "error";
  payload: Record<string, unknown>;
  // optional
  in_reply_to?: string;          // id of the message this is answering
  error?: string;
}

Filename rules

    Pattern: YYYYMMDD-HHMMSS-<from>-<seq>.json
    seq is a zero-padded counter local to that second (or a short random suffix).
    Never reuse an id.

Atomic write procedure (must be followed)

# Pseudocode
tmp = target_path + ".tmp"
write_full_json(tmp, message)
rename(tmp, target_path)          # atomic on both platforms when same filesystem

On Windows, MoveFileEx / fs.rename is atomic when source and destination are on the same volume. Keep the Syncthing share on a single volume per machine.
Processing state machine

pending (in inbox/<side>/)
   ↓  (agent claims it)
processing (in processing/<side>/)
   ↓  (success)
done (in done/<side>/)

   or

processing → error (still in processing/ or moved to done/ with status=error)

Recommended watcher behaviour

    Debounce / awaitWriteFinish of at least 200–300 ms.
    Ignore any path ending in .tmp.
    Only act on files that appear in your inbox.
    After claiming a message, the original path in inbox should no longer exist.

Heartbeats (optional but useful)

Each side may periodically write:

HANDOFF_ROOT/status/<side>.json

{
  "side": "mac",
  "updated": "2026-11-13T14:22:01Z",
  "pid": 12345,
  "watching": true
}

Update every 30–60 seconds while the agent is alive.
Setup message template

When introducing the new system, send a message of type: "setup" whose payload contains:

    title
    message (human-readable explanation of the layout and rules)
    action_required (what the other side must do and how to acknowledge)

The receiving side should reply with type: "result" or type: "status" confirming it understands and has updated its watcher.
Error handling

    If a message cannot be parsed, move it to done/<side>/ with status: "error" and an error field, and optionally notify the other side.
    Never leave a corrupted or half-written file in inbox/.

Compatibility with old single-file handoff

Once both sides are running the new protocol, stop writing to the old single handoff file. Keep it for a short transition period if needed, then remove it.
============================================================ FILE: scripts/atomic-write.js

#!/usr/bin/env node /**

    Atomic write helper for agent-handoff messages.
    Usage: node atomic-write.js <target.json> <json-string-or-file>
    Writes to target.tmp then renames to target. */

const fs = require('fs'); const path = require('path');

const [,, target, source] = process.argv;

if (!target || !source) { console.error('Usage: node atomic-write.js <target.json> json-string-or-@file'); process.exit(1); }

let data; if (source.startsWith('@')) { data = fs.readFileSync(source.slice(1), 'utf8'); } else { data = source; }

// Validate it is valid JSON JSON.parse(data);

const dir = path.dirname(target); const tmp = target + '.tmp';

fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(tmp, data, 'utf8'); fs.renameSync(tmp, target);

console.log('Wrote', target);
============================================================ FILE: scripts/status.js

#!/usr/bin/env node /**

    Quick status of the agent-handoff directories.
    Usage: node status.js [HANDOFF_ROOT] */

const fs = require('fs'); const path = require('path');

const root = process.argv[2] || process.env.HANDOFF_ROOT || path.join(process.env.HOME || process.env.USERPROFILE || '', 'agent-handoff');

function list(dir) { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; } }

function section(title, files) { console.log(\n${title} (${files.length})); if (files.length === 0) { console.log('  (empty)'); } else { files.forEach(f => console.log('  ' + f)); } }

console.log('HANDOFF_ROOT:', root);

['mac', 'win'].forEach(side => { section(inbox/${side}, list(path.join(root, 'inbox', side))); section(processing/${side}, list(path.join(root, 'processing', side))); section(done/${side}, list(path.join(root, 'done', side)).slice(-5)); // last 5 });
