# DraftForge backlog hardening — 2026-08-20

## Decision

This branch strengthens evidence, source-profile accuracy, ESPN recovery, and visual regression coverage without changing the certified production selection scoring. It is a local release candidate, not a new authenticated certification and not a claim of optimal drafting.

## Rejected strategy candidate

A narrow mid-draft QB preference for ESPN QB-plus-OP snake leagues was compared with the frozen baseline across 1,600 paired discovery and validation drafts using seed `32765104`. The candidate improved acquisition regret by `14.9346` points and roster fragility by `0.05497`, but reduced mean starting-lineup projection by `1.0905`, total projection by `1.2703`, VORP by `1.1907`, and modeled season win probability by `0.000693`. The composite objective improved by `0.5280`, but its confidence interval crossed zero. Because roster-strength means regressed, the strategy change and its temporary unit test were removed.

## Accepted hardening

- Authenticated ESPN QB plus OP leagues now request Tradyr's two-QB redraft profile. One-QB and two-QB intelligence snapshots have separate cache identities. Source membership, weights, freshness, coverage, and decision-time source freezing are unchanged.
- Completed salary-cap audits can retain a bounded, sanitized ledger of closing price, source auction value, fair value, target, ceiling, observed offer, submitted bids, nomination intent, and outcome. Player and opponent names, league names, cookies, credentials, member IDs, and account identifiers are not stored.
- Unchanged-threshold sleeper evidence now survives across the draft and records first/last observation plus authenticated acquisition timing. It does not manufacture a sleeper or raise a bid ceiling.
- The companion retains one unsettled auction offer through at most five transient ESPN context polls, allowing a delayed budget delta to produce the exact sale before the next nomination is tracked. It still fails boundedly rather than waiting forever.
- A lean visual/accessibility command runs one temporary production server and one muted isolated Chrome instance sequentially. It checks pre-room plus snake and salary command centers at 390, 1440, 1728, and 2560 widths for overflow, panel overlap, unnamed controls, sub-44px controls, duplicate IDs, landmarks, and progress semantics; perceptual baselines detect unintended presentation drift.

## Verification

```bash
npm run check
npm run test:visual
npm audit --audit-level=high
node --check extension/background.js
node --check extension/espn-content.js
node --check extension/app-bridge.js
git diff --check
```

The full local gate passes 179/179, including 20 complete deterministic snake drafts and 20 complete deterministic salary-cap drafts. The ten visual scenarios match their checked-in baselines. A real cold PPR/12-team/two-QB warmup returned `FIVE_SOURCE_READY` with all five sources in 20.402 seconds and explicitly reported `qbs: 2`; its temporary loopback server was then stopped. An authenticated no-click pre-room run then imported league `44050`, team `7`, proved QB plus OP, reached 5/5, confirmed the exact settings, and returned `DRAFT_DAY_READY` with Auto-Draft off. The loopback audit reported companion v0.2.17 and exactly two Chrome tabs. The one-command doctor now shares the same centralized QB-profile derivation. The v0.2.17 companion package SHA-256 is `9991640bb3bcf3b7c1977e4dd9031e732b0d7ce4e5d4d4f880a6dc8c4e30257e`.

## Remaining supervised work

Before promoting this candidate over the authenticated v0.2.16 release, use one authenticated ESPN salary-cap practice room to exercise a real nomination-to-sale transition, a dashboard reload, and final exact roster/price audit. Capture authenticated READY, live action, recovery, endgame, and complete command-center states during that rehearsal; the automated visual gate currently proves pre-room and blocked preview layouts, not live ESPN truth. The rehearsal must keep exactly the dashboard and one ESPN tab, sound muted, ESPN Autopick off, and Auto-Draft off until both READY gates pass.
