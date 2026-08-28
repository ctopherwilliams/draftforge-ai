# DraftForge AI

Running a rehearsal or real draft? Start with [DRAFT_DAY_HANDOVER.md](DRAFT_DAY_HANDOVER.md). Moving the project to another computer or Codex account? Start with [MIGRATION.md](MIGRATION.md) and [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

DraftForge is an ESPN-only fantasy football draft copilot. The primary cockpit is the Codex conversation working through the authenticated Chrome companion: it imports the league's real settings, follows a live snake or salary-cap draft, combines five public player-intelligence feeds, explains the next move, and can drive the ESPN draft room within explicit safety guardrails. The local app is the live supporting dashboard for imported state, consensus provenance, recommendations, and auditability. A single-tab in-app-browser runtime is retained as a recovery and test path, not as the production Chrome workflow.

Post-draft league management is intentionally out of scope.

## Implemented availability-veto contract

This section is retained as the auditable contract for the implemented availability veto. The current baseline reads ESPN's authenticated `injuryStatus`, removes definitive inactive designations, and stages recent credible external evidence through a sanitized, loopback-only, short-lived artifact. External news is a safety overlay, never a sixth ranking source.

### Goal

Add a deterministic, fail-closed **availability veto layer** that can prevent DraftForge from recommending or submitting a player when current evidence says the player cannot materially contribute this season or is not eligible to play. This is a safety overlay, not a new ranking source. The five-source consensus must remain exactly ESPN, FFC, MFL, Tradyr, and GNG with the existing weights.

### Required workflow

1. Read `README.md`, `AGENT_HANDOFF.md`, `MIGRATION.md`, `DRAFT_DAY_HANDOVER.md`, and `docs/data-sources.md` completely. Treat the Git worktree and tests as authoritative.
2. Record `git status --short`, the current branch and commit, then run `npm test` before editing. Do not build over a running production `vinext start` process.
3. Inspect the existing implementation in `extension/player-normalizers.js`, `app/lib/draft-engine.ts`, the draft-day bridge, source snapshot code, and their tests before proposing a design.
4. Implement the smallest reusable boundary that satisfies the acceptance criteria below. Do not duplicate recommendation, roster, bid-ceiling, reserve, sleeper, or action logic.
5. Add focused unit and integration tests, run the complete release gate, update the relevant handoff/data-source documentation, and report the exact commands and results.

### Grok VM capability contract

Grok is expected to perform this task in an isolated Linux VM with a writable repository checkout, shell access, Git, Node/npm, bounded CPU/memory/disk, and outbound network access that may be restricted or intermittent. Treat every capability as untrusted until it is observed. At startup, run the following non-secret capability probe and retain its output in the implementation report:

```bash
pwd
uname -a
node --version
npm --version
git --version
git status --short --branch
git remote -v
df -h .
```

Do not print environment variables, credential files, browser profiles, GitHub tokens, cookies, or keychain contents. If the repository is not already present, clone the configured GitHub remote, verify the default branch, and create a focused `grok/availability-guard` branch. Prefer `npm ci` when a lockfile is present. Never commit generated source snapshots, browser profiles, `.env` files, build output, or authenticated ESPN payloads.

Use the VM for:

- Reading and editing repository files.
- Running deterministic unit, integration, build, lint, type, snapshot-replay, Monte Carlo, and visual-regression checks.
- Fetching public documentation or public news endpoints during adapter development when network policy allows it.
- Using Grok's native web/X search, when exposed to the VM, to prepare a pre-draft evidence artifact; model prose is never itself authoritative evidence.
- Running a temporary, isolated, muted Chromium instance for localhost visual tests only.
- Producing a focused Git commit/branch, machine-readable test results, and a concise implementation handoff.

The VM must **not** be assumed to have:

- The user's authenticated ESPN session, macOS Chrome profile, DraftForge unpacked extension state, Keychain, Tailscale identity, or localhost process running on the user's Mac.
- Permission to drive the user's real ESPN draft, install software globally, change host firewall rules, expose port 3000 publicly, or access unrelated browser tabs/files.
- Stable long-lived storage or enough resources for unbounded parallel browsers, servers, or simulations.

If Grok has a browser-control tool, use it only against an ephemeral VM browser and localhost test fixtures. Do not sign in to ESPN and do not claim authenticated certification from mocked, copied, or replayed cookies. If Grok has GitHub write access, push only the focused branch; do not force-push, merge to `main`, rewrite history, or modify repository settings. If a capability is absent, use the safest repository-local substitute and record the limitation instead of weakening a gate.

Keep resource use bounded: run test families sequentially, start at most one temporary app server and one temporary browser, record their process IDs, and terminate them on success or failure. Reuse ignored output directories where the existing scripts expect them; do not leave orphan processes, browser windows, or listening ports. A VM timeout or eviction is an incomplete run, not a pass.

### VM-to-Mac handoff boundary

Grok's deliverable ends with code and reproducible local evidence. The authenticated Chrome proof must run later on the user's Mac from the exact reviewed commit. Grok must provide:

- Branch name and full commit SHA.
- A concise file-by-file change list tied to the functional contract.
- Baseline and final command results, including failures or skipped checks.
- Exact reproduction commands and any required repository-local configuration schema.
- Sanitized example availability artifacts covering hard veto, advisory, stale, conflicting, and ambiguous identity cases.
- An explicit `MAC_AUTHENTICATED_CERTIFICATION_PENDING` marker until both no-click ESPN rehearsals pass on the Mac.

The Mac operator must review/merge the branch, install the exact companion build if extension code changed, cold-start one production server on loopback port 3000, and perform the authenticated checks described below. VM tests may support this certification but can never replace it.

### Functional contract

- Keep the weighted five-source player ranking and auction-value calculation unchanged. News cannot add points, reorder healthy players, raise a salary-cap ceiling, or promote a sleeper.
- Combine ESPN's authenticated availability state with a sanitized external availability artifact supplied before the draft. The artifact must contain only normalized player identity, classification, event time, retrieval time, evidence URL/domain, and a short machine-readable reason. It must never contain ESPN cookies, member IDs, opponent identities, credentials, or arbitrary executable content.
- A Grok/web/X result may discover evidence but may not serve as the evidence. Every hard veto must resolve to an official NFL/team/league transaction or injury report, or to two independent reputable reports that explicitly support the same definitive state. Preserve source URLs and timestamps, not model transcripts.
- Require exact normalized player identity. Ambiguous, unmatched, or conflicting identities must not silently veto a player; expose them as unresolved and block arming only when the unresolved record claims a definitive season-ending or eligibility event for a player currently inside the actionable recommendation window.
- Treat only definitive states as hard vetoes: season-ending injury, injured reserve/PUP/NFI when the supplied evidence explicitly says the player cannot contribute in the relevant season window, retirement, release without a team, suspension covering the fantasy season, death, or another explicit league-ineligibility event. `QUESTIONABLE`, `DOUBTFUL`, day-to-day, limited practice, ordinary legal allegations, rumors, and opinion are advisory flags unless ESPN itself marks the player unavailable.
- Require evidence and retrieval timestamps. Default maximum age is 30 minutes on draft day and must be configurable only through an explicit bounded setting. Stale or malformed artifacts fail closed at the arming/readiness boundary; they must never be treated as fresh truth.
- Freeze an immutable availability digest for each individual decision. A source refresh may affect the next decision, but it must not mutate the truth underneath an action already being revalidated or submitted.
- Recheck the chosen player immediately before every snake selection, salary-cap nomination, and bid. If the player becomes vetoed, clear the pending intent, recompute from the same production engine, and require the normal exact-player/clock/offer verification path.
- A vetoed nominee in salary cap is always `PASS`; it may not be used as a price-enforcement or drain nomination. Existing one-dollar reserve, exact next-offer rule, walk-away ceiling, and bidding-war prevention remain absolute.
- The dashboard should show a compact status and timestamp for the availability gate plus the reason/evidence for a veto. Do not redesign the command center or add a general news feed.
- No Grok model call may occur inside a live action window. Any Grok-assisted collection or classification must complete before arming or between decisions with enough time to pass the normal clock gate. A model timeout, unavailable service, or invalid response must never authorize an action.

### Required tests

- ESPN definitive unavailable statuses remain excluded from snake and salary-cap recommendations.
- A fresh, exact-match external season-ending record vetoes an otherwise top-ranked player without changing the ordering or scores of the remaining healthy players.
- Questionable, doubtful, rumor, allegation, and day-to-day records remain advisory and do not become automatic hard vetoes.
- Stale, malformed, unsigned/untrusted if signing is introduced, conflicting, and identity-ambiguous artifacts cannot arm Auto-Draft.
- A veto arriving between recommendation and submission invalidates the pending action and forces a fresh deterministic recommendation.
- Salary-cap code never bids on or nominates a vetoed player and never changes the existing ceiling or reserve for other players.
- Identical league state, five-source snapshot, availability artifact, and seed produce byte-for-byte identical decision output and digest.
- Snapshot and audit output remain sanitized and contain no credentials, cookies, member IDs, real opponent names, or free-form model transcripts.
- Existing extension fail-closed, exact-tab, clock, Autopick, roster completion, sleeper, specialist, and 20-drafts-per-format tests continue to pass.

### Acceptance gate

Run all of the following from the repository root and include their exact results in the handoff:

```bash
npm test
npm run lint
npm run typecheck
npm run test:visual
node --check extension/background.js
node --check extension/espn-content.js
node --check extension/app-bridge.js
git diff --check
```

After the VM branch is reviewed on the Mac, perform one no-click authenticated pre-room rehearsal for each saved ESPN format. Both must return `DRAFT_DAY_READY`, show the exact imported league rules, five fresh consensus sources, a fresh availability digest, muted sound, ESPN Autopick off, DraftForge Auto-Draft off, and exactly one DraftForge dashboard plus one authenticated ESPN tab. Until that happens, Grok's report must end with `MAC_AUTHENTICATED_CERTIFICATION_PENDING`. Do not enter or operate a real league draft, and do not count simulations as authenticated certification.

### Definition of done

The work is complete only when the full gate passes, deterministic replay is proven, no existing strategy or safety invariant regresses, the extension package/version is updated when extension code changes, the README and handoff describe the final data contract, and the implementation is committed on a focused branch with a clean worktree. Report limitations honestly. Do not claim that rumor detection or player availability is perfect.

## What works

- Separate saved profiles for multiple ESPN leagues, including leagues drafting on different days
- ESPN scoring, roster, team, keeper, draft-type, timer, pick-order, player, and live draft-room context import
- Snake recommendations and salary-cap nominations/max bids
- Guided mode (recommend in conversation, execute after the user's approval) and explicitly armed Auto mode
- A timing-first action gate: recommendations are staged before the turn, and DraftForge rechecks ESPN's imported browser tab, league, pick, visible player, and format-specific safety window immediately before submission
- Deterministic, inspectable consensus using ESPN, Fantasy Football Calculator, MyFantasyLeague, Tradyr, and The GNG
- Corroborated value, sleeper, and deep-stash signals derived from model-versus-market disagreement within those same five sources
- Source health, weights, timestamps, and player-level provenance in the UI
- Companion-managed one-dashboard election and final-audit cleanup for exact generated practice workspaces
- ESPN credentials remain in the browser and are never persisted by DraftForge

## Run locally

Requirements: Node.js 22.18 or newer and Google Chrome with the DraftForge companion loaded from this repository.

The production server also requires `TRADYR_API_KEY` for a trustworthy complete Tradyr board. Tradyr's unkeyed bulk response is capped and may contain decoy rows, so DraftForge fails the five-source gate without the key. Keep it server-only; never put it in a URL, browser storage, snapshot, log, or committed file.

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
3. Confirm the production server has `TRADYR_API_KEY`, then warm all five sources before ESPN creates the room, using the scoring and team count returned by the authenticated league-rules probe rather than a remembered default. For the saved 10-team PPR snake league, the executable gate is:

   ```bash
   npm run draft-day:warm -- --scoring PPR --teams 10 --season 2026 --qbs 2
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
6. At completion, verify the exact roster, prices/budget, mandatory slots, position caps, one-dollar reserve, Autopick-off state, and muted sound. After the final-ready parity audit, the companion closes only the exact generated practice room, its matching source-league tab, and stale DraftForge dashboards. It never treats unrelated ESPN or user tabs as cleanup targets.

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
