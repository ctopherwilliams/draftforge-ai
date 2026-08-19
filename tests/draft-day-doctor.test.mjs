import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateDraftDayDoctor, resolveDraftDayDoctorLeague } from "../app/lib/draft-day-doctor.ts";

const leagues = JSON.parse(await readFile(new URL("../config/authenticated-espn-leagues.json", import.meta.url), "utf8"));
const release = JSON.parse(await readFile(new URL("../config/draft-day-release.json", import.meta.url), "utf8"));
const expected = leagues.profiles["salary-cap"];
const now = Date.parse("2026-08-19T12:00:05.000Z");

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAt: "2026-08-19T12:00:04.000Z",
    league: structuredClone(expected),
    binding: {
      tabId: 1234,
      commandCenterSessionId: "command-center-doctor",
      commandCenterStartedAt: "2026-08-19T11:59:00.000Z",
      authenticatedImportAt: "2026-08-19T12:00:00.000Z",
    },
    runtime: {
      capturedAt: "2026-08-19T12:00:04.000Z",
      extensionVersion: release.extensionVersion,
      browserTabCount: 2,
      draftForgeTabCount: 1,
      espnTabCount: 1,
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

function system(overrides = {}) {
  return {
    gitClean: true,
    headMatchesRemote: true,
    serverListenerCount: 1,
    serverReadyMs: 300,
    sourceWarmMs: 1_200,
    totalCheckMs: 1_700,
    manifestVersion: release.extensionVersion,
    expectedExtensionVersion: release.extensionVersion,
    extensionPackageSha256: release.extensionPackageSha256,
    expectedExtensionPackageSha256: release.extensionPackageSha256,
    ...overrides,
  };
}

test("draft-day doctor accepts one clean authenticated two-tab production runtime", () => {
  const result = evaluateDraftDayDoctor({ snapshot: snapshot(), expected, system: system(), now });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
});

test("draft-day doctor fails closed on extra tabs, stale import, or package drift", () => {
  const candidate = snapshot({
    binding: { ...snapshot().binding, authenticatedImportAt: "2026-08-19T11:50:00.000Z" },
    runtime: { ...snapshot().runtime, browserTabCount: 3 },
  });
  const result = evaluateDraftDayDoctor({
    snapshot: candidate,
    expected,
    system: system({ extensionPackageSha256: "different" }),
    now,
  });
  for (const blocker of ["authenticatedImportFresh", "exactTwoChromeTabs", "extensionPackageIntegrity"]) {
    assert.ok(result.blockers.includes(blocker), blocker);
  }
});

test("live doctor enforces the five-second recheck SLO and live safety gate", () => {
  const live = snapshot({
    safety: { ...snapshot().safety, liveChecklistReady: true, inDraftRoom: true, soundMuted: true },
  });
  assert.equal(evaluateDraftDayDoctor({ snapshot: live, expected, phase: "live", system: system(), now }).ready, true);
  const slow = evaluateDraftDayDoctor({ snapshot: live, expected, phase: "live", system: system({ totalCheckMs: 5_001 }), now });
  assert.ok(slow.blockers.includes("liveRecheckWithinSlo"));
});

test("doctor can bind a temporary ESPN practice-room identity without changing saved rules", () => {
  const room = resolveDraftDayDoctorLeague(expected, "1594208142", 6, 30);
  assert.equal(room.id, "1594208142");
  assert.equal(room.teamId, 6);
  assert.equal(room.secondsPerPick, 30);
  assert.equal(room.draftType, expected.draftType);
  assert.equal(room.rosterSize, expected.rosterSize);
  assert.throws(() => resolveDraftDayDoctorLeague(expected, "not-an-espn-id", 6), /DRAFT_DAY_ROOM_IDENTITY_INVALID/);
  assert.throws(() => resolveDraftDayDoctorLeague(expected, "1594208142", 6, 0), /DRAFT_DAY_ROOM_IDENTITY_INVALID/);
});

test("terminal doctor does not expire the import that started the completed draft", () => {
  const completed = snapshot({ binding: { ...snapshot().binding, authenticatedImportAt: "2026-08-19T11:45:00.000Z" } });
  const result = evaluateDraftDayDoctor({ snapshot: completed, expected, phase: "complete", system: system(), now });
  assert.equal(result.checks.authenticatedImportFresh, true);
});
