# Windows handoff, LAN hop

12 November 2026

This file asks the Windows machine for one measurement: make the Mac a second peer on the
Windows relay, and record the numbers. The code is in place. No run crossed two machines yet,
so every number in `spike/README.md` is still loopback.

## What changed for this test

Three pieces blocked a LAN address. All three accept one now.

- `spike/relay.js` reads `HOST`, and defaults to `127.0.0.1`.
- `core/browser-entry.mjs` dials `ws://${location.hostname}:${relayPort}`. A loopback page
  still dials `127.0.0.1`, and `relay=` still overrides the port for the jitter proxy.
- `spike/bridge/manifest.json` matches `http://*/*`. A Firefox match pattern cannot carry a
  port.

The Mac ran the ad, BiDi and room lanes on its own machine, and all passed. That checks the
code, not the hop.

## Steps on Windows

1. Take the folder from Syncthing. The commit is local to the Mac, so git does not carry it.
2. Build the bridge. From `spike`:

   ```
   node run.mjs --only=ad
   ```

   This writes `spike/.runtime/bridge.xpi` with the new manifest. Syncthing excludes
   `.runtime`, so each machine builds its own copy.
3. Start the relay on the LAN. In PowerShell:

   ```
   $env:HOST="0.0.0.0"; node relay.js
   ```

   The start line names the bound host. `curl http://127.0.0.1:8787/stats` returns a room
   table.
4. Open inbound TCP 8787 on the private network, in an admin PowerShell:

   ```
   New-NetFirewallRule -DisplayName "Brosr relay 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Profile Private -Action Allow
   ```

   Remove the rule after the test.
5. Read the LAN address with `ipconfig`. It looks like `192.168.x.x`.
6. Load the bridge. In Firefox open `about:debugging`, then This Firefox, then Load Temporary
   Add-on, and select `spike/.runtime/bridge.xpi`.
7. Open the room, with the LAN address in place of `<LAN-IP>`:

   ```
   http://<LAN-IP>:8787/room-b.html?role=host&room=lan&peer=host&name=Host&grant=mac
   ```

   Send the LAN address to the Mac.
8. Wait for the Mac to join. The page should show role host, one cursor and one presence
   entry. `/stats` should read `{"rooms":{"lan":2}}`.
9. For the click test, open:

   ```
   http://<LAN-IP>:8787/board.html?role=host&room=lan&peer=host&name=Host&grant=mac
   ```

   The Mac follows the navigation. Its click should land on this canvas as a synthetic point,
   which `window.__board.clicks` records with its coordinates.

## What the Mac will do

1. Load its own `spike/.runtime/bridge.xpi` the same way.
2. Open `http://<LAN-IP>:8787/room-b.html?role=peer&room=lan&peer=mac&host=host&name=Mac&capture=1`.
3. Read `document.documentElement.dataset.brosr` in the console. It holds `latencies` and
   `scroll`.
4. Click the canvas after step 9, at a known point, and report the coordinates.

## Record

Fill this table. Keep the numbers as measured, and do not round a p95 down.

| Item | Windows | Mac |
| --- | --- | --- |
| Peers in the room | | |
| Presence latency samples | | |
| Presence p95, ms | | |
| Scroll ratio | | |
| Click coordinates | | |
| Applied and dropped input | | |

Also record the Windows LAN address, the Firefox version on each side, and the time of the run.

Then:

1. Add a section to `spike/README.md` headed `LAN, two machines`. Do not put these numbers
   beside the loopback rows without that label.
2. Put the same numbers in this file.
3. Sync the folder back, so the Mac sees the result.

## Limits

- Two machines, one hop. Not WAN, not an hour, not more than two peers.
- The relay has no authentication. Use a trusted network, and remove the firewall rule.
- The bridge is a temporary add-on in Nightly or Developer Edition. Not release Firefox, and
  not a signed XPI.
- Do not claim a pass without the numbers in the table.
