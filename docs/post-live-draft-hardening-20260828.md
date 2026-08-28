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
- Auction offer transitions and sales compare exact nonzero ESPN player IDs before display names. Two different players with the same normalized display name settle independently; name fallback is used only when at least one side lacks an exact ID.
- Opponent identity is never inferred from a non-unique normalized name or abbreviation. Snake can retain a deterministic generic opponent placeholder; salary-cap ownership omits ambiguous teams and therefore cannot authorize a bid.
- ESPN sound is operator-preference telemetry. It remains visible to chat and the audit, but it does not authorize or block SELECT, NOMINATE, BID, readiness, or final certification. ESPN Autopick remains a hard gate.
- Final audit requires typed live-control evidence, fresh availability evidence, exact roster/price parity, complete legal roster construction, and full action attribution.

## Read-only chat/SRE path

`npm run draft-day:monitor` issues GET requests only. It receives at most 256 incremental events, rejects a missing sequence, a session change, stale context/pick/source timestamps, oversized responses, identity mismatch, and transport timeout. `npm run draft-day:status` is the one-shot chat path: it performs exactly one bounded (750 ms, 64 KiB) loopback GET for an atomic control-and-board snapshot and returns blocked with no recommendation whenever the server's observer-health gate detects stale or unsafe state. Neither command can POST, call Chrome/CDP, invoke the extension or engine, refresh sources, or mutate ESPN.

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

Source readiness binds content, not only five provider names. WARM and the active audit must publish the same exact scoring/team-count/season/QB profile, canonical UTC generation timestamp, and lowercase `sha256:<64 hex>` snapshot ID. The server retains a bounded fresh snapshot set and uses the exact retained tuple without refetching providers during doctor verification. A stale/malformed timestamp, wrong profile, unknown digest, or schema-v1 capture fails. The production supervisor also gives each server child a monotonic instance-start timestamp; a dashboard loaded before that server instance is rejected until it reloads and republishes.

## Release evidence

Historical pre-final-gate evidence retained from the earlier candidate:

- production typecheck/build and full repository suite: 279/279;
- deterministic engine regression: 20 complete snake plus 20 complete salary-cap drafts;
- focused live-control gate: 121/121;
- monitor chaos paths: 9/9 detected;
- read-only load: 1,000 requests, zero failures, about 4,222 requests/second, p95 2.52 ms, p99 3.20 ms;
- 500-player indexed decision p95: 0.67 ms; five-source consensus p95: 1.50 ms;
- ten-scenario visual certification: PASS across desktop, wide, ultrawide, and mobile;
- lint and `git diff --check`: PASS; dependency audit: zero vulnerabilities;
- independent P0/P1 review: GO after the stale/global auction-leader proof was removed;
- earlier five-seed synthetic matrix: 10,000 total drafts across its combined formats, zero failures and zero hard violations. This evidence predates the final exact-ID, source-binding, restart-fence, and sound-policy changes and must not substitute for the final full gate.

Current post-fix synthetic evidence:

- snake: 10,000/10,000 complete across seeds `20260828`, `18472631`, `73190422`, `41586703`, and `96724011`, with zero failures and zero hard violations;
- salary cap: 10,000/10,000 complete across the same seed family, with zero failures and zero hard violations;
- snake replay: the first 2,000-draft seed matched determinism digest `b5dc2cf5c84f35000a45256e10838d9d09e5bee7bb069ff464c2d966171ba695` and ordered outcome digest `e82d110285ff2133a749cf083ef8da2d409ce8abed252db463ff50f1ed05a63a` exactly;
- salary-cap replay: 2,000/2,000 complete for seed `20260828`; determinism digest `6305a5b2cbe02c61a8751a99270559d31b341854634939009a4ebaefc0c6ef06` and ordered outcome digest `279251a06f49915e3e69f6859d5cf65b4fab520b0731d95cf486250dc9306ebd` match the baseline exactly;
- all of these runs have `sourceSnapshotDigest: null` and are synthetic mechanics evidence, not current player-specific or authenticated ESPN certification.

Final frozen-tree mechanics evidence:

- full repository suite: 595/595 after typecheck and production build;
- focused live-control suite: 418 tests plus chaos, load, contention, and production-path probes;
- 1,000-request GET-only load: p95 2.53 ms, p99 3.89 ms, zero failures, and no sequence mutation;
- 25-second writer/observer contention: observer p99 5.40 ms, writer p99 12.41 ms, zero errors, 0.35 MiB retained heap growth, zero retained external growth, and 144.44 MiB peak RSS;
- near-cap production path: 1,890,787-byte starting ledger, 12 rapid salary writes at 75 ms, 13/13 durable exact-digest acknowledgments, one writer, concurrent 1 Hz/4 Hz observers, and no lost decision;
- two-minute soak: 480/480 polls, p95 7.37 ms, p99 28.58 ms, 59.42 MiB peak RSS, 0.956% RSS growth, and no safety incident;
- ten-viewport visual certification, lint, `git diff --check`, and dependency audit: PASS, with zero dependency vulnerabilities;
- one schema-v3 Monte Carlo run: 10,000 snake plus 10,000 salary-cap drafts, zero simulation errors, zero illegal/incomplete rosters, and zero duplicate-player, unavailable-player, specialist, position-cap, salary, reserve, max-bid, or mandatory-starter violations; determinism digest `7899ec6dea97ba0bcf677bdaba5f4b56e5fa8c2478f2889434125b3ded06dceb` and ordered-outcome digest `7b91eeebf380c55e872dfcb6c9ea67ef43010af7d704449d782c9e33b7efe9ed`;
- two independent current-code 1,000-draft replays matched determinism digest `4ef2821114eaf6c5ad3699fe9d265b14e06ef56ef990c59d3b3c96d3231ff8c1` and ordered-outcome digest `e90aabc8d058cd39151f7f3a6de69013c74fd759f8ac713180d367979d711b92` exactly; and
- exact duplicate replays of representative high-regret snake acquisition, salary underbid, and auction nomination cases were byte-identical.

The production-path probe records allocator-relative RSS growth for diagnosis but gates the live path against a 300 MiB absolute peak; the final run peaked at 206.94 MiB. Node/V8 initialization and repeated bounded checkpoint serialization made the former 96 MiB baseline-relative watermark unstable even though the dedicated post-GC contention probe showed negligible retained growth. The absolute ceiling is tighter than the former 384 MiB cap, and the separate contention gate still fails closed on retained heap or external memory.

Independent release review found no P0/P1 defect in the unchanged mechanics release. Two retrospectively selected salary underbid tails remain a shadow-experiment candidate, not authority to raise live ceilings. They use synthetic hidden outcomes, have only two full paired continuations, and do not outweigh the negative acquired surplus observed across the general $25–49 tier. No production strategy change was made from this evidence.

The exact depleted-TE adversarial failure at base seed `18472631`, trial `154`, was a harness inventory defect: the deepest 14-team variant exhausted all synthetic tight ends after two seeded news removals. The harness-only pool now covers every position cap plus a removal cushion. Exact replay is deterministic, and the full five-seed rerun passed without relaxing roster or nomination legality.

Partial authenticated Chrome state observed on 2026-08-28:

- exactly one DraftForge tab and one authenticated ESPN league tab;
- exact league `44050`, team `7`, season 2026;
- imported 12-team PPR salary-cap rules, $200 budget, 14 roster slots, QB plus OP;
- DraftForge Auto-Draft remained off and every nomination/bid control remained disabled;
- the current keyed five-source capture and an authenticated ESPN Player News review were not completed in this checkpoint and are not claimed;
- the required server-only Tradyr key is absent, no fresh authenticated schema-v3 snapshot exists, and the saved schema-v1 salary artifact is stale and noncertifying.

### 2026-08-28 availability freshness review

A read-only comparison against the official NFL news and transaction feeds found concrete evidence that the saved ESPN salary player pool is stale and must not authorize a draft:

- Jayden Higgins and Calvin Austin III are still marked healthy in the saved pool although NFL.com reports season-ending torn ACLs;
- Cedric Tillman remains attached to Cleveland although NFL.com reports that he is being released;
- Tutu Atwell remains attached to Miami although the official transaction feed records the August 27 trade to the Rams;
- Isiah Pacheco, Wan'Dale Robinson, and Cameron Dicker have new injury advisories that require current ESPN-news reconciliation, while Alec Pierce has been activated from PUP.

The official references are `https://www.nfl.com/news/texans-wr-jayden-higgins-torn-acl-out-2026-season`, `https://www.nfl.com/news/nfl-news-roundup-latest-league-updates-from-wednesday-aug-26`, `https://www.nfl.com/news/nfl-news-roundup-latest-league-updates-from-thursday-aug-27`, and `https://www.nfl.com/transactions/`. This review is not a staged availability artifact: the required authenticated ESPN Player News scan could not be completed through the current Chrome controller, so the availability gate remains blocked. Confirmed availability news stays a separate veto/advisory layer and never becomes a sixth ranking source.

The code and packaged companion are locally **GO for unchanged mechanics**. Authenticated current-source arming is intentionally **NO-GO** until a server-only Tradyr key is configured, a fresh authenticated schema-v3 5/5 snapshot with authenticated ESPN provenance and a separate availability artifact pass, and the committed/upstream-matched candidate passes its exact two-tab no-click and requested authenticated format certification. The final companion identity is v0.2.27 with packaged zip SHA-256 `526246b8a284422dfdc55d36dc57f6193a4b21a88018db2e3b511bcc4d12cc1d`.

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
