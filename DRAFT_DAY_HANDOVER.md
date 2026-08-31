# DraftForge draft-day handover

This is the operational source of truth for running an ESPN draft with Codex as the strategy/status cockpit, DraftForge as the command center and sole production writer, and Chrome as the execution surface. The current event-specific priority is the September 9, 2026 salary-cap draft documented in [docs/september-9-auction-runbook.md](docs/september-9-auction-runbook.md); that runbook supersedes snake rehearsal work for this event. New operators should first read [DRAFT_DAY_OPERATOR_CANVAS.md](DRAFT_DAY_OPERATOR_CANVAS.md). Read this handover before every rehearsal and real draft. Update the **Certification ledger** and **Known launch risks** whenever a rehearsal changes the evidence.

For implementation history and exclusions, see [AGENT_HANDOFF.md](AGENT_HANDOFF.md). For installation or migration, see [MIGRATION.md](MIGRATION.md). For source definitions and weights, see [docs/data-sources.md](docs/data-sources.md).

## Operating model

| Surface | Responsibility |
| --- | --- |
| Codex conversation | Strategy/status cockpit: run terminal checklists, read the sanitized GET-only status, explain decisions, and report exceptions. It never writes ESPN or mutates DraftForge control state. |
| DraftForge dashboard | Command center and writer: show the exact action, clock, bid ceiling, protected reserve, roster needs, alternatives, source health, and safety state; own import, confirm, arm, hold/resume, Guided approval, and recovery controls. |
| Authenticated ESPN tab | Execution surface: provide authoritative rules, room state, player availability, bids, picks, roster confirmation, sound state, and Autopick state. |
| Chrome companion | Narrow enforcement layer: act only in the exact imported tab, league, team, clock, player/nominee, and offer state. |
| `draft-day:status` | Read-only chat view: exactly one bounded (750 ms, 64 KiB) loopback GET for one atomic control-and-board snapshot; no Chrome/CDP, POST, source refresh, engine call, or ESPN action. A stale or unsafe snapshot returns blocked with no recommendation. |

Keep Codex open in the desktop app and exactly two companion-managed Chrome tabs: `http://127.0.0.1:3000` and the one authenticated ESPN lobby or live room. During the live draft, keep those as the active tab in separate Chrome windows so Chrome cannot background-throttle ESPN's exact action timers. Codex Chrome control is optional and is not a readiness requirement. Do not use a development server, multiple ESPN draft rooms, or a stale dashboard on draft day.

### Control boundary

- The DraftForge dashboard, loopback server, and DraftForge companion are the complete production control plane.
- Chat and terminal status tools are GET-only observers. They cannot import, confirm, arm, hold, resume, approve a Guided action, navigate recovery, or click ESPN.
- A human or optional external controller performs those visible setup/control interactions in the dashboard. After explicit arming, the companion operates independently and an external-controller disconnect does not interrupt or expand its authority.
- Codex/ChatGPT Chrome control, Computer Use, CDP, Playwright, Puppeteer, and remote-debugging transports are never release dependencies and can never satisfy a writer or dispatch lease.

## Non-negotiable safety rules

- ESPN-only. No post-draft league management.
- Five deterministic sources: ESPN, FFC, MFL, Tradyr, and GNG.
- Never act with stale or incomplete source coverage.
- Never act on an unverified, short, opponent, or changed clock.
- Never act in the wrong league, team, tab, player, nominee, or offer state.
- ESPN Autopick must remain off. ESPN sound is an observed operator preference; muted is recommended for testing, but on/off state does not authorize or block an action.
- Salary-cap bids may not exceed the exact live ceiling or consume the $1-per-open-slot reserve.
- No bidding wars, duplicate players, position-cap violations, or unnecessary second K/DST.
- Mandatory starter and specialist completion overrides discretionary depth in the endgame.
- ESPN roster confirmation is the only action-success signal.
- Every irreversible action requires an unexpired exact server dispatch lease binding one decision to one action ID, the source and availability digests, and the operation-specific pick, offer, ceiling, or nomination intent. Browser authority must also match the exact app tab, ESPN tab, audit session, command-center document, ESPN producer, and binding generation under the current 1.5-second writer lease. The companion must recheck `notAfter` after the server response and before any click; a heartbeat or action can never mint or resurrect expired authority.
- Any ambiguity means stop. A failed or missed ESPN action never counts as a DraftForge pass.

## Certification ledger

Last updated: 2026-08-31.

| Gate | State |
| --- | --- |
| 2026-08-31 September 9 auction candidate | **Local mechanics PASS** for the focused “It’s Fun To Do Bad Things XVII” salary-cap target. The full suite passes 689/689, including 20 complete deterministic salary-cap drafts (2,560 sales); lint, typecheck, production build, and dependency audit pass; visual certification passes 11/11 with zero baseline distance. The isolated production path records 82/82 exact acknowledgements, zero observer writes, one maximum in-flight writer, BID p99 below 90 ms, overall action p99 470.993 ms, critical durable-audit p99 39.859 ms, event-loop p99 21.742 ms, and bounded memory. Independent contention completes every scheduled request with observer p99 8.617 ms, writer p99 13.792 ms, availability p99 6.668 ms, event-loop p99 12.583 ms, stable ledger, zero errors, and 117.813 MB peak RSS. A current exact-profile source warm returned `FIVE_SOURCE_READY` for PPR/12-team/2026/two-QB with 5/5 sources and snapshot `sha256:c9149c7046b0b1353d98ca9a8301f7748b66072105a733fe009bd57df966e8bc`. The authenticated league import, 500-player status pool, v0.2.32 companion, no-reinstall recovery, and availability gate were previously proven on this Mac; the current active audit was intentionally invalidated by the certification server restart and must be republished by the final September 9 pre-room import. Future player news and the unopened live room remain time-bound pending gates, not local test failures. |
| 2026-08-28 post-live control candidate | Local mechanics gate **PASS** for companion v0.2.31: source SHA-256 `09a808245d2769264de12118b99001afc0a703bf93406d9236c67c0845abd194`, ZIP SHA-256 `733e572fbc281ce26d24e4e97047fd1329e5d7976c40544db82d557ee82e1268`, 19 files. The full test suite passes 683/683 with 20 deterministic snake drafts (2,560 picks) and 20 deterministic salary-cap drafts (2,560 sales); visual certification passes 11/11 states; and live control passes 477/477 focused checks plus 9/9 chaos. The 1,000-request load completes 1,000/1,000 at p95 3.917 ms and p99 6.415 ms. Contention records observer p95 4.902 ms, observer p99 6.147 ms, writer p99 9.809 ms, availability p99 5.282 ms, event-loop p99 12.616 ms, and peak RSS 137.438 MB. The production path records 82 physical clicks, 82 exact acknowledgments, zero observer writes, maximum one in-flight action, planning p95 2.346 ms and p99 5.598 ms, SELECT p99 88.888 ms, NOMINATE p99 138.821 ms, incremental BID p99 94.394 ms, custom BID p99 86.469 ms, overall action p99 464.799 ms, event-loop p99 24.822 ms, and peak RSS 205.578 MB. Dependency audit reports zero vulnerabilities. The release adds exact per-document/per-producer/generation browser authority, a 1.5-second non-minting writer lease, safe successor handoff, stale-result fencing, and a tested production boundary that excludes external browser controllers while retaining fail-closed publisher settlement, exact checkpoint replay, post-authorization revalidation, auction uncertainty reconciliation, Keychain credential isolation, and portable process control. Current authenticated arming remains **NO-GO** until an exact current 5/5 schema-v3 snapshot is published, Chrome proves the installed companion is v0.2.31, and the exact two-tab no-click, authenticated normal/rapid/recovery salary-cap, snake regression, and three-hour soak gates pass. Synthetic or local evidence does not certify current rankings or a room. |
| Historical local release gate | v0.2.24: 201/201 tests, lint, typecheck, production build, UI, extension safety, replay, managed workspace cleanup, recovery targeting, and latency passing; visual certification covered pre-room plus snake/salary command centers at 390, 1440, 1728, and 2560 widths with nine zero-distance captures and one accepted one-pixel mobile distance. This does not certify the current working tree. |
| Historical deterministic drafts | 20/20 snake and 20/20 salary-cap complete and legal under the recorded candidate |
| Historical live-snapshot Monte Carlo | Seed `20260820`: 10,000 snake + 10,000 salary-cap, including 4,000 exposed holdouts; zero failures, hard violations, or simulation errors under that snapshot |
| Historical overnight battle qualification | Four 5-draft batches per format: 20/20 snake + 20/20 salary cap, exact holdout replay, zero hard violations |
| Historical post-sleeper authenticated ledger | 19/20 snake and 15/20 salary-cap; retained as historical evidence |
| Historical final clean-room authenticated campaign | 20/20 snake and 20/20 salary-cap; every countable room final-audited under its immutable release; contaminated and incomplete rooms excluded |
| Historical authenticated latency | Snake 16/16: submit p95 1.140s, p99 1.175s, max 1.184s; salary cap 14/14: submit p95 0.720s, p99 1.414s, max 1.717s |
| Historical cold-start and recovery | Server, tab, extension, source, stale-action, and ESPN-Autopick recovery paths passed fail-closed checks; contaminated recovery room `1446060763` remains excluded |
| Historical 2026-08-21 READY gates | Saved snake and salary-cap profiles returned `DRAFT_DAY_READY` under that release's then-current exact settings and sources. This does not satisfy the 2026-08-28 keyed/schema-v3 source gate. |
| v0.2.17 authenticated pre-room | League `44050`, team `7`: exact QB+OP salary-cap rules, two-QB intelligence profile, 5/5 sources, exactly two Chrome tabs, companion v0.2.17, settings confirmed, Auto-Draft off, and `DRAFT_DAY_READY` |
| v0.2.17 authenticated recovery and completion | Salary-cap room `1778564226`: deliberate dashboard-reload recovery, exact two-window/two-tab workspace, 14/14 ESPN/app player-and-price parity, $182 spent/$18 remaining, K/DST complete, zero violations, muted sound, ESPN Autopick off, automatic shutdown, and `DRAFT_AUDIT_READY` |
| v0.2.22 authenticated cold-start and server recovery | Snake room `1221310079`: one-shot pre-room watch bound before the opening slot, first pick submitted with 27 seconds left, deliberate server outage at 2/16 recovered without reloading ESPN, exact 16/16 parity, zero violations, muted sound, ESPN Autopick off, automatic shutdown, and `DRAFT_AUDIT_READY` |
| v0.2.24 final candidate | Same live action and engine path as v0.2.23 plus one-dashboard election, exact owned-tab cleanup, healthy-room reuse, managed-cleanup readiness, and final-audit practice-workspace closure; package SHA-256 `ff42c6a085f5973d35e34e9766ca1b90c563be6a337998c8d4a17069f1dbe3b1`; full local and visual gates pass |
| v0.2.24 authenticated lifecycle certification | Salary-cap room `1551126922` completed 14/14 with exact player-and-price parity, $186 spent/$14 remaining, K/DST, deliberate recovery, muted sound, ESPN Autopick off, automatic shutdown, exact practice-tab cleanup, and `DRAFT_AUDIT_READY`. Snake room `1586041611` completed 16/16 with exact parity, K/DST, 5/5 sources, 16 confirmed automatic actions, muted sound, ESPN Autopick off, automatic shutdown, exact practice-tab cleanup, and `DRAFT_AUDIT_READY`. |
| 2026-08-21 authenticated no-action dry run | Both saved pre-room profiles returned `DRAFT_DAY_READY` with 5/5 fresh sources and zero actions. The fresh SOMFAB import showed that ESPN changed the saved snake league from Standard to PPR; the stale profile failed closed on `exactScoring`, then passed after the current profile and warm command were corrected. No draft room opened, Auto-Draft and ESPN Autopick remained off, the watch was disarmed, and Chrome returned to one DraftForge tab. |
| Excluded v0.2.24 recovery drill | Snake room `290283938` was deliberately excluded: an optional recovery was started after ESPN had already advanced to the team's 30-second clock; DraftForge refused the unsafe late action, ESPN timed out and enabled its own Autopick, and the exact room was closed. Never schedule an optional recovery during or immediately before an own-turn window. |
| Deterministic holdout replay | 2,000 snake + 2,000 salary-cap records replayed byte-for-byte with zero mismatches |

Do not advance an authenticated count without a complete final-ready loopback audit. Historical evidence is machine-readable in `simulation/evidence/authenticated-certification-20260818.json`; it does not certify the current working tree or current sources, and older excluded rooms must not be retroactively counted.

## T-24-hour preparation

1. Confirm the machine, power, network, Chrome login, ESPN login, and Codex task are available.
2. Pull and verify the merged release outside the live-draft window:

   ```bash
   cd /Users/chris/github/draftforge-ai
   git switch main
   git pull --ff-only
   npm install
   npm run check
   ```

3. Confirm Chrome reports companion v0.2.31 loaded from this repository's `extension/` directory, and verify `config/draft-day-release.json` matches source SHA-256 `09a808245d2769264de12118b99001afc0a703bf93406d9236c67c0845abd194`, ZIP SHA-256 `733e572fbc281ce26d24e4e97047fd1329e5d7976c40544db82d557ee82e1268`, and 19 source files. Older authenticated rooms and package digests remain historical regression evidence; the current candidate must receive its own authenticated no-click and salary-cap certification after the keyed schema-v3 source gate passes. The dashboard preflight must also report companion-managed workspace cleanup ready.
4. Run one cold-start, no-click rehearsal for the exact league. Do not wait until the real room opens to discover an ESPN login, companion, source, or firewall problem. External browser-control availability is not a gate.
5. Keep the companion zip digest and current release evidence in [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

## Cold-start kickoff

1. Quit Chrome completely. Stop any old DraftForge server. If rebuilding, stop the server before `npm run build`; never replace `dist` beneath a running production process.
2. Start one production server:

   ```bash
   cd /Users/chris/github/draftforge-ai
   npm run start
   ```

3. Confirm the server reports `http://127.0.0.1:3000`.
4. Open only the local dashboard and the authenticated ESPN league lobby in Chrome.
5. In Codex, use this kickoff message:

   > Draft day. Use the exact named ESPN league and team. Run the complete cold-start checklist. Keep Auto-Draft off and do not create or enter the room until you report READY.

6. Import the league from ESPN. Verify draft type, scoring, teams, roster slots, position caps, keepers, timer, budget, and team identity from the authenticated response rather than memory.
7. Start production with the free Tradyr key available only through `TRADYR_API_KEY` or the certified Mac's native `DraftForge Tradyr` / `draftforge` Keychain item. The launcher performs one bounded Keychain read and never logs or forwards the secret to Chrome; an unavailable credential leaves the five-source gate blocked. Warm the five sources with the imported scoring and league size. The exact salary-cap certification target is “It’s Fun To Do Bad Things XVII” (league `44050`, team `7`, season `2026`), which currently uses:

   ```bash
   npm run draft-day:warm -- --scoring PPR --teams 12 --season 2026 --qbs 2
   ```

   This command warms only the exact scoring/team-count/season/QB source profile. Authenticated league and team proof comes from the dashboard audit and the subsequent `draft-day:ready` gate; unsupported flags fail instead of being ignored.

8. Require `FIVE_SOURCE_READY` before room creation. The WARM response and live dashboard audit must match on exact scoring/team-count/season/QB profile, canonical UTC generation timestamp, and lowercase `sha256:<64 hex>` snapshot ID. An older profile, stale timestamp, schema-v1 artifact, or dashboard loaded before the current production-server instance must fail. Reload the dashboard after a server restart and rerun the gate. A cold warmup may take about 20 seconds.
9. Require the exact saved-profile gate before creating the room:

   ```bash
   npm run draft-day:ready -- --format snake --phase pre-room
   # or
   npm run draft-day:ready -- --format salary-cap --phase pre-room
   ```

   Do not continue unless it returns `DRAFT_DAY_READY` with no blockers and `Auto-Draft OFF`.

## First READY gate: before the room

Codex must report one compact result that includes:

- exact league and team;
- snake or salary-cap format;
- scoring, teams, roster slots, position caps, keepers, timer, and budget;
- extension connected;
- five fresh sources;
- selected strategy;
- production server and two-tab Chrome state; and
- `Auto-Draft OFF`.

If any line is not ready, do not open the room.

## Second READY gate: inside the room

After the pre-room gate passes, use **Confirm + arm live draft** once. This stores a bounded, one-shot intent for the exact authenticated source league, team, season, and draft type. After ESPN creates the room, the companion must verify the generated room's exact identity and rules, revalidate every live check against its exact tab, and only then arm; any mismatch leaves Auto-Draft off.

Verify the complete live-room dry run:

- one exact ESPN draft tab matches league and team;
- live pool, roster, clock, and action controls resolve;
- ESPN sound state is visible as operator-preference telemetry; either on or muted is legal;
- ESPN Autopick is off;
- five sources remain fresh;
- the no-click engine returns one legal recommendation;
- salary-cap ceiling, reserve, nomination, and next-offer state are exact; and
- DraftForge is still off.

For a regulation-timer room, run the matching terminal command with `--phase live`; it must return `DRAFT_DAY_READY`. A 30-second practice room may use the dashboard's identical in-process checklist and exact-tab revalidation so terminal startup cannot consume the opening clock. Neither path weakens the action guards.

Only then may the user arm Auto-Draft from the local DraftForge dashboard for that named room. Arming is scoped to the room and resets on reload, league switch, safety failure, completion, `hold`, or `stop`.

## Companion-owned recovery

The companion owns exact-tab selection, stale DraftForge cleanup, room reconciliation, and ESPN action authority. Recovery controls are deliberately loopback-only and visible in the local dashboard. An optional external controller may click them, but it is not trusted as a writer and is not required once armed auto is healthy.

- `http://localhost:3000/?reloadCompanion=1` reloads the already-installed unpacked companion from disk. Reload the dashboard so the new bridge context is active. Never run this inside an active action window.
- A loopback-only `recoverLive=1` command requires the exact generated practice-room league ID, source league ID, team, and season. It fails closed unless exactly one matching ESPN live room exists, reuses a healthy exact companion context without reloading ESPN, reloads only when that context is missing, imports authenticated settings and roster, closes only stale DraftForge tabs plus the matching source-league parent, and keeps ESPN visible in its own Chrome window. It never closes unrelated ESPN or browser tabs.
- After a final-ready parity audit, the dashboard automatically requests closure of the exact generated practice room, matching source-league parent, and stale DraftForge dashboards. Live verification still requires ESPN's league name to begin with `Practice Draft for `. If ESPN has expired the room, the audit fallback requires the exact generated room ID, Chrome tab ID, parity, automatic shutdown, and a room ID distinct from the real source league. A manual loopback-only `closePractice=1` command retains the same proof boundary.
- On every local handshake, the companion elects the newest exact DraftForge dashboard and closes only older DraftForge-origin dashboards. The manual `cleanWorkspace=1` path may additionally close `about:blank` tabs only when an operator supplies their exact observed IDs. Neither path closes Gmail, an unrelated ESPN page, an arbitrary blank tab, or any other user tab.
- Every recovery turns Auto-Draft off and settings confirmation false. Re-warm five sources if needed, confirm the imported checklist in the local dashboard, rerun the live dry run, and explicitly re-arm the exact room.
- Optional recovery drills must run before the room starts, while ESPN is paused, or only after authoritative state proves the team is safely outside its action window. Do not begin an optional recovery during or immediately before an own snake turn; 30-second Auto-team mocks can advance an entire round while the checklist is being rebuilt.

## Live-draft protocol

Use armed auto with chat supervision when the clock is short. Use Guided mode when there is enough time for per-action approval.

The exact successful live doctor gate automatically creates an ignored local code-freeze record bound to the clean, upstream-matched Git revision, saved source league, team, and exact ESPN room:

```bash
npm run draft-day:doctor -- --format snake --phase live --league <exactLiveRoomId> --team <teamId>
# or use --format salary-cap
```

There is no manual arm command. While this record is active, npm lifecycle guards reject dev/hot reload, builds, tests and simulations, source snapshot/warm commands, and companion packaging. `npm start` deliberately remains available so the already-certified production artifact can restart without rebuilding it. `npm run draft-day:freeze -- status` reports the exact frozen identity and revision.

The exact `draft-day:audit --require-complete` command in the completion section automatically clears the freeze only after the requested room/team returns a final-ready, complete, parity-matched audit on the same revision. An emergency clear is not a normal recovery step. If the frozen artifact cannot safely continue, first disarm live actions, then copy the identity-bound confirmation token from `draft-day:freeze -- status` and provide all exact fields plus a 20–500 character incident reason:

```bash
npm run draft-day:freeze -- clear \
  --league <savedSourceLeagueId> --team <teamId> --room <exactLiveRoomId> \
  --emergency-reason "<why the certified artifact cannot safely continue>" \
  --confirm-emergency "<exact token from freeze status>"
```

Emergency clear writes a local hashed-reason receipt under `.draftforge/`; it does not authorize a hurried rebuild or re-arm inside an unsafe action window.

Short chat requests are observational or advisory unless the user separately performs the visible dashboard control:

- `status` — report clock, action, roster needs, budget/reserve, and next targets;
- `explain` — explain the current recommendation without changing it;
- `draft it`, `bid`, or `pass` — ask for the recommended Guided action; approve it in the dashboard;
- `hold` or `stop` — ask for a stop, then use the dashboard control unless armed auto has already failed closed;
- `resume` — ask for refreshed checks, then re-arm in the dashboard only after they pass; and
- `switch strategy after this action` — change strategy only between safe action windows.

During a live clock, Codex should report only the decision-critical line, for example:

> BID $28 — ceiling $31 · reserve safe · TE starter open · 18 seconds

For a read-only query that cannot dispatch a browser action, use:

```bash
npm run draft-day:status -- --league <exactLiveRoomId> --team <teamId>
```

The command reads one atomic server snapshot rather than joining different publisher moments. It is safe to run alongside live execution because it performs exactly one bounded loopback GET and has no writer capability; any stale or unsafe observer-health dimension returns blocked with no recommendation.

Do not refresh source truth in the middle of a decision. For material late news, hold, refresh all five sources between action windows, verify the new coherent snapshot, and then resume. ESPN availability and exact action state are still revalidated immediately before every click.

## Stop conditions

DraftForge must fail closed and Codex must report the exact reason for any of these:

- source degradation;
- Chrome or companion disconnect;
- wrong or ambiguous tab/league/team;
- ESPN Autopick active or unknown;
- short, missing, opponent, or changed clock;
- changed player, nominee, bid, pick, or action control;
- missing roster confirmation;
- salary, reserve, ceiling, mandatory-slot, or position-cap risk; or
- a stale authorization modal after any room/context change.

Do not improvise around a stop condition. Fix or re-establish the exact state, rerun the second READY gate, and resume only from a fresh authorization.

## Completion and handoff

DraftForge must shut itself off after roster completion. Then run:

```bash
npm run draft-day:audit -- --league <liveLeagueId> --team <teamId> --require-complete
```

Count the room only when the audit proves exact ESPN/app roster parity, exact salary-cap prices, legal completion, mandatory K/DST, position caps, reserve and max-bid compliance, five-source readiness, recorded sound telemetry, ESPN Autopick off, exact tab binding, and automatic DraftForge shutdown. Sound on versus muted is not a pass/fail criterion.

Record the room ID, format, roster, prices/budget when applicable, audit result, exercised retries, source coverage, and count change in [AGENT_HANDOFF.md](AGENT_HANDOFF.md). Update the ledger in this document in the same commit. Close the completed ESPN tab and leave no stale room open.

## Known launch risks

- The server-only Tradyr credential is present in the certified Mac's Keychain. Production startup now performs one bounded, non-logging read of that exact item when `TRADYR_API_KEY` is absent; denied or locked Keychain access remains an explicit source blocker instead of silently trusting unkeyed data. Authenticated launch remains blocked until a fresh schema-v3 snapshot passes exact profile, canonical timestamp, authenticated ESPN provenance, atomic keyed-board completeness, coverage, and digest checks. Tradyr's unkeyed bulk response is capped at 50 and may contain decoys; the stale schema-v1 salary capture is regression-only evidence and must never arm a draft. Chrome must then prove the installed unpacked companion was reloaded to v0.2.31 before the exact two-tab no-click, authenticated normal/rapid/recovery salary-cap, snake regression, and three-hour soak gates run.

- Historical internal companion/dashboard recovery passed a clean two-tab cold start and a deliberate in-room dashboard reload, including Auto-Draft resetting off, exact-room re-import, full revalidation, safe re-arming, 16/16 parity, and automatic shutdown. The installed v0.2.31 identity and its exact current two-tab writer binding are not yet proven for the current candidate; external Chrome-controller claim/reclaim is intentionally outside certification. ESPN/Chrome drift can recur, so every real draft must run both READY gates.
- The expanded 2026-08-19 snapshot improved player-level coverage to 60.12% at four or more sources and 47.62% at all five, but GNG remains the shortest model board at 150 rows and not every late player can be corroborated. Treat confidence and sleeper labels accordingly.
- The immutable expanded snapshot produced zero production-qualified sleeper signals. The latest fresh saved-snake pre-room state now produces two unchanged-threshold, five-source candidates (Jalen Hurts and Kyler Murray), while salary cap produces none. Treat these as current recommendation evidence, not authenticated sleeper-acquisition outcome evidence, until countable rooms exercise them.
- Fresh room imports forcibly reset Auto-Draft and old-room telemetry. The one-shot pre-room watch now carries explicit arm intent into exactly one rule-matching room and revalidates the live tab before enabling Auto-Draft. Any missed identity, source, Autopick, player-pool, roster, clock, or action-surface check leaves it off; sound state remains visible telemetry. Any ESPN Autopick contamination excludes that room.
- Rebuilding `dist` invalidates a running vinext process. Release work must stop the production server before build and start exactly one new server afterward. The authenticated interruption rehearsal separately proves that stopping and restarting the server without a rebuild does not require reloading the ESPN room.
- The final v0.2.16 authenticated snake room removed the repeated late-round submit tail without weakening identity or clock checks: p95 1.140 seconds, p99 1.175 seconds, and maximum 1.184 seconds. The bounded profile activates only after ten confirmed snake roster slots; early snake, salary-cap, and mandatory K/DST paths are unchanged.
- ESPN practice rooms may disappear after completion; the loopback audit must be captured before the tab is closed or ESPN deletes the state.
- Companion v0.2.17 preserves a pending salary-cap sale for at most five context polls when ESPN briefly removes the budget surface between nominations. Focused tests prove the delayed closing price and subsequent nomination are recorded in order, and authenticated room `1778564226` completed with exact 14/14 player-and-price parity after an in-room dashboard recovery. The bounded limit prevents a malformed room from stalling tracking.

## Maintenance rule

Every engine, extension, source, UI-action, or safety change requires `npm run check`, a companion version bump when extension code changes, a rebuilt companion zip, deterministic 20+20 drafts, focused regression evidence, and this handover reviewed for drift. Strategy changes additionally require paired seeded evidence and must not regress average, 25th-percentile, or hard-invariant outcomes.
