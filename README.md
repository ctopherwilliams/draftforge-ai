# DraftForge AI

Moving the project to another computer or Codex account? Start with [MIGRATION.md](MIGRATION.md) and [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

DraftForge is an ESPN-only fantasy football draft copilot. The primary cockpit is the Codex conversation: it imports the league's real settings through a narrowly scoped Chrome extension, follows a live snake or salary-cap draft, combines five public player-intelligence feeds, explains the next move, and can drive the ESPN draft room within explicit safety guardrails. The local app is the supporting dashboard for imported state, consensus provenance, recommendations, and auditability.

Post-draft league management is intentionally out of scope.

## What works

- Separate saved profiles for multiple ESPN leagues, including leagues drafting on different days
- ESPN scoring, roster, team, keeper, draft-type, timer, pick-order, player, and live draft-room context import
- Snake recommendations and salary-cap nominations/max bids
- Guided mode (recommend in conversation, execute after the user's approval) and explicitly armed Auto mode
- A timing-first action gate: recommendations are staged before the turn, and DraftForge rechecks ESPN's imported browser tab, league, pick, visible player, and five-second safety window immediately before submission
- Deterministic, inspectable consensus using ESPN, Fantasy Football Calculator, MyFantasyLeague, Tradyr, and The GNG
- Corroborated value, sleeper, and deep-stash signals derived from model-versus-market disagreement within those same five sources
- Source health, weights, timestamps, and player-level provenance in the UI
- ESPN credentials remain in the browser and are never persisted by DraftForge

## Run locally

Requirements: Node.js 22.13 or newer and Chrome.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, install the extension from `extension/` using Chrome's **Load unpacked** flow, sign in to ESPN, and keep the ESPN league or draft room open in another tab.

For local development after the companion has been loaded once from this repository's `extension/` directory, opening `http://localhost:3000/?reloadCompanion=1` reloads the unpacked companion from disk. The command is rejected from non-localhost pages. Reload the ESPN and dashboard tabs after it runs; never invoke it during an active action window.

For a second league, choose **Import another ESPN league**, open that league on ESPN, and import it. DraftForge stores each league's settings, picks, player pool, and strategy separately. Auto-Draft is always reset to off when switching leagues or reloading.

## Draft operating modes

Use the Codex conversation as the active draft cockpit.

- **Guided mode (default):** Codex reads the live ESPN context, applies the deterministic model, explains its recommended move, and waits for a clear instruction such as `draft it`, `bid`, `pass`, or `hold` before driving ESPN.
- **Armed auto mode:** Codex may act without per-move approval only after the user explicitly arms it for the named ESPN league and live draft. It remains bounded by the imported roster, current draft state, strategy, computed max bid, one-dollar reserve, and a verified five-second-or-greater ESPN clock window. It shuts off on reload, league switch, missing or short clock, selector drift, or a `hold`/`stop` instruction.

The local app must never become an unbounded autonomous actor. It is an inspectable, secondary surface; the companion extension remains the narrow enforcement layer.

## Verify

```bash
npm test
node --check extension/background.js
node --check extension/espn-content.js
node --check extension/app-bridge.js
```

The test suite builds the production app and checks consensus calculation, deterministic recommendations, salary-cap reserve and pacing rules, extension safeguards, multi-league isolation, server rendering, and 20 complete deterministic drafts in each format.

For bounded, seeded strategy stress testing without opening ESPN, run:

```bash
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260814
```

The command runs the requested number of trials per format, keeps the production decision engine as the single strategy implementation, streams per-trial summaries, and writes machine-readable and Markdown output under `outputs/monte-carlo/`. See [docs/monte-carlo-report.md](docs/monte-carlo-report.md) for the accepted baseline/final evidence, replay commands, and limitations.

For current player-specific evidence, first capture an immutable five-source snapshot from a sanitized authenticated ESPN profile, then replay that exact digest across independent seed families:

```bash
npm run snapshot:capture -- --espn outputs/source-capture/espn-profile.json
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260814 --snapshot snapshots/intelligence/source-v1-....json
npm run simulate:matrix -- --drafts 1000 --snapshot snapshots/intelligence/source-v1-....json
```

Snapshot capture fails closed unless ESPN, FFC, MFL, Tradyr, and GNG are healthy and fresh. Snapshots are content-addressed, replay freshness at their capture time, and are ignored by Git because they contain large third-party datasets. The matrix runs independent seed families sequentially to bound CPU and memory.

## Data and decision model

The decision engine is deterministic: identical league state and source data produce the same recommendation. AI is not used to invent projections or silently override the model. The system normalizes player identities, rejects stale feeds, converts each source's rankings into comparable percentiles, applies documented weights, then adds league-aware value-over-replacement, roster need, tier scarcity, ADP value, corroborated sleeper timing, and the selected draft strategy. Sleeper labels require both model feeds to agree against the ESPN/FFC/MFL market; they never raise a salary-cap walk-away ceiling.

See [docs/data-sources.md](docs/data-sources.md) for endpoints, weights, update cadence, attribution, and the combination method.

## ESPN extension safety

The extension reads authenticated ESPN data using the existing signed-in Chrome session. Cookies are never copied into the app. Draft actions fail closed if the exact imported ESPN tab, open draft room, league, active pick, verified clock window, visible player, auction nominee, or current auction offer does not match the expected action. Before every draft, complete both the pre-draft import checklist and the second live-room dry run. A missed-clock ESPN auto-pick never counts as a DraftForge pass.

## Production build

```bash
npm run build
```
