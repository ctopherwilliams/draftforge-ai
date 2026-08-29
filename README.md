# DraftForge AI

Running a rehearsal or real draft? Start with [DRAFT_DAY_HANDOVER.md](DRAFT_DAY_HANDOVER.md). Moving the project to another computer or Codex account? Start with [MIGRATION.md](MIGRATION.md) and [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

DraftForge is an ESPN-only fantasy football draft copilot. The local dashboard and DraftForge Chrome companion are the production control plane: together they import the league's authenticated settings, follow a live snake or salary-cap draft, combine five public player-intelligence feeds, and drive the exact ESPN room within explicit safety guardrails. The Codex conversation is the strategy and status cockpit; it observes only the sanitized loopback status surface and is never an ESPN action writer. The isolated single-tab browser runtime is a lab-only, read-only test observer and is not a production recovery or action path.

Post-draft league management is intentionally out of scope.

## Current post-live candidate boundary

The 2026-08-28 working candidate hardens the control plane without changing the fixed source weights or adding a sixth ranking source:

- The dashboard and Chrome companion remain the only action writer. `npm run draft-day:status` performs exactly one bounded (750 ms, 64 KiB), loopback-only GET for one atomic control-and-board snapshot; it never calls Chrome, the extension, the engine, or an action route. The server rejects stale audit, context, pick-feed, source, availability, room, Autopick, attribution, or checklist state before publishing a live-ready recommendation.
- Codex/ChatGPT Chrome control, Computer Use, CDP, Playwright, Puppeteer, and remote-debugging transports are outside the production dependency boundary. A human or an optional external controller is required only for visible setup controls such as opening/importing the league, confirming the checklist, arming, hold/resume, Guided actions, and recovery navigation. Once explicitly armed, the dashboard and companion operate independently; failure of an external controller cannot grant, renew, or inherit writer authority.
- The final dispatch lease is an exact, operation-aware authorization. It binds the action ID and decision ID to the exact player, source snapshot, availability digests, expected pick or current bid, intended offer, maximum approved bid, nomination intent, and immutable deadline. One decision may own only one action ID. The companion rechecks the server lease acknowledgment against `notAfter` after the bounded network response, so a lease that expires during verification cannot click ESPN.
- Every decision binds the exact five-source profile, canonical generation timestamp, and lowercase `sha256:<64 hex>` snapshot identity. The READY path requires the WARM response and active dashboard audit to publish the same tuple. A stale dashboard loaded before a restarted production server is rejected until the dashboard is reloaded and republishes from that server instance.
- ESPN opponent reconciliation requires one unique normalized name or abbreviation. Ambiguous snake opponents receive a deterministic non-team placeholder identity; ambiguous salary-cap opponent ownership is omitted and therefore cannot authorize a bid.
- Salary-cap offer and sale settlement compares exact nonzero ESPN player IDs first. Players with the same display name but different ESPN IDs settle independently; normalized-name fallback is allowed only when at least one exact ID is unavailable.
- The audit publisher is fail-closed single-flight. A timed-out or aborted publication cannot overlap its successor; if the underlying transport does not settle inside the bounded abort grace period, that publisher is permanently poisoned and cannot mint live authority. Checkpoint persistence still uses atomic replacement plus file and directory sync, while exact serialized identity enables a collision-safe replay fast path without relaxing transition validation for changed payloads.
- Every final click path revalidates the immutable deadline, exact ESPN state, and unique control after server authorization returns. A per-ESPN-tab auction uncertainty latch blocks every later nomination or bid, even under new request, decision, or session IDs, until exact nonzero ESPN player-ID evidence reconciles the outcome. Display-name-only evidence cannot release the latch, and nomination uncertainty is reconciled immediately against the latest exact context.
- Browser authority is bound to the exact app tab, ESPN tab, immutable audit session, per-document command-center ID, ESPN producer ID, binding generation, and a 1.5-second writer lease. Only an explicit bind, verified recovery, or `APP_HELLO` may establish authority. Heartbeats and actions cannot mint or resurrect an expired lease; replacement rotates the generation, conditionally retires the superseded binding, and fences delayed results from older documents or ESPN producers.
- The production listener probe uses bounded, portable, fail-closed process discovery. On macOS the Tradyr credential may be read once from the server-only `DraftForge Tradyr` / `draftforge` Keychain item, never from browser code. CI now runs the complete fail-closed live-control release gate as a dedicated job.
- ESPN sound is observed and reported as operator-preference telemetry. Muted sound is preferred for testing and may be chosen on draft day, but sound state does not authorize or block a selection, nomination, bid, readiness result, or final audit. ESPN Autopick remains a hard safety gate.

The current packaged candidate is companion v0.2.31: unpacked-source SHA-256 `09a808245d2769264de12118b99001afc0a703bf93406d9236c67c0845abd194`, ZIP SHA-256 `733e572fbc281ce26d24e4e97047fd1329e5d7976c40544db82d557ee82e1268`, 19 source files. The full test suite passes 683/683 after typecheck and production build, including 20 complete deterministic snake drafts (2,560 picks) and 20 complete deterministic salary-cap drafts (2,560 sales). The visual certification passes 11/11 states, including the narrowest three-column breakpoint with a classic scrollbar gutter, and `npm run test:live-control` passes 477/477 focused checks plus 9/9 chaos cases. The 1,000-request read-only load completes 1,000/1,000 with p95 3.917 ms and p99 6.415 ms. Under writer/observer contention, observer p95 is 4.902 ms, observer p99 is 6.147 ms, writer p99 is 9.809 ms, availability p99 is 5.282 ms, event-loop p99 is 12.616 ms, and peak RSS is 137.438 MB. The production path records 82 physical clicks, 82 exact acknowledgments, zero observer writes, and maximum one in-flight action: planning p95 2.346 ms and p99 5.598 ms; SELECT p99 88.888 ms, NOMINATE p99 138.821 ms, incremental BID p99 94.394 ms, and custom BID p99 86.469 ms; overall action p99 464.799 ms, event-loop p99 24.822 ms, and peak RSS 205.578 MB. `npm audit` reports zero vulnerabilities. These automated runs certify local mechanics, not current player advice or an authenticated ESPN room.

Current authenticated arming is intentionally **NO-GO**. On the certified Mac, the Tradyr credential is stored in the native Keychain and injected only into the production server process; it is never printed, logged, committed, placed in a URL, or exposed to Chrome. The source adapter requests one atomic keyed board with `limit=1000&offset=0` and rejects capped, incomplete, mismatched-profile, duplicate, or stale responses. No fresh authenticated schema-v3 snapshot has yet been published from the final committed revision. The older `outputs/source-capture/release-salary-source-20260827.json` artifact is schema v1, stale, profile-bound historical evidence and cannot satisfy the current gate. Chrome has not yet proven that the installed unpacked companion was reloaded to v0.2.31. The exact salary-cap target is “It’s Fun To Do Bad Things XVII” (league `44050`, team `7`, season `2026`). Its exact two-tab no-click rehearsal, authenticated normal/rapid/recovery salary-cap rooms, authenticated snake regression, and three-hour soak remain required. Official availability news remains a separate short-lived hold/veto overlay and never changes consensus scores or weights.

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

After the VM branch is reviewed on the Mac, perform one no-click authenticated pre-room rehearsal for each saved ESPN format. Both must return `DRAFT_DAY_READY`, show the exact imported league rules, five fresh consensus sources, a fresh availability digest, observed sound preference, ESPN Autopick off, DraftForge Auto-Draft off, and exactly one DraftForge dashboard plus one authenticated ESPN tab. Until that happens, Grok's report must end with `MAC_AUTHENTICATED_CERTIFICATION_PENDING`. Do not enter or operate a real league draft, and do not count simulations as authenticated certification.

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
- A compact GET-only chat status command that reads one coherent control-and-board capture without touching the action path
- Companion-managed one-dashboard election and final-audit cleanup for exact generated practice workspaces
- ESPN credentials remain in the browser and are never persisted by DraftForge

## Run locally

Requirements: Node.js 22.18 or newer and Google Chrome with the DraftForge companion loaded from this repository.

The production server also requires `TRADYR_API_KEY` for a trustworthy complete Tradyr board. On the certified Mac, `npm start` first uses an explicit server environment value when present, otherwise performs one bounded read of the native Keychain item `DraftForge Tradyr` / `draftforge`. Missing, denied, invalid, or timed-out access starts safely without the credential and leaves the five-source gate blocked. Credential bytes and Keychain diagnostics are never printed, logged, committed, placed in a URL, or exposed to Chrome. Tradyr's unkeyed bulk response is capped and may contain decoy rows.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, install the extension from `extension/` using Chrome's **Load unpacked** flow, sign in to ESPN, and keep exactly one ESPN league or draft-room tab beside the dashboard. Those two tabs are the complete production workspace. Codex reads their sanitized, server-published status; it does not need ownership of either tab for armed-auto execution.

The optional single-tab browser runtime is lab-only and read-only. It cannot submit an ESPN action, arm autopilot, recover a production writer, or satisfy authenticated certification.

For local development after the companion has been loaded once from this repository's `extension/` directory, opening `http://localhost:3000/?reloadCompanion=1` reloads the unpacked companion from disk. The command is rejected from non-localhost pages. Reload the ESPN and dashboard tabs after it runs; never invoke it during an active action window.

For a second league, choose **Import another ESPN league**, open that league on ESPN, and import it. DraftForge stores each league's settings, picks, player pool, and strategy separately. Auto-Draft and old-room telemetry are always reset when importing, switching leagues, or reloading.

## Draft operating modes

Use the Codex conversation as the active strategy and status cockpit. Use the local dashboard for every visible setup or control mutation.

- **Guided mode (default):** Codex reads the sanitized live status and explains the deterministic recommendation. The user approves or rejects the visible action through the local dashboard; chat alone has no POST or ESPN-click capability.
- **Armed auto mode:** After the user explicitly confirms the checklist and arms the named room in the local dashboard, the DraftForge dashboard and companion may act without per-move approval. They remain bounded by the imported roster, current draft state, strategy, computed max bid, one-dollar reserve, and a verified clock window (at least ten seconds for snake selections and five seconds for other actions). Auto-Draft shuts off on reload, league switch, missing or short clock, selector drift, or a dashboard `hold`/`stop` action.

The local app must never become an unbounded autonomous actor. It is an inspectable live surface. The Chrome companion is the narrow enforcement layer. External browser-control tooling is optional operator convenience and never part of action authorization.

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

   This gate compares the live loopback audit with the exact saved ESPN settings, tab binding, publisher session, five-source set, source freshness, extension state, telemetry schema, and Auto-Draft/ESPN-Autopick safety state. It first primes the bounded source cache, then leases the audit's exact `sourceSnapshotId`/`sourceGeneratedAt`, performs a lookup-only exact WARM, and re-reads the audit. It exits nonzero if that identity is absent, stale, substituted, or changes during the gate.
4. Before creating the room, use **Confirm + arm live draft** once. The companion stores a bounded one-shot watch for the exact authenticated league, team, season, rules, and draft type. When ESPN creates the room, it binds only one exact match, reuses the authenticated player pool, verifies the generated room's rules, observes the sound preference, requires ESPN Autopick off, and revalidates the exact tab and action surface before Auto-Draft can turn on.
   For a regulation-timer room, also rerun the command with `--phase live`; it requires the second live-room checklist, explicit sound telemetry, and a resolved ESPN action surface. Sound may remain on or muted without changing action authority. A short practice room may use the dashboard's equivalent in-process checklist so terminal startup does not consume the opening clock.
   A successful terminal `--phase live` doctor automatically freezes the exact clean, upstream-matched revision and room identity. There is intentionally no manual freeze-arm command. Until the exact final-ready completion audit clears that record, npm rejects dev, build, test/simulation, source warm/capture, and extension-package operations; `npm start` remains available to restart only the already-built certified artifact. Inspect the state with `npm run draft-day:freeze -- status`. The status output also supplies the identity-bound confirmation token required for the documented emergency clear procedure in [DRAFT_DAY_HANDOVER.md](DRAFT_DAY_HANDOVER.md).
5. Only then start the guarded loop. It polls cheap DOM state off-clock, calls the production engine only for an own snake turn or active salary-cap decision, submits through the shared action implementation, and requires ESPN roster confirmation.
6. At completion, verify the exact roster, prices/budget, mandatory slots, position caps, one-dollar reserve, Autopick-off state, and recorded sound preference. After the final-ready parity audit, the companion closes only the exact generated practice room, its matching source-league tab, and stale DraftForge dashboards. It never treats unrelated ESPN or user tabs as cleanup targets.

   The dashboard also keeps a sanitized, in-memory final-certification snapshot for up to 24 hours. It is reachable only through loopback and contains no cookies, member IDs, or opponent identities. Require independent final proof with:

   ```bash
   npm run draft-day:audit -- --league <leagueId> --team <teamId> --require-complete
   ```

   The command exits nonzero unless the exact ESPN/app roster (including auction prices) is complete and legal, the live checklists and five-source gate passed, ESPN Autopick remained off, and DraftForge shut itself down. Sound state is retained in the audit as operator-preference telemetry and is not a pass/fail condition. On that exact final-ready result it also clears the matching live code freeze; a latest-room or mismatched-room audit can never clear it.

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

The command runs the requested number of synthetic trials per format, keeps the production decision engine as the single strategy implementation, uses an 80% authenticated-settings fixture / 20% ESPN-compatible adversarial-variant mix, streams per-trial summaries, and writes machine-readable and Markdown output under `outputs/monte-carlo/`. Captured player evidence is deliberately not reused across those different source profiles. See [the historical draft-day release-candidate report](docs/draft-day-release-candidate-20260819.md) for the prior authenticated, latency, and limitation record; its legacy mixed-profile simulation figures are not current certification evidence. [docs/monte-carlo-report.md](docs/monte-carlo-report.md) retains the earlier tuning-cycle history.

For current player-specific evidence, first import the exact ESPN league through the authenticated companion. On the same loopback dashboard, `?capture=sanitized` exposes JSON only after a current server-recorded audit grants a short-lived one-time receipt. Canonical SHA-256 binds the full sanitized rules fingerprint, exact ESPN player/status bytes, and original player-fetch timestamp. Save that JSON immediately; the CLI recomputes its digest and consumes the matching loopback receipt before contacting any public provider. Edits, replay, expiry, wrong identity, and server restart fail closed. The receipt is an in-process evidence anchor, not a cryptographic extension signature. The resulting schema-v3 snapshot keeps capture and public-source provenance inside its digest:

```bash
npm run snapshot:capture -- --espn outputs/source-capture/espn-profile.json
npm run simulate:monte-carlo -- --drafts 10000 --seed 20260814 --snapshot snapshots/intelligence/source-v3-....json
npm run simulate:matrix -- --drafts 1000 --snapshot snapshots/intelligence/source-v3-....json
```

Snapshot capture fails closed unless ESPN, FFC, MFL, Tradyr, and GNG are healthy and fresh and the draftable ESPN pool can fill every roster and mandatory starter slot. A snapshot-backed command automatically selects its one captured snake or salary-cap format and runs every seed against that exact scoring, team-count, season, QB, roster, and budget profile. Explicit cross-format reuse is rejected. Run the browser-free command above without `--snapshot` for the separate synthetic/adversarial stress campaign; never borrow one profile's player evidence for another league. Snapshots are content-addressed, replay freshness at their capture time, and are ignored by Git because they contain large third-party datasets. The matrix runs exact-profile seed families sequentially to bound CPU and memory. Every command exits nonzero if even one requested draft is missing or fails.

## Data and decision model

The decision engine is deterministic: identical league state and source data produce the same recommendation. AI is not used to invent projections or silently override the model. The system normalizes player identities, rejects stale feeds, converts each source's rankings into comparable percentiles, applies documented weights, then adds league-aware value-over-replacement, roster need, tier scarcity, ADP value, corroborated sleeper timing, and the selected draft strategy. Sleeper labels require both model feeds to agree against the ESPN/FFC/MFL market; they never raise a salary-cap walk-away ceiling.

See [docs/data-sources.md](docs/data-sources.md) for endpoints, weights, update cadence, attribution, and the combination method.

## ESPN extension safety

The extension reads authenticated ESPN data using the existing signed-in Chrome session. Cookies are never copied into the app. Draft actions fail closed if the exact imported ESPN tab, open draft room, league, active pick, verified clock window, visible player, auction nominee, or current auction offer does not match the expected action. Before every draft, complete both the pre-draft import checklist and the second live-room dry run. A missed-clock ESPN auto-pick never counts as a DraftForge pass.

## Production build

```bash
npm run build
```
