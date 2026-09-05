# Post-draft lineup and waiver plan

## Status and boundary

This is the approved plan for expanding DraftForge after the September 8, 2026 **It’s Fun To Do Bad Things XVII** auction is complete and its final roster has passed exact ESPN reconciliation.

This capability is **not implemented yet**. No post-draft work may change, delay, or destabilize the certified live-draft control plane before the auction. The draft engine remains ESPN-only, deterministic, fail closed, and isolated from this future workflow.

The initial post-draft release is recommendation-only. It may read authenticated ESPN state and explain decisions, but it may not submit lineup changes, waiver claims, drops, or acquisitions. ESPN write automation requires a separate safety design and authenticated certification campaign.

## Goal

For each ESPN league, provide timely and explainable answers to two recurring questions:

1. Who should start and who should sit this scoring period?
2. Which available players should be added, how should claims be prioritized or budgeted, and which rostered player should be dropped for each move?

The system should maximize expected seasonal wins rather than chase one-week point projections. Every recommendation must respect the exact league rules, current roster, opponent, player availability, waiver mechanism, deadlines, and the opportunity cost of the corresponding bench or drop decision.

## Required authenticated ESPN state

Each league is isolated by ESPN league ID, team ID, and season. Before making a recommendation, import and verify:

- scoring rules and lineup slots;
- position eligibility, roster limits, and acquisition limits;
- lineup-lock behavior and exact game-level deadlines;
- waiver processing days and times;
- waiver priority, FAAB budget, minimum and maximum bids, and tie-break rules;
- rostered players, bench, IR, keepers, and pending claims;
- the current opponent and both teams' legal lineup state;
- the authenticated free-agent and waiver pool; and
- current NFL schedule, bye weeks, player status, and ESPN projections.

Missing, stale, conflicting, or ambiguous state blocks the affected recommendation. One league's roster, settings, claims, budget, or strategy must never enter another league's decision.

## Evidence model

The existing deterministic five-source consensus remains the long-horizon player-value baseline. Its source set and fixed weights do not change silently.

Weekly information is applied through explicit overlays rather than disguised as a sixth ranking source:

- **Availability overlay:** confirmed injuries, IR/PUP/NFI, suspensions, releases, inactive status, and official participation reports.
- **Role overlay:** recent snaps, routes, targets, touches, red-zone work, depth-chart movement, and replacement opportunity.
- **Matchup overlay:** opponent strength, likely coverage or defensive matchup, expected game environment, home/away status, and schedule strength.
- **Environment overlay:** weather, venue, surface, and material travel or scheduling conditions.
- **Market overlay:** current roster percentage, add/drop velocity, waiver demand, and likely acquisition price.

Each overlay must expose its provenance, retrieval time, confidence, and effect. An overlay may adjust a weekly recommendation or veto an unavailable player; it may not mutate the underlying five-source consensus record.

## Lineup decision policy

Lineup optimization evaluates every legal assignment, including multi-position FLEX and OP combinations. It should:

- begin with median expected points and replacement-adjusted value;
- account for current role, matchup, availability risk, weather, and likely game script;
- recognize positional and lineup-slot scarcity;
- avoid double-counting signals already reflected in projections;
- prefer floor when protecting a projected lead and justified ceiling when an underdog needs variance;
- consider the opponent only to set rational risk posture, never to manufacture correlation without evidence;
- preserve late-swap flexibility by placing later-starting eligible players in FLEX or OP when appropriate;
- distinguish a true start/sit edge from a statistical tie; and
- produce a primary lineup, confidence level, material assumptions, and ranked pivots for unresolved news.

No player with a definitive availability veto may be recommended into an active slot. Questionable or game-time decisions require a named fallback whose game starts later than the decision deadline whenever possible.

## Waiver and add/drop policy

Every acquisition is evaluated as a complete transaction: **add player + acquisition cost + drop player + resulting roster**. The system should:

- rank rest-of-season value, near-term opportunity, positional scarcity, schedule, and upside;
- compare the add against the best freely available replacement and the proposed drop;
- protect high-value players from one-week overreaction;
- distinguish immediate starters, injury replacements, bench upgrades, speculative upside, handcuffs, and short-term streamers;
- account for FAAB or priority scarcity and expected competing demand;
- preserve enough FAAB for later high-leverage injuries and role changes;
- avoid unnecessary kicker or D/ST duplication;
- check future byes and mandatory starter coverage before a drop;
- retain keeper-relevant upside when the league rules make it valuable; and
- reject claims that create an illegal roster or leave no feasible lineup.

For FAAB, return an exact recommended bid, a hard ceiling, and a lower fallback bid where appropriate. For priority waivers, return the claim order and whether the move is worth consuming the current priority. Conditional claims must be ordered so that earlier outcomes cannot make later claims illegal or cause an unintended drop.

## User-facing output

Chat remains the primary explanation and decision interface. DraftForge becomes the command view showing current truth, deadlines, and recommendation state.

Each lineup report should include:

- the complete proposed starting lineup and bench;
- every changed player pair;
- projected point difference and confidence;
- the decisive evidence and freshness time;
- injury/news pivots and their deadlines; and
- any blocked or effectively tied decisions.

Each waiver report should include:

- prioritized claims;
- add, drop, FAAB bid or priority cost;
- rest-of-season and immediate rationale;
- roster impact and opportunity cost;
- hard ceiling or do-not-claim threshold;
- conditional ordering; and
- players explicitly protected from dropping.

## Operating cadence

### Immediately after each draft

1. Reconcile the final ESPN roster and acquisition prices exactly.
2. Re-import scoring, slots, limits, waiver settings, budgets, and deadlines.
3. Generate the first legal lineup without submitting changes.
4. Audit the free-agent pool for obvious post-draft value and roster defects.
5. Record unresolved injuries and the next decision deadline.

### Before waivers

1. Refresh authenticated ESPN state and all time-sensitive overlays.
2. Reconcile pending transactions and remaining FAAB or priority.
3. Produce complete add/drop pairs and conditional claim order.
4. Refresh again shortly before the deadline if material news is pending.
5. Require explicit user approval while the system remains recommendation-only.

### Before lineup locks

1. Produce an early-week baseline after waivers clear.
2. Recheck Thursday players before the first kickoff.
3. Recheck official practice and status information before Sunday games.
4. Run a final late-swap pass before each relevant game-level lock.
5. Preserve a legal fallback plan for every unresolved game-time decision.

## Safety requirements

- Read-only is the default and the only authorized mode for the first release.
- Never submit a drop, claim, acquisition, or lineup move from chat or an unverified browser session.
- Never act on stale league identity, roster, free-agent pool, deadline, budget, or player status.
- Never use display-name fallback when ESPN supplies a conflicting or ambiguous player ID.
- Never expose ESPN credentials, cookies, or private opponent data in logs or artifacts.
- Never treat an allegation, rumor, or uncertain report as a definitive availability veto.
- Never conceal a source outage by reusing stale weekly evidence.
- Never allow one league's state or recommendation to contaminate another.

## Delivery sequence

### Phase 1: authenticated read model

- Import finalized rosters, opponents, waiver settings, free agents, deadlines, and pending claims.
- Add league-isolation and freshness contracts.
- Persist only sanitized, bounded state required for deterministic replay.

### Phase 2: lineup recommender

- Implement legal lineup enumeration and projection comparison.
- Add availability, role, matchup, environment, and risk-posture overlays.
- Produce explanation-ready primary and fallback lineups.

### Phase 3: waiver recommender

- Implement add/drop pair valuation, FAAB and priority policy, conditional claims, and protected-player logic.
- Include streaming and speculative-upside strategies without weakening season-long value protection.

### Phase 4: command view and chat workflow

- Present deadlines, source freshness, lineup deltas, claims, budgets, confidence, and blockers prominently.
- Keep chat reads bounded and non-mutating so questions cannot contend with live state collection.

### Phase 5: authenticated certification

- Run read-only rehearsals against both real ESPN leagues.
- Validate cold start, stale data, late injury, postponed game, ambiguous identity, waiver tie, conditional claim, roster-limit, and recovery scenarios.
- Consider write automation only as a separately approved project after recommendation accuracy and fail-closed behavior are proven.

## Acceptance criteria

The recommendation-only release is complete when:

- both ESPN leagues import independently with exact rules and deadlines;
- every proposed lineup is legal and deterministic for identical inputs;
- every waiver recommendation contains a legal add/drop pair and valid cost;
- zero recommendations use vetoed, locked, rostered-by-an-opponent, or identity-ambiguous players;
- stale or incomplete evidence produces an explicit blocker rather than a guess;
- late-swap and conditional-claim ordering remain valid after each earlier outcome;
- every recommendation identifies provenance, freshness, confidence, and material assumptions;
- replay tests reproduce decisions exactly;
- adversarial and full regression suites pass without changing draft-engine behavior; and
- the live-draft release gate remains unchanged and passing.

## Explicitly out of scope for the first release

- trades and trade negotiation;
- commissioner or league administration;
- automated ESPN lineup or waiver submission;
- unbounded background monitoring;
- betting or wagering advice; and
- changes to the deterministic draft consensus, auction ceilings, or live action writer.

