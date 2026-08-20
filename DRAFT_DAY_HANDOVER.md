# DraftForge draft-day handover

This is the operational source of truth for running an ESPN draft with Codex as the primary cockpit, DraftForge as the command center, and Chrome as the execution surface. Read it before every rehearsal and real draft. Update the **Certification ledger** and **Known launch risks** whenever a rehearsal changes the evidence.

For implementation history and exclusions, see [AGENT_HANDOFF.md](AGENT_HANDOFF.md). For installation or migration, see [MIGRATION.md](MIGRATION.md). For source definitions and weights, see [docs/data-sources.md](docs/data-sources.md).

## Operating model

| Surface | Responsibility |
| --- | --- |
| Codex conversation | Primary cockpit: run checklists, explain decisions, change strategy between safe action windows, issue hold/resume commands, and report exceptions. |
| DraftForge dashboard | Command center: show the exact action, clock, bid ceiling, protected reserve, roster needs, alternatives, source health, and safety state. |
| Authenticated ESPN tab | Execution surface: provide authoritative rules, room state, player availability, bids, picks, roster confirmation, sound state, and Autopick state. |
| Chrome companion | Narrow enforcement layer: act only in the exact imported tab, league, team, clock, player/nominee, and offer state. |

Keep Codex open in the desktop app and exactly two controlled Chrome tabs: `http://127.0.0.1:3000` and the one authenticated ESPN lobby or live room. Do not use a development server, multiple ESPN draft rooms, or a stale dashboard on draft day.

## Non-negotiable safety rules

- ESPN-only. No post-draft league management.
- Five deterministic sources: ESPN, FFC, MFL, Tradyr, and GNG.
- Never act with stale or incomplete source coverage.
- Never act on an unverified, short, opponent, or changed clock.
- Never act in the wrong league, team, tab, player, nominee, or offer state.
- ESPN sound must remain muted and ESPN Autopick must remain off.
- Salary-cap bids may not exceed the exact live ceiling or consume the $1-per-open-slot reserve.
- No bidding wars, duplicate players, position-cap violations, or unnecessary second K/DST.
- Mandatory starter and specialist completion overrides discretionary depth in the endgame.
- ESPN roster confirmation is the only action-success signal.
- Any ambiguity means stop. A failed or missed ESPN action never counts as a DraftForge pass.

## Certification ledger

Last updated: 2026-08-20.

| Gate | State |
| --- | --- |
| Local release gate | Backlog-hardening candidate: 181/181 tests, lint, typecheck, production build, UI, extension safety, replay, recovery targeting, and latency passing; visual certification covers pre-room plus snake/salary command centers at 390, 1440, 1728, and 2560 widths |
| Deterministic drafts | 20/20 snake and 20/20 salary-cap complete and legal |
| Live-snapshot Monte Carlo | Fresh seed `20260820`: 10,000 snake + 10,000 salary-cap, including 4,000 exposed holdouts; zero failures, hard violations, or simulation errors |
| Overnight battle qualification | Four 5-draft batches per format: 20/20 snake + 20/20 salary cap, exact holdout replay, zero hard violations |
| Historical post-sleeper authenticated ledger | 19/20 snake and 15/20 salary-cap; retained as historical evidence |
| Current clean-room authenticated campaign | 20/20 snake and 20/20 salary-cap; every countable room final-audited; contaminated and incomplete rooms excluded |
| Final authenticated latency | Snake 16/16: submit p95 1.140s, p99 1.175s, max 1.184s; salary cap 14/14: submit p95 0.720s, p99 1.414s, max 1.717s |
| Cold-start and recovery | Server, tab, extension, source, stale-action, and ESPN-Autopick recovery paths passed fail-closed checks; contaminated recovery room `1446060763` remains excluded |
| One-command READY gates | Saved snake and salary-cap profiles both return `DRAFT_DAY_READY` with every exact setting/source/tab/safety check true |
| v0.2.17 authenticated pre-room | League `44050`, team `7`: exact QB+OP salary-cap rules, two-QB intelligence profile, 5/5 sources, exactly two Chrome tabs, companion v0.2.17, settings confirmed, Auto-Draft off, and `DRAFT_DAY_READY` |
| Deterministic holdout replay | 2,000 snake + 2,000 salary-cap records replayed byte-for-byte with zero mismatches |

Do not advance an authenticated count without a complete final-ready loopback audit. Current evidence is machine-readable in `simulation/evidence/authenticated-certification-20260818.json`; older excluded rooms remain historical and must not be retroactively counted.

## T-24-hour preparation

1. Confirm the machine, power, network, Chrome login, ESPN login, and Codex task are available.
2. Pull and verify the merged release outside the live-draft window:

   ```bash
   cd /Users/chris/draftforge-ai
   git switch main
   git pull --ff-only
   npm install
   npm run check
   ```

3. Confirm the unpacked Chrome companion is version `0.2.17` and loaded from this repository's `extension/` directory. The packaged zip SHA-256 is `30c5b3093f5508f6526d1e70526f2d400a7d45b64b0e9100134e9fd53ac5634f`. This locally verified hardening candidate still requires one supervised authenticated salary-cap recovery rehearsal before it supersedes the v0.2.16 live evidence.
4. Run one cold-start, no-click rehearsal for the exact league. Do not wait until the real room opens to discover an ESPN login, extension, source, firewall, or Chrome-control problem.
5. Keep the companion zip digest and current release evidence in [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

## Cold-start kickoff

1. Quit Chrome completely. Stop any old DraftForge server.
2. Start one production server:

   ```bash
   cd /Users/chris/draftforge-ai
   npm run start
   ```

3. Confirm the server reports `http://127.0.0.1:3000`.
4. Open only the local dashboard and the authenticated ESPN league lobby in Chrome.
5. In Codex, use this kickoff message:

   > Draft day. Use the exact named ESPN league and team. Run the complete cold-start checklist. Keep Auto-Draft off and do not create or enter the room until you report READY.

6. Import the league from ESPN. Verify draft type, scoring, teams, roster slots, position caps, keepers, timer, budget, and team identity from the authenticated response rather than memory.
7. Warm the five sources with the imported scoring and league size. League `44050`, team `7`, currently uses:

   ```bash
   npm run draft-day:warm -- --league 44050 --team 7 --scoring PPR --teams 12 --season 2026
   ```

8. Require `FIVE_SOURCE_READY` before room creation. A cold warmup may take about 20 seconds.
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

After ESPN creates the room, explicitly bind its new league ID and rerun the complete live-room dry run:

- one exact ESPN draft tab matches league and team;
- live pool, roster, clock, and action controls resolve;
- ESPN sound is muted;
- ESPN Autopick is off;
- five sources remain fresh;
- the no-click engine returns one legal recommendation;
- salary-cap ceiling, reserve, nomination, and next-offer state are exact; and
- DraftForge is still off.

Then run the matching command with `--phase live`. It must return `DRAFT_DAY_READY` before the authorization modal may arm Auto-Draft.

Only then may Codex arm Auto-Draft for that named room. Arming is scoped to the room and resets on reload, league switch, safety failure, completion, `hold`, or `stop`.

## Chat-owned Chrome recovery

Routine recovery is Codex-owned. The user should not have to reload the extension, close stale DraftForge tabs, or reconnect an exact practice room by hand.

- `http://localhost:3000/?reloadCompanion=1` reloads the already-installed unpacked companion from disk. Codex then reloads the dashboard so the new bridge context is active. Never run this inside an active action window.
- A loopback-only `recoverLive=1` command requires the exact generated practice-room league ID, source league ID, team, and season. It fails closed unless exactly one matching ESPN live room exists, reloads that room to re-inject the companion, imports its authenticated settings and roster, and closes only stale DraftForge tabs plus the matching source-league parent. It never closes unrelated ESPN or browser tabs.
- A loopback-only `closePractice=1` command first re-imports the exact room and requires ESPN's league name to begin with `Practice Draft for ` before it will close the tab. It cannot close a real league room through this path.
- Every recovery turns Auto-Draft off and settings confirmation false. Codex must re-warm five sources if needed, confirm the imported checklist, rerun the live dry run, and explicitly re-arm the exact room.

## Live-draft protocol

Use armed auto with chat supervision when the clock is short. Use Guided mode when there is enough time for per-action approval.

Short chat commands:

- `status` — report clock, action, roster needs, budget/reserve, and next targets;
- `explain` — explain the current recommendation without changing it;
- `draft it`, `bid`, or `pass` — approve the current Guided-mode action;
- `hold` or `stop` — prevent new actions immediately;
- `resume` — rerun live safety checks before continuing; and
- `switch strategy after this action` — change strategy only between safe action windows.

During a live clock, Codex should report only the decision-critical line, for example:

> BID $28 — ceiling $31 · reserve safe · TE starter open · 18 seconds

Do not refresh source truth in the middle of a decision. For material late news, hold, refresh all five sources between action windows, verify the new coherent snapshot, and then resume. ESPN availability and exact action state are still revalidated immediately before every click.

## Stop conditions

DraftForge must fail closed and Codex must report the exact reason for any of these:

- source degradation;
- Chrome or companion disconnect;
- wrong or ambiguous tab/league/team;
- sound on or ESPN Autopick active;
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

Count the room only when the audit proves exact ESPN/app roster parity, exact salary-cap prices, legal completion, mandatory K/DST, position caps, reserve and max-bid compliance, five-source readiness, muted sound, ESPN Autopick off, exact tab binding, and automatic DraftForge shutdown.

Record the room ID, format, roster, prices/budget when applicable, audit result, exercised retries, source coverage, and count change in [AGENT_HANDOFF.md](AGENT_HANDOFF.md). Update the ledger in this document in the same commit. Close the completed ESPN tab and leave no stale room open.

## Known launch risks

- Chrome-control recovery is no longer an untested blocker: a clean two-tab cold start and a deliberate in-room dashboard reload both passed, including Auto-Draft resetting off, exact-room re-import, full revalidation, safe re-arming, 16/16 parity, and automatic shutdown. ESPN/Chrome drift can still recur, so every real draft must run both READY gates.
- The expanded 2026-08-19 snapshot improved player-level coverage to 60.12% at four or more sources and 47.62% at all five, but GNG remains the shortest model board at 150 rows and not every late player can be corroborated. Treat confidence and sleeper labels accordingly.
- The immutable expanded snapshot produced zero production-qualified sleeper signals. The latest fresh saved-snake pre-room state now produces two unchanged-threshold, five-source candidates (Jalen Hurts and Kyler Murray), while salary cap produces none. Treat these as current recommendation evidence, not authenticated sleeper-acquisition outcome evidence, until countable rooms exercise them.
- Fresh room imports now forcibly reset Auto-Draft and old-room telemetry. A 30-second ESPN practice room can still start before manual setup finishes, so warm and pass the pre-room gate before room creation and use one bounded import/checklist/arming sequence inside the room. Any ESPN Autopick contamination excludes that room.
- The final v0.2.16 authenticated snake room removed the repeated late-round submit tail without weakening identity or clock checks: p95 1.140 seconds, p99 1.175 seconds, and maximum 1.184 seconds. The bounded profile activates only after ten confirmed snake roster slots; early snake, salary-cap, and mandatory K/DST paths are unchanged.
- ESPN practice rooms may disappear after completion; the loopback audit must be captured before the tab is closed or ESPN deletes the state.
- Companion v0.2.17 preserves a pending salary-cap sale for at most five context polls when ESPN briefly removes the budget surface between nominations. The focused recovery test proves the delayed closing price and subsequent nomination are recorded in order; the bounded limit prevents a malformed room from stalling tracking. Treat this as locally verified until the supervised authenticated recovery rehearsal is complete.

## Maintenance rule

Every engine, extension, source, UI-action, or safety change requires `npm run check`, a companion version bump when extension code changes, a rebuilt companion zip, deterministic 20+20 drafts, focused regression evidence, and this handover reviewed for drift. Strategy changes additionally require paired seeded evidence and must not regress average, 25th-percentile, or hard-invariant outcomes.
