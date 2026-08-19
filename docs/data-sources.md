# DraftForge player intelligence sources

DraftForge uses five complementary signals. ESPN remains the source of league truth; the other four sources change player valuation but never draft availability or league rules.

| Source | Role | Access | Refresh | Weight |
| --- | --- | --- | --- | ---: |
| ESPN Fantasy | League-specific projections, platform rank/ADP, auction value, injuries | Authenticated Chrome companion calls ESPN Fantasy's league/player JSON endpoints | Import and during draft | 30% |
| Fantasy Football Calculator | Recent redraft ADP, dispersion, and draft sample size | `GET /api/v1/adp/{format}?teams={n}&year={yyyy}` | Daily; DraftForge caches six hours | 15% |
| MyFantasyLeague | Cross-platform ADP and average auction value from completed leagues | Public MFL export API: `TYPE=players`, `TYPE=adp`, and `TYPE=aav` | Six-hour cache | 15% |
| Tradyr | Independent redraft-PPR composite | Bounded pages from `GET https://api.tradyr.app/v1/players?format=redraft&numQbs=1&limit=50&offset={n}` | Daily | 20% |
| The GNG Pigskin Rankings | Model ranking, tiers, movement, and projected PPG | `GET https://www.thegng.us/api/rankings.json?profile={standard|half_ppr|ppr}` | Source-generated timestamp; six-hour cache | 20% |

## Combination method

1. Normalize names, suffixes, punctuation, teams, and positions. A one-character fuzzy match is allowed only when team and position also agree.
2. Convert each source's overall rank into a 0–100 percentile so differently sized boards remain comparable.
3. Compute a weighted percentile consensus. Missing-player and failed-source weights are removed and the remaining weights are renormalized.
4. Reject a source snapshot older than 14 days. Show source coverage and rank dispersion for every recommendation.
5. Blend ESPN, FFC, and MFL ADP into the market-availability estimate. Blend ESPN and MFL auction values into the initial salary-cap market price.
6. Feed consensus, ESPN league-specific projected points, value over replacement, tier scarcity, roster construction, and selected strategy into the deterministic draft score.

The model never treats the five ranks as five equal expert opinions. ESPN projections answer “how valuable is this player in this league?”, while FFC/MFL answer “when or for how much will the room draft him?” Tradyr and The GNG add independent player-quality priors.

Tradyr pagination is sequential, capped at 1,000 rows, and remains one 20% source. The documented single-QB redraft page was verified field-for-field against the former `redraft-ppr` top 50 before adoption; offsets expand player reach without creating extra votes or changing consensus weights. A failed page fails the Tradyr source closed rather than silently retaining partial coverage.

## Immutable simulation snapshots

Player-specific Monte Carlo evidence uses a schema-versioned, content-addressed snapshot containing a sanitized ESPN league/player profile and the four public responses retrieved at the same capture time. Capture fails closed when any public source is failed, stale, or empty. Replay verifies the SHA-256 digest and evaluates source freshness relative to `capturedAt`, so the same saved input cannot change merely because wall-clock time advances.

ESPN negative D/ST IDs are preserved; placeholder IDs `0` and `-1`, raw settings, member identifiers, authentication data, and real team names are excluded. Source truth remains fixed during a simulated decision. Seeded projection uncertainty and late-news removals affect hidden outcomes or availability only, never the five-source recommendation input.

## Deterministic sleeper signal

Sleepers are derived from these same five sources; no editorial list or sixth weighted feed can override the consensus. DraftForge separates the ESPN/FFC/MFL market percentile from the Tradyr/GNG model percentile, then labels a player only when:

- both independent model feeds match the player and agree within 12 percentile points;
- ESPN plus at least one external market feed match the player, with at least four of five total sources present;
- the model percentile leads the market percentile by at least eight points;
- the player has positive scoring-adjusted value over replacement and no ESPN injury flag; and
- the combined edge, VORP, tier scarcity, coverage, and model agreement score reaches 50/100.

An ADP in rounds 1–5 is an ordinary `VALUE`, rounds 6–9 are a `SLEEPER`, and round 10 or later is a `DEEP STASH`. Snake drafts do not receive a sleeper timing bonus more than one league round before market ADP. Salary-cap drafts keep sleepers out of early target/drain nominations, add priority only as the room loses budget leverage, and never raise the source-backed max bid, position portfolio limit, pacing cap, or one-dollar-per-open-slot reserve.

Snapshot validation reports source reach, four-source and full-five-source coverage, complete market/model matches, and the production sleeper-evidence funnel. The 2026-08-19 expanded snapshot matched 181 Tradyr rows and improved the rosterable board from 41.07% to 60.12% at four or more sources and from 24.40% to 47.62% at all five. It still produced zero production-qualified sleeper signals: five players had positive model evidence, one cleared the eight-point model edge, and none reached the unchanged 50-point evidence threshold. This is an evidence gap, not permission to weaken corroboration.

## Attribution and usage

- [Fantasy Football Calculator ADP API](https://help.fantasyfootballcalculator.com/article/42-adp-rest-api) permits free personal and commercial use with requested attribution.
- [MyFantasyLeague](https://myfantasyleague.wordpress.com/2008/08/06/developer-api/) provides an open developer export API.
- [Tradyr API](https://api.tradyr.app/docs) is free for commercial use with attribution.
- [The GNG rankings](https://www.thegng.us/ranks) declares the JSON feed free to use with attribution and a link.
- ESPN's fantasy endpoints are undocumented and may change; the extension uses the user's existing ESPN session and fails closed if expected draft-room controls are not present.
