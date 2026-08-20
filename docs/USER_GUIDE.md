# DraftForge user guide and onboarding

This guide is for someone using DraftForge for the first time. It explains what to install, what to keep open, what to say in Codex, what the dashboard means, and what to do if anything stops.

For the shorter operator checklist and current release status, use [DRAFT_DAY_HANDOVER.md](../DRAFT_DAY_HANDOVER.md). For moving DraftForge to another computer, use [MIGRATION.md](../MIGRATION.md).

## The short version

On draft day, you work in three places:

| Surface | What it does | What you do there |
| --- | --- | --- |
| Codex conversation | Primary cockpit | Talk through strategy, request explanations, approve actions, and say `hold`, `stop`, or `resume`. |
| DraftForge dashboard | Command view | Watch the current recommendation, clock, roster needs, budget, source health, and safety state. |
| ESPN in Chrome | Authoritative draft room | Watch the real draft and use it as the manual fallback if DraftForge stops. |

The normal flow is:

1. Start DraftForge and open only the dashboard and one ESPN tab in Chrome.
2. Tell Codex which league is drafting.
3. Let DraftForge import the real league rules and warm all five data sources.
4. Wait for the first `DRAFT_DAY_READY` result before entering the draft room.
5. Enter the room, rerun the live checks, and wait for the second `DRAFT_DAY_READY` result.
6. Choose Guided mode or explicitly arm DraftForge Auto-Draft for that exact room.
7. Talk to Codex while watching the DraftForge command view and ESPN.
8. At the end, let Codex audit the completed roster before closing the room.

If anything is ambiguous, DraftForge stops instead of guessing.

## What DraftForge is

DraftForge is an ESPN-only fantasy football draft copilot for snake and salary-cap drafts. It:

- imports the league's actual ESPN scoring, roster, keeper, timer, order, budget, and position rules;
- tracks the live ESPN player pool, picks, bids, roster, clock, sound, and Autopick state;
- combines ESPN, Fantasy Football Calculator, MyFantasyLeague, Tradyr, and The GNG into one deterministic ranking;
- recommends a snake selection or a salary-cap nomination, bid, pass, and walk-away ceiling;
- protects roster legality, position caps, mandatory K/DST completion, salary reserve, and bid ceilings; and
- rechecks the exact ESPN tab, league, team, player, clock, and action immediately before a click.

DraftForge is not a waiver, trade, lineup, or post-draft league-management tool. ESPN remains the source of truth for what actually happened.

## Two different automation settings

These names are easy to confuse:

- **DraftForge Auto-Draft** is DraftForge's guarded execution mode. It may act only after you explicitly arm it for the exact verified room.
- **ESPN Autopick** is ESPN's fallback automation. It must remain **off** because an ESPN Autopick is not a DraftForge decision.

Guided mode is the default. DraftForge Auto-Draft always resets to off after a reload, league switch, safety failure, completed draft, or `hold`/`stop` instruction.

## First-time setup

### 1. Install the prerequisites

You need:

- macOS with a reliable network connection and power supply;
- Git;
- Node.js 22.18 or newer;
- Google Chrome;
- the Codex desktop app; and
- an ESPN account signed into Chrome.

Confirm Node is recent enough:

```bash
node --version
```

### 2. Install and verify DraftForge

If the repository is already at `/Users/chris/draftforge-ai`, run:

```bash
cd /Users/chris/draftforge-ai
git switch main
git pull --ff-only
npm install
npm run check
```

`npm run check` is the full release gate. It runs lint, type checking, the production build, deterministic snake and salary-cap drafts, and the safety regression suites. Do not make a draft-day code change if this command is failing.

### 3. Install the Chrome companion

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose `/Users/chris/draftforge-ai/extension`.
5. Confirm that **DraftForge ESPN Companion** is enabled.
6. Sign into ESPN in the same Chrome profile.

The current certified release uses companion version `0.2.16`. Always confirm the current version in [DRAFT_DAY_HANDOVER.md](../DRAFT_DAY_HANDOVER.md), because that document is the release source of truth.

After updating or reloading the companion, reload both the DraftForge and ESPN tabs. Never reload the companion during a live action window.

### 4. Complete one practice rehearsal

Before relying on DraftForge in a real league, complete one no-click cold-start rehearsal and one authenticated ESPN practice draft. The rehearsal should prove:

- the correct league rules import;
- five fresh sources;
- exactly one DraftForge tab and one ESPN tab;
- muted ESPN sound;
- ESPN Autopick off;
- the pre-room and live-room READY gates;
- legal recommendations; and
- automatic DraftForge shutdown after roster completion.

## The day before the draft

Do this outside the live-draft window:

1. Plug the computer into power and confirm the network is stable.
2. Confirm Chrome and ESPN login still work.
3. Update and verify the certified release:

   ```bash
   cd /Users/chris/draftforge-ai
   git switch main
   git pull --ff-only
   npm install
   npm run check
   ```

4. Confirm the Chrome companion is enabled and matches the version in the handover.
5. Run one cold-start, no-click rehearsal for the exact league.
6. Do not redesign, broadly retune, or update the engine immediately before the draft unless a reproducible blocker requires it.

## Draft-day startup

### Step 1: Start clean

1. Quit Chrome completely.
2. Stop any old DraftForge server.
3. In Terminal, start one production server:

   ```bash
   cd /Users/chris/draftforge-ai
   npm run start
   ```

4. Confirm it reports `http://127.0.0.1:3000`.

Use the production server on draft day. Do not use `npm run dev`; development reloads can reset live state.

### Step 2: Open the three working surfaces

Keep Codex open in the desktop app. In Chrome, keep exactly two tabs:

1. `http://127.0.0.1:3000`
2. the authenticated ESPN league lobby

Close old mock rooms, duplicate ESPN tabs, extension pages, and stale DraftForge tabs. This keeps tab binding unambiguous and conserves computer resources.

### Step 3: Give Codex the kickoff instruction

Paste this into the DraftForge Codex task:

> Draft day. Use the exact named ESPN league and team. Run the complete cold-start checklist. Keep DraftForge Auto-Draft off. Do not create or enter the room until you report READY. Use only the local DraftForge dashboard and one authenticated ESPN tab, keep ESPN sound muted, keep ESPN Autopick off, and stop on any ambiguity.

Include the league name if you have more than one ESPN league.

### Step 4: Import and confirm the league

Open the correct ESPN league in the single ESPN tab, then select **Import from ESPN** in DraftForge. Confirm the imported values instead of relying on memory:

- league and team identity;
- snake or salary-cap format;
- scoring system;
- number of teams;
- roster slots and position caps;
- keepers;
- pick timer;
- draft order, if available; and
- salary budget, if applicable.

Importing or switching leagues deliberately turns DraftForge Auto-Draft off and clears old-room telemetry.

### Step 5: Warm the five sources

Codex should run the source warmup using the imported scoring and team count. The command shape is:

```bash
npm run draft-day:warm -- --scoring <imported-scoring> --teams <imported-team-count> --season <season>
```

A cold warmup may take about 20 seconds. Do not create the ESPN room until the result is `FIVE_SOURCE_READY`.

### Step 6: Pass the first READY gate

Codex runs the command that matches the imported format:

```bash
npm run draft-day:ready -- --format snake --phase pre-room
# or
npm run draft-day:ready -- --format salary-cap --phase pre-room
```

Do not enter the room unless the result is `DRAFT_DAY_READY`, every check is true, and DraftForge Auto-Draft is off.

### Step 7: Enter the ESPN room and pass the second READY gate

Enter the draft room in the same ESPN tab. DraftForge must verify:

- one exact ESPN tab matches the imported league and team;
- the live player pool, roster, clock, and action controls resolve;
- ESPN sound is muted;
- ESPN Autopick is off;
- all five sources remain fresh;
- the engine can produce one legal no-click recommendation; and
- salary-cap nominee, offer, ceiling, and reserve state are exact when applicable.

Codex then runs:

```bash
npm run draft-day:ready -- --format snake --phase live
# or
npm run draft-day:ready -- --format salary-cap --phase live
```

Only a second `DRAFT_DAY_READY` result permits Guided actions or arming DraftForge Auto-Draft.

## Choose how DraftForge acts

### Guided mode

Use Guided mode when you want to approve every move. DraftForge recommends the action but waits for a clear chat instruction such as:

- `draft it`
- `bid`
- `pass`
- `hold`

Guided mode is best for a new user and for slower draft clocks.

### Armed Auto-Draft

Use DraftForge Auto-Draft when the clock is too short for approval on every action. Arm it only after the live READY gate and only for the exact named room. DraftForge still enforces every tab, league, clock, player, roster, source, ceiling, and reserve guard.

Auto-Draft is not permission to operate another league or room. It turns itself off when context changes or the draft completes.

## What to say during the draft

Short commands are best while the clock is moving:

| Command | Result |
| --- | --- |
| `status` | Reports the current action, clock, roster need, and budget/reserve. |
| `explain` | Explains the current recommendation without changing it. |
| `draft it` | Approves the current Guided-mode snake selection. |
| `bid` | Approves the exact current Guided-mode salary-cap offer. |
| `pass` | Declines the current salary-cap offer or recommendation. |
| `hold` or `stop` | Prevents new DraftForge actions immediately. |
| `resume` | Reruns live safety checks before continuing. |
| `switch strategy after this action` | Changes strategy only after the current safe action window closes. |

During a short clock, expect a compact response such as:

> BID $28 — ceiling $31 · reserve safe · TE starter open · 18 seconds

Use `explain` between action windows when you want the longer reasoning.

## Reading the DraftForge command view

### Do This Now

This is the primary decision card. It shows the exact player and action DraftForge currently recommends. In a snake draft, the action is a selection. In salary cap, it may be a nomination, incremental bid, hold, or pass.

If the card says `LOCKED`, DraftForge is intentionally refusing to act. Read the reason and do not work around it.

### ESPN clock and safety state

The clock comes from the live ESPN room. DraftForge acts only when it can verify that it is your turn and the safe window remains open. A missing, changed, opponent, or short clock stops the action.

### Live player board

This is the deterministic ranking of players still believed to be available. The top row is the best legal fit at that moment; alternatives appear below it. ESPN availability is rechecked before any click.

### Roster Control

This shows filled and open roster slots. DraftForge uses it to avoid duplicates, enforce position caps, complete mandatory starters, and avoid an unnecessary second K or D/ST.

### Salary-cap budget panel

For salary-cap drafts, watch:

- **Remaining:** money still available;
- **Protected reserve:** at least $1 for every open roster spot;
- **Spendable runway:** money that may legally be used after protecting the reserve;
- **Hard ceiling:** the maximum legal DraftForge bid for the current player; and
- **Room market:** observed inflation or discount from confirmed ESPN sales.

DraftForge bids incrementally. It does not jump straight to the ceiling and does not keep bidding after the ceiling is reached.

### Decision data

The source indicator must show all five fresh sources. The current fixed weights are:

- ESPN: 30%
- The GNG: 20%
- Tradyr: 20%
- Fantasy Football Calculator: 15%
- MyFantasyLeague: 15%

Stale data is rejected. DraftForge does not invent a missing projection.

## Common decision terms

| Term | Plain-English meaning |
| --- | --- |
| ADP | Average draft position: roughly where the market usually selects a player. |
| ADP edge | How the current opportunity compares with market draft position. |
| Projection | Estimated fantasy points under the imported scoring rules. |
| VORP | Value over replacement: the projected advantage over a player likely available later at the same position. |
| Tier drop | The quality gap between the current option and the next group at that position. |
| Source confidence | How well the available sources cover and agree on the player. It is not a guarantee. |
| Fair value | The five-source estimate of a player's salary-cap value in this league context. |
| Hard ceiling | The highest bid allowed after fair value, market, roster, pacing, budget, and reserve constraints. |
| Sleeper | A player whose model evidence beats market expectation by the required amount with enough independent corroboration. |
| Deep stash | A later, more speculative corroborated value. It never overrides roster legality or raises a bid ceiling. |

## Snake-draft behavior

DraftForge reranks the legal remaining pool before each of your turns. It weighs projections, VORP, roster needs, tier scarcity, ADP value, and corroborated sleeper timing. It delays K and D/ST when appropriate but will prioritize mandatory completion before the roster closes.

For each selection:

1. DraftForge prepares the recommendation before your turn when possible.
2. ESPN reports that your clock is active.
3. DraftForge rechecks the exact room, pick, player, and clock.
4. Guided mode waits for `draft it`; armed mode may submit automatically.
5. ESPN roster confirmation is required before the selection counts as successful.

If the intended player is no longer available, DraftForge uses the next deterministic legal option. It never treats a missed clock or ESPN Autopick as a successful DraftForge selection.

## Salary-cap behavior

DraftForge enters with a portfolio plan but adapts to confirmed ESPN prices, opponent budgets, remaining needs, positional scarcity, and late-budget leverage.

For every player, it distinguishes:

- **target nomination:** nominate a player DraftForge is willing to acquire;
- **drain nomination:** nominate a player intended to consume opponents' money, without price enforcing;
- **bid:** submit only the next legal incremental offer;
- **hold:** do nothing because you already lead; and
- **pass/walk:** stop when the next offer would exceed the current ceiling or violate strategy.

The ceiling can move down as the room changes. DraftForge preserves $1 for each open roster slot, avoids bidding wars, and does not rebid on its own drain nomination.

## Stop conditions

DraftForge must stop rather than click when it detects any of these:

- a source is stale or unavailable;
- Chrome or the companion disconnects;
- the ESPN tab, league, or team is wrong or ambiguous;
- ESPN sound is on or ESPN Autopick is active;
- the clock is missing, short, changed, or belongs to an opponent;
- the player, nominee, bid, pick, or action control changed;
- ESPN did not confirm the roster change;
- a salary bid would cross the ceiling or protected reserve;
- a roster, mandatory-slot, or position-cap rule would be violated; or
- an old authorization modal survived a context change.

Do not bypass a stop condition. Say `hold`, fix the visible state, rerun the live READY gate, and resume only from a fresh authorization.

## Recovery guide

### The dashboard says `LOCKED`

Read the exact blocker. Keep DraftForge Auto-Draft off, correct the state, and rerun the matching READY gate. `LOCKED` is a safety result, not a prompt to force a click.

### The companion says disconnected

1. Say `hold` in Codex.
2. Confirm the unpacked extension is enabled in `chrome://extensions`.
3. Close duplicate ESPN or DraftForge tabs.
4. Reload the dashboard and the one ESPN tab only when no action is in progress.
5. Re-import the exact room if necessary.
6. Rerun the live READY gate before rearming.

### Chrome reports `Extension context invalidated`

This commonly appears in a tab that was open while the extension updated. Reload the DraftForge and ESPN tabs, then rerun both connection and live-room checks. Do not assume the old page is still controlled.

### ESPN Autopick turns on

Say `stop` immediately. Disable ESPN Autopick in the ESPN room, verify the authoritative roster, and rerun the live READY gate. A practice room contaminated by ESPN Autopick is excluded from certification. In a real draft, use the visible ESPN room as the manual fallback until the exact state is safe again.

### There are multiple ESPN draft tabs

Say `hold`, close every stale or duplicate ESPN room, leave the one exact league tab open, and rerun the live READY gate. DraftForge will not guess which tab is authoritative.

### ESPN changes its page and DraftForge cannot find a control

DraftForge fails closed. Use ESPN manually for the immediate action if necessary. Do not ask DraftForge to click an unknown control during a live clock. Record the problem after the draft so it can be reproduced and fixed safely.

### The server is not available on port 3000

Stop old DraftForge processes and start exactly one production server:

```bash
cd /Users/chris/draftforge-ai
npm run start
```

Then reopen `http://127.0.0.1:3000` and rerun the cold-start checks.

## End-of-draft procedure

DraftForge should turn Auto-Draft off automatically when the roster is complete. Before closing the ESPN room, Codex runs:

```bash
npm run draft-day:audit -- --league <live-room-league-id> --team <team-id> --require-complete
```

The draft counts as verified only when the audit proves:

- exact DraftForge/ESPN roster parity;
- exact salary-cap prices when applicable;
- a complete legal roster;
- mandatory K and D/ST;
- no position-cap, reserve, or max-bid violation;
- five-source readiness;
- muted ESPN sound;
- ESPN Autopick off;
- the exact bound tab; and
- automatic DraftForge shutdown.

Capture the audit before closing a practice room because ESPN may remove completed mock-room state. After verification, close the completed ESPN tab and leave no stale room open.

## Privacy and safety

DraftForge uses the existing signed-in ESPN session inside Chrome. It does not copy ESPN cookies or passwords into the app or repository. Never paste `espn_s2`, `SWID`, GitHub tokens, or other credentials into Codex, documentation, logs, or screenshots.

The local draft-day server binds to loopback at `127.0.0.1`. The local dashboard is the recommended draft-day surface. The hosted copy may belong to a different Codex workspace and is not a substitute for the authenticated local Chrome workflow.

## One-page draft-day checklist

### Before creating the room

- [ ] Computer on power; network stable
- [ ] Certified `main` release; `npm run check` passed outside the live window
- [ ] Exactly one production DraftForge server on `127.0.0.1:3000`
- [ ] Codex desktop task open
- [ ] Exactly two Chrome tabs: DraftForge and one authenticated ESPN league tab
- [ ] Correct league imported from ESPN
- [ ] Format, scoring, teams, roster, caps, keepers, timer, order, and budget verified
- [ ] Five sources report `FIVE_SOURCE_READY`
- [ ] Pre-room gate reports `DRAFT_DAY_READY`
- [ ] DraftForge Auto-Draft off

### Inside the room

- [ ] Exact room, league, team, and tab bound
- [ ] Player pool, roster, clock, and action controls resolved
- [ ] ESPN sound muted
- [ ] ESPN Autopick off
- [ ] Legal no-click recommendation visible
- [ ] Salary nominee, offer, ceiling, and reserve exact, if applicable
- [ ] Live gate reports `DRAFT_DAY_READY`
- [ ] Guided mode selected, or Auto-Draft explicitly armed for this room

### After the draft

- [ ] DraftForge Auto-Draft shut down
- [ ] Complete roster and prices match ESPN
- [ ] Final audit reports ready
- [ ] Audit captured before the practice room disappears
- [ ] Completed ESPN tab closed
- [ ] No stale draft tabs or orphaned Chrome windows remain

## Where to go next

- [Draft-day handover](../DRAFT_DAY_HANDOVER.md): current release, exact operating checklist, certification, and known risks
- [README](../README.md): project overview and developer commands
- [Data sources](data-sources.md): source definitions, weights, freshness, and consensus logic
- [Release-candidate report](draft-day-release-candidate-20260819.md): authenticated and simulation evidence behind the current release
- [Migration runbook](../MIGRATION.md): move DraftForge to another machine or Codex account
