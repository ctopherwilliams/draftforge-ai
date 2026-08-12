# DraftForge agent handoff

## Active objective

Build and verify an ESPN-only fantasy football draft copilot with a Chrome extension that:

- imports and confirms all ESPN league and draft settings;
- supports snake and salary-cap drafts;
- synchronizes live draft state;
- combines ESPN, Fantasy Football Calculator, MyFantasyLeague, Tradyr, and The GNG through a transparent deterministic consensus;
- recommends selections, nominations, and bids according to configurable strategy;
- precomputes a legal ESPN-visible recommendation and can submit it while the draft clock is still safely open;
- uses the Codex conversation as the primary guided-draft cockpit, presenting a recommendation and driving ESPN after a clear user approval;
- can submit legal actions without per-move approval only when the user explicitly arms auto mode for the named ESPN league and draft;
- keeps the local app as an inspectable secondary dashboard rather than an unbounded autonomous actor; and
- excludes all post-draft league-management features.

The user has two ESPN leagues on different draft days. Their settings, picks, player pools, strategy, and confirmation state must remain isolated by ESPN league ID. Guided mode is the default. Armed auto mode must reset off across reloads and league switches, and immediately stop on a `hold` or `stop` instruction.

## Current checkpoint

- Branch: `main`
- Latest pre-handoff implementation commit: `29af0f5`
- Production app: `https://draftforge-ai.workspace-231977.chatgpt.site`
- Chrome extension package: `public/draftforge-espn-companion.zip`
- Extension version: `0.1.3`
- Test command: `npm test`
- Last verified result: production build, lint, extension safeguards, one complete authenticated ESPN mock in each format, and all 35 tests passed. The full-draft suite includes 20 deterministic snake drafts and 20 deterministic salary-cap drafts.

The deployed Sites project is owner-only and tied to the previous Codex workspace. See `MIGRATION.md` before redeploying under another account.

## Architecture

- `app/page.tsx`: secondary dashboard for settings confirmation, source health, league switching, recommendation staging, and Auto-Draft arming.
- `app/lib/draft-engine.ts`: deterministic league-aware scoring, roster need, value over replacement, tier scarcity, ADP value, and salary-cap reserve rules.
- `app/lib/consensus.ts`: player identity normalization, stale-source rejection, weighted percentiles, confidence, and provenance.
- `app/lib/profiles.ts`: isolated saved profiles keyed by ESPN league ID.
- `app/api/intelligence/route.ts`: parallel adapters for the four external public feeds; ESPN is supplied by the extension.
- `extension/background.js`: authenticated ESPN fetches, settings/player/pick normalization, polling, exact league-and-imported-tab routing, and app messaging; the dashboard heartbeats that exact tab every 750ms and may follow ESPN's waiting-room-to-live-tab handoff only when exactly one live tab matches both the imported league and team.
- Local development can reload the unpacked companion through `http://localhost:3000/?reloadCompanion=1`; the background accepts that command only from `localhost` or `127.0.0.1`, and ESPN/dashboard tabs must be reloaded afterward.
- `extension/espn-content.js`: live draft-room context detection and fail-closed selection/nomination/bid UI actions.
- `extension/app-bridge.js`: narrow web-app-to-extension message bridge.
- `docs/data-sources.md`: source endpoints, weights, attribution, cadence, and combination logic.

Consensus weights are ESPN 30%, The GNG 20%, Tradyr 20%, Fantasy Football Calculator 15%, and MyFantasyLeague 15%. Sources older than 14 days are ignored. The recommendation engine is deterministic; generative AI is not allowed to invent projections or silently override the model.

The Codex conversation is the orchestration surface. It may use the authenticated ESPN browser only for the active draft under the selected mode; it must never infer authorization to submit to a real league outside the user's stated guided or armed-auto choice.

## Verification checkpoint

Proven locally:

- production application build;
- deterministic recommendation behavior;
- salary-cap reserve logic;
- five-source merge and provenance;
- multi-league state isolation;
- extension manifest scope and credential non-persistence;
- fail-closed guard presence;
- live responses from all four external adapters on PPR, half-PPR, and standard requests.
- authenticated import of the user's 2026 snake and salary-cap leagues, including ESPN's string `AUCTION` draft type and configured keeper count;
- authenticated salary-cap nomination, bidding, exact offer changes, walkaways, one-dollar reserve enforcement, and a complete 16-player roster;
- authenticated armed-auto snake execution with all 16 players confirmed on the exact ESPN roster, no ESPN `AUTO` fallback, and mandatory K/D/ST endgame completion;
- ESPN negative D/ST player IDs, exact post-click roster confirmation, player fallback identity, and active sound-control detection;
- fail-closed wrong-league/tab, wrong nominee, missing/short clock, changed pick/offer, missing player/control, max-bid, and reserve paths; and
- 20 complete deterministic snake simulations (2,560 picks) plus 20 complete deterministic salary-cap simulations (2,560 sales) on the frozen engine candidate.

## Next recommended work

1. Run `npm test` after any engine or extension change.
2. Before a real draft, import the named league, confirm every rule/source check, enter the room, mute ESPN, and pass the second live-room dry run.
3. Keep Guided mode as the default; arm auto only for the exact named league and draft when explicitly requested.
4. Capture future ESPN DOM/API drift as sanitized fixtures and preserve fail-closed behavior.

## Safety invariants

- Never persist or transmit `espn_s2`, `SWID`, GitHub tokens, or Sites repository credentials.
- Never submit to a different ESPN league or browser tab than the explicitly imported `expectedLeagueId` and `expectedTabId`.
- Waiting-room URLs omit `teamId`; derive it only from ESPN's own `Edit Team Settings` link before allowing the unique waiting-room-to-live-tab handoff.
- Never select or nominate unless ESPN visibly reports the user's turn.
- Treat ESPN's `OPENING OFFER` plus `NOMINATE PLAYER` confirmation panel as the continuation of an already-started salary-cap nomination turn; either phrase alone is not sufficient.
- Never submit an action when ESPN exposes fewer than five seconds remaining, or when a reliable clock cannot be read.
- Revalidate the league, active pick, action window, and visible player immediately before the ESPN submit click.
- Never bid on a nominee that does not match the recommendation.
- Never bid if ESPN's current offer differs from the offer observed for the recommendation, or if the requested bid is not the next legal offer.
- Never exceed the computed max bid or spend the one-dollar reserve for open roster slots.
- If ESPN markup is unfamiliar or an action control cannot be identified, fail closed and require manual ESPN fallback.
- Guided mode is the default. Armed auto mode must be an explicit, reversible opt-in, limited to the named league/draft, and default to off.
