# DraftForge agent handoff

## Active objective

Build and verify an ESPN-only fantasy football draft control room with a Chrome extension that:

- imports and confirms all ESPN league and draft settings;
- supports snake and salary-cap drafts;
- synchronizes live draft state;
- combines ESPN, Fantasy Football Calculator, MyFantasyLeague, Tradyr, and The GNG through a transparent deterministic consensus;
- recommends selections, nominations, and bids according to configurable strategy;
- submits legal actions when explicitly armed for Auto-Draft;
- otherwise stages the action for user approval in DraftForge; and
- excludes all post-draft league-management features.

The user has two ESPN leagues on different draft days. Their settings, picks, player pools, strategy, and confirmation state must remain isolated by ESPN league ID. Auto-Draft must reset off across reloads and league switches.

## Current checkpoint

- Branch: `main`
- Latest pre-handoff implementation commit: `29af0f5`
- Production app: `https://draftforge-ai.workspace-231977.chatgpt.site`
- Chrome extension package: `public/draftforge-espn-companion.zip`
- Extension version: `0.1.2`
- Test command: `npm test`
- Last verified result: production build succeeded and all 9 tests passed.

The deployed Sites project is owner-only and tied to the previous Codex workspace. See `MIGRATION.md` before redeploying under another account.

## Architecture

- `app/page.tsx`: control room, settings confirmation, source health, league switching, recommendation staging, and Auto-Draft arming.
- `app/lib/draft-engine.ts`: deterministic league-aware scoring, roster need, value over replacement, tier scarcity, ADP value, and salary-cap reserve rules.
- `app/lib/consensus.ts`: player identity normalization, stale-source rejection, weighted percentiles, confidence, and provenance.
- `app/lib/profiles.ts`: isolated saved profiles keyed by ESPN league ID.
- `app/api/intelligence/route.ts`: parallel adapters for the four external public feeds; ESPN is supplied by the extension.
- `extension/background.js`: authenticated ESPN fetches, settings/player/pick normalization, polling, expected-league routing, and app messaging.
- `extension/espn-content.js`: live draft-room context detection and fail-closed selection/nomination/bid UI actions.
- `extension/app-bridge.js`: narrow web-app-to-extension message bridge.
- `docs/data-sources.md`: source endpoints, weights, attribution, cadence, and combination logic.

Consensus weights are ESPN 30%, The GNG 20%, Tradyr 20%, Fantasy Football Calculator 15%, and MyFantasyLeague 15%. Sources older than 14 days are ignored. The recommendation engine is deterministic; generative AI is not allowed to invent projections or silently override the model.

## Proven and unproven

Proven locally:

- production application build;
- deterministic recommendation behavior;
- salary-cap reserve logic;
- five-source merge and provenance;
- multi-league state isolation;
- extension manifest scope and credential non-persistence;
- fail-closed guard presence;
- live responses from all four external adapters on PPR, half-PPR, and standard requests.

Not yet proven against authenticated ESPN:

- current ESPN 2026 private league response shapes for both user leagues;
- current live snake draft-room selectors and final confirmation behavior;
- current live salary-cap nominee, bid, and confirmation selectors;
- end-to-end Auto-Draft behavior inside real ESPN mock rooms.

Do not mark the objective complete until one authenticated snake mock and one authenticated salary-cap mock pass.

## Next recommended work

1. Run `npm test` and confirm a clean worktree.
2. Install the packaged extension and import each ESPN league independently.
3. Compare every normalized setting with ESPN and inspect `rawSettings` for omissions.
4. Run the snake mock with manual approval, then explicitly arm Auto-Draft.
5. Run the salary-cap mock through nomination, bid escalation, max-bid stopping, and roster reserve.
6. Capture any ESPN DOM/API shape drift as sanitized fixtures and add executable regression tests.
7. Repackage the extension, commit, and redeploy after fixes.

## Safety invariants

- Never persist or transmit `espn_s2`, `SWID`, GitHub tokens, or Sites repository credentials.
- Never submit to a different ESPN league than `expectedLeagueId`.
- Never select or nominate unless ESPN visibly reports the user's turn.
- Never bid on a nominee that does not match the recommendation.
- Never exceed the computed max bid or spend the one-dollar reserve for open roster slots.
- If ESPN markup is unfamiliar or an action control cannot be identified, fail closed and require manual ESPN fallback.
- Auto-Draft must be an explicit, reversible opt-in and must default to off.
