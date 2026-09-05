import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateDraftDayReadiness } from "../app/lib/draft-day-readiness.ts";

const config = JSON.parse(await readFile(new URL("../config/authenticated-espn-leagues.json", import.meta.url), "utf8"));
const expected = config.profiles["salary-cap"];

function audit(overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAt: "2026-08-18T12:00:00.000Z",
    league: structuredClone(expected),
    binding: {
      tabId: 1234,
      commandCenterSessionId: "command-center-ready",
      commandCenterStartedAt: "2026-08-18T11:59:00.000Z",
      authenticatedImportAt: "2026-08-18T11:59:30.000Z",
      authenticatedPlayerPool: {
        schemaVersion: 1,
        requestedCount: 500,
        playerCount: 500,
        uniquePlayerCount: 500,
        fetchedAt: "2026-08-18T11:59:30.000Z",
        leagueId: expected.id,
        teamId: expected.teamId,
        season: expected.season,
      },
    },
    runtime: {
      capturedAt: "2026-08-18T12:00:00.000Z",
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
      liveChecklistReady: false,
      extensionConnected: true,
      inDraftRoom: false,
      soundMuted: false,
      autopickActive: false,
      autoDraft: false,
      sourceCoverage: 5,
      sourceIds: ["espn", "ffc", "mfl", "tradyr", "gng"],
      actionState: "Pre-draft checks confirmed.",
    },
    draft: { totalPicks: 0, appRoster: [], espnRoster: [] },
    telemetry: { actions: [] },
    sleeperEvidence: { candidateCount: 0, candidates: [] },
    availability: {
      status: "READY",
      digest: `sha256:${"a".repeat(64)}`,
      evaluatedAt: "2026-08-18T12:00:00.000Z",
      freshUntil: "2026-08-18T12:30:00.000Z",
      blockingReasons: [],
      vetoedPlayerIds: [],
    },
    ...overrides,
  };
}

test("authenticated pre-room gate requires exact fresh settings and stays fail-closed", () => {
  const ready = evaluateDraftDayReadiness({ snapshot: audit(), expected, now: Date.parse("2026-08-18T12:00:05.000Z") });
  assert.equal(ready.ready, true);

  const wrongTimer = audit({ league: { ...expected, secondsPerPick: 30 } });
  assert.deepEqual(evaluateDraftDayReadiness({ snapshot: wrongTimer, expected, now: Date.parse("2026-08-18T12:00:05.000Z") }).blockers, ["exactTimer"]);

  const stale = evaluateDraftDayReadiness({ snapshot: audit(), expected, now: Date.parse("2026-08-18T12:00:30.000Z") });
  assert.equal(stale.ready, false);
  assert.ok(stale.blockers.includes("snapshotFresh"));
});

test("readiness requires the exact carried 500-player authenticated ESPN pool proof", () => {
  for (const playerCount of [1, expected.size * expected.rosterSize, 499]) {
    const baseline = audit();
    const candidate = audit({
      binding: {
        ...baseline.binding,
        authenticatedPlayerPool: {
          ...baseline.binding.authenticatedPlayerPool,
          playerCount,
          uniquePlayerCount: playerCount,
        },
      },
    });
    const result = evaluateDraftDayReadiness({ snapshot: candidate, expected, now: Date.parse("2026-08-18T12:00:05.000Z") });
    assert.equal(result.ready, false, `${playerCount} players cannot pass readiness`);
    assert.ok(result.blockers.includes("exactAuthenticatedEspnPlayerPool"));
  }
});

test("live gate detects extension, source, tab, autopick, and markup recovery failures", () => {
  const unsafe = audit({
    binding: { tabId: 0 },
    safety: {
      ...audit().safety,
      liveChecklistReady: false,
      extensionConnected: false,
      inDraftRoom: false,
      soundMuted: false,
      autopickActive: true,
      sourceCoverage: 4,
      actionState: "Action stopped: player controls drifted.",
    },
  });
  const result = evaluateDraftDayReadiness({ snapshot: unsafe, expected, phase: "live", now: Date.parse("2026-08-18T12:00:05.000Z") });
  assert.equal(result.ready, false);
  for (const blocker of ["exactTabBound", "extensionConnected", "fiveSources", "espnAutopickOff", "actionHealthy", "liveChecklistReady", "inDraftRoom"]) {
    assert.ok(result.blockers.includes(blocker), blocker);
  }
  assert.equal(result.blockers.includes("soundMuted"), false);
});

test("readiness requires exactly one DraftForge tab and one ESPN tab under managed cleanup", () => {
  const unmanaged = audit({ runtime: { ...audit().runtime, managedCleanupReady: false } });
  const result = evaluateDraftDayReadiness({ snapshot: unmanaged, expected, now: Date.parse("2026-08-18T12:00:05.000Z") });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("managedWorkspaceCleanup"));
  for (const runtime of [
    { ...audit().runtime, browserTabCount: 3 },
    { ...audit().runtime, draftForgeTabCount: 2 },
    { ...audit().runtime, espnTabCount: 2 },
  ]) {
    const duplicate = evaluateDraftDayReadiness({ snapshot: audit({ runtime }), expected, now: Date.parse("2026-08-18T12:00:05.000Z") });
    assert.equal(duplicate.ready, false);
    assert.ok(duplicate.blockers.includes("managedWorkspaceCleanup"));
  }
});

test("pre-room and live readiness reject missing, blocked, malformed, or stale availability truth", () => {
  const now = Date.parse("2026-08-18T12:00:05.000Z");
  for (const candidate of [
    audit({ availability: undefined }),
    audit({ availability: { ...audit().availability, status: "BLOCKED", blockingReasons: ["NEWS_SCAN_FAILED"] } }),
    audit({ availability: { ...audit().availability, digest: "invalid" } }),
    audit({ availability: { ...audit().availability, freshUntil: "2026-08-18T12:00:04.000Z" } }),
    audit({ availability: { ...audit().availability, vetoedPlayerIds: [12, 12] } }),
  ]) {
    const preRoom = evaluateDraftDayReadiness({ snapshot: candidate, expected, now });
    assert.equal(preRoom.ready, false);
    assert.ok(preRoom.blockers.includes("availabilityReady"));
  }

  const live = audit({
    safety: { ...audit().safety, liveChecklistReady: true, inDraftRoom: true, soundMuted: true },
    availability: { ...audit().availability, freshUntil: "2026-08-18T12:00:04.000Z" },
  });
  const liveResult = evaluateDraftDayReadiness({ snapshot: live, expected, phase: "live", now });
  assert.equal(liveResult.ready, false);
  assert.ok(liveResult.blockers.includes("availabilityReady"));
});

test("live and complete phases cannot be confused", () => {
  const live = audit({ safety: { ...audit().safety, liveChecklistReady: true, inDraftRoom: true, soundMuted: false } });
  assert.equal(evaluateDraftDayReadiness({ snapshot: live, expected, phase: "live", now: Date.parse("2026-08-18T12:00:05.000Z") }).ready, true);
  const complete = evaluateDraftDayReadiness({ snapshot: live, expected, phase: "complete", now: Date.parse("2026-08-18T12:00:05.000Z") });
  assert.equal(complete.ready, false);
  assert.ok(complete.blockers.includes("completeAudit"));
});

test("readiness config tracks both authenticated ESPN formats", () => {
  assert.deepEqual(Object.keys(config.profiles).sort(), ["salary-cap", "snake"]);
  assert.equal(config.profiles.snake.draftType, "SNAKE");
  assert.equal(config.profiles.snake.secondsPerPick, 60);
  assert.equal(config.profiles.snake.scoringLabel, "PPR");
  assert.equal(config.profiles.snake.scoringRules, 29);
  assert.equal(config.profiles["salary-cap"].draftType, "AUCTION");
  assert.equal(config.profiles["salary-cap"].keeperCount, 2);
  assert.equal(config.profiles["salary-cap"].event.draftAt, "2026-09-08T20:00:00-05:00");
  assert.deepEqual(config.profiles["salary-cap"].event.selectedKeepers, [
    { espnPlayerId: 3916148, name: "Tony Pollard", position: "RB", amount: 0 },
    { espnPlayerId: 3121422, name: "Terry McLaurin", position: "WR", amount: 1 },
  ]);
  assert.equal(config.profiles["salary-cap"].event.keeperSpend, 1);
  assert.equal(config.profiles["salary-cap"].event.remainingBudget, 199);
  assert.equal(config.profiles["salary-cap"].event.remainingRosterSlots, 12);
});
