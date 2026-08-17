# DraftForge migration runbook

This repository is the portable source of truth for moving DraftForge to another machine and another Codex account. Do not copy `node_modules`, `.next`, browser profiles, ESPN cookies, or Chrome extension storage.

## 1. Clone on the new machine

Install Git, Node.js 22.13 or newer, Chrome, and the Codex desktop app. Sign Codex into the destination account, then run:

```bash
git clone https://github.com/ctopherwilliams/draftforge-ai.git
cd draftforge-ai
npm install
npm test
npm run dev
```

Open `http://localhost:3000` and open this repository folder as a new Codex task.

## 2. Give the new Codex agent the handoff

Paste this prompt into the new task:

> Read `AGENT_HANDOFF.md`, `README.md`, and `docs/data-sources.md` completely. Treat the Git worktree and tests as authoritative. Continue the ESPN-only draft goal from the documented checkpoint. The Codex conversation is the primary guided-draft cockpit; the local app is a secondary dashboard. Support Guided mode by default and scoped, explicitly armed auto mode. Do not add post-draft league-management features. Preserve the deterministic five-source consensus and fail-closed extension safety. First run `npm test`, then inspect the current plan and finish the authenticated ESPN snake and salary-cap mock-draft verification.

The old Codex task, its goal state, and its private Sites ownership should not be assumed to follow the Git repository to a different account. `AGENT_HANDOFF.md` carries the durable context instead.

## 3. Install the Chrome extension

1. Unzip `public/draftforge-espn-companion.zip`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted `extension` directory.
5. Sign into ESPN in Chrome and open the relevant league or draft room.

After updating an unpacked companion, reload both the local DraftForge tab and the ESPN draft tab. An `Extension context invalidated` message from an already-open draft tab is expected during that transition and must not be treated as an ESPN action.

ESPN authentication stays in Chrome. No ESPN cookies or credentials are present in this repository.

## 4. Move hosting to the new Codex account

The existing production URL and `.openai/hosting.json` `project_id` belong to the current Codex workspace. Local development does not depend on them.

To deploy a new private copy under the destination Codex account:

1. Remove only the `project_id` property from `.openai/hosting.json`; leave `d1` and `r2` unchanged.
2. Ask the new Codex agent to deploy the repository privately with Sites.
3. After deployment, add the exact new production hostname pattern to `extension/manifest.json` under the app content script's `matches` list.
4. Increment the extension version, rebuild `public/draftforge-espn-companion.zip`, run `npm test`, commit, and redeploy.

The current extension supports localhost and the exact production origin `https://draftforge-ai.workspace-231977.chatgpt.site`. Keep hosted origins exact: broad sibling-site wildcards would let an unrelated page reach the authenticated ESPN bridge. Step 3 is necessary whenever the deployment hostname changes.

## 5. Acceptance status

The code, production build, public data adapters, and local tests pass. The issue #1 verification gate includes:

- isolated authenticated imports for both ESPN leagues;
- one complete authenticated snake mock with exact roster confirmation, explicitly armed auto mode, K/DST completion, muted sound, and no ESPN auto-pick fallback;
- one complete authenticated salary-cap mock covering nominations, strategic bids/walkaways, max-bid and one-dollar reserve enforcement; and
- 20 complete deterministic full-draft simulations per format on the frozen candidate, plus fail-closed regression coverage for wrong league/tab, nominee, clock, player, pick, offer, budget, and changed controls.

The robustness gate also supports immutable live five-source capture/replay and sequential independent-seed matrices. Generated snapshot JSON and Monte Carlo outputs are intentionally ignored by Git; reproduce them from a fresh authenticated ESPN import rather than copying browser credentials or profiles.

Re-run the full 20+20 simulation gate after any engine-affecting change. Authenticated mocks and deterministic simulations are recorded separately; simulations are not represented as live ESPN drafts.

For each authenticated final rehearsal, require the loopback certification ledger before counting it:

```bash
npm run draft-day:audit -- --league <leagueId> --team <teamId> --require-complete
```

The ledger is sanitized and in-memory only, expires after 24 hours, and is not a substitute for the exact live-room checklist or fail-closed action guards.

## 6. Useful commands

```bash
npm test
npm run snapshot:capture -- --validate snapshots/intelligence/source-v1-....json
npm run simulate:matrix -- --drafts 1000 --snapshot snapshots/intelligence/source-v1-....json
npm run draft-day:audit -- --league <leagueId> --team <teamId> --require-complete
node --check extension/background.js
node --check extension/espn-content.js
node --check extension/app-bridge.js
git status
```

The currently deployed private site is `https://draftforge-ai.workspace-231977.chatgpt.site`. It may remain inaccessible from the destination account unless the old workspace grants access.
