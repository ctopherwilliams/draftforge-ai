# Intelligence snapshots

DraftForge captures immutable, content-addressed five-source inputs for deterministic simulation and exact replay. Each snapshot combines a sanitized authenticated ESPN league/player profile with FFC, MFL, Tradyr, and GNG data retrieved for that capture.

Snapshot JSON is intentionally ignored by Git because it contains large third-party datasets. It must never contain cookies, credentials, member IDs, or real team names.

```bash
npm run snapshot:capture -- --espn outputs/source-capture/espn-profile.json
npm run snapshot:capture -- --validate snapshots/intelligence/source-v3-....json
```

After an exact authenticated import, the loopback dashboard's `?capture=sanitized` mode emits input JSON only after the current server-recorded dashboard audit grants a short-lived one-time capture receipt. Canonical SHA-256 binds the exact sanitized league rules, ESPN players, statuses, and original player-fetch timestamp. The CLI recomputes that digest and consumes the matching in-process receipt before any public fetch; timestamp edits, byte changes, replay, expiry, or server restart fail closed. The receipt is a process-local evidence anchor, not a cryptographic signature from the Chrome extension and not a defense against a compromised local host. Schema v3 retains the consumed-receipt provenance and exact public-consensus identity inside the snapshot digest, rechecks freshness after provider I/O, and writes through an atomic rename.

Freshness is evaluated at the preserved `capturedAt`, not replay time. A capture fails closed unless all four public adapters are healthy and fresh, the draftable ESPN inventory can fill every roster and mandatory starter slot, and the scoring/team-count/season/QB parameters match the sanitized ESPN profile; ESPN is the deterministic fifth source. Replay is bound to that profile and its captured snake or salary-cap format.

Provider update time and transport retrieval time remain distinct. FFC, Tradyr,
and GNG must supply a validated provider-authored update timestamp. MFL's public
rolling ADP/AAV exports expose no equivalent timestamp, so DraftForge records
`updatedAt: null` plus the successful `retrievedAt` receipt for the explicit
30-day query; it never presents retrieval time as an MFL publication time.
