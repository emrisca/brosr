# Brosr documentation

The design is split by subject so a reader can open one file. The old single file,
`docs/plan.md`, is retired: git ignores it, so the link from the README returned a 404.

| File | Contents |
| --- | --- |
| [design.md](design.md) | The idea, the competition, and what works per use case. |
| [engines.md](engines.md) | Firefox and Chromium side by side, uBlock Origin and the bridge extension. |
| [sync.md](sync.md) | The five sync layers, the wire protocol, the media policy and input. |
| [architecture.md](architecture.md) | The parts of a room, the browser surface and the transport. |
| [safety.md](safety.md) | Grants, the origin allowlist, sealing and rate limits. |
| [privacy.md](privacy.md) | What stays end-to-end sealed, what the relay sees, and what never crosses it. |
| [milestones.md](milestones.md) | M0 to M8, each with its done-when and the as-built notes. |
| [measurements.md](measurements.md) | The numbers a claim must meet, and the test lanes. |
| [scope.md](scope.md) | Risks, the v1 scope and the open questions. |
| [apps.md](apps.md) | The landing page and the apps that run on a room. |
| [progress-log.md](progress-log.md) | What changed, newest first. |
| [m0-results.md](m0-results.md) | What the M0 spike measured. |
| [remaining-work.md](remaining-work.md) | The working list of open items, dated 20 November 2026. |
| [regressions.md](regressions.md) | The guardrails and the test that holds each one. |

The code has its own READMEs: [../core/README.md](../core/README.md),
[../relay/README.md](../relay/README.md), [../spike/README.md](../spike/README.md) and
[../zen/README.md](../zen/README.md).
