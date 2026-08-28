# DraftForge player intelligence sources

DraftForge uses five complementary signals. ESPN remains the source of league truth; the other four sources change player valuation but never draft availability or league rules.

| Source | Role | Access | Refresh | Weight |
| --- | --- | --- | --- | ---: |
| ESPN Fantasy | League-specific projections, platform rank/ADP, auction value, injuries | Authenticated Chrome companion calls ESPN Fantasy's league/player JSON endpoints | Import and during draft | 30% |
| Fantasy Football Calculator | Recent redraft ADP, dispersion, and draft sample size | `GET /api/v1/adp/{format}?teams={n}&year={yyyy}` | Daily; DraftForge caches six hours | 15% |
| MyFantasyLeague | Cross-platform ADP and average auction value from completed leagues | Public MFL export API: `TYPE=players`, `TYPE=adp`, and `TYPE=aav` | Six-hour cache | 15% |
| Tradyr | Independent redraft-PPR composite | One server-only bearer-authenticated atomic request to `GET https://api.tradyr.app/v1/players?format=redraft&numQbs={1\|2}&limit=1000&offset=0` | Daily | 20% |
| The GNG Pigskin Rankings | Model ranking, tiers, movement, and projected PPG | `GET https://www.thegng.us/api/rankings.json?profile={standard|half_ppr|ppr}` | Source-generated timestamp; six-hour cache | 20% |

## Current certification boundary — 2026-08-28

Current authenticated source certification is **NO-GO**. The certified Mac now stores the Tradyr credential in its native Keychain and injects it only into the production server process, but no fresh authenticated schema-v3 snapshot from the final committed revision exists yet. `outputs/source-capture/release-salary-source-20260827.json` is schema v1, was captured at `2026-08-28T03:13:30.425Z`, contains only 50 unkeyed Tradyr rows, and is historical regression evidence only. Its age, schema, profile identity, and missing authenticated ESPN provenance must prevent it from satisfying current readiness.

A current capture requires a fresh authenticated ESPN artifact with a canonical UTC `capturedAt`, exact scoring/team-count/season/QB/format profile, and matching sanitized authentication attestation. Snapshot construction then requires all five providers and binds the exact profile plus provider data to its digest. Missing credentials, a stale or future timestamp, a profile mismatch, a stale ESPN player pool, an old schema, incomplete provider coverage, or a digest mismatch is fatal. Never rewrite an old artifact's timestamp or metadata to make it appear current.

The live WARM and READY path adds a shorter authorization window: WARM and the active dashboard audit must publish the same exact source profile, canonical generation timestamp, and lowercase `sha256:<64 hex>` identity. The doctor uses a retained exact tuple and must not refetch or silently replace source truth during verification or an active decision.

Official availability news is intentionally outside this weighted table. Authenticated ESPN Player News plus official NFL/team/league evidence may populate the separate short-lived hold/veto artifact. Definitive, exactly resolved events can block a player; advisories, legal allegations, rumors, ambiguous identities, contradictions, or stale evidence cannot change a rank, projection, sleeper label, or bid ceiling. The overlay is never a sixth source.

## Combination method

1. Normalize names, suffixes, punctuation, teams, and positions. A one-character fuzzy match is allowed only when team and position also agree.
2. Convert each source's overall rank into a 0–100 percentile so differently sized boards remain comparable.
3. Compute the rank consensus against the fixed 100% weight budget above. A source that does not match a player contributes zero rather than transferring its weight to another source; a failed or stale source locks the five-source gate. Field-specific ADP and auction-price blends normalize only among the market sources that actually publish that field.
4. Reject provider-authored source data older than 14 days, and reject a current certification artifact more than 30 minutes after its authenticated ESPN capture. Show source coverage and rank dispersion for every recommendation.
5. Blend ESPN, FFC, and MFL ADP into the market-availability estimate. Blend ESPN and MFL auction values into the initial salary-cap market price.
6. Feed consensus, ESPN league-specific projected points, value over replacement, tier scarcity, roster construction, and selected strategy into the deterministic draft score.

The model never treats the five ranks as five equal expert opinions. ESPN projections answer “how valuable is this player in this league?”, while FFC/MFL answer “when or for how much will the room draft him?” Tradyr and The GNG add independent player-quality priors.

Tradyr remains one 20% source. Since the documented 2026-08-15 access change, trustworthy bulk use requires the server-only `TRADYR_API_KEY`; unkeyed results stop at 50 rows and may contain decoys. A healthy refresh is one bounded atomic keyed response, never a merge of independently generated pages. DraftForge sends the key only in the Authorization header and fails closed unless the response proves the exact redraft and one-QB/two-QB profile, `limit=1000`, `offset=0`, a fresh generation timestamp, more than 50 and at most 1,000 total rows, an exact returned-row count, and unique canonical player identities. It also rejects limited/ignored access flags and inconsistent optional access counts. The key never enters URLs, browser storage, logs, snapshots, or committed files. DraftForge requests Tradyr's two-QB board only when the authenticated ESPN starter slots contain QB plus OP (or otherwise permit two starting quarterbacks); one-QB and two-QB snapshots use separate cache keys.

## Immutable simulation snapshots

Player-specific Monte Carlo evidence uses a schema-versioned, content-addressed snapshot containing a sanitized ESPN league/player profile and the four public responses retrieved for that capture. The loopback dashboard computes canonical SHA-256 over the exact sanitized league rules, player/status bytes, and original player-fetch timestamp, then obtains a bounded one-time receipt tied to its current server-recorded audit. The CLI must recompute the digest and consume that unexpired receipt before any public request. Schema v3 includes the capture digest, consumed-receipt assertion, full rules fingerprint, and exact public-consensus identity in its own digest; it rechecks freshness after provider I/O and before atomic write. The receipt is an in-process evidence anchor rather than a cryptographic extension signature, so it prevents offline artifact relabeling/replay but does not claim to secure a compromised local host.

Capture also fails closed when any public source is failed, stale, or empty. Replay verifies the SHA-256 digest and evaluates provider freshness relative to the preserved `capturedAt`, so the same saved input cannot change merely because wall-clock time advances. Re-import ESPN to produce a new authenticated artifact if the 30-minute input window expires; editing or re-wrapping an old JSON file is not certification evidence.

ESPN negative D/ST IDs are preserved; placeholder IDs `0` and `-1`, raw settings, member identifiers, authentication data, and real team names are excluded. Source truth remains fixed during a simulated decision. Seeded projection uncertainty and late-news removals affect hidden outcomes or availability only, never the five-source recommendation input.

## Deterministic sleeper signal

Sleepers are derived from these same five sources; no editorial list or sixth weighted feed can override the consensus. DraftForge separates the ESPN/FFC/MFL market percentile from the Tradyr/GNG model percentile, then labels a player only when:

- both independent model feeds match the player and agree within 12 percentile points;
- ESPN plus at least one external market feed match the player, with at least four of five total sources present;
- the model percentile leads the market percentile by at least eight points;
- the player has positive scoring-adjusted value over replacement and no ESPN injury flag; and
- the combined edge, VORP, tier scarcity, coverage, and model agreement score reaches 50/100.

An ADP in rounds 1–5 is an ordinary `VALUE`, rounds 6–9 are a `SLEEPER`, and round 10 or later is a `DEEP STASH`. Snake drafts do not receive a sleeper timing bonus more than one league round before market ADP. Salary-cap drafts keep sleepers out of early target/drain nominations, add priority only as the room loses budget leverage, and never raise the source-backed max bid, position portfolio limit, pacing cap, or one-dollar-per-open-slot reserve.

Snapshot validation reports source reach, four-source and full-five-source coverage, complete market/model matches, and the production sleeper-evidence funnel. It also reports the same measures by position and by early (1–48), middle (49–96), and late (97+) rosterable-board ranges so late-data weakness cannot hide inside one average.

The 2026-08-19 salary-cap PPR snapshot matched 181 Tradyr rows and improved the rosterable board from 41.07% to 60.12% at four or more sources and from 24.40% to 47.62% at all five. Four-source coverage was 100% early, 77.08% middle, and 22.22% late. It produced no production-qualified sleeper signal: five players had positive model evidence, one cleared the eight-point model edge, and none reached the unchanged 50-point evidence threshold.

A separate authenticated 10-team Standard snake capture (`38604a70ba64ff02c7b019a1b736885d9521236203e9daca473b80d709db944f`) measured 50.63% four-source and 43.13% full-five coverage across 160 rosterable players. Four-source coverage was 97.92% early, 50% middle, and 15.63% late. It produced one unchanged-threshold `VALUE` signal backed by all five sources; it did not produce a late-round `SLEEPER` or `DEEP_STASH`. K and D/ST remain zero-coverage gaps in the four public ranking feeds, so DraftForge continues to use ESPN as the platform truth and its existing mandatory-slot/specialist protections rather than weakening corroboration or adding a sixth source.

## Attribution and usage

- [Fantasy Football Calculator ADP API](https://help.fantasyfootballcalculator.com/article/42-adp-rest-api) permits free personal and commercial use with requested attribution.
- [MyFantasyLeague](https://myfantasyleague.wordpress.com/2008/08/06/developer-api/) provides an open developer export API.
- [Tradyr API](https://api.tradyr.app/docs) documents free keyed access for commercial or automated bulk use and requires attribution.
- [The GNG rankings](https://www.thegng.us/ranks) declares the JSON feed free to use with attribution and a link.
- ESPN's fantasy endpoints are undocumented and may change; the extension uses the user's existing ESPN session and fails closed if expected draft-room controls are not present.
