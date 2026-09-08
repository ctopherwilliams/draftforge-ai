# September 7 source replacement and auction safety follow-up

## Scope and decision

The user authorized replacing GNG when its underlying board could not be refreshed. Its live PPR API reported an August 19 generation and board version, separately from a September 7 sync. GNG's FAQ identifies generation time as the displayed source version. A new sync must not satisfy source freshness by itself.

FantasyPros ECR replaces GNG at the same 20% weight. The exact set is ESPN30/FantasyPros20/Tradyr20/FFC15/MFL15. Old GNG snapshots are rejected rather than relabeled. Historical reports and artifacts still describe their original sources. No selection formula, sleeper threshold, bid ceiling, reserve, roster rule, or extension permission was changed.

## Implemented protections

- Parse only bounded literal JSON from the public draft rankings page; never execute provider JavaScript. Bound response size, chunks, and complete request/body time.
- Verify NFL, season, draft/overall context, scoring and expert cohort identity. Require current board publication and every selected expert's update within the unchanged 14-day/five-minute-future limits. Record the oldest selected publication, not page-access time.
- Retain provider ranks without pretending they are projections or published auction dollars. Existing league-normalized auction estimates remain model estimates, not provider price quotes.
- Exclude all members of genuine same-name/position ambiguity with distinct provider IDs and teams. Duplicate IDs, ranks, or same-team duplicates still fail closed. The live PPR board had two Isaiah Williams records (NYJ/FA); neither may be guessed into an ESPN identity.
- Use one shared exact-keeper validator in the external readiness gate and UI action authorization. Missing, partial, wrong-price or asynchronously changed keeper evidence blocks the pinned event, including immediately before submission after awaited checks.
- Distinguish missing/invalid availability stages from transient read outages. Explicit missing/invalid evidence clears authorization and disarms; the UI only says cached when evidence actually exists.
- Preserve the old synthetic PRNG namespace when renaming a source, so paired simulation seeds keep their meaning. This does not reuse GNG data.

## Live source observations

Public endpoint and production canonicalizer checks on September 7 accepted PPR **547 usable rows / 127 selected experts**, Standard 537/127, Half PPR 976/132. PPR's conservative oldest-selected publication was `2026-09-01T04:15:40.000Z`; the aggregate board was published September 7. Provider health does not mean every ESPN player has all five matches.

Only the PPR/12-team/two-QB auction is the current event. FantasyPros' board is general PPR, not a custom two-QB auction board; ESPN scoring and matching Tradyr QB settings remain authoritative for league context. Half PPR has a substantially larger FA tail, which affects the existing percentile denominator. Access/parser success is not strategic certification of that profile. No speculative retirement filtering or broad engine retuning was applied.

## Validation

- Untouched baseline: `npm test`, 697/697 passed.
- Final integrated release check: `npm run check`, lint/typecheck/build and 765/765 tests passed.
- The initial replacement run exposed a synthetic seed-namespace change; retaining the published namespace restored the exact counterfactual replay case. A live canonicalizer check separately exposed the ambiguous Isaiah Williams rows; focused regressions now cover the safe exclusion boundary.
- Final `test:production-path` and `test:contention`: both passed. These are local harness results, not new authenticated ESPN draft completions or proof of improved season win probability.
- Seed `20260907`: 20/20 snake and 20/20 salary-cap simulations completed, zero format-level failures and zero hard violations. Eight holdouts remain sealed; aggregate tuning metrics show only 32 trials. Counterfactuals were explicitly skipped. The CLI correctly returned `SYNTHETIC_NON_CERTIFYING` rather than current-source certification. Summary digest: `0ea544e9ccf4c2c7c4c2a58a54d5d41ac24da7f05342d480eb515a709d095b50`. Artifacts are under `outputs/monte-carlo/fantasypros-contract-20260907/`.

## Operating boundary

Event: September 8, 2026, 8 PM America/Chicago; league 44050 / team 7 / season 2026. Pollard $0 and McLaurin $1 must yield $199 and 12 open draft slots. Keep Auto-Draft off until fresh imported rules/status, five-source identity, availability evidence, exact room, safe clock, Autopick-off and no-click gates all pass.

Companion 0.2.33 and its pinned package are unchanged; no reinstall is required. This release needs a dashboard refresh after the certified server starts. Keep exactly two Chrome tabs total for live authorization. The guard was not weakened to accept unrelated personal tabs; their presence must be treated as an explicit blocked checklist, not a false green. During this work only the existing two managed tabs were used; personal tabs were preserved.

Availability evidence is separately time-limited to 30 minutes and must be refreshed on draft day. Official-source review confirmed season-ending ACL reports for Jayden Higgins, Calvin Austin and Kendrick Law; Pacheco/Kirk/Tyson IR does not mean season-ending. Slayton's release requires a re-signing check, and Guerendo has inconsistent Active/Reserve-PUP labeling across official surfaces. Do not treat those uncertainties as resolved. The refreshed artifact uses exact published metadata and corrected canonical names; do not redate an old scan to keep it green.

## Reproduction and deployment

```bash
npm run check
npm run test:production-path
npm run test:contention
npm run simulate:monte-carlo -- --drafts 20 --seed 20260907 --skip-counterfactuals --output outputs/monte-carlo/fantasypros-contract-20260907
```

Stop the supervised production server before rebuilding. Commit/push the validated source, build from the clean revision, then use `npm start`. Refresh the existing dashboard and authenticated league import. A deployment that cannot fetch/validate the exact new five-source set must stay disarmed; never switch back to stale GNG data or bypass freshness to recover.
