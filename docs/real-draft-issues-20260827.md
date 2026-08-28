# SOMFAB real-draft issue backlog — 2026-08-27

## Purpose

This is the evidence-backed post-draft backlog from the real authenticated SOMFAB snake draft (ESPN league `1603083723`, team `6`, 10 teams, PPR, QB plus OP, 16 roster slots, 60-second clock). It records control-plane and operator-experience defects only. Do not change production code during the live draft, do not infer a strategy defect from one uncontrolled pick, and do not weaken the deterministic five-source consensus or fail-closed action guards.

## Live evidence captured so far

- The workspace stayed lean at exactly one DraftForge tab and one exact ESPN draft tab.
- DraftForge selected Jayden Daniels at 1.07 with 57 seconds showing; ESPN confirmed the roster in 1.561 seconds.
- At the live-room start, the loopback audit remained at zero picks briefly before reconciling from zero to five. No illegal action occurred, but chat did not have current pick truth during that interval.
- The external Chrome controller repeatedly listed both exact tabs but timed out or disconnected when claiming either tab. The installed DraftForge companion remained connected and successfully submitted actions.
- ESPN Autopick became active before 2.04. DraftForge detected it, disabled ESPN Autopick, and disarmed Auto-Draft as designed. Auto-Draft did not re-arm before the next clock, and ESPN selected Drake Maye at 2.04. The roster reconciled exactly, but the pick has no DraftForge action attribution and must not be treated as a certified engine decision.
- Manual re-arming restored the proven action path. DraftForge then selected A.J. Brown at 3.07 and Malik Nabers at 4.04; both were confirmed in 154 ms with 57 seconds showing.
- The loopback audit exposes confirmed actions and roster parity, but it does not expose the pending recommendation early enough for chat to announce the intended player before an immediate automatic submission.
- A completed preflight automation was deleted after its one-time job finished, but the product surfaced this as though the SOMFAB live monitor had been deleted. The live companion and room binding were unaffected; the wording created avoidable operator uncertainty.
- In the served live release, ESPN sound was a hard Auto-Draft prerequisite, so a request to unmute could not coexist with armed mode. The post-live candidate supersedes that policy: sound is operator-preference telemetry and cannot authorize or block an action, readiness, or final audit. ESPN Autopick remains a hard gate.
- The first DraftForge pick submitted at 57 seconds because the running certified build had no delayed snake-submit policy. A later dirty-worktree timing edit was not part of the served build and must not be counted as live evidence.
- One fallback sequence displayed Chris Godwin Jr. while ESPN added the Rams D/ST, and the final sequence again displayed/submitted Chris Godwin Jr. while the authoritative roster added Bryce Young. The roster became legal and complete, but final action telemetry never proved either displayed identity. These additions are `UNKNOWN_EXTERNAL` unless a typed action lifecycle can attribute them.
- The final audit returned ready from present-state parity even though the room contained the earlier Autopick pick and unresolved final-action identity. That result is invalid certification evidence; historical contamination and every pending/unattributed roster delta must remain fatal.

## Post-live resolution status — 2026-08-28

The current working candidate addresses the observed failure classes without changing ranking weights or broadly retuning strategy:

- The companion/dashboard remain the only writer. `draft-day:status` reads the compact control envelope and league board using exactly one bounded (750 ms, 64 KiB) loopback GET for an atomic server snapshot and has no POST, Chrome/CDP, extension, source-fetch, engine, or action capability. Its observer-health gate withholds recommendations on stale or unsafe state, so chat queries cannot contend with or outlive the live writer.
- Source authorization now binds the exact scoring/team-count/season/QB profile, canonical UTC generation timestamp, and lowercase `sha256:<64 hex>` snapshot ID across WARM and the dashboard audit. A stale dashboard loaded before a restarted production server is rejected until it reloads and republishes from that server instance.
- The dashboard no longer passes the source freshness predicate directly to `Array.filter`. That callback-arity error interpreted provider indexes as 1970-era evaluation timestamps, falsely displayed 1/5 despite a valid server 5/5 envelope, and prevented audit publication. One explicit evaluation instant now drives the source count, details, checklist, and audit.
- Opponent identity must resolve uniquely by normalized team name or abbreviation. Ambiguous snake opponents receive a deterministic generic placeholder; ambiguous auction opponents are omitted, so an uncertain owner can never authorize a bid.
- Auction offer transitions and completed sales compare exact nonzero ESPN player IDs before display names. Same-name players with different IDs settle independently; name fallback is allowed only if one side lacks an exact ID.
- Sound is now telemetry only. The action path still fails closed on unknown/active ESPN Autopick, unsafe clocks, changed identity/action surfaces, source mismatch, post-click uncertainty, and incomplete attribution.
- Fresh synthetic regression completed 10,000 snake and 10,000 salary-cap trials with zero recorded invariant failures. Independent 2,000-trial replays for both formats matched their run and ordered-outcome digests exactly. The final full repository/release gate remains pending.

This is not an authenticated certification claim. Current source arming remains **NO-GO** because no fresh authenticated schema-v3 source snapshot exists from the final committed revision. The server-only Tradyr credential is now held in native Keychain and the source adapter requires one complete atomic keyed board. Official availability news remains a separate hold/veto overlay; the ranking consensus remains exactly ESPN/FFC/MFL/Tradyr/GNG at fixed weights.

## Prioritized backlog

### P0 — Prevent another unowned clock expiration

1. **Harden ESPN Autopick prevention and recovery.**
   - Revalidate ESPN Autopick immediately before every own turn, not only at initial arming and action submission.
   - Persist an audit event for detected activation, disable attempt, disable confirmation, Auto-Draft shutdown, and any subsequent external roster addition.
   - Stage the current legal recommendation before disabling Autopick so the operator can recover without recomputing under the clock.
   - Design an explicit recovery policy: fail closed by default, but present one deterministic, verified re-arm action after ESPN confirms Autopick is off. Never silently re-arm across a changed league, tab, team, pick, source snapshot, clock, or action surface.
   - Acceptance: an authenticated fixture that activates ESPN Autopick one pick before our turn disables it, records every transition, preserves the staged recommendation, and either re-arms through an explicit authorized recovery or remains safely stopped without contaminating the roster.

2. **Expose a live chat decision envelope before submission.**
   - Extend the loopback audit with current pick, round, on-clock state, remaining seconds, recommendation identity, top legal alternatives, decision confidence, intended submit window, and a monotonically increasing decision ID.
   - Publish the plan as soon as ESPN puts the team on the clock, before any selection click.
   - Acceptance: a chat monitor can reliably emit `PICK <player> — submit near <n>s` at least five seconds before the production action in a 60-second authenticated room.

3. **Make submit timing a tested policy, not an improvised live edit.**
   - Support a configurable snake submit window that varies within a bounded late-clock range while retaining enough time for the existing confirmation and retry budget.
   - Freeze the chosen deadline per league/pick so React renders and ESPN clock updates cannot move it.
   - The recommendation must remain live and may change before the deadline if ESPN removes a player; the action must still revalidate the exact candidate, pick, clock, and roster immediately before clicking.
   - Acceptance: seeded timing tests prove bounded variation, deterministic replay for identical inputs, no action below the minimum safe clock, successful fallback/retry headroom, and no change to selection ranking.

### P1 — Make live state authoritative and explainable

4. **Reduce or surface draft-start reconciliation lag.**
   - Measure DOM context and authenticated ESPN API latency separately.
   - Mark the board stale when the room says the draft started but the authenticated pick feed has not advanced within a bounded interval.
   - Increase event-driven reconciliation around draft start and own-turn boundaries without unbounded polling.
   - Acceptance: fixtures covering API lag, DOM-first updates, and eventual reconciliation never present zero picks as current truth after the bounded stale threshold.

5. **Attribute every roster addition.**
   - Classify each own-roster delta as `DRAFTFORGE_CONFIRMED`, `ESPN_AUTOPICK`, `USER_MANUAL`, or `UNKNOWN_EXTERNAL` using action IDs, timestamps, expected pick, and roster transitions.
   - Preserve the classification in the final audit and exclude uncontrolled selections from engine-quality claims.
   - Acceptance: the Drake Maye sequence replays as an ESPN-Autopick addition; the Rams D/ST/Bryce Young mismatches remain unknown external unless action lineage proves otherwise; only terminally acknowledged actions count as DraftForge-confirmed.

6. **Repair Chrome controller ownership and recovery.**
   - Reproduce the state where tab enumeration succeeds but tab claiming hangs or disconnects.
   - Determine whether the cause is CDP ownership, browser-extension transport contention, stale session identity, or host/firewall state.
   - Provide one bounded reconnect path that does not open extra windows, reload the ESPN room, invalidate the companion, or require repeated user intervention.
   - Acceptance: a clean authenticated two-tab session supports repeated list, claim, inspect, release, and reclaim cycles while the DraftForge companion remains healthy.

7. **Separate automation lifecycle wording from live monitoring.**
   - Rename one-time preflight automation deletion as `preflight completed and retired`.
   - Never label the live companion, command-center heartbeat, or room binding as deleted when only the scheduler entry was removed.
   - Acceptance: lifecycle tests and UI copy clearly distinguish scheduled wakeups from the active draft monitor.

### P2 — Operator experience and release discipline

8. **Record sound preference without coupling it to authority — resolved in the post-live candidate.**
   - Report whether ESPN is muted or unmuted, and prefer muted audio during automated testing.
   - Do not disarm, refuse, retry, or alter a selection, nomination, bid, readiness result, or final audit solely because sound is on.
   - Keep ESPN Autopick as the independent hard gate.

9. **Enforce a live-draft code freeze.**
   - The draft-day command should reject build, extension reload, dashboard hot-reload, or tracked-source modification while a real room is active unless an explicit emergency-release procedure is invoked.
   - Record the dirty-worktree state before kickoff and defer backlog changes until completion.
   - Acceptance: the production draft process continues from certified artifacts while documentation/evidence capture remains possible in a separate safe path.

10. **Add an operator-critical audit cadence.**
    - Publish state changes immediately and retain the five-second heartbeat only as a watchdog.
    - Include `capturedAt`, ESPN-context age, pick-feed age, source age, and last successful action time so chat can distinguish a slow drafter from stale telemetry.

## Validation sequence after the real draft

1. Finish and audit the real roster before touching runtime code.
2. Preserve the final loopback audit, sanitized action chronology, and the exact uncontrolled 2.14 transition as fixtures.
3. Revert or separately review any unvalidated live-worktree edits; do not merge them by inertia.
4. Implement P0 items in narrow commits with focused tests.
5. Run `npm test`, then the full `npm run check` release gate.
6. Run authenticated snake recovery rehearsals covering draft-start lag, Autopick activation, explicit re-arm, chat announcement, varied safe timing, roster attribution, and Chrome reclaim.
7. Run the unchanged salary-cap regression suite to prove no impact to bids, ceilings, reserve, nomination timing, or specialist completion.
8. Repeat deterministic 20 snake plus 20 salary-cap drafts and the existing paired Monte Carlo/replay gates.

## Non-goals

- No ranking-weight changes from this incident alone.
- No sixth source or decision-time news mutation.
- No weakening of exact league/team/tab, five-source freshness, clock, roster, salary, or action-surface guards.
- No post-draft league-management features.
- No claim that the uncontrolled Drake Maye selection was optimal or harmful without counterfactual evidence.
