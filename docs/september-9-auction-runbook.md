# September 8 auction runbook

This is the focused operating plan for the September 8, 2026 ESPN salary-cap draft in **It’s Fun To Do Bad Things XVII**. It supersedes broader snake-plus-salary rehearsal plans for this event. The legacy filename is retained so existing operator links do not break; the date authenticated on ESPN is authoritative.

## Exact target

| Field | Required value |
| --- | --- |
| Platform | ESPN only |
| League | It’s Fun To Do Bad Things XVII |
| League ID | `44050` |
| Team ID | `7` |
| Season | `2026` |
| Draft time | September 8, 2026 at 8:00 PM America/Chicago |
| Draft | Salary cap / auction |
| Scoring | PPR |
| Teams | 12 |
| Budget | $200 |
| Roster | 14 draftable slots, including QB and OP |
| Intelligence profile | Two-QB |

## Locked keeper baseline

ESPN keeper selections locked on September 5 establish the opening roster and budget:

| Player | ESPN ID | Position | Keeper price |
| --- | ---: | --- | ---: |
| Tony Pollard | `3916148` | RB | $0 |
| Terry McLaurin | `3121422` | WR | $1 |

The draft must begin with both exact keeper identities, **$1 spent, $199 remaining, and 12 draftable roster slots open**. The authenticated ESPN import remains authoritative. Any different keeper identity, price, budget, or roster count is a stop condition requiring reconciliation before Auto-Draft can arm.

Pollard is value RB depth, not a reason to pass on an elite RB at or below its ceiling. McLaurin satisfies the initial WR starter but does not prohibit adding a premium WR. Because the lineup includes QB plus OP, acquiring two playable quarterbacks remains a central scarcity priority. The engine should preserve flexibility rather than pre-spend the keeper surplus, and it must evaluate tight ends as flex-eligible players rather than forcing a dedicated TE slot that this league does not have.

The authenticated ESPN import is authoritative if any remembered value differs. A mismatch is a stop condition, never a reason to coerce the saved profile.

## Definition of ready

DraftForge is ready to arm only when all of these are simultaneously true:

- one production server is listening on `127.0.0.1:3000`;
- Chrome contains exactly one DraftForge dashboard and one exact authenticated ESPN league or room tab;
- the installed unpacked companion matches `config/draft-day-release.json` without reinstalling it;
- authenticated ESPN settings and the 500-player status pool have been freshly imported;
- ESPN, FFC, MFL, Tradyr, and GNG are all fresh for the exact PPR/12-team/2026/two-QB profile;
- the current availability overlay is fresh, exact-identity matched, and free of unresolved definitive events;
- DraftForge Auto-Draft and ESPN Autopick are off during preflight;
- the live room has an exact identity, resolved action surface, current nominee/offer, and safe clock; and
- the no-click dry run and both readiness gates report no blocker.

The five-source consensus remains deterministic and fixed. Availability news is a separate hold/veto layer; it cannot change rankings, raise a bid ceiling, or create a sixth source.

## Strategy contract

- Begin from the exact keeper state: Pollard at $0 and McLaurin at $1, leaving $199 for 12 selections.
- Treat the $1 keeper spend as sunk roster construction, not permission to overpay early. Preserve the surplus through exact bid ceilings.
- Prioritize two playable quarterbacks for QB plus OP scarcity while still requiring value at the live ceiling; never turn scarcity into a bidding war.
- Continue pursuing an elite RB or WR anchor when value permits. Pollard is not the planned RB1 ceiling, and McLaurin does not close the WR market.
- Respect the exact roster-aware walk-away ceiling on every offer. Never chase one dollar beyond it.
- Preserve at least one dollar for every open roster slot. The maximum legal bid is `remaining budget - (open slots - 1)` and the engine may impose a lower value or pacing ceiling.
- Use room spending, remaining opponent maximum bids, nomination order, positional scarcity, and our open slots to adjust value within the production engine.
- Avoid a reflexive stars-and-scrubs opening. Acquire anchors only at or below their exact live ceilings, then preserve enough flexibility for QB/OP, required starters, depth, K, and DST.
- Prefer target nominations when DraftForge wants the player at the current opening offer. Use drain nominations only when the engine explicitly marks the nomination safe; a vetoed or ambiguous player is always a pass.
- Do not make a nomination or bid while the prior outcome is uncertain. Exact ESPN player-ID and sale-price reconciliation must release the auction uncertainty latch first.
- Mandatory roster completion, position caps, and the final K/DST slots override discretionary depth.

## T-24 hours

Run outside the live window:

```bash
cd /Users/chris/github/draftforge-ai
git switch main
git pull --ff-only
npm install
npm run check
npm run test:production-path
npm run test:contention
npm run test:visual
npm audit --audit-level=high
```

Then cold-start one production server and warm only the exact source profile:

```bash
npm run start
npm run draft-day:warm -- --scoring PPR --teams 12 --season 2026 --qbs 2
```

Open only:

- `http://127.0.0.1:3000`
- `https://fantasy.espn.com/football/team?leagueId=44050&teamId=7&seasonId=2026`

Use **Import from ESPN**, inspect the authenticated rules, and keep Auto-Draft off. The normal update path for an already-loaded companion is `http://localhost:3000/?reloadCompanion=1`; do not reinstall the extension and never invoke the reload path during an active auction lifecycle.

Require:

```bash
npm run draft-day:ready -- --format salary-cap --phase pre-room
```

The only acceptable result is `DRAFT_DAY_READY` with exact league/team/rules, current server identity, 5/5 sources, a fresh availability digest, exactly two tabs, ESPN Autopick off, and DraftForge Auto-Draft off.

## Draft-day refresh

Repeat the production start, authenticated import, source warm, player-status import, and availability scan. Check definitive season-ending injuries, IR/PUP/NFI that removes the player from the relevant season window, suspensions, retirement, release without a team, death, and explicit league ineligibility. Ordinary questionable/doubtful designations, rumors, arrests or allegations without an eligibility consequence, and day-to-day news remain advisory.

Do not carry a T-24-hour readiness result into the live room. Source, availability, server, dashboard-document, and ESPN-tab identities are time-bound.

## Live-room gate

When ESPN opens the exact room:

1. Bind only that room and close stale practice or duplicate DraftForge/ESPN tabs.
2. Verify ESPN Autopick is off. Sound is an operator preference and does not authorize an action.
3. Confirm the room rules, $200 budget, 14 slots, current nominee/offer, and clock.
4. Run the dashboard’s live checklist and no-click dry run.
5. Run:

   ```bash
   npm run draft-day:ready -- --format salary-cap --phase live
   ```

6. Arm only after the gate reports `DRAFT_DAY_READY` with no blockers.

During the draft, chat is the status and explanation cockpit. DraftForge and the companion are the sole action writer. A chat, Chrome-controller, or terminal disconnect cannot grant or inherit action authority and should not stop an already healthy armed control plane.

## Automatic stop conditions

DraftForge must stop rather than guess on stale or incomplete five-source coverage, stale availability, wrong or ambiguous tab identity, server/dashboard generation mismatch, unknown or unsafe clock, ESPN Autopick, changed nominee, ambiguous offer/leader, exceeded bid ceiling, insufficient reserve, uncertain prior outcome, roster mismatch, or extension ownership loss.

Recovery is bounded: Auto-Draft turns off, stale intent is discarded, the exact tab and current ESPN truth are re-imported/reconciled, the live checklist is repeated, and the operator explicitly re-arms. Routine recovery uses the installed companion; it does not require reinstalling it.

## Completion

After ESPN confirms the final roster, require exact player-and-price parity, legal completion, mandatory K/DST, no duplicate or position-cap violation, and automatic DraftForge shutdown:

```bash
npm run draft-day:audit -- --league 44050 --team 7 --require-complete
```

A timeout, ESPN Autopick, missed action, manual contamination, incomplete audit, or mismatched price excludes the run. Preserve the audit and add every observed operational defect to `docs/real-draft-issues-20260827.md` before any later code change.

## Pre-room certification boundary

Before September 8, local tests can certify engine legality, deterministic auction decisions, action serialization, durability, latency, recovery, and extension fail-closed behavior. They cannot certify the future live ESPN room or future player news. The final authenticated pre-room and live-room gates therefore remain intentionally pending until their time-bound inputs exist.
