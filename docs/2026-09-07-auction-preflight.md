# September 7 auction preflight

## Verdict

**Not yet cleared to arm.** Local release checks pass, but GNG's underlying rankings are stale. This is a preparation checkpoint, not authenticated live-room certification. The exact real room and clock must be checked when ESPN opens the room tomorrow.

## Authenticated event and keeper baseline

On September 7 around 7:33–7:43 PM America/Chicago, the signed-in ESPN UI confirmed league **44050**, team **7**, season **2026**, and **Tuesday September 8 at 8:00 PM**. The league is 12-team PPR salary cap with $200, 14 draftable slots, QB1/RB1/WR1/FLEX2/OP1/K1/DST1 plus six bench slots. There is no dedicated TE starter. IR is not a draftable slot. ESPN's unlimited position-limit sentinel is `-1`.

The roster visibly contains Terry McLaurin and Tony Pollard. A subsequent authenticated ESPN API read confirmed nested `playerPoolEntry.keeperValue` of **$1 and $0**, respectively, and `onTeamId: 7` for both, implying **$199 available and 12 open slots**. ESPN has not yet materialized keeper picks in its draft-detail feed: both roster entries use `acquisitionType: "ADD"`, and the draft feed contains placeholders. This is why the initial dashboard import incorrectly showed zero rostered players and $200.

## Live-source result

The production source adapters were queried for PPR/12 teams/2026/two-QB at `2026-09-08T00:40:36.087Z`, using the existing server-only Keychain credential without exposing it.

| Feed | Observed result |
| --- | --- |
| FFC | OK, 262 players, September 7 provider update |
| MFL | OK, 314 players; adapter returned no provider update timestamp |
| Tradyr | OK, 198 players, `2026-09-08T00:40:16.603Z` update |
| GNG | Blocked: `GNG_PROVIDER_TIMESTAMP_STALE` |
| ESPN | Exact authenticated settings and 500/500 unique players imported through the current companion; repeat tomorrow |

GNG returned HTTP 200 and 150 rankings, but `generated_at` was `2026-08-19T11:37:39Z`, beyond the existing 14-day limit. Its September 7 `synced_at` is not a fresh ranking publication. The provider must publish a genuinely refreshed board. Do not relabel the timestamp, relax freshness, replace a source, or renormalize the fixed ESPN30/GNG20/Tradyr20/FFC15/MFL15 weights.

## Repairs and regression evidence

- Preserve $0 keeper prices in the public board and budget arithmetic; previously the board displayed a minimum $1 purchase cost.
- Permit ESPN's `-1` unlimited sentinel in position limits, not lineup counts.
- Require the configured keeper IDs, positions, and prices at readiness gates. Require exactly the keeper roster pre-room; permit legitimate additional purchases live. Do not inherit real-team keepers into generated practice-room identities.
- Exempt only pinned, exact keeper identities/prices from new-auction WON-sale evidence. Ordinary $0 acquisitions and forged keeper flags still fail.
- Preserve keeper metadata during ESPN reconciliation.
- Add a narrowly pinned pre-room import fallback for the exact league, season, and two keeper identities. Require an otherwise empty real pick feed, explicit pre-draft state, exact two-player roster, matching nested ownership, and explicit integer $0/$1 prices. Reject partial, historical, wrong-identity or live-state evidence. A config-parity test guards against drift. Companion v0.2.33 contains this fix; it does not change live bid/nomination execution.
- Apply compatible dependency-lock updates; npm audit now reports zero vulnerabilities.

Validation on this candidate:

| Check | Result |
| --- | --- |
| Initial `npm test` before edits | 688/689; latency p99 10.30 ms narrowly exceeded unchanged 10 ms limit |
| Isolated unchanged latency test | Passed; recommendation p95 1.37 ms/p99 1.02 ms; consensus p95 1.87 ms |
| Final `npm run check` after keeper-import repair | Passed lint, typecheck, build, all 697 tests |
| `npm run test:production-path` | `LIVE_CONTROL_PRODUCTION_PATH_PASSED`; snake and auction; 82 physical test clicks/82 exact acknowledgements; zero observer writes |
| `npm run test:contention` | `LIVE_CONTROL_CONTENTION_PASSED`; no errors; memory bounds passed |
| `git diff --check` | Passed |

The test clicks above are harness events, **not actions in a real ESPN draft**. These tests do not establish tomorrow's end-to-end live-room readiness.

The production-path and contention checks were repeated after the v0.2.33 import repair and passed again. Production-path action p95 was 92.97 ms (overall p99 466.81 ms includes intentionally delayed acknowledgement); contention observer p99 was 12.94 ms and writer p99 16.96 ms. All unchanged latency and memory limits passed. These are local harness measurements, not ESPN internet round-trip guarantees.

## Chrome cleanup

Two v0.2.32 companions were enabled from different directories. Kept `gbmaadbebjimdnkofnjijeneciibfiji` from `~/github/draftforge-ai/extension`. Disabled, without deleting, legacy `ifaijlickpcmpkkhheldlmfikijmleoa` from `~/draftforge-ai/extension`. No reinstall or permission expansion was performed. Closed the temporary extension-manager tab and reloaded the exact ESPN league to retire old content-script contexts. Unrelated personal tabs were preserved.

After the keeper-import repair, reloaded that same installed companion and verified Chrome reports **v0.2.33 enabled**. The exact source/package hashes are pinned in `config/draft-day-release.json`. No remove/reinstall cycle was needed.

## Availability review and final-room checklist

Reviewed the authenticated ESPN Player News feed on September 7. Follow-up items include Pacheco's IR status, Slayton's release/roster status, and current injury reports for questionable targets. Allegations, expected practice returns, and unclear timelines are not proof of a season-ending absence. Do not infer that every player is healthy from a single feed page. Recheck exact identities and authoritative status before staging any hold/veto.

Before the September 8 draft:

1. Use the supervised production build and only one enabled current companion, one managed dashboard, and one exact ESPN league/room tab. Keep Auto-Draft off.
2. Refresh all five feeds; require GNG's actual publication freshness and complete consensus coverage. Re-import exact ESPN settings and all 500 player statuses. Confirm both keepers, $199, and 12 open slots.
3. Refresh current ESPN news and official availability evidence, including season-ending injuries, suspensions and releases. Apply confirmed availability only through the separate existing hold/veto layer; the scan is time-sensitive and must be repeated tomorrow.
4. When the room opens, bind its exact identity, ensure ESPN Autopick is off, check live nominee/offer/clock and source/availability freshness, run the no-click dry run and readiness gates, then arm only if all pass.
5. During the draft, do not edit code, run simulations, or refresh sources synchronously on the action path. Chat reads the bounded status interface; the dashboard/companion owns actions.

Use [the event runbook](september-9-auction-runbook.md) for exact operating commands and recovery procedures. A stale-source failure is a stop condition, not permission to bid manually around the safety boundary.
