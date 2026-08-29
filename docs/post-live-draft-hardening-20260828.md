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
- Audit publication is single-flight across timeout and abort settlement. A successor cannot overlap an unresolved transport; if the prior request ignores cancellation past the bounded grace period, that publisher is permanently poisoned and cannot authorize later actions.
- Checkpoint persistence materializes each snapshot once, preserves atomic replacement plus file and directory sync, and uses exact serialized identity for collision-safe replay. An exact replay cannot mint a live-control lease that the persisted state did not already authorize, while any changed or reordered payload still traverses full transition validation.
- The final server dispatch lease is an exact, operation-aware authorization. It binds `actionId`, `decisionId`, room/dashboard identity, player, source snapshot, availability-stage digest, availability-decision digest, and immutable `notAfter`. SELECT also binds the expected pick; BID binds expected current bid, intended offer, and maximum approved bid; NOMINATE binds intended offer and TARGET/DRAIN intent. Missing, malformed, changed, or operation-inapplicable evidence mismatches fail closed.
- A decision may own exactly one action ID. A second distinct action ID for the same decision invalidates the typed live-control ledger rather than creating another executable path.
- The companion includes the action, decision, dashboard, source, availability, economics, and deadline evidence in its execution signature. After the bounded server request returns, it rechecks the exact lease acknowledgment and immutable `notAfter` against the current clock before any ESPN click, preventing expiry during verification.
- ESPN Autopick and salary-cap leader ownership are tri-state. Missing or contradictory proof is unsafe, never interpreted as OFF or “not leading.”
- Auction clocks bind to nominee plus offer. Consecutive $1 nominations cannot inherit the prior nominee's timer.
- Bids require exact ID-first nominee identity, explicit opponent-leader/outbid evidence, exact current-plus-one price, an immutable ceiling, and the one-dollar-per-open-slot reserve.
- Custom bid and nomination controls require one unique visible form, an exact settled numeric value, a paired submit control, a final pre-click revalidation, and one visible identity-and-price-scoped confirmation dialog.
- Every final click path rechecks the immutable deadline, exact ESPN context, preflight state, and freshly resolved unique control after server authorization returns. Replacement controls or state drift during the authorization wait fail closed.
- Any uncertain auction row, submit, or confirmation click sets a per-ESPN-tab latch before another action can begin. New request, decision, or session IDs cannot bypass it; only exact nonzero ESPN player-ID roster, sale, nominee, price, and leader evidence can release it. Display-name-only evidence never releases the latch, and nomination uncertainty is reconciled immediately against the latest exact context.
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

Tradyr changed its access policy on 2026-08-15. Unkeyed bulk responses are capped at 50 rows, ignore pagination, and may contain decoy entries. DraftForge now requires a server-only `TRADYR_API_KEY`, sends it only as an Authorization header, and consumes one atomic `limit=1000&offset=0` keyed board. It fails closed on limited access, response-profile drift, stale generation time, count mismatch, duplicate player identities, or missing credentials. The key is never written to URLs, logs, snapshots, browser storage, or committed files. Snapshots also bind source truth to the authenticated one-QB or two-QB ESPN profile.

On the certified Mac, production gives an explicit server environment value precedence and otherwise performs one bounded, silent read of the native Keychain item `DraftForge Tradyr` / `draftforge`. Denial, timeout, malformed output, or an unavailable Keychain leaves the source gate blocked. The credential is available only to server-side provider I/O; the snapshot-capture path borrows it only around that I/O and then restores the caller environment. The production listener probe likewise uses bounded, portable process discovery and fails closed on missing or malformed ownership evidence. CI exercises the complete live-control gate in a dedicated job.

Source readiness binds content, not only five provider names. WARM and the active audit must publish the same exact scoring/team-count/season/QB profile, canonical UTC generation timestamp, and lowercase `sha256:<64 hex>` snapshot ID. The server retains a bounded fresh snapshot set and uses the exact retained tuple without refetching providers during doctor verification. A stale/malformed timestamp, wrong profile, unknown digest, or schema-v1 capture fails. The production supervisor also gives each server child a monotonic instance-start timestamp; a dashboard loaded before that server instance is rejected until it reloads and republishes.

Dashboard source health now evaluates every provider against one explicit wall-clock instant. The prior `Array.filter` callback accidentally passed each array index as the freshness timestamp, so a valid server-accepted 5/5 envelope rendered as 1/5 and could never publish a valid audit. The shared callback-safe helper and dashboard regression test close that authorization/presentation split without changing source weights or freshness limits.

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

Historical v0.2.27 post-fix synthetic evidence:

- snake: 10,000/10,000 complete across seeds `20260828`, `18472631`, `73190422`, `41586703`, and `96724011`, with zero failures and zero hard violations;
- salary cap: 10,000/10,000 complete across the same seed family, with zero failures and zero hard violations;
- snake replay: the first 2,000-draft seed matched determinism digest `b5dc2cf5c84f35000a45256e10838d9d09e5bee7bb069ff464c2d966171ba695` and ordered outcome digest `e82d110285ff2133a749cf083ef8da2d409ce8abed252db463ff50f1ed05a63a` exactly;
- salary-cap replay: 2,000/2,000 complete for seed `20260828`; determinism digest `6305a5b2cbe02c61a8751a99270559d31b341854634939009a4ebaefc0c6ef06` and ordered outcome digest `279251a06f49915e3e69f6859d5cf65b4fab520b0731d95cf486250dc9306ebd` match the baseline exactly;
- all of these runs have `sourceSnapshotDigest: null` and are synthetic mechanics evidence, not current player-specific or authenticated ESPN certification.

Superseded v0.2.28 local mechanics evidence:

- package identity: 18 source files; unpacked-source SHA-256 `e253c4dac6bacf791bc15cc729a6229e42ef5c0f7708ae9bfca4f64c52f21074`; ZIP SHA-256 `4f0d8d06146fe58f2388b180a8b600332d11c33d9f4900450f2425c9c9374a79`;
- `npm test`: 611/611 after typecheck and production build, including 20 complete deterministic snake drafts and 20 complete deterministic salary-cap drafts;
- `npm run test:live-control`: 424/424;
- focused action-authorization suite: 135/135;
- production path: 82/82 exact acknowledgments with action p99 468.31 ms;
- GET-only load: 1,000/1,000, p95 12.59 ms, p99 20.94 ms;
- writer/observer contention: PASS;
- monitor chaos: 9/9 detected;
- short soak: 150 polls, p99 14.00 ms, 0.75% growth;
- visual certification: all ten scenarios PASS; and
- dependency audit: zero vulnerabilities.

The preceding 595/595, 418-test, 13-acknowledgment, two-minute-soak, memory, Monte Carlo, and replay measurements remain historical evidence for v0.2.27 and earlier candidates. The v0.2.28 and v0.2.29 evidence immediately above is also historical. None replaces v0.2.30's current gate or authenticates current source truth.

Independent release review found two authorization-integrity gaps and v0.2.28 closes both: the final dispatch lease had not bound every source/availability/economic field, and one decision could own multiple action IDs. The repair is narrow and fail closed, including a post-response deadline recheck. Two retrospectively selected salary underbid tails remain a shadow-experiment candidate, not authority to raise live ceilings. They use synthetic hidden outcomes, have only two full paired continuations, and do not outweigh the negative acquired surplus observed across the general $25–49 tier. No production strategy change was made from this evidence.

Final v0.2.30 local mechanics evidence:

- package identity: 18 source files; unpacked-source SHA-256 `837bc692506a7833ad059aeb9d529af72c3b3a80f2f9cfb6b3d9951dc3f28b13`; ZIP SHA-256 `1f903d6ead73e393bc7f38824c80e4f04dfc26a29ed62572144dfd1b832d820a`;
- `npm run check`: 655/655 after typecheck and production build, including 20 complete deterministic snake drafts (2,560 picks) and 20 complete deterministic salary-cap drafts (2,560 sales);
- visual certification: 10/10 states;
- `npm run test:live-control`: 465/465 focused checks plus 9/9 chaos cases;
- GET-only load: 1,000 requests, p95 2.42 ms, p99 3.69 ms;
- writer/observer contention: observer p95 4.89 ms, observer p99 5.30 ms, writer p99 7.97 ms, availability p99 5.25 ms, event-loop p99 12.57 ms, and peak RSS 134.89 MB;
- production path: 82 physical clicks and maximum one in-flight action; planning p95 2.50 ms and p99 6.32 ms, SELECT p99 92.44 ms, NOMINATE p99 89.80 ms, incremental BID p99 87.36 ms, custom BID p99 87.47 ms, event-loop p99 19.74 ms, and peak RSS 265.33 MB; and
- dependency audit: zero vulnerabilities.

This candidate adds fail-closed audit-publisher settlement, durable exact checkpoint replay, final post-authorization state/control revalidation, a cross-key per-tab auction uncertainty latch with exact-ID-only release and immediate nomination reconciliation, a server-only Keychain Tradyr reader, a portable fail-closed listener probe, and a dedicated CI live-control job. It does not change the fixed five-source weights, bid ceilings, bidding-war prevention, one-dollar reserve, sleeper protections, ESPN-only scope, or mandatory roster-completion rules.

The exact depleted-TE adversarial failure at base seed `18472631`, trial `154`, was a harness inventory defect: the deepest 14-team variant exhausted all synthetic tight ends after two seeded news removals. The harness-only pool now covers every position cap plus a removal cushion. Exact replay is deterministic, and the full five-seed rerun passed without relaxing roster or nomination legality.

Partial authenticated Chrome state observed on 2026-08-28:

- exactly one DraftForge tab and one authenticated ESPN league tab;
- exact league `44050`, team `7`, season 2026;
- imported 12-team PPR salary-cap rules, $200 budget, 14 roster slots, QB plus OP;
- DraftForge Auto-Draft remained off and every nomination/bid control remained disabled;
- the server-only Tradyr credential is now secured in native Keychain, but the current keyed five-source capture has not yet been published from the final committed revision; no fresh authenticated schema-v3 snapshot exists, and the saved schema-v1 salary artifact is stale and noncertifying;
- a later authenticated ESPN Player News scan and official-NFL comparison completed and produced the short-lived staged availability evidence described below. That stage is separate from source readiness and must be refreshed whenever its draft-day TTL expires.

### 2026-08-28 availability freshness review

A read-only comparison against the official NFL news and transaction feeds found concrete evidence that the saved ESPN salary player pool is stale and must not authorize a draft. The subsequent authenticated ESPN Player News scan completed successfully. The staged artifact contains exactly resolved hard-veto records for:

- Jayden Higgins and Calvin Austin III are still marked healthy in the saved pool although NFL.com reports season-ending torn ACLs;

The exact official references are `https://www.nfl.com/news/texans-wr-jayden-higgins-torn-acl-out-2026-season` and `https://www.nfl.com/news/nfl-news-roundup-latest-league-updates-from-wednesday-aug-26`. The ignored local artifact `outputs/availability/release-20260828.json` records the sanitized authenticated/official scan receipt and those two hard vetoes; it contains no ESPN credentials or opponent identity. Its freshness is bounded, so it must be rescanned and restaged before arming if its TTL has elapsed. Confirmed availability news stays a separate veto/advisory layer and never becomes a sixth ranking source or a substitute for the blocked exact five-source snapshot.

The code and packaged companion are locally **GO for v0.2.30 mechanics**. Authenticated current-source arming is intentionally **NO-GO**: no exact current schema-v3 5/5 snapshot has been published from the final revision, Chrome has not proven that the installed unpacked companion was reloaded to v0.2.30, and the committed/upstream-matched candidate still requires its exact two-tab no-click rehearsal, authenticated normal/rapid/recovery salary-cap rooms, authenticated snake regression, and three-hour soak. The final companion identity is v0.2.30 with 18 files, unpacked-source SHA-256 `837bc692506a7833ad059aeb9d529af72c3b3a80f2f9cfb6b3d9951dc3f28b13`, and packaged ZIP SHA-256 `1f903d6ead73e393bc7f38824c80e4f04dfc26a29ed62572144dfd1b832d820a`.

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
