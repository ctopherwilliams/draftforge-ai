# DraftForge AI

Moving the project to another computer or Codex account? Start with [MIGRATION.md](MIGRATION.md) and [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

DraftForge is an ESPN-only fantasy football draft control room. It imports the league's real settings through a narrowly scoped Chrome extension, follows a live snake or salary-cap draft, combines five public player-intelligence feeds, and recommends the next selection, nomination, or bid.

Post-draft league management is intentionally out of scope.

## What works

- Separate saved profiles for multiple ESPN leagues, including leagues drafting on different days
- ESPN scoring, roster, team, keeper, draft-type, timer, pick-order, player, and live-pick import
- Snake recommendations and salary-cap nominations/max bids
- Manual approval mode and explicitly armed Auto-Draft mode
- Deterministic, inspectable consensus using ESPN, Fantasy Football Calculator, MyFantasyLeague, Tradyr, and The GNG
- Source health, weights, timestamps, and player-level provenance in the UI
- ESPN credentials remain in the browser and are never persisted by DraftForge

## Run locally

Requirements: Node.js 22.13 or newer and Chrome.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, install the extension from `extension/` using Chrome's **Load unpacked** flow, sign in to ESPN, and keep the ESPN league or draft room open in another tab.

For a second league, choose **Import another ESPN league**, open that league on ESPN, and import it. DraftForge stores each league's settings, picks, player pool, and strategy separately. Auto-Draft is always reset to off when switching leagues or reloading.

## Verify

```bash
npm test
node --check extension/background.js
node --check extension/espn-content.js
node --check extension/app-bridge.js
```

The test suite builds the production app and checks consensus calculation, deterministic recommendations, salary-cap reserve rules, extension safeguards, multi-league isolation, and server rendering.

## Data and decision model

The decision engine is deterministic: identical league state and source data produce the same recommendation. AI is not used to invent projections or silently override the model. The system normalizes player identities, rejects stale feeds, converts each source's rankings into comparable percentiles, applies documented weights, then adds league-aware value-over-replacement, roster need, tier scarcity, ADP value, and the selected draft strategy.

See [docs/data-sources.md](docs/data-sources.md) for endpoints, weights, update cadence, attribution, and the combination method.

## ESPN extension safety

The extension reads authenticated ESPN data using the existing signed-in Chrome session. Cookies are never copied into the app. Draft actions fail closed if the open ESPN room, league, clock state, player, or auction nominee does not match the expected action. Because ESPN does not publish a supported fantasy-draft write API, validate both a snake mock draft and a salary-cap mock draft before using Auto-Draft in a live league.

## Production build

```bash
npm run build
```
