import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LIVE_CONTROL_EVENTS,
  appendLiveControlEvent,
  buildLiveControlCompactView,
  createLiveControlState,
  deterministicSnakeSubmitSecondsRemaining,
  isLiveControlState,
  preserveLiveControlForVerifiedRebound,
  validateLiveControlTransition,
} from "../app/lib/live-control.ts";

const at = (offset = 0) => new Date(Date.parse("2026-08-28T01:00:00.000Z") + offset).toISOString();
const player = (playerId, playerName, position = "WR") => ({ playerId, playerName, position });

function decision(overrides = {}) {
  return {
    decisionId: "decision-14",
    decidedAt: at(),
    contextCapturedAt: at(),
    leagueId: "1603083723",
    teamId: 6,
    tabId: 41,
    operation: "SELECT",
    sourceSnapshotId: "snapshot:five-source:20260828",
    expectedPick: 14,
    submitNotBeforeAt: at(30_000),
    submitTargetSeconds: 27,
    intendedPlayer: player(101, "Intended Receiver"),
    alternatives: [player(102, "Alternative Runner", "RB")],
    ...overrides,
  };
}

function append(state, event) {
  return appendLiveControlEvent(state, { occurredAt: at(state.sequence * 1_000), ...event });
}

test("snake submit timing is deterministic, bounded, and varies across picks", () => {
  const first = deterministicSnakeSubmitSecondsRemaining("1603083723", 14);
  assert.equal(first, deterministicSnakeSubmitSecondsRemaining("1603083723", 14));
  const sample = Array.from({ length: 40 }, (_, index) => deterministicSnakeSubmitSecondsRemaining("1603083723", index + 1));
  assert.ok(sample.every((second) => second >= 22 && second <= 30));
  assert.ok(new Set(sample).size > 1);
  assert.throws(() => deterministicSnakeSubmitSecondsRemaining("", 1), /INVALID_SNAKE_SUBMIT_TIMING_INPUT/);
  assert.throws(() => deterministicSnakeSubmitSecondsRemaining("league", 0), /INVALID_SNAKE_SUBMIT_TIMING_INPUT/);
});

test("verified tab rebound preserves the exact control ledger only between actions", () => {
  const clean = createLiveControlState("rebound-session", { espnContextAt: at() });
  assert.equal(preserveLiveControlForVerifiedRebound(clean, false), clean);
  assert.throws(() => preserveLiveControlForVerifiedRebound(clean, true), /LIVE_CONTROL_REBOUND_ACTION_PENDING/);

  const pending = append(clean, {
    kind: "ACTION_LIFECYCLE",
    actionId: "rebound-action",
    decisionId: "rebound-decision",
    operation: "BID",
    phase: "PLANNED",
    intendedPlayer: player(202, "Exact Nominee", "RB"),
    intendedOffer: 19,
  });
  assert.equal(pending.pendingActionCount, 1);
  assert.throws(() => preserveLiveControlForVerifiedRebound(pending, false), /LIVE_CONTROL_REBOUND_ACTION_PENDING/);
});

test("live control events are monotonic, bounded, and retain sticky incident state", () => {
  let control = createLiveControlState("somfab-live-20260827");
  control = append(control, {
    kind: "SAFETY",
    condition: "ESPN_AUTOPICK",
    active: true,
    code: "AUTOPICK_DETECTED",
  });
  control = append(control, {
    kind: "SAFETY",
    condition: "ESPN_AUTOPICK",
    active: false,
    code: "AUTOPICK_DISABLED",
  });
  control = append(control, {
    kind: "ROSTER_ATTRIBUTION",
    player: player(20, "External Quarterback", "QB"),
    attribution: "ESPN_AUTOPICK",
  });
  for (let index = 0; index < MAX_LIVE_CONTROL_EVENTS + 10; index += 1) {
    control = append(control, {
      kind: "SAFETY",
      condition: "CLOCK",
      active: false,
      code: "CLOCK_VERIFIED",
    });
  }

  assert.equal(isLiveControlState(control), true);
  assert.equal(control.sequence, MAX_LIVE_CONTROL_EVENTS + 13);
  assert.equal(control.events.length, MAX_LIVE_CONTROL_EVENTS);
  assert.equal(control.events.at(-1).sequence, control.sequence);
  assert.equal(control.historicalAutopickDetected, true);
  assert.equal(control.uncontrolledRosterAdditionDetected, true);
  assert.equal(control.rosterAttributions[0].attribution, "ESPN_AUTOPICK");
});

test("a decision is write-once while resolved identity may be filled exactly once", () => {
  const empty = createLiveControlState("decision-session");
  const planned = {
    ...append(empty, {
      kind: "ACTION_LIFECYCLE",
      actionId: "action-14",
      decisionId: "decision-14",
      operation: "SELECT",
      phase: "PLANNED",
      intendedPlayer: player(101, "Intended Receiver"),
    }),
    decision: decision(),
  };
  assert.equal(planned.pendingActionCount, 1);
  assert.deepEqual(validateLiveControlTransition(empty, planned), { ok: true, code: "LIVE_CONTROL_ACCEPTED" });

  const resolvedPlayer = player(-16, "Los Angeles Rams D/ST", "DST");
  const resolved = {
    ...append(planned, {
      kind: "ACTION_LIFECYCLE",
      actionId: "action-14",
      decisionId: "decision-14",
      operation: "SELECT",
      phase: "RESOLVED",
      intendedPlayer: player(101, "Intended Receiver"),
      resolvedPlayer,
    }),
    decision: decision({ resolvedPlayer }),
  };
  assert.deepEqual(validateLiveControlTransition(planned, resolved), { ok: true, code: "LIVE_CONTROL_ACCEPTED" });

  const mutated = {
    ...append(resolved, {
      kind: "ACTION_LIFECYCLE",
      actionId: "action-14",
      decisionId: "decision-14",
      operation: "SELECT",
      phase: "CLICK_SENT",
      resolvedPlayer,
    }),
    decision: decision({ intendedPlayer: player(999, "Mutated Intent"), resolvedPlayer }),
  };
  assert.deepEqual(validateLiveControlTransition(resolved, mutated), { ok: false, code: "LIVE_CONTROL_DECISION_MUTATED" });
});

test("compact control polling returns only events after the requested sequence and computed ages", () => {
  let control = createLiveControlState("poll-session", {
    espnContextAt: at(),
    pickFeedAt: at(1_000),
    sourceSnapshotAt: at(2_000),
    lastActionAt: null,
  });
  control = append(control, {
    kind: "SAFETY",
    condition: "EXACT_BINDING",
    active: false,
    code: "EXACT_BINDING_VERIFIED",
  });
  control = append(control, {
    kind: "SAFETY",
    condition: "CLOCK",
    active: false,
    code: "CLOCK_VERIFIED",
  });

  const view = buildLiveControlCompactView(control, 1, Date.parse(at(5_000)));
  assert.equal(view.sequence, 2);
  assert.equal(view.unchanged, false);
  assert.deepEqual(view.events.map((event) => event.sequence), [2]);
  assert.deepEqual(view.agesMs, {
    espnContext: 5_000,
    pickFeed: 4_000,
    sourceSnapshot: 3_000,
    lastAction: null,
    decision: null,
    decisionContext: null,
  });
  assert.equal(buildLiveControlCompactView(control, 2).unchanged, true);
  assert.deepEqual(buildLiveControlCompactView(control, 2).events, []);
});

test("same-sequence control mutations and sticky-state regressions are rejected", () => {
  let control = createLiveControlState("regression-session");
  control = append(control, {
    kind: "SAFETY",
    condition: "ESPN_AUTOPICK",
    active: true,
    code: "AUTOPICK_DETECTED",
  });
  assert.equal(validateLiveControlTransition(control, { ...control, pendingActionCount: 1 }).code, "LIVE_CONTROL_STATE_CHANGED_WITHOUT_EVENT");
  assert.equal(validateLiveControlTransition(control, { ...control, historicalAutopickDetected: false }).code, "LIVE_CONTROL_INVALID");
  assert.equal(validateLiveControlTransition(control, { ...control, sequence: 0, events: [] }).code, "LIVE_CONTROL_SEQUENCE_REGRESSION");
});

test("lifecycle identity, event continuity, pending counts, and freshness cannot drift", () => {
  const empty = createLiveControlState("lifecycle-session", { espnContextAt: at() });
  const planned = {
    ...append(empty, {
      kind: "ACTION_LIFECYCLE",
      actionId: "action-1",
      decisionId: "decision-14",
      operation: "SELECT",
      phase: "PLANNED",
      intendedPlayer: player(101, "Intended Receiver"),
    }),
    decision: decision(),
  };
  assert.equal(validateLiveControlTransition(empty, planned).ok, true);

  const completed = append(planned, {
    kind: "ACTION_LIFECYCLE",
    actionId: "action-1",
    decisionId: "decision-14",
    operation: "SELECT",
    phase: "ROSTER_CONFIRMED",
    intendedPlayer: player(101, "Intended Receiver"),
  });
  assert.equal(completed.pendingActionCount, 0);
  assert.equal(validateLiveControlTransition(planned, completed).ok, true);

  const pendingMismatch = { ...planned, pendingActionCount: 0 };
  assert.deepEqual(validateLiveControlTransition(empty, pendingMismatch), {
    ok: false,
    code: "LIVE_CONTROL_PENDING_COUNT_MISMATCH",
  });
  const freshnessRegression = { ...planned, freshness: { ...planned.freshness, espnContextAt: at(-1) } };
  assert.equal(validateLiveControlTransition(planned, freshnessRegression).code, "LIVE_CONTROL_FRESHNESS_REGRESSION");

  const discontinuous = structuredClone(planned);
  discontinuous.sequence = 3;
  discontinuous.events[0].sequence = 3;
  assert.equal(validateLiveControlTransition(empty, discontinuous).code, "LIVE_CONTROL_EVENT_GAP");

  assert.throws(() => append(planned, {
    kind: "ACTION_LIFECYCLE",
    actionId: "action-1",
    decisionId: "different-decision",
    operation: "BID",
    phase: "RESOLVED",
  }), /INVALID_LIVE_CONTROL_TRANSITION/);
});

test("an acknowledged bid can terminate without pretending the auction sale is roster-confirmed", () => {
  let control = createLiveControlState("auction-action-session");
  control = append(control, {
    kind: "ACTION_LIFECYCLE",
    actionId: "bid-1",
    decisionId: "decision-bid-1",
    operation: "BID",
    phase: "PLANNED",
  });
  control = append(control, {
    kind: "ACTION_LIFECYCLE",
    actionId: "bid-1",
    decisionId: "decision-bid-1",
    operation: "BID",
    phase: "ESPN_ACKNOWLEDGED",
  });
  control = append(control, {
    kind: "ACTION_LIFECYCLE",
    actionId: "bid-1",
    decisionId: "decision-bid-1",
    operation: "BID",
    phase: "ACTION_COMPLETED",
  });
  assert.equal(control.pendingActionCount, 0);
  assert.equal(control.events.at(-1).phase, "ACTION_COMPLETED");
});
