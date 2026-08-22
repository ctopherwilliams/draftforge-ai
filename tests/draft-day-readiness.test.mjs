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
    },
    runtime: {
      capturedAt: "2026-08-18T12:00:00.000Z",
      extensionVersion: "0.2.12",
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

test("live gate detects extension, source, tab, sound, autopick, and markup recovery failures", () => {
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
  for (const blocker of ["exactTabBound", "extensionConnected", "fiveSources", "espnAutopickOff", "actionHealthy", "liveChecklistReady", "inDraftRoom", "soundMuted"]) {
    assert.ok(result.blockers.includes(blocker), blocker);
  }
});

test("readiness rejects a companion without managed workspace cleanup", () => {
  const unmanaged = audit({ runtime: { ...audit().runtime, managedCleanupReady: false } });
  const result = evaluateDraftDayReadiness({ snapshot: unmanaged, expected, now: Date.parse("2026-08-18T12:00:05.000Z") });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("managedWorkspaceCleanup"));
});

test("live and complete phases cannot be confused", () => {
  const live = audit({ safety: { ...audit().safety, liveChecklistReady: true, inDraftRoom: true, soundMuted: true } });
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
});
