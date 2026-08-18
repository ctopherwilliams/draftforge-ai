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

Last updated: 2026-08-18.

| Gate | State |
| --- | --- |
| Local release gate | 144/144 tests, lint, typecheck, production build, UI, extension safety, replay, and latency passing |
| Deterministic drafts | 20/20 snake and 20/20 salary-cap complete and legal |
| Live-snapshot Monte Carlo | 10,000 snake + 10,000 salary-cap; zero hard violations and zero simulation errors |
| Overnight battle qualification | Four 5-draft batches per format: 20/20 snake + 20/20 salary cap, exact holdout replay, zero hard violations |
| Post-sleeper authenticated snake | 19/20 countable |
| Post-sleeper authenticated salary cap | 15/20 countable |
| Remaining certification | 1 snake and 5 salary-cap rooms |

Do not advance an authenticated count without a complete final-ready loopback audit. Room `1957835193` is excluded: every live check passed, but Chrome control disconnected at arming and the audit recorded `autoDraft: false` with no DraftForge bids.

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

3. Confirm the unpacked Chrome companion is version `0.2.11` and loaded from this repository's `extension/` directory.
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

Only then may Codex arm Auto-Draft for that named room. Arming is scoped to the room and resets on reload, league switch, safety failure, completion, `hold`, or `stop`.

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

- The remaining authenticated certification is blocked by intermittent Chrome-control disconnection at the final arming action. Engine, UI, extension, and loopback audits fail closed, but draft-day readiness requires clean authenticated completion across the remaining 5+1 rooms.
- Player-level live-source corroboration is uneven even when all five feeds are healthy. The latest immutable snapshot had 37.5% coverage from at least four sources and 23.21% full five-source player coverage. Treat confidence and sleeper labels accordingly.
- The latest immutable snapshot produced no measurable sleeper acquisitions. Do not claim sleeper performance has been authenticated until a fresh corroborated snapshot and countable rooms exercise it.
- ESPN practice rooms may disappear after completion; the loopback audit must be captured before the tab is closed or ESPN deletes the state.

## Maintenance rule

Every engine, extension, source, UI-action, or safety change requires `npm run check`, a companion version bump when extension code changes, a rebuilt companion zip, deterministic 20+20 drafts, focused regression evidence, and this handover reviewed for drift. Strategy changes additionally require paired seeded evidence and must not regress average, 25th-percentile, or hard-invariant outcomes.
