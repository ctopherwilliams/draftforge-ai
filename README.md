# DraftForge AI

Running a rehearsal or real draft? Start with [DRAFT_DAY_HANDOVER.md](DRAFT_DAY_HANDOVER.md). Moving the project to another computer or Codex account? Start with [MIGRATION.md](MIGRATION.md) and [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

DraftForge is an ESPN-only fantasy football draft copilot. The primary cockpit is the Codex conversation working through the authenticated Chrome companion: it imports the league's real settings, follows a live snake or salary-cap draft, combines five public player-intelligence feeds, explains the next move, and can drive the ESPN draft room within explicit safety guardrails. The local app is the live supporting dashboard for imported state, consensus provenance, recommendations, and auditability. A single-tab in-app-browser runtime is retained as a recovery and test path, not as the production Chrome workflow.

Post-draft league management is intentionally out of scope.

## What works

- Separate saved profiles for multiple ESPN leagues, including leagues drafting on different days
- ESPN scoring, roster, team, keeper, draft-type, timer, pick-order, player, and live draft-room context import
- Snake recommendations and salary-cap nominations/max bids
- Guided mode (recommend in conversation, execute after the user's approval) and explicitly armed Auto mode
- A timing-first action gate: recommendations are staged before the turn, and DraftForge rechecks ESPN's imported browser tab, league, pick, visible player, and format-specific safety window immediately before submission
- Deterministic, inspectable consensus using ESPN, Fantasy Football Calculator, MyFantasyLeague, Tradyr, and The GNG
- Corroborated value, sleeper, and deep-stash signals derived from model-versus-market disagreement within those same five sources
- Source health, weights, timestamps, and player-level provenance in the UI
- ESPN credentials remain in the browser and are never persisted by DraftForge

## Run locally

Requirements: Node.js 22.18 or newer and Google Chrome with the DraftForge companion loaded from this repository.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, install the extension from `extension/` using Chrome's **Load unpacked** flow, sign in to ESPN, and keep exactly one ESPN league or draft-room tab beside the dashboard. Codex uses those two Chrome tabs as the observable draft-day workspace.

The optional single-tab recovery path can reuse an authenticated in-app-browser ESPN tab, but it must pass the same league, source, sound, Autopick, clock, roster, ceiling, and reserve checks.

For local development after the companion has been loaded once from this repository's `extension/` directory, opening `http://localhost:3000/?reloadCompanion=1` reloads the unpacked companion from disk. The command is rejected from non-localhost pages. Reload the ESPN and dashboard tabs after it runs; never invoke it during an active action window.

For a second league, choose **Import another ESPN league**, open that league on ESPN, and import it. DraftForge stores each league's settings, picks, player pool, and strategy separately. Auto-Draft and old-room telemetry are always reset when importing, switching leagues, or reloading.

## Draft operating modes

Use the Codex conversation as the active draft cockpit.

- **Guided mode (default):** Codex reads the live ESPN context, applies the deterministic model, explains its recommended move, and waits for a clear instruction such as `draft it`, `bid`, `pass`, or `hold` before driving ESPN.
- **Armed auto mode:** Codex may act without per-move approval only after the user explicitly arms it for the named ESPN league and live draft. It remains bounded by the imported roster, current draft state, strategy, computed max bid, one-dollar reserve, and a verified clock window (at least ten seconds for snake selections and five seconds for other actions). It shuts off on reload, league switch, missing or short clock, selector drift, or a `hold`/`stop` instruction.

The local app must never become an unbounded autonomous actor. It is an inspectable live surface. The Chrome companion is the narrow enforcement layer. The optional single-tab browser runtime temporarily installs the same selector, clock, bid, reserve, and roster-verification implementation, then removes it when that draft tab closes.

## Draft-day kickoff

Draft day is a cold-start workflow, not a continuation of whatever tabs or server process happen to exist:

1. Verify the repository and current production build, start exactly one DraftForge server on port 3000, and confirm `/api/draft-day` exists.
2. Open the local dashboard plus exactly one authenticated ESPN lobby tab in Chrome and import the named league's scoring, roster, keeper, timer, order, and draft-type rules.
3. Warm all five sources before ESPN creates the room, using the scoring and team count returned by the authenticated league-rules probe rather than a remembered default. For the saved 10-team Standard snake league, the executable gate is:

   ```bash
   npm run draft-day:warm -- --scoring Standard --teams 10 --season 2026
   ```

   Change scoring and team count to the imported league values. Add `--qbs 2` when the authenticated ESPN starter slots contain QB plus OP; the dashboard and one-command READY path derive this automatically from the imported rules. The command exits nonzero unless ESPN plus FFC, MFL, Tradyr, and GNG are all ready.
   After importing and confirming the saved league, require the matching one-command pre-room gate:

   ```bash
   npm run draft-day:ready -- --format snake --phase pre-room
   # or
   npm run draft-day:ready -- --format salary-cap --phase pre-room
   ```

   This gate compares the live loopback audit with the exact saved ESPN settings, tab binding, publisher session, five-source set, source freshness, extension state, telemetry schema, and Auto-Draft/ESPN-Autopick safety state. It exits nonzero on any mismatch.
4. Before creating the room, use **Confirm + arm live draft** once. The companion stores a bounded one-shot watch for the exact authenticated league, team, season, rules, and draft type. When ESPN creates the room, it binds only one exact match, reuses the authenticated player pool, verifies the generated room's rules, mutes sound, requires ESPN Autopick off, and revalidates the exact tab and action surface before Auto-Draft can turn on.
   For a regulation-timer room, also rerun the command with `--phase live`; it requires the second live-room checklist, muted sound, and resolved ESPN action surface. A short practice room may use the dashboard's equivalent in-process checklist so terminal startup does not consume the opening clock.
5. Only then start the guarded loop. It polls cheap DOM state off-clock, calls the production engine only for an own snake turn or active salary-cap decision, submits through the shared action implementation, and requires ESPN roster confirmation.
6. At completion, verify the exact roster, prices/budget, mandatory slots, position caps, one-dollar reserve, Autopick-off state, muted sound, and close the completed ESPN tab while keeping the dashboard available for the next rehearsal.

   The dashboard also keeps a sanitized, in-memory final-certification snapshot for up to 24 hours. It is reachable only through loopback and contains no cookies, member IDs, or opponent identities. Require independent final proof with:

   ```bash
   npm run draft-day:audit -- --league <leagueId> --team <teamId> --require-complete
   ```

   The command exits nonzero unless the exact ESPN/app roster (including auction prices) is complete and legal, the live checklists and five-source gate passed, sound remained muted, ESPN Autopick remained off, and DraftForge shut itself down.

Any failed check stops DraftForge from clicking. A cold source refresh may take roughly 20 seconds because MFL is intentionally queried sequentially under its public rate limit; that work must finish before room launch.

Stop any running production server before `npm run build`, then start exactly one fresh `npm run start` process from the certified output. Do not overwrite `dist` while vinext is serving it.

## Verify

```bash
npm test
npm run test:visual
node --check extension/background.js
node --check extension/espn-content.js
node --check extension/app-bridge.js
```

The test suite builds the production app and checks consensus calculation, deterministic recommendations, salary-cap reserve and pacing rules, extension safeguards, multi-league isolation, server rendering, and 20 complete deterministic drafts in each format. The separate visual gate uses one temporary muted browser and one temporary loopback server, checks pre-room plus both command centers from mobile through 2560px, writes ignored screenshots under `outputs/ui-regression/latest/`, and removes its temporary browser/server state on exit.

For bounded, seeded strategy stress testing without opening ESPN, run:

```bash
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260820
```

The command runs the requested number of trials per format, keeps the production decision engine as the single strategy implementation, streams per-trial summaries, and writes machine-readable and Markdown output under `outputs/monte-carlo/`. See [the draft-day release-candidate report](docs/draft-day-release-candidate-20260819.md) for current authenticated, holdout, latency, reproduction, and limitation evidence; [docs/monte-carlo-report.md](docs/monte-carlo-report.md) retains the earlier tuning-cycle history.

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
