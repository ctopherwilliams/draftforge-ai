# DraftForge post-live draft hardening

Date: 2026-08-28  
Scope: ESPN-only snake and salary-cap command center, companion, source integrity, and read-only chat monitoring.

## Release objective

The dashboard and companion are the only production writer. Chat and terminal tooling are read-only observers of a compact, loopback-only event stream. No live action is permitted unless the exact ESPN league, team, season, room tab, DraftForge tab, command-center session, clock, action surface, five-source snapshot, and availability artifact are current and authoritative.

## Failure classes closed after the live snake draft

- Snake recommendations publish immediately, then submit at a deterministic but varied 22–30 seconds remaining. This leaves time for operator awareness while preserving a ten-second hard floor.
- Every action has a bounded result watchdog. A lost result disarms the writer and never retries a post-click outcome.
- A selected-but-unconfirmed player is post-click uncertainty. DraftForge does not click the same player or a fallback again.
- Action request IDs are scoped to a validated command-center session. A dashboard reload cannot collide with the ESPN tab's prior idempotency cache.
- MV3 worker restart restores authority only after revalidating both bound tabs and the exact live ESPN identity. Closing either tab revokes persisted authority.
- A verified ESPN tab replacement preserves the append-only action/attribution/incident ledger only between actions. It never replaces history and Auto-Draft remains off until the fresh checklist passes.
- A stale or replacement audit publisher immediately disarms DraftForge; it cannot keep acting while chat observes an obsolete ledger.
- ESPN Autopick and salary-cap leader ownership are tri-state. Missing or contradictory proof is unsafe, never interpreted as OFF or “not leading.”
- Auction clocks bind to nominee plus offer. Consecutive $1 nominations cannot inherit the prior nominee's timer.
- Bids require exact ID-first nominee identity, explicit opponent-leader/outbid evidence, exact current-plus-one price, an immutable ceiling, and the one-dollar-per-open-slot reserve.
- Custom bid and nomination controls require one unique visible form, an exact settled numeric value, a paired submit control, a final pre-click revalidation, and one visible identity-and-price-scoped confirmation dialog.
- HOLD, WALK, and DRAIN outcomes are no-click terminal decisions. They never fabricate click lifecycle events or price-enforce a drain nomination.
- Auction sales, tracked offers, own nominations, and clock caches are scoped to the exact draft instance and bounded. ESPN SPA navigation cannot import prior-room state.
- Final audit requires typed live-control evidence, fresh availability evidence, exact roster/price parity, complete legal roster construction, and full action attribution.

## Read-only chat/SRE path

`npm run draft-day:monitor` issues GET requests only. It receives at most 256 incremental events, rejects a missing sequence, a session change, stale context/pick/source timestamps, oversized responses, identity mismatch, and transport timeout. It cannot call the extension or mutate ESPN.

Release budgets:

- monitor p95: at most 25 ms;
- monitor p99: at most 50 ms;
- one production action writer;
- at most one in-flight action;
- zero duplicate clicks, self-bids, ceiling violations, reserve violations, incomplete rosters, duplicate players, or redundant K/DST;
- exact cleanup of managed DraftForge/ESPN practice tabs only.

## Source and availability integrity

The ranking model remains the deterministic fixed-weight consensus:

- ESPN 30%
- GNG 20%
- Tradyr 20%
- Fantasy Football Calculator 15%
- MyFantasyLeague 15%

Confirmed availability news is a separate hold/veto layer and never becomes a sixth ranking source. The stage is loopback-only, bounded, schema-validated, content-addressed, and short-lived. Missing, stale, ambiguous, or contradictory evidence blocks arming.

Tradyr changed its access policy on 2026-08-15. Unkeyed bulk responses are capped at 50 rows, ignore pagination, and may contain decoy entries. DraftForge now requires a server-only `TRADYR_API_KEY`, sends it only as an Authorization header, and fails closed on limited access, ignored/mismatched offsets, duplicate pages, incomplete totals, or missing credentials. The key is never written to URLs, logs, snapshots, or browser storage. Snapshots also bind source truth to the authenticated one-QB or two-QB ESPN profile.

## Release evidence

Completed for the local candidate:

- production typecheck/build and full repository suite: 279/279;
- deterministic engine regression: 20 complete snake plus 20 complete salary-cap drafts;
- focused live-control gate: 121/121;
- monitor chaos paths: 9/9 detected;
- read-only load: 1,000 requests, zero failures, about 4,222 requests/second, p95 2.52 ms, p99 3.20 ms;
- 500-player indexed decision p95: 0.67 ms; five-source consensus p95: 1.50 ms;
- ten-scenario visual certification: PASS across desktop, wide, ultrawide, and mobile;
- lint and `git diff --check`: PASS; dependency audit: zero vulnerabilities;
- independent P0/P1 review: GO after the stale/global auction-leader proof was removed;
- five-seed synthetic matrix: 10,000/10,000 drafts across snake and salary cap, zero failures and zero hard violations. This matrix is deterministic engine-regression evidence and does not certify current source truth.

The exact depleted-TE adversarial failure at base seed `18472631`, trial `154`, was a harness inventory defect: the deepest 14-team variant exhausted all synthetic tight ends after two seeded news removals. The harness-only pool now covers every position cap plus a removal cushion. Exact replay is deterministic, and the full five-seed rerun passed without relaxing roster or nomination legality.

Authenticated no-click Chrome evidence on 2026-08-28:

- exactly one DraftForge tab and one authenticated ESPN league tab;
- exact league `44050`, team `7`, season 2026;
- imported 12-team PPR salary-cap rules, $200 budget, 14 roster slots, QB plus OP;
- short-lived availability artifact staged and the authenticated ESPN Player News feed reviewed;
- DraftForge Auto-Draft remained off and every nomination/bid control remained disabled;
- fresh FFC, MFL, and GNG feeds returned successfully; Tradyr returned `TRADYR_API_KEY_REQUIRED`;
- both saved snake and salary-cap pre-room gates returned `SOURCE_WARMUP_FAILED` because five-source coverage was incomplete.

Therefore the local code candidate is GO, while authenticated current-source arming is intentionally **NO-GO** until a server-only Tradyr key is configured and a fresh complete 5/5 snapshot and no-click pre-room rehearsal pass. The companion package remains v0.2.26, SHA-256 `96acc8438a0f5ca2e66bd780afe7432581f95198ff0c5a8cd943b6318b478791`.

## Rollback and no-go triggers

Do not arm or immediately disarm on any of the following:

- fewer than five fresh, complete sources;
- missing or expired availability stage;
- unknown/active ESPN Autopick;
- unknown salary-cap leader ownership;
- ambiguous tabs, changed league/team/season/session, or unverified rebound;
- unknown/unsafe clock or unstable player pool;
- any unresolved prior action or post-click uncertainty;
- price above the exact ceiling, nonincremental bid, self-bid, DRAIN bid, or reserve breach;
- monitor sequence/session gap or audit publisher conflict;
- source, roster, sale, or attribution mismatch.

Recovery is to stop automatic actions, preserve the ledger, revalidate the exact room and rules, rerun the no-click checklist, and only then explicitly re-arm. Never edit or rebuild code inside a real draft room.
