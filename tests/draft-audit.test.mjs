import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_AUDIT_DASHBOARD_INSTANCE_STALE,
  buildDraftDayObserverHealth,
  GET,
  MAX_DRAFT_AUDIT_POST_BYTES,
  MAX_DRAFT_BOARD_GET_BYTES,
  MAX_DRAFT_STATUS_GET_BYTES,
  POST,
} from "../app/api/draft-day/route.ts";
import {
  buildDraftLeagueBoardSnapshot,
  draftAuditChecklistBindingKey,
  evaluateDraftAuditSnapshot,
  isDraftAuditSnapshot,
  MAX_DRAFT_AUDIT_AUCTION_BUDGET,
  MAX_DRAFT_AUDIT_AVAILABILITY_VETOES,
  MAX_DRAFT_AUDIT_LEAGUE_SIZE,
  MAX_DRAFT_AUDIT_MAP_ENTRIES,
  MAX_DRAFT_AUDIT_ROSTER_SIZE,
  MAX_DRAFT_OPERATOR_ALTERNATIVES,
  MAX_DRAFT_LEAGUE_BOARD_BYTES,
  MAX_DRAFT_LEAGUE_BOARD_RECENT_PICKS,
  MAX_DRAFT_ACTION_TELEMETRY_EVENTS,
  resolveDraftAuditChecklistReady,
  sanitizeDraftLeagueBoardSnapshot,
  sanitizeDraftOperatorSnapshot,
} from "../app/lib/draft-audit.ts";
import {
  createDraftAuditPublisher,
  draftAuditPublicationDigest,
} from "../app/lib/draft-audit-publisher.ts";
import {
  MAX_LIVE_CONTROL_EVENTS,
  appendLiveControlEvent,
  createLiveControlState,
} from "../app/lib/live-control.ts";
import {
  authenticatedEspnCaptureDigest,
  buildAuthenticatedEspnCaptureAttestation,
  buildAuthenticatedEspnCaptureProfile,
  sanitizeAuthenticatedEspnLeague,
  sanitizeAuthenticatedEspnPlayers,
} from "../app/lib/authenticated-espn-capture.ts";

const roster = [
  [1, "Quarterback One", "QB", 8],
  [2, "Quarterback Two", "QB", 2],
  [3, "Running Back One", "RB", 38],
  [4, "Running Back Two", "RB", 24],
  [5, "Running Back Three", "RB", 4],
  [6, "Receiver One", "WR", 42],
  [7, "Receiver Two", "WR", 28],
  [8, "Receiver Three", "WR", 8],
  [9, "Receiver Four", "WR", 4],
  [10, "Receiver Five", "WR", 2],
  [11, "Tight End One", "TE", 12],
  [12, "Tight End Two", "TE", 2],
  [-16013, "Defense One", "DST", 1],
  [14, "Kicker One", "K", 1],
].map(([playerId, playerName, position, amount]) => ({ playerId, playerName, position, amount }));

const testAuditEpoch = Date.now() - 60_000;
const testCapturedAt = (offsetSeconds = 0) => new Date(testAuditEpoch + offsetSeconds * 1000).toISOString();
const sourceSnapshotId = `sha256:${"c".repeat(64)}`;

function completeSalaryCapEvidence() {
  return {
    sales: roster.map((entry, index) => ({
      sequence: index + 1,
      playerId: entry.playerId,
      position: entry.position,
      closingPrice: entry.amount,
      sourceAuction: entry.amount,
      fairValue: entry.amount,
      targetBid: entry.amount,
      maxApprovedBid: entry.amount,
      highestObservedBid: entry.amount,
      nominationIntent: "TARGET",
      outcome: "WON",
      submittedBidCount: 1,
      highestSubmittedBid: entry.amount,
    })),
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAt: testCapturedAt(),
    league: {
      id: "audit-verified-1",
      teamId: 7,
      season: 2026,
      draftType: "AUCTION",
      size: 12,
      rosterSize: 14,
      auctionBudget: 200,
      secondsPerPick: 60,
      scoringLabel: "PPR",
      scoringRules: 45,
      keeperCount: 2,
      lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "7": 1, "16": 1, "17": 1, "20": 6, "23": 2 },
      positionLimits: { "1": 2, "2": 3, "3": 5, "4": 2, "16": 1, "17": 1 },
    },
    binding: { tabId: 1234, authenticatedImportAt: testCapturedAt() },
    runtime: {
      capturedAt: testCapturedAt(),
      extensionVersion: "0.2.12",
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
      autoDraft: false,
      sourceCoverage: 5,
      sourceIds: ["espn", "ffc", "mfl", "tradyr", "gng"],
      sourceSnapshotId,
      sourceSnapshotGeneratedAt: testCapturedAt(),
      actionState: "Draft complete: ESPN confirmed every roster spot.",
    },
    draft: {
      totalPicks: 168,
      appRoster: roster,
      espnRoster: roster,
    },
    telemetry: {
      actions: [{
        occurredAt: testCapturedAt(),
        operation: "BID",
        ok: true,
        code: "ACTION_SUBMITTED",
        submitMs: 21,
        roundTripMs: 84,
        clockSeconds: 31,
        automatic: false,
        playerId: 1,
        amount: 8,
        maxApprovedBid: 8,
      }],
    },
    salaryCapEvidence: completeSalaryCapEvidence(),
    sleeperEvidence: {
      candidateCount: 1,
      candidates: [{
        playerId: 99,
        playerName: "Corroborated Sleeper",
        position: "WR",
        adp: 88,
        label: "SLEEPER",
        score: 62,
        modelMarketEdge: 12,
        modelSpread: 4,
        sourceCount: 5,
      }],
    },
    availability: {
      status: "READY",
      digest: `sha256:${"a".repeat(64)}`,
      evaluatedAt: testCapturedAt(),
      freshUntil: testCapturedAt(1_800),
      blockingReasons: [],
      vetoedPlayerIds: [],
    },
    liveControl: attributedLiveControl(),
    ...overrides,
  };
}

function attributedLiveControl(entries = roster, attributionFor = () => "DRAFTFORGE_CONFIRMED") {
  let control = createLiveControlState("audit-control-session", {
    espnContextAt: testCapturedAt(),
    pickFeedAt: testCapturedAt(),
    sourceSnapshotAt: testCapturedAt(),
    lastActionAt: testCapturedAt(),
  });
  entries.forEach((entry, index) => {
    control = appendLiveControlEvent(control, {
      occurredAt: testCapturedAt(index),
      kind: "ROSTER_ATTRIBUTION",
      player: { playerId: entry.playerId, playerName: entry.playerName, position: entry.position },
      attribution: attributionFor(entry, index),
      actionId: `action-${index + 1}`,
      decisionId: `decision-${index + 1}`,
    });
  });
  return control;
}

function cleanLiveControl(sessionId = "clean-control-session") {
  return createLiveControlState(sessionId, {
    espnContextAt: testCapturedAt(),
    pickFeedAt: testCapturedAt(),
    sourceSnapshotAt: testCapturedAt(),
    lastActionAt: null,
  });
}

function operatorSnapshot() {
  return {
    room: {
      round: null,
      pick: 37,
      onClock: false,
      secondsRemaining: 14,
      nominee: { playerId: 301, playerName: "Nominee Receiver", position: "WR", team: "HOU" },
      currentBid: 18,
      leader: "OPPONENT",
      maxLegalBid: 22,
    },
    team: {
      remainingBudget: 87,
      openRosterSlots: 8,
      primaryNeeds: [{ position: "QB", count: 1 }, { position: "WR", count: 2 }],
    },
    recommendation: {
      state: "PREVIEW",
      action: "BID",
      player: { playerId: 301, playerName: "Nominee Receiver", position: "WR", team: "HOU" },
      offer: 19,
      maxLegalBid: 22,
    },
    alternatives: [
      { player: { playerId: 302, playerName: "Alternative Back", position: "RB", team: "DET" }, maxLegalBid: 17 },
    ],
    lastDecision: {
      operation: "BID",
      phase: "ACTION_COMPLETED",
      player: { playerId: 299, playerName: "Prior Tight End", position: "TE", team: "ARI" },
      offer: 11,
      occurredAt: testCapturedAt(),
      code: "ROSTER_CONFIRMED",
    },
  };
}

function leagueBoardSnapshot() {
  const ourPick = {
    overall: 12,
    round: 1,
    teamSlot: 2,
    ours: true,
    player: { playerId: 402, playerName: "Our Receiver", position: "WR", team: "DAL" },
    amount: null,
  };
  return {
    draftType: "SNAKE",
    auctionBudget: null,
    rankingBasis: "AVERAGE_PROJECTION",
    recentPicks: [{
      overall: 11,
      round: 1,
      teamSlot: 1,
      ours: false,
      player: { playerId: 401, playerName: "Public Opponent Pick", position: "RB", team: "ATL" },
      amount: null,
    }, ourPick],
    ourRoster: [ourPick],
    teams: [{
      teamSlot: 1,
      ours: false,
      rank: 2,
      playerCount: 1,
      projectedPoints: 280.2,
      averageProjectedPoints: 280.2,
      spent: null,
      remainingBudget: null,
      positionCounts: { RB: 1 },
    }, {
      teamSlot: 2,
      ours: true,
      rank: 1,
      playerCount: 1,
      projectedPoints: 301.4,
      averageProjectedPoints: 301.4,
      spent: null,
      remainingBudget: null,
      positionCounts: { WR: 1 },
    }],
    recommendation: {
      player: { playerId: 403, playerName: "Next Receiver", position: "WR", team: "MIN" },
      confidence: 84,
      reasons: ["Best projected value", "A receiver tier drop is approaching"],
      sourceCount: 5,
      sourceSnapshotId,
    },
  };
}

function completeLeagueBoardSnapshot() {
  const ourRoster = roster.map((entry, index) => ({
    overall: index + 1,
    round: null,
    teamSlot: 1,
    ours: true,
    player: {
      playerId: entry.playerId,
      playerName: entry.playerName,
      position: entry.position,
    },
    amount: entry.amount,
  }));
  const positionCounts = roster.reduce((counts, entry) => {
    counts[entry.position] = Number(counts[entry.position] || 0) + 1;
    return counts;
  }, {});
  return {
    draftType: "AUCTION",
    auctionBudget: 200,
    rankingBasis: "AVERAGE_PROJECTION",
    recentPicks: ourRoster,
    ourRoster,
    teams: [{
      teamSlot: 1,
      ours: true,
      rank: 1,
      playerCount: roster.length,
      projectedPoints: 3_700,
      averageProjectedPoints: 264.3,
      spent: 176,
      remainingBudget: 24,
      positionCounts,
    }],
    recommendation: leagueBoardSnapshot().recommendation,
  };
}

test("completed exact ESPN/app audit is final-ready", () => {
  const candidate = snapshot();
  assert.equal(isDraftAuditSnapshot(candidate), true);
  assert.deepEqual(evaluateDraftAuditSnapshot(candidate), {
    complete: true,
    finalReady: true,
    parity: true,
    openSlots: 0,
    spent: 176,
    remainingBudget: 24,
    hardViolations: [],
    finalViolations: [],
  });
});

test("authenticated capture receipts require the private current-audit issue token and consume once", async () => {
  const auditAt = new Date().toISOString();
  const importAt = new Date(Date.now() - 1_000).toISOString();
  const dashboardLoadedAt = new Date(Date.now() - 2_000).toISOString();
  const numericLeagueId = "44050999";
  const league = {
    ...snapshot().league,
    id: numericLeagueId,
    teamId: 7,
    keeperCount: 0,
    pickOrder: [],
  };
  const audit = snapshot({
    capturedAt: auditAt,
    league,
    binding: {
      tabId: 9123,
      dashboardLoadedAt,
      commandCenterSessionId: "capture-receipt-publisher",
      commandCenterStartedAt: dashboardLoadedAt,
      authenticatedImportAt: importAt,
      authenticatedPlayerPool: {
        schemaVersion: 1,
        requestedCount: 500,
        playerCount: 500,
        uniquePlayerCount: 500,
        fetchedAt: importAt,
        leagueId: numericLeagueId,
        teamId: 7,
        season: 2026,
      },
    },
    runtime: { ...snapshot().runtime, capturedAt: auditAt },
    safety: {
      ...snapshot().safety,
      sourceSnapshotGeneratedAt: auditAt,
      extensionConnected: true,
      settingsConfirmed: true,
      sourceCoverage: 5,
    },
    liveControl: undefined,
  });
  const localPost = (body) => POST(new Request("http://127.0.0.1:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(body),
  }));
  const recorded = await localPost({ operation: "AUDIT", audit });
  assert.equal(recorded.status, 200);
  const recordedBody = await recorded.json();
  assert.match(recordedBody.captureIssueToken, /^[a-f0-9]{32}$/);

  const sanitizedLeague = sanitizeAuthenticatedEspnLeague({
    ...league,
    rawSettings: {
      scoringSettings: {
        scoringItems: Array.from({ length: league.scoringRules }, (_, index) => ({ statId: index + 1, points: 0 })),
      },
    },
  });
  const espnPlayers = sanitizeAuthenticatedEspnPlayers(Array.from({ length: 500 }, (_, index) => ({
    id: index + 1,
    name: `Player ${index + 1}`,
    team: index % 2 === 0 ? "A" : "B",
    pos: index % 2 === 0 ? "QB" : "RB",
    rank: index + 1,
    adp: index + 1,
    auction: 1,
    projected: Math.max(1, 500 - index),
  })));
  const sourceProfile = { scoring: "PPR", teams: 12, season: 2026, qbs: 2 };
  const digest = await authenticatedEspnCaptureDigest({ capturedAt: importAt, league: sanitizedLeague, espnPlayers });
  const capture = {
    digest,
    capturedAt: importAt,
    profile: buildAuthenticatedEspnCaptureProfile({ league: sanitizedLeague, espnPlayers, request: sourceProfile }),
    tabId: 9123,
    dashboardLoadedAt,
    commandCenterSessionId: "capture-receipt-publisher",
  };

  const noToken = await localPost({ operation: "ISSUE_ESPN_CAPTURE_RECEIPT", capture });
  assert.equal(noToken.status, 409);
  const wrongTab = await localPost({
    operation: "ISSUE_ESPN_CAPTURE_RECEIPT",
    captureIssueToken: recordedBody.captureIssueToken,
    capture: { ...capture, tabId: 9124 },
  });
  assert.equal(wrongTab.status, 409);
  const issued = await localPost({
    operation: "ISSUE_ESPN_CAPTURE_RECEIPT",
    captureIssueToken: recordedBody.captureIssueToken,
    capture,
  });
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  assert.match(issuedBody.receipt, /^[a-f0-9]{32}$/);

  const proof = buildAuthenticatedEspnCaptureAttestation({
    capturedAt: importAt,
    league: sanitizedLeague,
    espnPlayers,
    request: sourceProfile,
    digest,
    receipt: issuedBody.receipt,
  });
  const consumed = await localPost({ operation: "CONSUME_ESPN_CAPTURE_RECEIPT", authenticatedEspnCapture: proof });
  assert.equal(consumed.status, 200);
  const replayed = await localPost({ operation: "CONSUME_ESPN_CAPTURE_RECEIPT", authenticatedEspnCapture: proof });
  assert.equal(replayed.status, 409);
});

test("dashboard load identity is canonical when present", () => {
  assert.equal(isDraftAuditSnapshot(snapshot({
    binding: {
      ...snapshot().binding,
      dashboardLoadedAt: testCapturedAt(),
    },
  })), true);
  for (const dashboardLoadedAt of [
    "2026-08-28T00:00:00Z",
    "not-a-timestamp",
    "2026-08-28T00:00:00.000+00:00",
  ]) {
    assert.equal(isDraftAuditSnapshot(snapshot({
      binding: { ...snapshot().binding, dashboardLoadedAt },
    })), false, dashboardLoadedAt);
  }
});

test("server restart rejects missing or old dashboards and accepts a reloaded dashboard", async () => {
  const previousServerInstanceStartedAt = process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT;
  const serverInstanceStartedAt = testCapturedAt(10);
  process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT = serverInstanceStartedAt;
  const postAudit = (candidate) => POST(new Request("http://127.0.0.1:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: candidate }),
  }));
  const base = snapshot({
    league: { ...snapshot().league, id: "restart-fence-audit", teamId: 8 },
    liveControl: undefined,
  });
  try {
    for (const binding of [
      base.binding,
      { ...base.binding, dashboardLoadedAt: testCapturedAt(9) },
    ]) {
      const rejected = await postAudit({ ...base, binding });
      assert.equal(rejected.status, 409);
      assert.deepEqual(await rejected.json(), {
        ok: false,
        code: DRAFT_AUDIT_DASHBOARD_INSTANCE_STALE,
      });
    }

    const reloaded = await postAudit({
      ...base,
      capturedAt: testCapturedAt(11),
      binding: { ...base.binding, dashboardLoadedAt: testCapturedAt(11) },
      runtime: { ...base.runtime, capturedAt: testCapturedAt(11) },
      safety: {
        ...base.safety,
        sourceSnapshotGeneratedAt: testCapturedAt(11),
      },
      availability: {
        ...base.availability,
        evaluatedAt: testCapturedAt(11),
        freshUntil: testCapturedAt(1_811),
      },
    });
    assert.equal(reloaded.status, 200);
    assert.equal((await reloaded.json()).code, "DRAFT_AUDIT_RECORDED");
  } finally {
    if (previousServerInstanceStartedAt === undefined) {
      delete process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT;
    } else {
      process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT = previousServerInstanceStartedAt;
    }
  }
});

test("observer health blocks stale feeds and unsafe live state even with a current audit heartbeat", () => {
  const now = Date.parse(testCapturedAt()) + 500;
  const currentAt = new Date(now - 100).toISOString();
  const control = createLiveControlState("observer-health-control", {
    espnContextAt: currentAt,
    pickFeedAt: currentAt,
    pickFeedObservedAt: currentAt,
    sourceSnapshotAt: currentAt,
    lastActionAt: null,
  });
  const healthy = snapshot({
    capturedAt: currentAt,
    runtime: { ...snapshot().runtime, capturedAt: currentAt },
    safety: {
      ...snapshot().safety,
      sourceSnapshotGeneratedAt: currentAt,
      actionState: "Live control ready.",
    },
    availability: {
      ...snapshot().availability,
      evaluatedAt: currentAt,
      freshUntil: new Date(now + 60_000).toISOString(),
    },
    liveControl: control,
  });
  assert.equal(buildDraftDayObserverHealth(healthy, now).liveReady, true);

  const cases = [
    ["EXTENSION_DISCONNECTED", (value) => { value.safety.extensionConnected = false; }],
    ["NOT_IN_DRAFT_ROOM", (value) => { value.safety.inDraftRoom = false; }],
    ["ESPN_AUTOPICK_ACTIVE", (value) => { value.safety.autopickActive = true; }],
    ["LIVE_CHECKLIST_NOT_READY", (value) => { value.safety.liveChecklistReady = false; }],
    ["SOURCE_COVERAGE_INCOMPLETE", (value) => { value.safety.sourceCoverage = 4; }],
    ["SOURCE_SNAPSHOT_STALE", (value) => { value.safety.sourceSnapshotGeneratedAt = new Date(now - 700_000).toISOString(); }],
    ["AVAILABILITY_STALE", (value) => { value.availability.freshUntil = new Date(now).toISOString(); }],
    ["ESPN_CONTEXT_STALE", (value) => { value.liveControl.freshness.espnContextAt = new Date(now - 20_000).toISOString(); }],
    ["PICK_FEED_STALE", (value) => { value.liveControl.freshness.pickFeedObservedAt = new Date(now - 20_000).toISOString(); }],
    ["PICK_FEED_LAGGING", (value) => { value.liveControl.freshness.pickFeedLagging = true; }],
    ["ROSTER_ATTRIBUTION_UNRESOLVED", (value) => { value.liveControl.uncontrolledRosterAdditionDetected = true; }],
  ];
  for (const [code, mutate] of cases) {
    const candidate = structuredClone(healthy);
    mutate(candidate);
    const health = buildDraftDayObserverHealth(candidate, now);
    assert.equal(health.liveReady, false, code);
    assert.ok(health.blockers.includes(code), code);
  }
});

test("audio preference remains telemetry and never blocks final audit", () => {
  const candidate = snapshot({
    safety: { ...snapshot().safety, soundMuted: false },
  });
  assert.equal(isDraftAuditSnapshot(candidate), true);
  const evaluation = evaluateDraftAuditSnapshot(candidate);
  assert.equal(evaluation.finalReady, true);
  assert.deepEqual(evaluation.hardViolations, []);
  assert.deepEqual(evaluation.finalViolations, []);
});

test("audit source identity is exact, canonical, fresh, and bound across published views", () => {
  const baseline = snapshot();
  const invalidSafety = [
    { ...baseline.safety, sourceSnapshotId: undefined },
    { ...baseline.safety, sourceSnapshotId: sourceSnapshotId.toUpperCase() },
    { ...baseline.safety, sourceSnapshotId: "sha256:not-a-digest" },
    { ...baseline.safety, sourceSnapshotGeneratedAt: "2026-08-28T00:00:00Z" },
    { ...baseline.safety, sourceSnapshotGeneratedAt: testCapturedAt(-601) },
    { ...baseline.safety, sourceCoverage: 4 },
    { ...baseline.safety, sourceIds: ["espn", "ffc", "mfl", "tradyr", "other"] },
  ];
  invalidSafety.forEach((safety, index) => {
    assert.equal(isDraftAuditSnapshot(snapshot({ safety })), false, `invalid source safety ${index + 1}`);
  });

  const mismatchedBoard = completeLeagueBoardSnapshot();
  mismatchedBoard.recommendation = {
    ...mismatchedBoard.recommendation,
    sourceSnapshotId: `sha256:${"d".repeat(64)}`,
  };
  assert.ok(sanitizeDraftLeagueBoardSnapshot(mismatchedBoard), "the board is independently well formed");
  assert.equal(isDraftAuditSnapshot(snapshot({ leagueBoard: mismatchedBoard })), false, "board identity must equal audit safety");

  const mismatchedFreshness = {
    ...baseline.liveControl,
    freshness: {
      ...baseline.liveControl.freshness,
      sourceSnapshotAt: testCapturedAt(1),
    },
  };
  assert.equal(isDraftAuditSnapshot(snapshot({ liveControl: mismatchedFreshness })), false, "control timestamp must equal audit safety");

  const intendedPlayer = { playerId: 301, playerName: "Bound Receiver", position: "WR" };
  const decisionControl = appendLiveControlEvent(attributedLiveControl(), {
    kind: "ACTION_LIFECYCLE",
    occurredAt: testCapturedAt(20),
    actionId: "source-bound-action",
    decisionId: "source-bound-decision",
    operation: "BID",
    phase: "PLANNED",
    intendedPlayer,
    intendedOffer: 19,
  });
  decisionControl.decision = {
    decisionId: "source-bound-decision",
    decidedAt: testCapturedAt(20),
    contextCapturedAt: testCapturedAt(20),
    leagueId: baseline.league.id,
    teamId: baseline.league.teamId,
    tabId: baseline.binding.tabId,
    operation: "BID",
    sourceSnapshotId: `sha256:${"d".repeat(64)}`,
    expectedCurrentBid: 18,
    intendedOffer: 19,
    maxApprovedBid: 22,
    intendedPlayer,
    alternatives: [],
  };
  assert.equal(isDraftAuditSnapshot(snapshot({ liveControl: decisionControl })), false, "decision identity must equal audit safety");
});

test("final audit requires typed control and availability that remains fresh at capture", () => {
  const withoutControl = evaluateDraftAuditSnapshot(snapshot({ liveControl: undefined }));
  assert.equal(withoutControl.finalReady, false);
  assert.ok(withoutControl.finalViolations.includes("LIVE_CONTROL_MISSING"));

  const withoutAvailability = evaluateDraftAuditSnapshot(snapshot({ availability: undefined }));
  assert.equal(withoutAvailability.finalReady, false);
  assert.ok(withoutAvailability.finalViolations.includes("AVAILABILITY_GATE_MISSING"));

  const staleAvailability = evaluateDraftAuditSnapshot(snapshot({
    availability: {
      ...snapshot().availability,
      freshUntil: testCapturedAt(-1),
    },
  }));
  assert.equal(staleAvailability.finalReady, false);
  assert.ok(staleAvailability.finalViolations.includes("AVAILABILITY_GATE_STALE"));
});

test("typed live control permits final-ready only after every roster addition is attributed and actions settle", () => {
  const completeControl = attributedLiveControl();
  assert.equal(evaluateDraftAuditSnapshot(snapshot({ liveControl: completeControl })).finalReady, true);

  const pending = { ...completeControl, pendingActionCount: 1 };
  const pendingResult = evaluateDraftAuditSnapshot(snapshot({ liveControl: pending }));
  assert.equal(pendingResult.finalReady, false);
  assert.ok(pendingResult.finalViolations.includes("LIVE_ACTIONS_PENDING"));

  const partialControl = {
    ...attributedLiveControl(roster.slice(0, -1)),
    unattributedRosterCount: 1,
  };
  const partialResult = evaluateDraftAuditSnapshot(snapshot({ liveControl: partialControl }));
  assert.equal(partialResult.finalReady, false);
  assert.ok(partialResult.finalViolations.includes("ROSTER_ATTRIBUTION_INCOMPLETE"));
});

test("typed live control keeps historical Autopick and unknown additions fatal after current ESPN state clears", () => {
  const autopickControl = attributedLiveControl(roster, (_entry, index) => index === 1 ? "ESPN_AUTOPICK" : "DRAFTFORGE_CONFIRMED");
  const autopickResult = evaluateDraftAuditSnapshot(snapshot({ liveControl: autopickControl }));
  assert.equal(autopickResult.finalReady, false);
  assert.ok(autopickResult.finalViolations.includes("HISTORICAL_ESPN_AUTOPICK"));
  assert.ok(autopickResult.finalViolations.includes("UNCONTROLLED_ROSTER_ADDITION"));

  const unknownControl = attributedLiveControl(roster, (_entry, index) => index === 2 ? "UNKNOWN_EXTERNAL" : "DRAFTFORGE_CONFIRMED");
  const unknownResult = evaluateDraftAuditSnapshot(snapshot({ liveControl: unknownControl }));
  assert.equal(unknownResult.finalReady, false);
  assert.ok(unknownResult.finalViolations.includes("UNCONTROLLED_ROSTER_ADDITION"));
});

test("action telemetry retains a bounded full-draft latency sample", () => {
  const event = snapshot().telemetry.actions[0];
  assert.equal(isDraftAuditSnapshot(snapshot({ telemetry: { actions: Array.from({ length: MAX_DRAFT_ACTION_TELEMETRY_EVENTS }, () => ({ ...event })) } })), true);
  assert.equal(isDraftAuditSnapshot(snapshot({ telemetry: { actions: Array.from({ length: MAX_DRAFT_ACTION_TELEMETRY_EVENTS + 1 }, () => ({ ...event })) } })), false);
});

test("audit schema accepts exact ESPN maxima and rejects every bounded resource overflow", () => {
  const boundedMap = Object.fromEntries(Array.from({ length: MAX_DRAFT_AUDIT_MAP_ENTRIES }, (_, index) => [`X${index}`, MAX_DRAFT_AUDIT_ROSTER_SIZE]));
  const maximum = snapshot({
    league: {
      ...snapshot().league,
      id: "x".repeat(64),
      size: MAX_DRAFT_AUDIT_LEAGUE_SIZE,
      rosterSize: MAX_DRAFT_AUDIT_ROSTER_SIZE,
      auctionBudget: MAX_DRAFT_AUDIT_AUCTION_BUDGET,
      secondsPerPick: 3_600,
      scoringLabel: "x".repeat(64),
      scoringRules: 512,
      keeperCount: MAX_DRAFT_AUDIT_ROSTER_SIZE,
      lineupSlotCounts: boundedMap,
      positionLimits: boundedMap,
    },
    safety: { ...snapshot().safety, actionState: "x".repeat(512) },
    draft: { ...snapshot().draft, totalPicks: MAX_DRAFT_AUDIT_LEAGUE_SIZE * MAX_DRAFT_AUDIT_ROSTER_SIZE },
    availability: {
      ...snapshot().availability,
      vetoedPlayerIds: Array.from({ length: MAX_DRAFT_AUDIT_AVAILABILITY_VETOES }, (_, index) => index + 1),
    },
    liveControl: undefined,
  });
  assert.equal(isDraftAuditSnapshot(maximum), true, "every documented maximum remains accepted");

  const baseline = snapshot({ liveControl: undefined });
  const overflowCases = [
    { ...baseline, league: { ...baseline.league, size: MAX_DRAFT_AUDIT_LEAGUE_SIZE + 1 } },
    { ...baseline, league: { ...baseline.league, rosterSize: MAX_DRAFT_AUDIT_ROSTER_SIZE + 1 } },
    { ...baseline, league: { ...baseline.league, auctionBudget: MAX_DRAFT_AUDIT_AUCTION_BUDGET + 1 } },
    { ...baseline, league: { ...baseline.league, lineupSlotCounts: { ...boundedMap, overflow: 1 } } },
    { ...baseline, safety: { ...baseline.safety, actionState: "x".repeat(513) } },
    { ...baseline, draft: { ...baseline.draft, appRoster: Array.from({ length: baseline.league.rosterSize + 1 }, (_, index) => ({ playerId: index + 1, playerName: `Player ${index}`, position: "WR", amount: 1 })) } },
    { ...baseline, availability: { ...baseline.availability, vetoedPlayerIds: Array.from({ length: MAX_DRAFT_AUDIT_AVAILABILITY_VETOES + 1 }, (_, index) => index + 1) } },
  ];
  overflowCases.forEach((candidate, index) => assert.equal(isDraftAuditSnapshot(candidate), false, `overflow ${index + 1}`));
});

test("audit POST accepts 512 KiB exactly and rejects one extra byte without mutating the ledger", async () => {
  const league = { ...snapshot().league, id: "audit-body-boundary" };
  const initial = snapshot({ capturedAt: testCapturedAt(300), league, liveControl: undefined });
  const makeBody = (audit, bytes) => {
    const base = JSON.stringify({ operation: "AUDIT", audit, padding: "" });
    const paddingLength = bytes - Buffer.byteLength(base);
    assert.ok(paddingLength >= 0);
    const body = JSON.stringify({ operation: "AUDIT", audit, padding: "x".repeat(paddingLength) });
    assert.equal(Buffer.byteLength(body), bytes);
    return body;
  };
  const post = (body) => POST(new Request("http://localhost:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body,
  }));

  const accepted = await post(makeBody(initial, MAX_DRAFT_AUDIT_POST_BYTES));
  assert.equal(accepted.status, 200);

  const replacement = snapshot({
    capturedAt: testCapturedAt(301),
    league,
    safety: { ...snapshot().safety, actionState: "must never be stored" },
    liveControl: undefined,
  });
  const rejected = await post(makeBody(replacement, MAX_DRAFT_AUDIT_POST_BYTES + 1));
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).code, "DRAFT_AUDIT_PAYLOAD_TOO_LARGE");

  const read = await GET(new Request("http://localhost:3000/api/draft-day?leagueId=audit-body-boundary&teamId=7"));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).snapshot.capturedAt, initial.capturedAt);
});

test("operator status is bounded, exact-shape, detached, and excludes private payload fields", () => {
  const operator = operatorSnapshot();
  const candidate = snapshot({ operator });
  assert.equal(isDraftAuditSnapshot(candidate), true);
  assert.deepEqual(sanitizeDraftOperatorSnapshot(operator), operator);

  const sanitized = sanitizeDraftOperatorSnapshot(operator);
  operator.room.currentBid = 99;
  assert.equal(sanitized.room.currentBid, 18);

  assert.equal(isDraftAuditSnapshot(snapshot({
    operator: { ...operatorSnapshot(), memberId: "private-member-id" },
  })), false);
  assert.equal(isDraftAuditSnapshot(snapshot({
    operator: {
      ...operatorSnapshot(),
      room: { ...operatorSnapshot().room, cookie: "espn_s2=secret" },
    },
  })), false);
  assert.equal(isDraftAuditSnapshot(snapshot({
    operator: {
      ...operatorSnapshot(),
      alternatives: Array.from({ length: MAX_DRAFT_OPERATOR_ALTERNATIVES + 1 }, (_, index) => ({
        player: { playerId: 500 + index, playerName: `Alternative ${index}`, position: "WR" },
        maxLegalBid: 10,
      })),
    },
  })), false);
  assert.equal(isDraftAuditSnapshot(snapshot({
    operator: {
      ...operatorSnapshot(),
      alternatives: [{ player: operatorSnapshot().recommendation.player, maxLegalBid: 22 }],
    },
  })), false);
});

test("league board is bounded, detached, exact-shape, and contains no opponent-private or command fields", () => {
  const board = leagueBoardSnapshot();
  const sanitized = sanitizeDraftLeagueBoardSnapshot(board);
  assert.deepEqual(sanitized, board);
  assert.ok(Buffer.byteLength(JSON.stringify(sanitized)) <= MAX_DRAFT_LEAGUE_BOARD_BYTES);
  board.recentPicks[0].player.playerName = "mutated after sanitization";
  assert.equal(sanitized.recentPicks[0].player.playerName, "Public Opponent Pick");

  const privateCases = [
    { ...leagueBoardSnapshot(), command: { operation: "SELECT" } },
    {
      ...leagueBoardSnapshot(),
      teams: [{ ...leagueBoardSnapshot().teams[0], memberId: "private-member" }],
    },
    {
      ...leagueBoardSnapshot(),
      recommendation: { ...leagueBoardSnapshot().recommendation, rawDom: "<button>Draft</button>" },
    },
    {
      ...leagueBoardSnapshot(),
      recentPicks: [{
        ...leagueBoardSnapshot().recentPicks[0],
        player: { ...leagueBoardSnapshot().recentPicks[0].player, cookie: "espn_s2=secret" },
      }],
    },
  ];
  privateCases.forEach((candidate, index) => {
    assert.equal(sanitizeDraftLeagueBoardSnapshot(candidate), null, `private field ${index + 1}`);
  });

  const relationalCases = [
    {
      label: "exactly one ours",
      candidate: {
        ...leagueBoardSnapshot(),
        teams: leagueBoardSnapshot().teams.map((team) => ({ ...team, ours: false })),
      },
    },
    {
      label: "contiguous ranks",
      candidate: {
        ...leagueBoardSnapshot(),
        teams: leagueBoardSnapshot().teams.map((team) => team.teamSlot === 2 ? { ...team, rank: 3 } : team),
      },
    },
    {
      label: "pick/team ours consistency",
      candidate: {
        ...leagueBoardSnapshot(),
        recentPicks: leagueBoardSnapshot().recentPicks.map((pick, index) => index === 0 ? { ...pick, ours: true } : pick),
      },
    },
    {
      label: "position sum",
      candidate: {
        ...leagueBoardSnapshot(),
        teams: leagueBoardSnapshot().teams.map((team) => team.teamSlot === 1 ? { ...team, playerCount: 2 } : team),
      },
    },
    {
      label: "sorted picks",
      candidate: {
        ...leagueBoardSnapshot(),
        recentPicks: [...leagueBoardSnapshot().recentPicks].reverse(),
      },
    },
    {
      label: "unique picks",
      candidate: {
        ...leagueBoardSnapshot(),
        recentPicks: leagueBoardSnapshot().recentPicks.map((pick, index) => index === 1
          ? { ...pick, overall: 11, player: { ...pick.player, playerId: 401 } }
          : pick),
      },
    },
    {
      label: "snake amount",
      candidate: {
        ...leagueBoardSnapshot(),
        recentPicks: leagueBoardSnapshot().recentPicks.map((pick, index) => index === 0 ? { ...pick, amount: 1 } : pick),
      },
    },
    {
      label: "auction budget arithmetic",
      candidate: {
        ...completeLeagueBoardSnapshot(),
        teams: completeLeagueBoardSnapshot().teams.map((team) => ({ ...team, remainingBudget: 23 })),
      },
    },
    {
      label: "auction amount",
      candidate: {
        ...completeLeagueBoardSnapshot(),
        ourRoster: completeLeagueBoardSnapshot().ourRoster.map((pick, index) => index === 0 ? { ...pick, amount: null } : pick),
      },
    },
  ];
  assert.deepEqual(sanitizeDraftLeagueBoardSnapshot(completeLeagueBoardSnapshot()), completeLeagueBoardSnapshot());
  relationalCases.forEach(({ label, candidate }) => {
    assert.equal(sanitizeDraftLeagueBoardSnapshot(candidate), null, label);
  });
  assert.equal(isDraftAuditSnapshot(snapshot({ leagueBoard: completeLeagueBoardSnapshot() })), true);
  assert.equal(isDraftAuditSnapshot(snapshot({
    leagueBoard: completeLeagueBoardSnapshot(),
    draft: { totalPicks: 167, appRoster: roster.slice(0, -1), espnRoster: roster.slice(0, -1) },
  })), false, "published board roster must exactly match the audit roster");

  assert.equal(sanitizeDraftLeagueBoardSnapshot({
    ...leagueBoardSnapshot(),
    recentPicks: Array.from({ length: MAX_DRAFT_LEAGUE_BOARD_RECENT_PICKS + 1 }, (_, index) => ({
      overall: index + 1,
      round: 1,
      teamSlot: 1,
      ours: false,
      player: { playerId: index + 1_000, playerName: `Player ${index}`, position: "WR" },
      amount: null,
    })),
  }), null);

  const wideName = "界".repeat(120);
  const oversized = {
    draftType: "SNAKE",
    auctionBudget: null,
    rankingBasis: "AVERAGE_PROJECTION",
    recentPicks: Array.from({ length: MAX_DRAFT_LEAGUE_BOARD_RECENT_PICKS }, (_, index) => ({
      overall: index + 1,
      round: 1,
      teamSlot: 1,
      ours: false,
      player: { playerId: index + 1_000, playerName: wideName, position: "WR", team: "NFL" },
      amount: null,
    })),
    ourRoster: Array.from({ length: 40 }, (_, index) => ({
      overall: index + MAX_DRAFT_LEAGUE_BOARD_RECENT_PICKS + 1,
      round: 2,
      teamSlot: 2,
      ours: true,
      player: { playerId: index + 2_000, playerName: wideName, position: "RB", team: "NFL" },
      amount: null,
    })),
    teams: [{
      teamSlot: 1,
      ours: false,
      rank: 2,
      playerCount: 24,
      projectedPoints: 5_000,
      averageProjectedPoints: 208.3,
      spent: null,
      remainingBudget: null,
      positionCounts: { WR: 24 },
    }, {
      teamSlot: 2,
      ours: true,
      rank: 1,
      playerCount: 40,
      projectedPoints: 8_000,
      averageProjectedPoints: 200,
      spent: null,
      remainingBudget: null,
      positionCounts: { RB: 40 },
    }],
    recommendation: {
      player: { playerId: 9_999, playerName: wideName, position: "WR", team: "NFL" },
      confidence: 90,
      reasons: Array.from({ length: 5 }, (_, index) => `${index}${"界".repeat(159)}`),
      sourceCount: 5,
      sourceSnapshotId,
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > MAX_DRAFT_LEAGUE_BOARD_BYTES);
  assert.equal(sanitizeDraftLeagueBoardSnapshot(oversized), null);
});

test("league board builder pseudonymizes opponents and publishes enough deterministic evidence to rank top three", () => {
  const teamIds = [901, 902, 903, 904];
  const league = {
    id: "board-builder",
    name: "Private league name",
    season: 2026,
    size: 4,
    teamId: 902,
    draftType: "SNAKE",
    secondsPerPick: 60,
    rosterSize: 8,
    auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1 },
    positionLimits: {},
    scoringLabel: "PPR",
    scoringRules: 20,
    keeperCount: 0,
    pickOrder: teamIds,
    teams: teamIds.map((id, index) => ({
      id,
      name: `Opponent Private Name ${index + 1}`,
      abbrev: `PRIVATE${index + 1}`,
      memberId: `member-${index + 1}`,
    })),
  };
  const positions = ["QB", "RB", "WR", "TE"];
  const picks = Array.from({ length: 28 }, (_, index) => ({
    playerId: 10_000 + index,
    teamId: teamIds[index % teamIds.length],
    overall: index + 1,
    round: Math.floor(index / teamIds.length) + 1,
    amount: 0,
  }));
  const playerById = new Map(picks.map((pick, index) => [pick.playerId, {
    id: pick.playerId,
    name: `Drafted Player ${index + 1}`,
    team: `N${index % 10}`,
    pos: positions[index % positions.length],
    rank: index + 1,
    adp: index + 1,
    auction: 1,
    projected: 400 - (index % teamIds.length) * 50,
  }]));
  playerById.set(20_000, {
    id: 20_000,
    name: "Current Recommendation",
    team: "REC",
    pos: "WR",
    rank: 1,
    adp: 1,
    auction: 50,
    projected: 320,
  });
  const board = buildDraftLeagueBoardSnapshot({
    league,
    picks,
    playerById,
    recommendation: {
      ...playerById.get(20_000),
      confidence: 88,
      reasons: ["Best value\nnow", "Five-source agreement"],
      sourceCount: 5,
    },
    sourceSnapshotId,
  });
  assert.ok(board);
  assert.equal(board.recentPicks.length, MAX_DRAFT_LEAGUE_BOARD_RECENT_PICKS);
  assert.equal(board.recentPicks[0].overall, 5);
  assert.equal(board.ourRoster.length, 7);
  assert.deepEqual(board.teams.map((team) => team.rank), [1, 2, 3, 4]);
  assert.deepEqual(board.teams.filter((team) => team.rank <= 3).map((team) => team.teamSlot), [1, 2, 3]);
  assert.deepEqual(board.recommendation, {
    player: { playerId: 20_000, playerName: "Current Recommendation", position: "WR", team: "REC" },
    confidence: 88,
    reasons: ["Best valuenow", "Five-source agreement"],
    sourceCount: 5,
    sourceSnapshotId,
  });
  const serialized = JSON.stringify(board);
  assert.doesNotMatch(serialized, /Opponent Private Name|PRIVATE|member-|teamId|command|cookie|rawDom/);
  assert.ok(Buffer.byteLength(serialized) <= MAX_DRAFT_LEAGUE_BOARD_BYTES);
});

test("salary-cap evidence accepts sanitized sale outcomes and rejects private or malformed data", () => {
  const sale = {
    sequence: 1,
    playerId: 99,
    position: "WR",
    closingPrice: 31,
    sourceAuction: 28.5,
    fairValue: 29.2,
    targetBid: 27,
    maxApprovedBid: 30,
    highestObservedBid: 31,
    nominationIntent: null,
    outcome: "BID_LOST",
    submittedBidCount: 2,
    highestSubmittedBid: 30,
  };
  assert.equal(isDraftAuditSnapshot(snapshot({ salaryCapEvidence: { sales: [sale] } })), true);
  assert.equal(isDraftAuditSnapshot(snapshot({ salaryCapEvidence: { sales: [{ ...sale, closingPrice: 0 }] } })), false);
  assert.equal(isDraftAuditSnapshot(snapshot({
    league: { ...snapshot().league, draftType: "SNAKE" },
    salaryCapEvidence: { sales: [sale] },
  })), false);
});

test("final salary-cap audit requires exact won-price evidence and never permits a vetoed roster player", () => {
  const missing = evaluateDraftAuditSnapshot(snapshot({ salaryCapEvidence: undefined }));
  assert.ok(missing.finalViolations.includes("SALARY_CAP_EVIDENCE_MISSING"));
  assert.equal(missing.finalReady, false);

  const mismatched = completeSalaryCapEvidence();
  mismatched.sales[0] = { ...mismatched.sales[0], closingPrice: 7, highestObservedBid: 8 };
  const mismatchedEvaluation = evaluateDraftAuditSnapshot(snapshot({ salaryCapEvidence: mismatched }));
  assert.ok(mismatchedEvaluation.finalViolations.includes("OWN_SALARY_CAP_PRICE_MISMATCH"));
  assert.equal(mismatchedEvaluation.finalReady, false);

  const vetoed = evaluateDraftAuditSnapshot(snapshot({
    availability: { ...snapshot().availability, vetoedPlayerIds: [roster[0].playerId] },
  }));
  assert.ok(vetoed.hardViolations.includes("AVAILABILITY_VETOED_ROSTER_PLAYER"));
  assert.equal(vetoed.finalReady, false);

  const telemetryViolation = evaluateDraftAuditSnapshot(snapshot({
    telemetry: {
      actions: [{
        ...snapshot().telemetry.actions[0],
        amount: 9,
        maxApprovedBid: 8,
      }],
    },
  }));
  assert.ok(telemetryViolation.finalViolations.includes("BID_CEILING_TELEMETRY_INCOMPLETE"));
  assert.equal(telemetryViolation.finalReady, false);
});

test("completed audit preserves prior checklist evidence only for the same exact room", () => {
  const exactRoom = draftAuditChecklistBindingKey("1743483683", 7, 2097429901);
  assert.equal(resolveDraftAuditChecklistReady({
    currentReady: false,
    rosterComplete: true,
    currentBindingKey: exactRoom,
    lastValidatedBindingKey: exactRoom,
  }), true);
  assert.equal(resolveDraftAuditChecklistReady({
    currentReady: false,
    rosterComplete: false,
    currentBindingKey: exactRoom,
    lastValidatedBindingKey: exactRoom,
  }), false);
  assert.equal(resolveDraftAuditChecklistReady({
    currentReady: false,
    rosterComplete: true,
    currentBindingKey: draftAuditChecklistBindingKey("1743483683", 7, 2097429902),
    lastValidatedBindingKey: exactRoom,
  }), false);
  assert.equal(resolveDraftAuditChecklistReady({
    currentReady: true,
    rosterComplete: false,
    currentBindingKey: exactRoom,
    lastValidatedBindingKey: "",
  }), true);
});

test("audit rejects duplicate specialists, position caps, and reserve violations", () => {
  const unsafeRoster = [
    ...roster.slice(0, 3),
    { playerId: 13, playerName: "Defense One", position: "DST", amount: 80 },
    { playerId: 15, playerName: "Defense Two", position: "DST", amount: 80 },
  ];
  const candidate = snapshot({
    draft: { totalPicks: 50, appRoster: unsafeRoster, espnRoster: unsafeRoster },
  });
  const evaluation = evaluateDraftAuditSnapshot(candidate);
  assert.equal(evaluation.complete, false);
  assert.ok(evaluation.hardViolations.includes("UNNECESSARY_SECOND_DST"));
  assert.ok(evaluation.hardViolations.includes("POSITION_CAP_DST"));
  assert.ok(evaluation.hardViolations.includes("ONE_DOLLAR_RESERVE_VIOLATION"));
});

test("audit requires the exact live extension room at final verification", () => {
  const candidate = snapshot({
    safety: { ...snapshot().safety, extensionConnected: false, inDraftRoom: false },
  });
  const evaluation = evaluateDraftAuditSnapshot(candidate);
  assert.ok(evaluation.hardViolations.includes("EXTENSION_NOT_CONNECTED"));
  assert.ok(evaluation.hardViolations.includes("NOT_IN_DRAFT_ROOM"));
  assert.equal(evaluation.finalReady, false);
});

test("audit requires exact roster-and-price parity and automatic shutdown", () => {
  const espnRoster = roster.map((entry) => entry.playerId === 6 ? { ...entry, amount: entry.amount + 1 } : entry);
  const candidate = snapshot({
    safety: { ...snapshot().safety, autoDraft: true },
    draft: { totalPicks: 168, appRoster: roster, espnRoster },
  });
  const evaluation = evaluateDraftAuditSnapshot(candidate);
  assert.equal(evaluation.parity, false);
  assert.ok(evaluation.finalViolations.includes("ESPN_APP_ROSTER_MISMATCH"));
  assert.ok(evaluation.finalViolations.includes("AUTO_DRAFT_NOT_SHUT_DOWN"));
  assert.equal(evaluation.finalReady, false);
});

test("audit rejects a complete roster that cannot fill every ESPN starter slot", () => {
  const noQuarterbacks = roster.map((entry) => entry.position === "QB" ? { ...entry, position: "WR" } : entry);
  const candidate = snapshot({
    league: { ...snapshot().league, positionLimits: { ...snapshot().league.positionLimits, "3": 10 } },
    draft: { totalPicks: 168, appRoster: noQuarterbacks, espnRoster: noQuarterbacks },
  });
  const evaluation = evaluateDraftAuditSnapshot(candidate);
  assert.ok(evaluation.finalViolations.includes("MANDATORY_STARTER_MISSING"));
  assert.equal(evaluation.finalReady, false);
});

test("loopback dashboard can record an audit that terminal reads back", async () => {
  const candidate = snapshot({ capturedAt: testCapturedAt(1) });
  const recorded = await POST(new Request("http://localhost:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: candidate }),
  }));
  assert.equal(recorded.status, 200);
  assert.equal((await recorded.json()).evaluation.finalReady, true);

  const read = await GET(new Request("http://localhost:3000/api/draft-day?leagueId=audit-verified-1&teamId=7"));
  assert.equal(read.status, 200);
  const result = await read.json();
  assert.equal(result.snapshot.league.id, "audit-verified-1");
  assert.equal(result.evaluation.finalReady, true);
});

test("newest command center owns audit publishing for an ESPN room", async () => {
  const league = { ...snapshot().league, id: "audit-publisher-ownership" };
  const older = snapshot({
    capturedAt: testCapturedAt(10),
    league,
    binding: {
      tabId: 4321,
      commandCenterSessionId: "older-command-center",
      commandCenterStartedAt: "2026-08-17T20:00:00.000Z",
      authenticatedImportAt: testCapturedAt(),
    },
    liveControl: cleanLiveControl("older-clean-control"),
  });
  const newer = snapshot({
    capturedAt: testCapturedAt(70),
    league,
    binding: {
      tabId: 4321,
      commandCenterSessionId: "newer-command-center",
      commandCenterStartedAt: "2026-08-17T20:01:00.000Z",
      authenticatedImportAt: testCapturedAt(),
    },
    liveControl: cleanLiveControl("newer-clean-control"),
  });
  const post = (audit) => POST(new Request("http://localhost:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit }),
  }));

  assert.equal((await post(older)).status, 200);
  assert.equal((await post(newer)).status, 200);

  const staleLegacy = { ...snapshot({ capturedAt: testCapturedAt(120), league }), binding: { tabId: 4321, authenticatedImportAt: testCapturedAt() } };
  const staleLegacyResponse = await post(staleLegacy);
  assert.equal(staleLegacyResponse.status, 409);
  assert.equal((await staleLegacyResponse.json()).code, "DRAFT_AUDIT_STALE_PUBLISHER");

  const staleOlderResponse = await post({ ...older, capturedAt: testCapturedAt(180) });
  assert.equal(staleOlderResponse.status, 409);
  assert.equal((await staleOlderResponse.json()).code, "DRAFT_AUDIT_STALE_PUBLISHER");

  const currentUpdate = {
    ...newer,
    capturedAt: testCapturedAt(240),
    safety: { ...newer.safety, actionState: "Current command center still owns this room." },
  };
  assert.equal((await post(currentUpdate)).status, 200);

  const read = await GET(new Request("http://localhost:3000/api/draft-day?leagueId=audit-publisher-ownership&teamId=7"));
  const result = await read.json();
  assert.equal(result.snapshot.binding.commandCenterSessionId, "newer-command-center");
  assert.equal(result.snapshot.safety.actionState, "Current command center still owns this room.");
});

test("a newer stored snapshot rejects an older exact BID publication and authorizes zero clicks", async () => {
  const league = { ...snapshot().league, id: "audit-stale-exact-bid" };
  const commandCenterSessionId = "stale-bid-command-center";
  const liveControlSessionId = "stale-bid-live-control";
  const binding = {
    tabId: 4321,
    commandCenterSessionId,
    commandCenterStartedAt: "2026-08-17T20:00:00.000Z",
    authenticatedImportAt: testCapturedAt(),
  };
  const current = snapshot({
    capturedAt: testCapturedAt(30),
    league,
    binding,
    liveControl: cleanLiveControl(liveControlSessionId),
  });
  const recordedCurrent = await POST(new Request("http://localhost:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: current }),
  }));
  assert.equal(recordedCurrent.status, 200);

  const olderBidEventControl = appendLiveControlEvent(cleanLiveControl(liveControlSessionId), {
    occurredAt: testCapturedAt(10),
    kind: "ACTION_LIFECYCLE",
    actionId: "action-stale-bid",
    decisionId: "decision-stale-bid",
    operation: "BID",
    phase: "PLANNED",
    intendedPlayer: { playerId: 301, playerName: "Stale Bid Receiver", position: "WR" },
    intendedOffer: 19,
  });
  const olderBidControl = {
    ...olderBidEventControl,
    decision: {
      decisionId: "decision-stale-bid",
      decidedAt: testCapturedAt(10),
      contextCapturedAt: testCapturedAt(10),
      leagueId: league.id,
      teamId: league.teamId,
      tabId: binding.tabId,
      operation: "BID",
      sourceSnapshotId,
      intendedPlayer: { playerId: 301, playerName: "Stale Bid Receiver", position: "WR" },
      expectedCurrentBid: 18,
      intendedOffer: 19,
      maxApprovedBid: 22,
      alternatives: [],
    },
  };
  const olderBid = snapshot({
    capturedAt: testCapturedAt(20),
    league,
    binding,
    liveControl: olderBidControl,
  });
  const exactBinding = {
    commandCenterSessionId,
    liveControlSessionId,
    leagueId: league.id,
    teamId: league.teamId,
    tabId: binding.tabId,
  };
  const publisher = createDraftAuditPublisher({
    retryDelaysMs: [],
    post: async (candidate, signal) => {
      const result = await POST(new Request("http://localhost:3000/api/draft-day", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ operation: "AUDIT", audit: candidate.snapshot }),
        signal,
      }));
      const payload = await result.json();
      return {
        ok: result.ok,
        status: result.status,
        code: payload.code,
        recordedPublication: payload.recordedPublication ?? null,
      };
    },
  });
  publisher.bind(exactBinding);
  publisher.enqueue({
    digest: draftAuditPublicationDigest(olderBid),
    capturedAt: olderBid.capturedAt,
    snapshot: olderBid,
    binding: exactBinding,
    decisionId: olderBidControl.decision.decisionId,
  });

  let submitActions = 0;
  const authorized = await publisher.waitUntilAuthorized(exactBinding, "decision-stale-bid", 200);
  if (authorized) submitActions += 1;
  await publisher.flush();
  assert.equal(authorized, false);
  assert.equal(submitActions, 0);
  assert.equal(publisher.isAuthorized(exactBinding, "decision-stale-bid"), false);

  const staleResponse = await POST(new Request("http://localhost:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: olderBid }),
  }));
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, "DRAFT_AUDIT_STALE_SNAPSHOT");
});

test("newer publisher cannot erase irreversible live-control history", async () => {
  const actionControl = appendLiveControlEvent(cleanLiveControl("action-control"), {
    occurredAt: testCapturedAt(),
    kind: "ACTION_LIFECYCLE",
    actionId: "action-1",
    decisionId: "decision-1",
    operation: "BID",
    phase: "PLANNED",
    intendedPlayer: { playerId: 99, playerName: "Action Player", position: "WR" },
    intendedOffer: 17,
  });
  const stickyControl = appendLiveControlEvent(cleanLiveControl("sticky-control"), {
    occurredAt: testCapturedAt(),
    kind: "SAFETY",
    condition: "ESPN_AUTOPICK",
    active: true,
    code: "ESPN_AUTOPICK_DETECTED",
  });
  const cases = [
    ["action", actionControl],
    ["attribution", attributedLiveControl(roster.slice(0, 1))],
    ["sticky", stickyControl],
  ];
  for (const [label, liveControl] of cases) {
    const league = { ...snapshot().league, id: `audit-publisher-history-${label}` };
    const oldAudit = snapshot({
      capturedAt: testCapturedAt(10),
      league,
      binding: {
        tabId: 4321,
        commandCenterSessionId: `old-publisher-${label}`,
        commandCenterStartedAt: "2026-08-17T20:00:00.000Z",
        authenticatedImportAt: testCapturedAt(),
      },
      liveControl,
    });
    const replacement = snapshot({
      capturedAt: testCapturedAt(20),
      league,
      binding: {
        tabId: 4321,
        commandCenterSessionId: `new-publisher-${label}`,
        commandCenterStartedAt: "2026-08-17T20:01:00.000Z",
        authenticatedImportAt: testCapturedAt(),
      },
      liveControl: cleanLiveControl(`replacement-control-${label}`),
    });
    const post = (audit) => POST(new Request("http://localhost:3000/api/draft-day", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ operation: "AUDIT", audit }),
    }));

    assert.equal((await post(oldAudit)).status, 200, label);
    const rejected = await post(replacement);
    assert.equal(rejected.status, 409, label);
    assert.equal((await rejected.json()).code, "DRAFT_AUDIT_CONTROL_SESSION_REPLACEMENT", label);
  }
});

test("non-loopback pages cannot write or read the local certification ledger", async () => {
  const deniedWrite = await POST(new Request("http://localhost:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ operation: "AUDIT", audit: snapshot() }),
  }));
  assert.equal(deniedWrite.status, 403);

  const deniedRead = await GET(new Request("http://localhost:3000/api/draft-day", {
    headers: { origin: "https://fantasy.espn.com" },
  }));
  assert.equal(deniedRead.status, 403);

  const deniedLanRead = await GET(new Request("http://192.168.1.25:3000/api/draft-day"));
  assert.equal(deniedLanRead.status, 403);

  const deniedLanWrite = await POST(new Request("http://192.168.1.25:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: snapshot() }),
  }));
  assert.equal(deniedLanWrite.status, 403);
});

test("loopback compact control polling is sanitized, incremental, and rejects ledger regression", async () => {
  const league = { ...snapshot().league, id: "audit-live-control-view" };
  const binding = {
    tabId: 4321,
    commandCenterSessionId: "control-view-publisher",
    commandCenterStartedAt: testCapturedAt(),
    authenticatedImportAt: testCapturedAt(),
  };
  const audit = snapshot({
    capturedAt: testCapturedAt(10),
    league,
    binding,
    operator: operatorSnapshot(),
    leagueBoard: completeLeagueBoardSnapshot(),
    liveControl: attributedLiveControl(),
  });
  const post = (candidate) => POST(new Request("http://127.0.0.1:3000/api/draft-day", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: candidate }),
  }));
  assert.equal((await post(audit)).status, 200);

  const read = await GET(new Request("http://127.0.0.1:3000/api/draft-day?leagueId=audit-live-control-view&teamId=7&view=control&since=13"));
  assert.equal(read.status, 200);
  const result = await read.json();
  assert.equal(result.code, "DRAFT_LIVE_CONTROL_READY");
  assert.equal(result.control.sequence, 14);
  assert.deepEqual(result.control.events.map((event) => event.sequence), [14]);
  assert.equal(Object.hasOwn(result, "snapshot"), false);
  assert.equal(Object.hasOwn(result, "leagueBoard"), false, "1 Hz control polling shape stays unchanged");
  assert.deepEqual(Object.keys(result.league).sort(), ["draftType", "id", "teamId"]);
  assert.deepEqual(result.operator, operatorSnapshot());

  const regression = snapshot({
    capturedAt: testCapturedAt(20),
    league,
    binding,
    liveControl: attributedLiveControl(roster.slice(0, -1)),
  });
  const rejected = await post(regression);
  assert.equal(rejected.status, 409);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.code, "DRAFT_AUDIT_CONTROL_REGRESSION");
  assert.equal(rejectedBody.controlCode, "LIVE_CONTROL_SEQUENCE_REGRESSION");

  const invalidSince = await GET(new Request("http://127.0.0.1:3000/api/draft-day?leagueId=audit-live-control-view&teamId=7&view=control&since=-1"));
  assert.equal(invalidSince.status, 400);

  const ambiguous = await GET(new Request("http://127.0.0.1:3000/api/draft-day?view=control"));
  assert.equal(ambiguous.status, 400);
  assert.equal((await ambiguous.json()).code, "LIVE_CONTROL_IDENTITY_REQUIRED");
});

test("exact-identity league-board GET is read-only and cannot perturb control, audit, writer, or Chrome state", async () => {
  const league = { ...snapshot().league, id: "audit-league-board-view" };
  const binding = {
    tabId: 4567,
    commandCenterSessionId: "league-board-publisher",
    commandCenterStartedAt: testCapturedAt(),
    authenticatedImportAt: testCapturedAt(),
  };
  const audit = snapshot({
    capturedAt: testCapturedAt(10),
    league,
    binding,
    operator: operatorSnapshot(),
    leagueBoard: completeLeagueBoardSnapshot(),
    liveControl: attributedLiveControl(),
  });
  const post = (candidate, suffix = "") => POST(new Request(`http://127.0.0.1:3000/api/draft-day${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: candidate }),
  }));
  assert.equal((await post(audit)).status, 200);
  const originalDigest = draftAuditPublicationDigest(audit);
  const controlUrl = "http://127.0.0.1:3000/api/draft-day?leagueId=audit-league-board-view&teamId=7&view=control&since=0";
  const boardUrl = "http://127.0.0.1:3000/api/draft-day?leagueId=audit-league-board-view&teamId=7&view=board";
  const beforeControl = await (await GET(new Request(controlUrl))).json();

  const priorChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let chromeTouches = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: new Proxy({}, {
      get() {
        chromeTouches += 1;
        throw new Error("READ_ONLY_BOARD_TOUCHED_CHROME");
      },
    }),
  });
  try {
    for (let index = 0; index < 25; index += 1) {
      const read = await GET(new Request(boardUrl));
      assert.equal(read.status, 200);
      const raw = await read.text();
      assert.ok(Buffer.byteLength(raw) <= MAX_DRAFT_BOARD_GET_BYTES);
      const result = JSON.parse(raw);
      assert.deepEqual(Object.keys(result).sort(), ["capturedAt", "code", "league", "leagueBoard", "ok"]);
      assert.equal(result.code, "DRAFT_LEAGUE_BOARD_READY");
      assert.deepEqual(result.leagueBoard, completeLeagueBoardSnapshot());
      assert.doesNotMatch(raw, /memberId|cookie|rawDom|command|tabId|operation/);
    }
  } finally {
    if (priorChrome) Object.defineProperty(globalThis, "chrome", priorChrome);
    else delete globalThis.chrome;
  }
  assert.equal(chromeTouches, 0);

  const afterControl = await (await GET(new Request(controlUrl))).json();
  assert.equal(afterControl.control.sequence, beforeControl.control.sequence);
  assert.equal(afterControl.control.pendingActionCount, beforeControl.control.pendingActionCount);
  assert.deepEqual(afterControl.control.events, beforeControl.control.events);
  const fullRead = await (await GET(new Request("http://127.0.0.1:3000/api/draft-day?leagueId=audit-league-board-view&teamId=7"))).json();
  assert.equal(draftAuditPublicationDigest(fullRead.snapshot), originalDigest);

  const nextAudit = {
    ...audit,
    capturedAt: testCapturedAt(20),
    safety: { ...audit.safety, actionState: "Writer lane remains independently writable." },
  };
  const nextWrite = await post(nextAudit);
  assert.equal(nextWrite.status, 200);
  assert.equal((await nextWrite.json()).recordedPublication.digest, draftAuditPublicationDigest(nextAudit));

  const postReadAttempt = await post(audit, "?view=board");
  assert.equal(postReadAttempt.status, 405);
  assert.equal((await postReadAttempt.json()).code, "DRAFT_LEAGUE_BOARD_READ_ONLY");
  const ambiguousBoard = await GET(new Request("http://127.0.0.1:3000/api/draft-day?view=board"));
  assert.equal(ambiguousBoard.status, 400);
  assert.equal((await ambiguousBoard.json()).code, "DRAFT_LEAGUE_BOARD_IDENTITY_REQUIRED");
  const unknownView = await GET(new Request("http://127.0.0.1:3000/api/draft-day?leagueId=audit-league-board-view&teamId=7&view=commands"));
  assert.equal(unknownView.status, 400);
  assert.equal((await unknownView.json()).code, "DRAFT_DAY_VIEW_INVALID");
});

test("atomic status GET excludes a full control ledger and cannot straddle a writer publication", async () => {
  const league = { ...snapshot().league, id: "audit-atomic-status-view" };
  const binding = {
    tabId: 5678,
    commandCenterSessionId: "atomic-status-publisher",
    commandCenterStartedAt: testCapturedAt(),
    authenticatedImportAt: testCapturedAt(),
  };
  let fullControl = attributedLiveControl();
  for (let index = 0; index < MAX_LIVE_CONTROL_EVENTS; index += 1) {
    fullControl = appendLiveControlEvent(fullControl, {
      occurredAt: testCapturedAt(100 + index),
      kind: "SAFETY",
      condition: "CLOCK",
      active: false,
      code: "CLOCK_VERIFIED",
    });
  }
  assert.equal(fullControl.events.length, MAX_LIVE_CONTROL_EVENTS);

  const firstAudit = snapshot({
    capturedAt: testCapturedAt(10),
    league,
    binding,
    operator: operatorSnapshot(),
    leagueBoard: completeLeagueBoardSnapshot(),
    liveControl: fullControl,
  });
  const post = (candidate, suffix = "") => POST(new Request(`http://127.0.0.1:3000/api/draft-day${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ operation: "AUDIT", audit: candidate }),
  }));
  assert.equal((await post(firstAudit)).status, 200);

  const statusUrl = "http://127.0.0.1:3000/api/draft-day?leagueId=audit-atomic-status-view&teamId=7&view=status";
  const priorChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let chromeTouches = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: new Proxy({}, {
      get() {
        chromeTouches += 1;
        throw new Error("READ_ONLY_STATUS_TOUCHED_CHROME");
      },
    }),
  });
  let firstRead;
  try {
    firstRead = await GET(new Request(statusUrl));
  } finally {
    if (priorChrome) Object.defineProperty(globalThis, "chrome", priorChrome);
    else delete globalThis.chrome;
  }
  assert.equal(chromeTouches, 0);

  const secondOperator = operatorSnapshot();
  secondOperator.room.pick = 38;
  const secondBoard = completeLeagueBoardSnapshot();
  secondBoard.recommendation.confidence = 85;
  const secondAudit = {
    ...firstAudit,
    capturedAt: testCapturedAt(20),
    operator: secondOperator,
    leagueBoard: secondBoard,
  };
  assert.equal((await post(secondAudit)).status, 200, "the writer remains independent of the observer read");

  const firstRaw = await firstRead.text();
  assert.ok(Buffer.byteLength(firstRaw) <= MAX_DRAFT_STATUS_GET_BYTES);
  assert.doesNotMatch(firstRaw, /CLOCK_VERIFIED|"events"|rosterAttributions|sessionId|decisionId|tabId/);
  const firstStatus = JSON.parse(firstRaw);
  assert.equal(firstStatus.code, "DRAFT_DAY_STATUS_SNAPSHOT_READY");
  assert.equal(firstStatus.capturedAt, firstAudit.capturedAt);
  assert.equal(firstStatus.operator.room.pick, 37);
  assert.equal(firstStatus.leagueBoard.recommendation.confidence, 84);
  assert.deepEqual(Object.keys(firstStatus.control).sort(), [
    "decisionActive",
    "historicalAutopickDetected",
    "pendingActionCount",
    "schemaVersion",
    "sequence",
    "unattributedRosterCount",
    "uncontrolledRosterAdditionDetected",
  ]);

  const secondStatus = await (await GET(new Request(statusUrl))).json();
  assert.equal(secondStatus.capturedAt, secondAudit.capturedAt);
  assert.equal(secondStatus.operator.room.pick, 38);
  assert.equal(secondStatus.leagueBoard.recommendation.confidence, 85);

  const postReadAttempt = await post(secondAudit, "?view=status");
  assert.equal(postReadAttempt.status, 405);
  assert.equal((await postReadAttempt.json()).code, "DRAFT_DAY_STATUS_READ_ONLY");
  const ambiguous = await GET(new Request("http://127.0.0.1:3000/api/draft-day?view=status"));
  assert.equal(ambiguous.status, 400);
  assert.equal((await ambiguous.json()).code, "DRAFT_DAY_STATUS_IDENTITY_REQUIRED");
});
