import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/draft-day/route.ts";
import {
  draftAuditChecklistBindingKey,
  evaluateDraftAuditSnapshot,
  isDraftAuditSnapshot,
  MAX_DRAFT_ACTION_TELEMETRY_EVENTS,
  resolveDraftAuditChecklistReady,
} from "../app/lib/draft-audit.ts";

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
      browserTabCount: 2,
      draftForgeTabCount: 1,
      espnTabCount: 1,
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
        roundTripMs: 84,
        clockSeconds: 31,
        automatic: false,
      }],
    },
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
    ...overrides,
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

test("action telemetry retains a bounded full-draft latency sample", () => {
  const event = snapshot().telemetry.actions[0];
  assert.equal(isDraftAuditSnapshot(snapshot({ telemetry: { actions: Array.from({ length: MAX_DRAFT_ACTION_TELEMETRY_EVENTS }, () => ({ ...event })) } })), true);
  assert.equal(isDraftAuditSnapshot(snapshot({ telemetry: { actions: Array.from({ length: MAX_DRAFT_ACTION_TELEMETRY_EVENTS + 1 }, () => ({ ...event })) } })), false);
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
