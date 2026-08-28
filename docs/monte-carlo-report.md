# DraftForge Monte Carlo stress tests

> Historical tuning record: captured-snapshot campaigns in this document predate exact scoring/team-count/season/QB/format replay binding. Their mixed-profile commands and figures are retained for audit history and are not current certification evidence. Use the exact-profile and separate synthetic/adversarial commands in the README for new runs.

## Current evidence semantics (schema v3)

The current harness keeps production strategy code unchanged while making the audit layer more discriminating:

- a captured five-source snapshot now supplies immutable player truth to both the exact authenticated league (80% of trials) and clearly labeled ESPN-compatible rules variants (20%); variant trials never claim that the sources were fetched for the alternate profile;
- salary-cap acquisitions are evaluated as price decisions through bounded `BID`, `PASS`, and alternate-ceiling continuations, rather than against unrelated raw player ranks;
- counterfactual candidates have independent snake-pick, acquired-player, underbid, target-nomination, and drain-nomination queues, preventing deliberate drain nominations from crowding out other decision classes;
- auction outcomes are streamed into bounded strata for source count, price-input coverage, consensus confidence, price tier, and positional-run intensity;
- the old 64-sample zero-heavy title indicator is replaced by a smooth deterministic static-roster title estimate, plus season-strength percentile and upper-quartile opponent-strength margin. These are paired evidence signals, not claims about in-season management.

All evidence and ordered-outcome digest domains were versioned forward. Digests from schema-v2 runs remain valid historical artifacts but are not expected to match schema-v3 replays.

## 2026-08-28 post-live synthetic regression matrix

The post-live working candidate completed two separate five-seed matrices:

| Format | Requested | Completed | Failures | Hard invariant counts |
| --- | ---: | ---: | ---: | ---: |
| Snake | 10,000 | 10,000 | 0 | 0 across all 11 recorded classes |
| Salary cap | 10,000 | 10,000 | 0 | 0 across all 11 recorded classes |

Each format ran 2,000 drafts for seeds `20260828`, `18472631`, `73190422`, `41586703`, and `96724011`. The zero classes were duplicate players, unavailable selections, invalid keeper count, invalid keeper price, incomplete rosters, unnecessary second specialist, position cap, salary cap, one-dollar reserve, max bid, and missing mandatory starter.

The separate 2,000-draft snake replay for seed `20260828` matched both baseline identities exactly:

- determinism digest: `b5dc2cf5c84f35000a45256e10838d9d09e5bee7bb069ff464c2d966171ba695`;
- ordered outcome digest: `e82d110285ff2133a749cf083ef8da2d409ce8abed252db463ff50f1ed05a63a`.

The independent 2,000-draft salary-cap replay for seed `20260828` also matched both baseline identities exactly:

- determinism digest: `6305a5b2cbe02c61a8751a99270559d31b341854634939009a4ebaefc0c6ef06`;
- ordered outcome digest: `279251a06f49915e3e69f6859d5cf65b4fab520b0731d95cf486250dc9306ebd`.

Its production-code and evidence-identity digests also matched the original run. This proves deterministic replay of the modeled salary-cap mechanics; it does not upgrade the synthetic evidence to current or authenticated player truth.

```bash
npm run simulate:matrix -- --drafts 2000 --seeds 20260828,18472631,73190422,41586703,96724011 --formats snake --output outputs/monte-carlo/final-postfix-snake-20260828

npm run simulate:matrix -- --drafts 2000 --seeds 20260828,18472631,73190422,41586703,96724011 --formats salary-cap --output outputs/monte-carlo/final-postfix-salary-cap-20260828

npm run simulate:matrix -- --drafts 2000 --seeds 20260828 --formats snake --output outputs/monte-carlo/final-postfix-snake-replay-20260828

npm run simulate:matrix -- --drafts 2000 --seeds 20260828 --formats salary-cap --output outputs/monte-carlo/final-postfix-salary-cap-replay-20260828
```

Both baseline summaries explicitly report `sourceSnapshotDigest: null`, evidence class `synthetic-mechanics-only`, status `SYNTHETIC_NON_CERTIFYING`, and blocker `CURRENT_SOURCE_FORMAT_EXACT_V2_SNAPSHOT_REQUIRED`. These runs support deterministic mechanics and safety-invariant regression only. They do not certify current rankings, current player availability, source freshness, or authenticated ESPN control.

## 2026-08-18 overnight 20+20 battle qualification

DraftForge completed four bounded five-draft batches per format against one frozen authenticated ESPN five-source snapshot: **20 accepted snake drafts and 20 accepted salary-cap drafts**. Each format used 16 saved authenticated-settings trials and four seeded ESPN-compatible adversarial trials, split into 12 discovery, four validation, and four holdout drafts. Every roster completed with zero duplicate-player, incomplete-roster, duplicate-specialist, position-cap, salary-cap, reserve, max-bid, mandatory-starter, or simulation violations.

The immutable snapshot was captured at `2026-08-17T23:11:22.400Z` with digest `25c2f8bf053c6491bca73cbacca7fa7502493c380f52937f9b2bc713501f7abd`. Its deterministic inputs are ESPN, FFC, MFL, Tradyr, and GNG. The batch seeds were `20260821`, `20260822`, `20260823`, and `20260824`. The sealed fourth batch was exposed only after the candidate held through the preceding batches; replaying it produced the same five records per format and exact zero paired metric deltas.

| Format | Drafts | Lineup mean | Lineup P25 | VORP mean | Objective mean | Objective P25 | Regret mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Snake | 20 | 2564.32 | 2553.08 | 1697.21 | 2996.39 | 2958.51 | 475.12 |
| Salary cap | 20 | 2052.92 | 1975.52 | 1186.90 | 2188.98 | 2049.19 | 1665.15 |

Salary-cap remaining-budget efficiency averaged `0.9087` with a `0.8602` P25. Snake roster fragility averaged `30.17` with a `28.64` P25; salary-cap fragility averaged `22.65` with a `20.13` P25.

### Evidence-linked engine change

Batch one reproduced the same snake decision defect in two independent saved-settings `ELITE_QB` seeds: `570294550` and `536739312`. At decision 13, a fractional FLEX need caused a one-TE lineup to treat a third tight end as starter depth. The production engine now uses the exact dedicated TE slot count for tight-end depth saturation, while preserving fractional FLEX eligibility for VORP comparisons.

The five-seed paired replay improved mean starting-lineup projection by `+5.51`, total projection by `+55.18`, VORP by `+25.18`, regret by `-93.15`, and composite objective by `+26.49`. P25 total projection improved `+19.68`, P25 VORP `+14.70`, P25 regret `-112.17`, and P25 objective `+26.44`; lineup P25 and fragility P25 were unchanged. Mean fragility rose `+1.36` in that small paired batch, with an interval spanning zero. Focused tests, the full suite, the next 15 drafts per format, and the untouched holdout found no safety regression.

No salary-cap strategy change was accepted. Bid, pass, alternate-ceiling, target-nomination, and drain-nomination continuations remained directionally contradictory across discovery and validation. Some target/bid branches improved, some drain/pass branches improved, and some target branches materially worsened. A global auction-policy change would overfit these synthetic rooms.

### Reproduction

```bash
npm run snapshot:capture -- --validate snapshots/intelligence/source-v1-2026-08-17T23-11-22.400Z-ppr-12t-25c2f8bf053c.json

npm run simulate:monte-carlo -- --drafts 5 --seed 20260821 --formats snake --snapshot snapshots/intelligence/source-v1-2026-08-17T23-11-22.400Z-ppr-12t-25c2f8bf053c.json --expose-holdout --skip-counterfactuals --output outputs/monte-carlo/overnight-b1-snake-replay-seed-20260821

npm run simulate:monte-carlo -- --drafts 5 --seed 20260821 --formats salary-cap --snapshot snapshots/intelligence/source-v1-2026-08-17T23-11-22.400Z-ppr-12t-25c2f8bf053c.json --expose-holdout --skip-counterfactuals --output outputs/monte-carlo/overnight-b1-salary-cap-replay-seed-20260821

npm run check
```

Repeat the two simulation commands with seeds `20260822`, `20260823`, and `20260824` for the remaining batches. Machine-readable evidence, including the ten largest remaining regret cases, is tracked in `simulation/evidence/overnight-battle-20260818.json`; exact ledgers remain in ignored `outputs/monte-carlo/overnight-*` directories.

### Remaining evidence boundary

- The opponent field is varied but synthetic and cannot reproduce every human room.
- Only 37.5% of rosterable players had four-source coverage and 23.21% had full five-source player-level coverage. Live actions still fail closed when required current coverage is incomplete.
- The snapshot produced no qualifying corroborated sleeper acquisitions. Sleeper protections remain covered by deterministic tests, but this campaign supplies no new evidence of sleeper upside.
- Snake static-roster win probability saturated at one, so projection, VORP, regret, fragility, and objective are the useful discriminators here.
- This was intentionally browser-free and does not advance authenticated ESPN completion counts.

## Independent mission-control verification seed

After the mission-control visual rebuild, the frozen production engine completed the explicit 20-draft gate for each format: 20 snake drafts (2,560 selections) and 20 salary-cap drafts (2,560 sales), with no incomplete rosters or invariant failures.

An independent `20260817` campaign then completed 10,000 snake and 10,000 salary-cap simulations against the same immutable authenticated five-source snapshot. The public discovery and validation set contained 16,000 drafts and the 4,000 holdout drafts remained sealed. All hard-invariant and simulation-error counts were zero. The deterministic digest was `a32f3dba653f1ac0022180e93c71399c4e09ec17d9fe4504aab42ad563e6a76a`.

| Public metric | Mean | P25 |
| --- | ---: | ---: |
| Starting-lineup projection | 2282.74 | 2013.78 |
| Total projection | 3396.20 | 2930.24 |
| VORP | 1370.67 | 1134.03 |
| Composite objective | 2547.69 | 2162.57 |
| Remaining-budget efficiency | 0.9151 | 0.8548 |

The ten largest regret cases were all salary-cap contexts. Exact five-way counterfactual continuations produced an even split: bid/target was best in five cases and pass/drain was best in five. Every branch remained legal, but the opposing outcomes occurred across both discovery and validation. A global bid, pass, ceiling, or nomination-policy change would therefore be test-fitting, so no production strategy change was accepted.

The remaining improvement boundary is now data rather than an uncovered deterministic rule. Only 39.29% of rosterable players have full five-source player-level coverage, this snapshot produced zero qualifying corroborated sleeper observations, and the synthetic rooms cannot supply observed human bid/pass response curves. The next justified tuning cycle requires fresher, denser five-source player coverage plus authenticated ESPN auction outcome telemetry. Draft actions continue to fail closed when required live source coverage is incomplete.

```bash
node --test --test-concurrency=1 tests/full-draft-simulation.test.mjs

npm run simulate:monte-carlo -- --drafts 10000 --seed 20260817 --snapshot snapshots/intelligence/source-v1-2026-08-15T03-23-31.378Z-ppr-12t-1a6c36e176bf.json --skip-counterfactuals --output outputs/monte-carlo/mission-control-final-seed-20260817-10000

npm run simulate:monte-carlo -- --drafts 10000 --seed 20260817 --snapshot snapshots/intelligence/source-v1-2026-08-15T03-23-31.378Z-ppr-12t-1a6c36e176bf.json --counterfactual-replay salary-cap:1409
```

Machine-readable evidence is tracked in `simulation/evidence/mission-control-verification-20260817.json`.

## 2026-08-16 live-snapshot UI and engine validation

### Result

The rebuilt snake and salary-cap command center was validated first, then the unchanged production engine completed a new seeded campaign using the sanitized authenticated ESPN five-source snapshot. The baseline completed 10,000 snake and 10,000 salary-cap drafts with seed `20260816`; 6,000 discovery, 2,000 validation, and 2,000 untouched holdout trials were assigned per format. Eighty percent used the saved ESPN league settings and twenty percent used seeded ESPN-compatible adversarial variants.

All 20,000 baseline drafts and the separate 4,000-draft holdout exposure completed. There were zero duplicate players, incomplete rosters, unnecessary second K/DST selections, position-cap violations, salary violations, reserve violations, max-bid violations, missing mandatory starters, or simulation errors. The exposed holdout reproduced every baseline metric exactly with zero paired deltas.

This is strong evidence for legality, determinism, and robustness under the modeled rooms. It is not proof of perfect or globally optimal draft decisions.

### UI outcome

- One persistent operations rail now consolidates league, progress, strategy, five-source health, and exact ESPN connection state.
- The primary card begins with one large `DO THIS NOW` command and a distinct `ACTION READY`, `PREPARED`, or `LOCKED` state.
- Salary-cap mode makes the current offer, fair value, hard ceiling, reserve floor, spendable runway, and `$1 × open slots` reserve visible before secondary explanation.
- Roster needs remain prominent and sticky on desktop; opponent leverage, reasoning, source detail, and recent activity use progressive disclosure.
- Safe disconnected Snake and Salary cap previews support visual inspection without authorizing an ESPN action.
- Desktop, tablet, and 390-pixel mobile checks showed no horizontal overflow. All existing action callbacks and fail-closed guards remain unchanged.

### Live source evidence

The immutable snapshot digest is `1a6c36e176bf602d584661a7936f3ac4683fe84ebb78eef8e22540e6a7fef896`, captured `2026-08-15T03:23:31.378Z`. It contains 500 ESPN players plus fresh FFC, MFL, Tradyr, and GNG inputs. At least four sources covered 43.45% of the rosterable board and all five covered 39.29%; the production decision path still fails closed unless its required current five-source decision snapshot is healthy.

Public discovery and validation aggregates cover 16,000 drafts. The untouched holdout results were:

| Format | Drafts | Lineup mean | Lineup P25 | VORP mean | Objective mean | Objective P25 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Snake | 2,000 | 2529.49 | 2497.12 | 1609.43 | 2928.20 | 2878.99 |
| Salary cap | 2,000 | 2044.37 | 1937.73 | 1140.99 | 2179.80 | 2057.69 |

Salary-cap holdout remaining-budget efficiency averaged 0.8363 with a 0.7404 P25. Every holdout hard-invariant count was zero.

### Evidence decision

Two high-regret snake outliers suggested that an early QB/OP starter floor could help Zero-RB rooms. A narrow snake-only candidate was reproduced on trials `6465` and `2337`, then tested across all 8,000 paired discovery and validation snake drafts. It improved mean starting-lineup projection by 8.34, reduced regret by 32.84, and raised mean objective by 7.46. It also reduced total projection by 10.31 and VORP by 9.46, increased fragility by 0.37, and lowered paired P25 objective by 9.42. The candidate therefore failed the lower-tail acceptance rule and was removed.

The largest salary-cap outliers were non-acquired nomination proxies. Bounded bid/pass/alternate-ceiling/target/drain continuations were legal but mixed across validation; they did not justify changing the production target-versus-drain policy. No production strategy change was accepted in this cycle.

### Largest remaining regret cases

| Format | Trial | Split | Decision | Evaluation | Regret |
| --- | ---: | --- | ---: | --- | ---: |
| Salary cap | 545 | Discovery | 6 | Nomination proxy | 291.68 |
| Snake | 6465 | Validation | 3 | Acquisition | 279.31 |
| Salary cap | 264 | Discovery | 3 | Nomination proxy | 258.90 |
| Snake | 2337 | Discovery | 3 | Acquisition | 256.03 |
| Salary cap | 2110 | Discovery | 3 | Nomination proxy | 255.22 |
| Salary cap | 7379 | Validation | 7 | Nomination proxy | 253.48 |
| Salary cap | 5789 | Discovery | 4 | Nomination proxy | 253.30 |
| Salary cap | 1373 | Discovery | 6 | Nomination proxy | 252.00 |
| Salary cap | 7114 | Validation | 3 | Nomination proxy | 251.28 |
| Salary cap | 6259 | Validation | 8 | Nomination proxy | 249.05 |

Non-acquired nomination proxies remain excluded from aggregate acquisition regret. They are retained to prioritize future target-versus-drain experiments.

### Reproduction

```bash
npm run snapshot:capture -- --validate snapshots/intelligence/source-v1-2026-08-15T03-23-31.378Z-ppr-12t-1a6c36e176bf.json

npm run simulate:monte-carlo -- --drafts 10000 --seed 20260816 --snapshot snapshots/intelligence/source-v1-2026-08-15T03-23-31.378Z-ppr-12t-1a6c36e176bf.json --skip-counterfactuals --output outputs/monte-carlo/ui-rebuild-baseline-seed-20260816-10000

npm run simulate:monte-carlo -- --drafts 10000 --seed 20260816 --phases holdout --expose-holdout --snapshot snapshots/intelligence/source-v1-2026-08-15T03-23-31.378Z-ppr-12t-1a6c36e176bf.json --compare outputs/monte-carlo/ui-rebuild-baseline-seed-20260816-10000 --skip-counterfactuals --output outputs/monte-carlo/ui-rebuild-final-holdout-seed-20260816-10000

npm run simulate:monte-carlo -- --drafts 10000 --seed 20260816 --snapshot snapshots/intelligence/source-v1-2026-08-15T03-23-31.378Z-ppr-12t-1a6c36e176bf.json --counterfactual-replay snake:6465

npm run lint
npm test
```

Machine-readable evidence is tracked in `simulation/evidence/ui-rebuild-20260816.json`. Generated full summaries and reports are under `outputs/monte-carlo/` and remain ignored because the trial ledgers and third-party snapshot are large.

### Remaining weaknesses

- The opponent field is varied but synthetic and cannot model every human room.
- Snake static-roster win probability saturated near one in this snapshot, so projection, VORP, regret, fragility, and objective are more discriminating for that format.
- Sleeper acquisition/timing metrics were zero because this captured board did not produce qualifying corroborated sleepers; deterministic sleeper safety tests still pass, but this campaign is not fresh evidence of sleeper upside.
- Only 39.29% of rosterable players had full five-source player-level coverage. Draft actions still fail closed when the required live decision snapshot is incomplete.
- Static-roster evaluation intentionally excludes post-draft waivers, trades, lineup management, and injuries.

## Result

The accepted cycle-1 candidate completed 10,000 snake and 10,000 salary-cap simulations with seed `20260814`. All 20,000 drafts completed, all 20,000 paired baseline records were matched, and all 50 bounded counterfactual continuations completed.

There were zero duplicate players, incomplete rosters, unnecessary second K/DST selections, position-cap violations, missing mandatory starters, salary-cap violations, one-dollar-reserve violations, max-bid violations, simulation errors, counterfactual errors, or counterfactual safety violations.

This is evidence of improved behavior under the modeled conditions, not a claim of a perfect or globally optimal strategy.

## Baseline versus final

| Metric | Mean paired delta | 95% confidence interval | P25 result |
| --- | ---: | ---: | ---: |
| Starting-lineup projection | +2.7472 | +2.5947 to +2.8997 | No paired-seed regression |
| Total projection | +0.1812 | +0.0218 to +0.3406 | No paired-seed regression |
| VORP | +0.2547 | +0.1050 to +0.4045 | No paired-seed regression |
| Static-roster win probability | +0.005304 | +0.004639 to +0.005969 | No paired-seed regression |
| Decision regret | -0.2262 | -0.3911 to -0.0612 | No paired-seed regression |
| Composite objective | +2.4648 | +2.2890 to +2.6406 | No paired-seed regression |

The snake holdout independently retained the effect: mean starting-lineup projection improved by 5.232 points (95% CI +4.595 to +5.869), win probability by 1.005 percentage points (CI +0.731 to +1.278), and composite objective by 4.515 (CI +3.787 to +5.244). Its actual P25 starting-lineup projection improved by 9.918 and P25 objective by 7.171. Salary-cap holdout results were statistically neutral, with unchanged sleeper acquisition/timing and no safety regression.

The tradeoff is small but measurable: mean roster-fragility score rose by 0.0149 overall and by 0.0293 in snake holdout; snake-holdout P25 fragility rose 0.0406. Mandatory starter strength and primary P25 outcomes improved materially, but the late RB correction occasionally displaced backup depth.

## Scenario breakdown

| Format and settings | Drafts | Starting lineup | Win probability | Objective |
| --- | ---: | ---: | ---: | ---: |
| Snake, saved authenticated settings | 8,000 | 2755.63 | 22.72% | 3256.87 |
| Snake, adversarial ESPN variants | 2,000 | 2572.98 | 13.62% | 3057.96 |
| Salary cap, saved authenticated settings | 8,000 | 2139.01 | 10.89% | 2543.19 |
| Salary cap, adversarial ESPN variants | 2,000 | 2360.53 | 21.93% | 2814.54 |

For the saved 10-team snake settings, slot-level starting-lineup projection ranged from 2750.77 at slot 10 to 2761.84 at slot 4. Simulated win probability ranged from 19.08% at slot 10 to 25.22% at slot 3. Full 8-, 10-, 12-, and 14-team slot tables are in the generated report.

## Evidence-linked changes

1. The simulator player-depth buffer was restored after the first harness run exposed 242 late-round inventory dead ends confined to the deep 14-team adversarial variant. Every failed seed replayed successfully, and the corrected baseline completed 20,000/20,000. This was a harness defect, not a production-engine defect.
2. The production engine now softens the `ZERO_RB` RB score discount only when a mandatory skill starter remains empty after 55% roster completion. Early Zero-RB behavior is unchanged. Auction ceiling calculations continue to use the configured preset multiplier, so the change cannot raise a walk-away bid.
3. The evaluator now excludes salary-cap nominations DraftForge did not acquire from aggregate decision regret. Those nominations remain available as explicitly labeled target-versus-drain proxies for bounded counterfactual testing. A paired 2,000-draft check preserved every draft digest and roster metric while removing false regret from all 1,000 salary-cap trials.

Representative paired reproduction seeds are snake discovery trial `2268` (objective +152.15; lineup +113.65; regret -104.26) and snake validation trial `7199` (objective +140.72; lineup +113.82; win probability +6.25 percentage points). The complete evidence record is in `simulation/evidence/cycle-1.json`.

## Largest remaining regret cases

| Format | Trial | Split | Decision | Regret |
| --- | ---: | --- | ---: | ---: |
| Salary cap | 2768 | Discovery | 3 | 252.08 |
| Salary cap | 1275 | Discovery | 3 | 234.94 |
| Salary cap | 3289 | Discovery | 5 | 231.37 |
| Snake | 9089 | Holdout | 5 | 230.95 |
| Salary cap | 822 | Discovery | 3 | 224.86 |
| Salary cap | 6576 | Validation | 3 | 223.83 |
| Salary cap | 951 | Discovery | 3 | 222.29 |
| Salary cap | 7220 | Validation | 4 | 221.93 |
| Salary cap | 4816 | Discovery | 3 | 220.52 |
| Salary cap | 8846 | Holdout | 3 | 219.90 |

Nine of these rows are nomination proxies, not acquired players, so they are excluded from aggregate decision regret. They are retained to prioritize the required bid/pass/ceiling/target/drain continuations. Those five-action continuations produced mixed outcomes, so they did not support another production change.

## Reproduction

```bash
# Corrected sealed baseline (run from the documented pre-fix checkpoint)
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260814 --skip-counterfactuals --label corrected-regret-baseline-v3 --output outputs/monte-carlo/corrected-regret-baseline-v3-seed-20260814-10000

# Paired discovery and validation cycle
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260814 --phases discovery,validation --compare outputs/monte-carlo/corrected-regret-baseline-v3-seed-20260814-10000 --output outputs/monte-carlo/cycle-1-seed-20260814-10000

# Final paired run, including holdout
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260814 --expose-holdout --compare outputs/monte-carlo/corrected-regret-baseline-v3-seed-20260814-10000 --evidence simulation/evidence/cycle-1.json --output outputs/monte-carlo/corrected-regret-final-v3-seed-20260814-10000

# Exact regret replay
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260814 --replay salary-cap:2768

npm run lint
npm test
```

Machine-readable output: `outputs/monte-carlo/corrected-regret-final-v3-seed-20260814-10000/summary.json`

Full generated report: `outputs/monte-carlo/corrected-regret-final-v3-seed-20260814-10000/report.md`
Determinism digest: `2e80dd4fd58af8f83d305f628a547f97f2ef26319fb6ebe7013fa0c573fe0b7e`

## Limitations

- The repository did not contain a saved live five-source 2026 player snapshot. The harness therefore uses a seeded five-source-calibrated fixture passed through the production consensus merger. It tests mechanics and robustness, not current player-specific advice.
- Opponent archetypes are reproducible and varied but synthetic.
- Static-roster win probability excludes post-draft waivers, trades, lineup management, and later injuries, which are outside this ESPN-only draft scope.
- Quantiles use a bounded deterministic reservoir; exact means and confidence intervals stream across every completed trial.
- Early salary-cap nomination proxies remain the largest modeled uncertainty. Their counterfactual evidence was mixed, so no speculative second tuning cycle was applied.
