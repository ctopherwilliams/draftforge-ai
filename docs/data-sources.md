# DraftForge player intelligence sources

DraftForge uses five complementary signals. ESPN remains the source of league truth; the other four sources change player valuation but never draft availability or league rules.

| Source | Role | Access | Refresh | Weight |
| --- | --- | --- | --- | ---: |
| ESPN Fantasy | League-specific projections, platform rank/ADP, auction value, injuries | Authenticated Chrome companion calls ESPN Fantasy's league/player JSON endpoints | Import and during draft | 30% |
| Fantasy Football Calculator | Recent redraft ADP, dispersion, and draft sample size | `GET /api/v1/adp/{format}?teams={n}&year={yyyy}` | Daily; DraftForge caches six hours | 15% |
| MyFantasyLeague | Cross-platform ADP and average auction value from completed leagues | Public MFL export API: `TYPE=players`, `TYPE=adp`, and `TYPE=aav` | Six-hour cache | 15% |
| Tradyr | Independent redraft-PPR composite | `GET https://api.tradyr.app/v1/rankings/redraft-ppr` | Daily | 20% |
| The GNG Pigskin Rankings | Model ranking, tiers, movement, and projected PPG | `GET https://www.thegng.us/api/rankings.json?profile={standard|half_ppr|ppr}` | Source-generated timestamp; six-hour cache | 20% |

## Combination method

1. Normalize names, suffixes, punctuation, teams, and positions. A one-character fuzzy match is allowed only when team and position also agree.
2. Convert each source's overall rank into a 0–100 percentile so differently sized boards remain comparable.
3. Compute a weighted percentile consensus. Missing-player and failed-source weights are removed and the remaining weights are renormalized.
4. Reject a source snapshot older than 14 days. Show source coverage and rank dispersion for every recommendation.
5. Blend ESPN, FFC, and MFL ADP into the market-availability estimate. Blend ESPN and MFL auction values into the initial salary-cap market price.
6. Feed consensus, ESPN league-specific projected points, value over replacement, tier scarcity, roster construction, and selected strategy into the deterministic draft score.

The model never treats the five ranks as five equal expert opinions. ESPN projections answer “how valuable is this player in this league?”, while FFC/MFL answer “when or for how much will the room draft him?” Tradyr and The GNG add independent player-quality priors.

## Attribution and usage

- [Fantasy Football Calculator ADP API](https://help.fantasyfootballcalculator.com/article/42-adp-rest-api) permits free personal and commercial use with requested attribution.
- [MyFantasyLeague](https://myfantasyleague.wordpress.com/2008/08/06/developer-api/) provides an open developer export API.
- [Tradyr API](https://api.tradyr.app/docs) is free for commercial use with attribution.
- [The GNG rankings](https://www.thegng.us/ranks) declares the JSON feed free to use with attribution and a link.
- ESPN's fantasy endpoints are undocumented and may change; the extension uses the user's existing ESPN session and fails closed if expected draft-room controls are not present.
