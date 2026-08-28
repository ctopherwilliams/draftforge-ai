import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DRAFT_DAY_DOCTOR_SLOS,
  draftDaySourceSnapshotAgeMs,
  evaluateDraftDayDoctor,
  isDraftDaySourceSnapshotFresh,
  isDraftDaySourceSnapshotId,
  resolveDraftDayDoctorLeague,
} from "../app/lib/draft-day-doctor.ts";

const leagues = JSON.parse(await readFile(new URL("../config/authenticated-espn-leagues.json", import.meta.url), "utf8"));
const release = JSON.parse(await readFile(new URL("../config/draft-day-release.json", import.meta.url), "utf8"));
const expected = leagues.profiles["salary-cap"];
const now = Date.parse("2026-08-19T12:00:05.000Z");
const sourceSnapshotId = `sha256:${"c".repeat(64)}`;
const sourceSnapshotGeneratedAt = "2026-08-19T12:00:00.000Z";

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
      extensionSourceSha256: release.extensionSourceSha256,
      extensionSourceFileCount: release.extensionSourceFileCount,
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
      sourceSnapshotId,
      sourceSnapshotGeneratedAt,
      actionState: "Pre-draft checks confirmed.",
    },
    draft: { totalPicks: 0, appRoster: [], espnRoster: [] },
    telemetry: { actions: [] },
    sleeperEvidence: { candidateCount: 0, candidates: [] },
    availability: {
      status: "READY",
      digest: `sha256:${"a".repeat(64)}`,
      evaluatedAt: "2026-08-19T12:00:04.000Z",
      freshUntil: "2026-08-19T12:30:04.000Z",
      blockingReasons: [],
      vetoedPlayerIds: [],
    },
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
    sourceWarmSnapshotId: sourceSnapshotId,
    sourceWarmSnapshotGeneratedAt: sourceSnapshotGeneratedAt,
    totalCheckMs: 1_700,
    manifestVersion: release.extensionVersion,
    expectedExtensionVersion: release.extensionVersion,
    extensionPackageSha256: release.extensionPackageSha256,
    expectedExtensionPackageSha256: release.extensionPackageSha256,
    extensionDirectorySourceSha256: release.extensionSourceSha256,
    extensionArchiveSourceSha256: release.extensionSourceSha256,
    expectedExtensionSourceSha256: release.extensionSourceSha256,
    extensionSourceFileCount: release.extensionSourceFileCount,
    extensionArchiveFileCount: release.extensionSourceFileCount,
    expectedExtensionSourceFileCount: release.extensionSourceFileCount,
    currentRevision: "a".repeat(40),
    servedReleaseRevision: "a".repeat(40),
    currentSourceTreeSha256: "b".repeat(64),
    servedSourceTreeSha256: "b".repeat(64),
    servedReleaseManifestIntegrity: true,
    servedRuntimeAssetsIntegrity: true,
    ...overrides,
  };
}

test("draft-day doctor accepts one clean authenticated two-tab production runtime", () => {
  const result = evaluateDraftDayDoctor({ snapshot: snapshot(), expected, system: system(), now });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
});

test("source snapshot identity and timestamps use strict canonical forms", () => {
  assert.equal(isDraftDaySourceSnapshotId(sourceSnapshotId), true);
  for (const invalid of [
    sourceSnapshotId.toUpperCase(),
    sourceSnapshotId.slice(0, -1),
    `${sourceSnapshotId}0`,
    "c".repeat(64),
    "sha256:not-hex",
    null,
  ]) assert.equal(isDraftDaySourceSnapshotId(invalid), false, String(invalid));

  assert.equal(draftDaySourceSnapshotAgeMs(sourceSnapshotGeneratedAt, now), 5_000);
  assert.equal(isDraftDaySourceSnapshotFresh(sourceSnapshotGeneratedAt, now), true);
  assert.equal(isDraftDaySourceSnapshotFresh("2026-08-19T12:00:00Z", now), false);
  assert.equal(isDraftDaySourceSnapshotFresh("not-a-timestamp", now), false);
  assert.equal(isDraftDaySourceSnapshotFresh(
    new Date(now - DRAFT_DAY_DOCTOR_SLOS.sourceSnapshotFreshMs - 1).toISOString(),
    now,
  ), false);
  assert.equal(isDraftDaySourceSnapshotFresh(new Date(now + 5_001).toISOString(), now), false);
});

test("draft-day doctor fails closed on absent or malformed source snapshot identity", () => {
  const absent = snapshot();
  delete absent.safety.sourceSnapshotId;
  delete absent.safety.sourceSnapshotGeneratedAt;
  const absentResult = evaluateDraftDayDoctor({ snapshot: absent, expected, system: system(), now });
  for (const blocker of [
    "activeSourceSnapshotIdentity",
    "sourceSnapshotIdentityMatch",
    "sourceSnapshotGeneratedAtMatch",
    "activeSourceSnapshotFresh",
  ]) {
    assert.ok(absentResult.blockers.includes(blocker), blocker);
  }

  const malformedWarm = evaluateDraftDayDoctor({
    snapshot: snapshot(),
    expected,
    system: system({
      sourceWarmSnapshotId: "sha256:not-a-digest",
      sourceWarmSnapshotGeneratedAt: "2026-08-19T12:00:00Z",
    }),
    now,
  });
  for (const blocker of [
    "sourceWarmSnapshotIdentity",
    "sourceSnapshotIdentityMatch",
    "sourceSnapshotGeneratedAtMatch",
    "sourceWarmSnapshotFresh",
  ]) {
    assert.ok(malformedWarm.blockers.includes(blocker), blocker);
  }
});

test("draft-day doctor rejects changed or stale source snapshot bindings", () => {
  const changed = evaluateDraftDayDoctor({
    snapshot: snapshot(),
    expected,
    system: system({ sourceWarmSnapshotId: `sha256:${"d".repeat(64)}` }),
    now,
  });
  assert.equal(changed.checks.sourceWarmSnapshotIdentity, true);
  assert.equal(changed.checks.activeSourceSnapshotIdentity, true);
  assert.ok(changed.blockers.includes("sourceSnapshotIdentityMatch"));

  const changedMetadata = snapshot({
    safety: {
      ...snapshot().safety,
      sourceSnapshotGeneratedAt: "2026-08-19T12:00:01.000Z",
    },
  });
  const changedMetadataResult = evaluateDraftDayDoctor({
    snapshot: changedMetadata,
    expected,
    system: system(),
    now,
  });
  assert.ok(changedMetadataResult.blockers.includes("sourceSnapshotGeneratedAtMatch"));

  const staleWarm = evaluateDraftDayDoctor({
    snapshot: snapshot(),
    expected,
    system: system({
      sourceWarmSnapshotGeneratedAt: new Date(
        now - DRAFT_DAY_DOCTOR_SLOS.sourceSnapshotFreshMs - 1,
      ).toISOString(),
    }),
    now,
  });
  assert.ok(staleWarm.blockers.includes("sourceWarmSnapshotFresh"));

  const staleActive = snapshot({
    safety: {
      ...snapshot().safety,
      sourceSnapshotGeneratedAt: new Date(
        now - DRAFT_DAY_DOCTOR_SLOS.sourceSnapshotFreshMs - 1,
      ).toISOString(),
    },
  });
  const staleActiveResult = evaluateDraftDayDoctor({ snapshot: staleActive, expected, system: system(), now });
  assert.ok(staleActiveResult.blockers.includes("activeSourceSnapshotFresh"));
});

test("source snapshot binding survives restart replay but an old replay expires", () => {
  const replayedSnapshot = JSON.parse(JSON.stringify(snapshot()));
  const replayedSystem = JSON.parse(JSON.stringify(system()));
  const replay = evaluateDraftDayDoctor({
    snapshot: replayedSnapshot,
    expected,
    system: replayedSystem,
    now,
  });
  assert.equal(replay.ready, true);
  assert.equal(replay.checks.sourceSnapshotIdentityMatch, true);

  const expiredReplay = evaluateDraftDayDoctor({
    snapshot: replayedSnapshot,
    expected,
    system: replayedSystem,
    now: now + DRAFT_DAY_DOCTOR_SLOS.sourceSnapshotFreshMs + 1,
  });
  assert.equal(expiredReplay.ready, false);
  assert.ok(expiredReplay.blockers.includes("sourceWarmSnapshotFresh"));
  assert.ok(expiredReplay.blockers.includes("activeSourceSnapshotFresh"));
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

test("draft-day doctor rejects an extension without managed cleanup capability", () => {
  const candidate = snapshot({ runtime: { ...snapshot().runtime, managedCleanupReady: false } });
  const result = evaluateDraftDayDoctor({ snapshot: candidate, expected, system: system(), now });
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("managedWorkspaceCleanup"));
});

test("draft-day doctor fails closed on served build or extension byte provenance drift", () => {
  const candidate = snapshot({
    runtime: { ...snapshot().runtime, extensionSourceSha256: "c".repeat(64) },
  });
  const result = evaluateDraftDayDoctor({
    snapshot: candidate,
    expected,
    system: system({
      extensionArchiveSourceSha256: "d".repeat(64),
      servedReleaseRevision: "e".repeat(40),
      servedSourceTreeSha256: "f".repeat(64),
      servedRuntimeAssetsIntegrity: false,
    }),
    now,
  });
  for (const blocker of [
    "extensionDirectoryPackageParity",
    "extensionSourceIntegrity",
    "installedExtensionSourceIntegrity",
    "servedReleaseRevisionPinned",
    "servedReleaseSourcePinned",
    "servedRuntimeAssetsIntegrity",
  ]) assert.ok(result.blockers.includes(blocker), blocker);
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
