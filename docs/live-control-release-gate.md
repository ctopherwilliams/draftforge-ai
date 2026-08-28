# Live-control release gate

This gate certifies DraftForge's authenticated ESPN control path separately from
strategy quality. It applies to both snake and salary-cap drafts and preserves:

- ESPN-only league settings and actions.
- The deterministic ESPN/FFC/MFL/Tradyr/GNG five-source consensus and fixed
  weights.
- Fail-closed browser behavior.
- One-dollar salary-cap reserve, exact bid ceilings, and no bidding wars.
- Mandatory roster completion and specialist rules.

Passing this gate does not mean the strategy is perfect. It means the tested
release met the stated safety, latency, replay, and recovery criteria.

## One production writer

The installed Chrome companion and DraftForge dashboard are the only production
action path. Chat and terminal monitors may only issue GET requests to the
compact loopback control view.

`scripts/draft-day-browser-runtime.mjs` is an isolated-lab observer. Every
builder requires the explicit `LAB_ONLY_COMPANION_DISABLED` mode and a positive
assertion that the companion is disabled. The observer exposes context reads
only. Direct actions and its former guarded autopilot are permanently disabled.
It must never be injected during a real draft or authenticated certification.

## Commands

Run the focused live-control gate after the candidate worktree stops changing:

```bash
npm run test:live-control
```

The gate is bounded to three minutes by default, starts each child in its own
process group, forwards termination signals, and kills a timed-out child group.
It runs the incident-class tests, compact-monitor tests, chaos probe, and a
1,000-request loopback load smoke test.

Run the chaos probe alone:

```bash
npm run test:chaos
```

It proves that the read-only monitor fails closed on a hung response, oversized
payload, HTTP failure, stale ESPN context, sequence regression, connection
reset, wrong league identity, and publisher-session replacement. Every fixture
binds only to `127.0.0.1` and closes its server, sockets, and timers in `finally`
blocks.

Run a self-contained load smoke test:

```bash
npm run test:load -- --fixture --requests 1000 --concurrency 8
```

Run the same GET-only load probe against a stopped-draft/quiescent candidate:

```bash
npm run test:load -- \
  --origin http://127.0.0.1:3000 \
  --league 44050 \
  --team 7 \
  --requests 100000 \
  --concurrency 8 \
  --max-duration-ms 600000 \
  --require-stable-sequence
```

`--require-stable-sequence` proves that status reads do not mutate the published
ledger. Use it only while the dashboard publisher is quiescent; a live publisher
can legitimately advance the sequence.

Run the compact monitor during a no-click rehearsal:

```bash
npm run draft-day:monitor -- \
  --origin http://127.0.0.1:3000 \
  --league 44050 \
  --team 7 \
  --polls 300 \
  --interval-ms 1000
```

The monitor is bounded, loopback-only, GET-only, incremental by sequence, and
rejects responses over 16 KiB. It makes no Chrome, engine, source, or action
calls. It exits nonzero for stale or malformed control state.

Run the parameterized soak only after the short release gate passes:

```bash
npm run test:soak -- \
  --origin http://127.0.0.1:3000 \
  --league 44050 \
  --team 7 \
  --minutes 180 \
  --interval-ms 1000
```

The soak caps duration at four hours and polls at most 20,000 times. Its memory
check covers the monitor process. Record the production server and Chrome RSS
separately during authenticated certification.

## Safety acceptance criteria

All are zero-tolerance:

- Zero wrong tab, league, team, season, player, nominee, offer, or pick actions.
- Exactly one action writer and at most one in-flight action.
- Zero duplicate clicks or blind retries after an uncertain ESPN result.
- Zero cap, reserve, ceiling, roster-cap, duplicate-player, or unnecessary
  second K/DST violations.
- Every own-roster addition has immutable DraftForge, manual, ESPN Autopick, or
  unknown-external attribution.
- Historical Autopick and uncontrolled additions remain sticky and prevent a
  clean final certification.
- Source and availability-veto digests cannot change from decision creation
  through ESPN acknowledgment and roster/sale confirmation.

## Latency and resource objectives

- Actionable ESPN context age: p99 at most 500 ms; hard stale after 1 second in
  salary-cap or 2 seconds in snake.
- ESPN pick/sale feed age: p99 at most 2.5 seconds.
- Engine decision compute: p99 at most 10 ms.
- Context-to-plan: p95 at most 150 ms, p99 at most 300 ms.
- Plan-to-extension dispatch: p95 at most 100 ms, p99 at most 250 ms.
- Salary-cap DOM change-to-click: p95 at most 300 ms, p99 at most 600 ms when
  the action remains legal and armed.
- Click-to-authoritative ESPN acknowledgment: p95 at most 1 second, p99 at most
  2 seconds.
- Compact status GET: p95 at most 25 ms, p99 at most 50 ms, and at most 16 KiB.
- Concurrent status reads add no more than 5% or 50 ms to measured action
  latency in the authenticated rehearsal.
- Disconnect detection within 2 seconds and disarm within 250 ms.
- Three-hour soak: server RSS below 300 MiB, p99 event-loop lag below 50 ms,
  Chrome/extension memory growth below 10%, and no owned orphan process, tab,
  window, socket, or port listener after shutdown.

## Incident-class replay matrix

`npm run test:live-control` covers the failures observed in the real snake draft
and the faster salary-cap variants:

- Initial pick-feed lag and stale/unknown clocks fail closed.
- Exact team, season, tab, league, player, pick, nominee, and bid identity.
- WALK and leading-bid states never produce a bid.
- Changed offers invalidate a planned bid.
- Concurrent identical bids are single-flight and idempotent.
- A clicked bid or nomination requires bounded ESPN acknowledgment and is never
  retried blindly when acknowledgment is uncertain.
- DRAIN nominations retain exact intent and can never trigger price enforcement.
- Historical ESPN Autopick and external roster additions remain visible after
  the immediate condition clears.
- A complete roster with an unresolved action cannot certify final-ready.
- Source snapshot and intended decision identity are write-once during an
  action lifecycle.
- Room-watch, exact-context recovery, compact incremental reads, stale state,
  oversized state, and transport failure.

## Full release sequence

1. Stop DraftForge, status monitors, and owned Chrome practice windows.
2. Freeze the candidate commit; do not edit code while any certification draft
   is open.
3. Run `git diff --check`, clean install, audit, lint, typecheck, full tests,
   visual certification, extension packaging, and package digest verification.
4. Run `npm run test:live-control`, `npm run test:load` against the candidate,
   and `npm run test:chaos`.
5. Run current-source paired Monte Carlo discovery/validation. Expose the
   untouched holdout only for the final candidate. Reject material mean,
   25th-percentile, or high-regret regression.
6. Run the three-hour soak.
7. From quit Chrome, certify one complete authenticated snake mock and three
   complete salary-cap mocks: normal, rapid bidding, and recovery/worker restart.
8. Require complete action/roster lineage, zero pending actions, and no excluded
   or contaminated run counted as a pass.
9. Tag the immutable commit and verify that the served build and installed
   extension report the tagged artifact digests.

## Draft-day no-code-change model

- **T-24 hours:** freeze and tag; build/package once; finish all automated and
  authenticated gates.
- **T-60 minutes:** quit Chrome and stop all managed processes. Start one
  certified production server. Open exactly one DraftForge tab and one exact
  ESPN tab in separate active windows. Import the authenticated rules and player
  statuses, warm the fixed five sources, and load the separate availability
  veto artifact.
- **T-10 minutes:** renew the room watch, run the in-memory/no-network live gate,
  verify exact room identity, ESPN Autopick off, sound state, source/news digest,
  clock, action surface, and no pending action, then arm explicitly.
- **Live:** the companion/dashboard writes. Chat reads the compact published
  state. Do not run Git, builds, tests, source refreshes, screenshots, browser
  runtime injection, or code changes on the action path.
- **Recovery:** disarm immediately. Recover only outside our turn or an active
  offer. Revalidate every identity, freshness, digest, and pending-action gate
  before explicit rearm. Use an attributed manual ESPN fallback if the safe
  window cannot be restored.
- **Completion:** wait for the final action to settle, verify roster parity and
  complete attribution, stop the server and monitor, and confirm no owned tabs,
  processes, sockets, or listeners remain.
