import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/draft-day/route.ts";
import {
  validateLiveControlRecoveryCandidate,
  validateLiveControlRecoveryImport,
} from "../app/lib/live-control-recovery.ts";
import { appendLiveControlEvent, createLiveControlState } from "../app/lib/live-control.ts";

const now = Date.now();
const at = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
const sourceSnapshotId = `sha256:${"c".repeat(64)}`;
const roster = [
  { playerId: 101, playerName: "Recovered Quarterback", position: "QB", amount: 17 },
  { playerId: 202, playerName: "Recovered Receiver", position: "WR", amount: 31 },
];

function recoveredControl(attribution = "DRAFTFORGE_CONFIRMED") {
  let control = createLiveControlState("recovered-live-control", {
    espnContextAt: at(-1_000),
    pickFeedAt: at(-1_000),
    pickFeedObservedAt: at(-1_000),
    sourceSnapshotAt: at(-1_000),
    lastActionAt: at(-1_000),
  });
  roster.forEach((entry, index) => {
    control = appendLiveControlEvent(control, {
      kind: "ROSTER_ATTRIBUTION",
      occurredAt: at(-900 + index),
      player: { playerId: entry.playerId, playerName: entry.playerName, position: entry.position },
      attribution,
    });
  });
  return control;
}

function audit(overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAt: at(-250),
    league: {
      id: "1603083723",
      teamId: 6,
      season: 2026,
      draftType: "AUCTION",
      size: 10,
      rosterSize: 16,
      auctionBudget: 200,
      secondsPerPick: 30,
      scoringLabel: "PPR",
      scoringRules: 42,
      keeperCount: 0,
      lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7 },
      positionLimits: { "0": 4, "2": 8, "4": 8, "6": 3, "16": 1, "17": 1 },
    },
    binding: {
      tabId: 44,
      commandCenterSessionId: "prior-command-center",
      commandCenterStartedAt: at(-60_000),
      authenticatedImportAt: at(-50_000),
    },
    runtime: {
      capturedAt: at(-250),
      extensionVersion: "0.2.27",
      extensionSourceSha256: "a".repeat(64),
      extensionSourceFileCount: 18,
      browserTabCount: 2,
      draftForgeTabCount: 1,
      espnTabCount: 1,
      managedCleanupReady: true,
    },
    safety: {
      settingsConfirmed: true,
      liveChecklistReady: true,
      extensionConnected: true,
      inDraftRoom: true,
      soundMuted: true,
      autopickActive: false,
      autoDraft: true,
      sourceCoverage: 5,
      sourceIds: ["espn", "ffc", "mfl", "tradyr", "gng"],
      sourceSnapshotId,
      sourceSnapshotGeneratedAt: at(-1_000),
      actionState: "Live auction active.",
    },
    draft: { totalPicks: 28, appRoster: roster, espnRoster: roster },
    telemetry: {
      actions: [{
        occurredAt: at(-1_000),
        operation: "BID",
        ok: true,
        code: "ACTION_SUBMITTED",
        submitMs: 12,
        roundTripMs: 44,
        clockSeconds: 19,
        automatic: true,
        playerId: 101,
        amount: 17,
        maxApprovedBid: 20,
      }],
    },
    sleeperEvidence: { candidateCount: 0, candidates: [] },
    liveControl: recoveredControl(),
    ...overrides,
  };
}

const expected = { leagueId: "1603083723", teamId: 6, season: 2026, draftType: "AUCTION" };

test("exact loopback audit GET preserves every recovery-critical ledger", async () => {
  const candidate = audit();
  const recorded = await POST(new Request("http://127.0.0.1:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: candidate }),
  }));
  assert.equal(recorded.status, 200);

  const response = await GET(new Request("http://127.0.0.1:3000/api/draft-day?leagueId=1603083723&teamId=6"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.code, "DRAFT_AUDIT_READY");
  assert.equal(result.evaluation.parity, true);
  assert.deepEqual(result.snapshot.binding, candidate.binding);
  assert.deepEqual(result.snapshot.liveControl, candidate.liveControl);
  assert.deepEqual(result.snapshot.telemetry, candidate.telemetry);
  assert.deepEqual(result.snapshot.sleeperEvidence, candidate.sleeperEvidence);
});

test("a recent exact clean audit preserves irreversible roster history for recovery", () => {
  const result = validateLiveControlRecoveryCandidate({
    snapshot: audit(),
    reportedParity: true,
    expected,
    nowMs: now,
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidate.commandCenterSessionId, "prior-command-center");
  assert.equal(result.candidate.irreversibleHistory, true);
  assert.deepEqual(result.candidate.snapshot.telemetry.actions, audit().telemetry.actions);
});

test("recovery refuses stale, mismatched, pending, incident, or unattributed history", () => {
  const staleControl = recoveredControl();
  staleControl.freshness.sourceSnapshotAt = at(-31_000);
  const stale = validateLiveControlRecoveryCandidate({
    snapshot: audit({
      capturedAt: at(-31_000),
      safety: { ...audit().safety, sourceSnapshotGeneratedAt: at(-31_000) },
      liveControl: staleControl,
    }),
    reportedParity: true,
    expected,
    nowMs: now,
  });
  assert.deepEqual(stale, { ok: false, code: "LIVE_CONTROL_RECOVERY_AUDIT_STALE" });

  const mismatch = validateLiveControlRecoveryCandidate({
    snapshot: audit(),
    reportedParity: true,
    expected: { ...expected, teamId: 7 },
    nowMs: now,
  });
  assert.deepEqual(mismatch, { ok: false, code: "LIVE_CONTROL_RECOVERY_IDENTITY_MISMATCH" });

  let pendingControl = recoveredControl();
  pendingControl = appendLiveControlEvent(pendingControl, {
    kind: "ACTION_LIFECYCLE",
    occurredAt: at(-100),
    actionId: "pending-action",
    decisionId: "pending-decision",
    operation: "BID",
    phase: "PLANNED",
    intendedPlayer: { playerId: 303, playerName: "Pending Player", position: "RB" },
    intendedOffer: 9,
  });
  const pending = validateLiveControlRecoveryCandidate({
    snapshot: audit({ liveControl: pendingControl }),
    reportedParity: true,
    expected,
    nowMs: now,
  });
  assert.deepEqual(pending, { ok: false, code: "LIVE_CONTROL_RECOVERY_ACTION_PENDING" });

  const incident = validateLiveControlRecoveryCandidate({
    snapshot: audit({ liveControl: recoveredControl("UNKNOWN_EXTERNAL") }),
    reportedParity: true,
    expected,
    nowMs: now,
  });
  assert.deepEqual(incident, { ok: false, code: "LIVE_CONTROL_RECOVERY_INCIDENT_PRESENT" });

  const missingAttribution = validateLiveControlRecoveryCandidate({
    snapshot: audit({
      liveControl: createLiveControlState("missing-attribution-control", { sourceSnapshotAt: at(-1_000) }),
    }),
    reportedParity: true,
    expected,
    nowMs: now,
  });
  assert.deepEqual(missingAttribution, { ok: false, code: "LIVE_CONTROL_RECOVERY_ATTRIBUTION_MISMATCH" });
});

test("authenticated re-import must match tab, format, roster salaries, and explicit Autopick-off", () => {
  const candidateResult = validateLiveControlRecoveryCandidate({
    snapshot: audit(),
    reportedParity: true,
    expected,
    nowMs: now,
  });
  assert.equal(candidateResult.ok, true);
  const observed = {
    ...expected,
    tabId: 44,
    inDraftRoom: true,
    autopickActive: false,
    roster: roster.map(({ playerId, amount }) => ({ playerId, amount })),
    rules: audit().league,
  };
  assert.deepEqual(validateLiveControlRecoveryImport(candidateResult.candidate, observed), {
    ok: true,
    code: "LIVE_CONTROL_RECOVERY_IMPORT_VERIFIED",
  });
  assert.equal(validateLiveControlRecoveryImport(candidateResult.candidate, { ...observed, tabId: 45 }).ok, false);
  assert.deepEqual(validateLiveControlRecoveryImport(candidateResult.candidate, observed, candidateResult.candidate.expiresAtMs + 1), {
    ok: false,
    code: "LIVE_CONTROL_RECOVERY_AUDIT_STALE",
  });
  assert.deepEqual(validateLiveControlRecoveryImport(candidateResult.candidate, { ...observed, autopickActive: undefined }), {
    ok: false,
    code: "LIVE_CONTROL_RECOVERY_AUTOPICK_NOT_OFF",
  });
  assert.deepEqual(validateLiveControlRecoveryImport(candidateResult.candidate, {
    ...observed,
    roster: [{ playerId: 101, amount: 18 }, { playerId: 202, amount: 31 }],
  }), {
    ok: false,
    code: "LIVE_CONTROL_RECOVERY_ROSTER_CHANGED",
  });
});

test("authenticated recovery rejects drift in every strategy-critical league rule", () => {
  const candidateResult = validateLiveControlRecoveryCandidate({
    snapshot: audit(),
    reportedParity: true,
    expected,
    nowMs: now,
  });
  assert.equal(candidateResult.ok, true);
  const observed = {
    ...expected,
    tabId: 44,
    inDraftRoom: true,
    autopickActive: false,
    roster: roster.map(({ playerId, amount }) => ({ playerId, amount })),
    rules: audit().league,
  };
  const mutations = [
    { size: 12 },
    { rosterSize: 17 },
    { auctionBudget: 201 },
    { secondsPerPick: 29 },
    { scoringLabel: "Half PPR" },
    { scoringRules: 43 },
    { keeperCount: 1 },
    { lineupSlotCounts: { ...observed.rules.lineupSlotCounts, "0": 2 } },
    { positionLimits: { ...observed.rules.positionLimits, "0": 5 } },
  ];
  for (const mutation of mutations) {
    assert.deepEqual(validateLiveControlRecoveryImport(candidateResult.candidate, {
      ...observed,
      rules: { ...observed.rules, ...mutation },
    }), { ok: false, code: "LIVE_CONTROL_RECOVERY_RULES_CHANGED" });
  }
});
