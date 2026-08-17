# Intelligence snapshots

DraftForge captures immutable, content-addressed five-source inputs for deterministic simulation and exact replay. Each snapshot combines a sanitized ESPN league/player profile with FFC, MFL, Tradyr, and GNG data retrieved at the same capture time.

Snapshot JSON is intentionally ignored by Git because it contains large third-party datasets. It must never contain cookies, credentials, member IDs, or real team names.

```bash
npm run snapshot:capture -- --espn outputs/source-capture/espn-profile.json
npm run snapshot:capture -- --validate snapshots/intelligence/source-v1-....json
```

Freshness is evaluated at `capturedAt`, not replay time. A capture fails closed unless all four public adapters are healthy and fresh; ESPN is the deterministic fifth source.
