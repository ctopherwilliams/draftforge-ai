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

> Read `AGENT_HANDOFF.md`, `README.md`, and `docs/data-sources.md` completely. Treat the Git worktree and tests as authoritative. Continue the ESPN-only draft goal from the documented checkpoint. Do not add post-draft league-management features. Preserve the deterministic five-source consensus and fail-closed extension safety. First run `npm test`, then inspect the current plan and finish the authenticated ESPN snake and salary-cap mock-draft verification.

The old Codex task, its goal state, and its private Sites ownership should not be assumed to follow the Git repository to a different account. `AGENT_HANDOFF.md` carries the durable context instead.

## 3. Install the Chrome extension

1. Unzip `public/draftforge-espn-companion.zip`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted `extension` directory.
5. Sign into ESPN in Chrome and open the relevant league or draft room.

ESPN authentication stays in Chrome. No ESPN cookies or credentials are present in this repository.

## 4. Move hosting to the new Codex account

The existing production URL and `.openai/hosting.json` `project_id` belong to the current Codex workspace. Local development does not depend on them.

To deploy a new private copy under the destination Codex account:

1. Remove only the `project_id` property from `.openai/hosting.json`; leave `d1` and `r2` unchanged.
2. Ask the new Codex agent to deploy the repository privately with Sites.
3. After deployment, add the exact new production hostname pattern to `extension/manifest.json` under the app content script's `matches` list.
4. Increment the extension version, rebuild `public/draftforge-espn-companion.zip`, run `npm test`, commit, and redeploy.

The current extension already supports localhost and `*.chatgpt.site`, so step 3 is necessary only if the new deployment uses a different hostname family.

## 5. Resume acceptance testing

The code, production build, public data adapters, and local tests pass. The remaining real-world gate is authenticated ESPN verification:

- Import both ESPN leagues and confirm that settings and strategies remain isolated.
- Complete at least one snake mock with manual approval, then Auto-Draft.
- Complete at least one salary-cap mock covering nomination, bidding, max-bid enforcement, and the one-dollar-per-open-slot reserve.
- Confirm that the wrong league, wrong nominee, missing clock, missing player, and changed ESPN control paths all fail closed.

Do not rely on Auto-Draft in a live league until those mock-draft checks pass.

## 6. Useful commands

```bash
npm test
node --check extension/background.js
node --check extension/espn-content.js
node --check extension/app-bridge.js
git status
```

The currently deployed private site is `https://draftforge-ai.workspace-231977.chatgpt.site`. It may remain inaccessible from the destination account unless the old workspace grants access.
