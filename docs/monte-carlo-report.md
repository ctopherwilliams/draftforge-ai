# DraftForge Monte Carlo stress test — 2026-08-14

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
