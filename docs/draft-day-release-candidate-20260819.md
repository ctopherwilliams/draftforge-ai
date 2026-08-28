# DraftForge draft-day release candidate — 2026-08-19

## Historical release decision

This document records the candidate decision made on 2026-08-19 for revision `af06f0d64343f9a601c3ec803d913483e0f5a352`. It is not a certification of the current tree. The authenticated ESPN room evidence remains historical evidence, but the mixed-profile captured-snapshot simulations below predate strict scoring/team-count/season/QB binding and are non-certifying under the current validator. A current release must regenerate valid exact-profile snapshots and rerun the replacement commands in the reproduction section; synthetic adversarial variants remain a separate campaign.

Release branch revision at live certification: `af06f0d64343f9a601c3ec803d913483e0f5a352`.

Chrome companion:

- version `0.2.16`;
- package SHA-256 `027d5abe34412717f6b70c9a21922eee4cc5a9e40ba84789848d6589003dacd2`;
- exact DraftForge/ESPN sender origins, exact room/team/tab binding, exact player identity, muted sound, ESPN Autopick-off, and clock checks remain mandatory.

## Authenticated ESPN evidence

The clean-room campaign completed 20/20 snake and 20/20 salary-cap practice drafts. Every countable room required a complete loopback audit, exact ESPN/app roster parity, legal roster construction, one K and one D/ST, five fresh sources, muted sound, ESPN Autopick off, exact tab binding, and automatic DraftForge shutdown. Setup-contaminated, Autopick-contaminated, ambiguous, incomplete, or unauditable rooms were excluded.

The final fresh snake release room completed 16/16 with exact parity and zero hard or final violations. Exact clock-to-submit telemetry for its 16 successful selections was:

| Metric | Result |
| --- | ---: |
| p50 | 311.5 ms |
| p95 | 1,139.75 ms |
| p99 | 1,175.15 ms |
| maximum | 1,184 ms |
| over 1.5 seconds | 0 |

The final fresh salary-cap release room completed 14/14 with exact player/price parity, $196 spent, $4 remaining, and zero hard or final violations. Across 137 successful live submissions, clock-to-submit p95 was 719.8 ms, p99 was 1,414.2 ms, and the maximum was 1,717 ms. Bids alone had p95 491.65 ms and p99 944.13 ms. Stale offers and nominee transitions failed closed and retried from fresh state.

The snake latency correction is intentionally narrow. Once ESPN confirms ten rostered players, ordinary snake search retains deterministic candidate order and exact identity but uses a bounded 1.24-second resolution profile. Early snake picks, salary-cap actions, mandatory K/DST filtering, the ten-second snake clock floor, confirmation-before-advance, and all fail-closed checks are unchanged.

## Historical Monte Carlo and holdout regression (superseded evidence boundary)

Seed `20260820` historically ran one frozen 10,000-draft campaign per format. Each used 6,000 discovery, 2,000 validation, and 2,000 holdout trials, with 80% saved authenticated settings and 20% seeded ESPN-compatible adversarial variants. Those figures are retained for audit history, not as current source-provenance evidence: one captured source profile may no longer be replayed across a different scoring, team-count, season, QB, or draft-format profile.

| Format | Immutable snapshot | Drafts | Failures | Hard violations | Determinism digest |
| --- | --- | ---: | ---: | ---: | --- |
| Snake | `38604a70ba64ff02c7b019a1b736885d9521236203e9daca473b80d709db944f` | 10,000 | 0 | 0 | `eab04080b0d3161343066bf1523719baabc1aeb1a1fad74acf57dd2b86888b6b` |
| Salary cap | `7c1d974b8f92339a4f68ef904bed97cc3467b9309f8815f879cbaf706a193b5e` | 10,000 | 0 | 0 | `f90011bc531d7092409aef5a1d1137e75099e0b2d68d97ccede44f0d1fc5ff78` |

All 20,000 drafts had zero duplicate players, incomplete rosters, unnecessary second specialists, position-cap violations, salary-cap violations, reserve violations, max-bid violations, or missing mandatory starters. All 4,000 holdout records were replayed with identical seeds; every serialized trial record matched exactly, with zero mismatches.

Selected aggregate estimates and 95% confidence intervals:

| Format | Starting-lineup mean (95% CI) | VORP mean (95% CI) | Static-roster win probability (95% CI) | P25 total projection |
| --- | ---: | ---: | ---: | ---: |
| Snake | 1,911.23 (1,909.08–1,913.38) | 702.55 (700.79–704.32) | 92.94% (92.53%–93.36%) | 2,850.95 |
| Salary cap | 2,002.77 (1,999.91–2,005.64) | 1,123.44 (1,120.73–1,126.16) | 62.46% (61.66%–63.26%) | 2,794.03 |

These values are model-specific and should be used for regression comparison, not as literal forecasts of a real league championship probability.

## Source and sleeper evidence

The fixed weighted consensus remains ESPN 30%, GNG 20%, Tradyr 20%, FFC 15%, and MFL 15%. No source, source weight, freshness rule, or sleeper threshold changed during release certification.

- Standard snake snapshot: 50.63% of rosterable players had at least four sources and 43.13% had all five. Coverage was strongest early and weakest late. It produced one five-source `VALUE`, but no qualified late `SLEEPER` or `DEEP_STASH`.
- PPR salary-cap snapshot: 60.12% had at least four sources and 47.62% had all five. It produced no qualified sleeper signal.
- K and D/ST remain public-feed coverage gaps. ESPN remains platform truth and mandatory specialist rules stay authoritative.

The absence of a sleeper label is evidence discipline, not a reason to weaken corroboration. Sleeper acquisition and timing remain an explicit weakness until a frozen snapshot contains enough qualified candidates to measure them.

## Command-center and operations certification

The graphite/white/blue/amber command center passed desktop, two-rail, tablet, and mobile static checks without material overlap or horizontal overflow. The live decision, clock, exact action, bid ceiling/walk point, reserve, roster needs, and safety state remain primary; sources, reasoning, opponent leverage, and activity are progressive disclosure. Presentation changes do not bypass submission callbacks or safety gates.

The release runtime passed cold-start, exact two-tab launch, dashboard reload recovery, extension reload, stale-action rejection, source degradation, sound-on, ESPN Autopick detection/recovery, wrong/ambiguous tab, completion, and automatic shutdown checks. Draft day still requires the two READY gates in `DRAFT_DAY_HANDOVER.md`.

## Remaining weaknesses and tradeoffs

- ESPN draft-room markup and undocumented endpoints can change. Unknown controls fail closed and require manual ESPN fallback.
- Public-source player coverage is incomplete, especially late and for specialists.
- Opponent archetypes are synthetic and cannot reproduce every human room.
- Static-roster season evaluation excludes waivers, trades, lineup management, and later injuries, which are outside this ESPN-only draft scope.
- Salary-cap nomination counterfactuals remain noisier than acquired-player decisions. Mixed evidence did not justify a broad strategy retune.
- A cold five-source warmup can take about 16–20 seconds. It must finish before room creation; a room contaminated by setup delay or ESPN Autopick is excluded.

## Current replacement reproduction commands

```bash
# Full local gate
npm run check
npm audit --audit-level=high

# Capture fresh snapshots from each exact authenticated profile first. Old local
# 2026-08-19 artifacts do not satisfy the current QB/coverage schema.
npm run snapshot:capture -- --espn outputs/source-capture/exact-snake-profile.json
npm run snapshot:capture -- --espn outputs/source-capture/exact-salary-cap-profile.json

# Exact-profile player evidence. The snapshot selects and binds its own format.
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260820 --snapshot <current-snake-snapshot.json> --expose-holdout --counterfactual-cases 10 --output outputs/monte-carlo/current-exact-snake-seed-20260820-10000
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260820 --snapshot <current-salary-cap-snapshot.json> --expose-holdout --counterfactual-cases 10 --output outputs/monte-carlo/current-exact-salary-cap-seed-20260820-10000

# Separate synthetic/authenticated-settings-fixture + adversarial stress campaign.
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260820 --expose-holdout --skip-counterfactuals --output outputs/monte-carlo/current-synthetic-adversarial-seed-20260820-10000

# Deterministic exact-profile holdout replays.
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260820 --phases holdout --snapshot <current-snake-snapshot.json> --expose-holdout --skip-counterfactuals --output outputs/monte-carlo/current-exact-snake-holdout-seed-20260820-10000
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260820 --phases holdout --snapshot <current-salary-cap-snapshot.json> --expose-holdout --skip-counterfactuals --output outputs/monte-carlo/current-exact-salary-cap-holdout-seed-20260820-10000
```

Generated trial ledgers and reports remain under ignored `outputs/monte-carlo/`. Every replacement command must complete its exact requested count with zero failure seeds; paired comparisons additionally require one-to-one seed/split/scenario/league/source identity. Durable historical sanitized evidence remains in `simulation/evidence/authenticated-certification-20260818.json` and must not be relabeled as current strict-profile evidence.
