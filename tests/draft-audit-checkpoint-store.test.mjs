import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DRAFT_AUDIT_CHECKPOINT_SCHEMA,
  DRAFT_AUDIT_CHECKPOINT_RETIRE_CONFIRMATION,
  MAX_DRAFT_AUDIT_CHECKPOINT_BYTES,
  draftAuditCheckpointCriticalDigest,
  draftAuditCheckpointDigest,
  draftAuditCheckpointPersistenceRequired,
  loadPersistedDraftAuditCheckpoint,
  quarantinePersistedDraftAuditCheckpoint,
  scavengeDraftAuditCheckpointTemps,
  parsePersistedDraftAuditCheckpoint,
  persistDraftAuditCheckpoint,
  retirePersistedDraftAuditCheckpoint,
} from "../app/lib/draft-audit-checkpoint-store.ts";
import { appendLiveControlEvent, createLiveControlState } from "../app/lib/live-control.ts";

const capturedAt = "2026-08-28T12:00:00.000Z";

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAt,
    league: {
      id: "44050",
      teamId: 7,
      season: 2026,
      draftType: "AUCTION",
      size: 12,
      rosterSize: 14,
      auctionBudget: 200,
      secondsPerPick: 60,
      scoringLabel: "PPR",
      scoringRules: 45,
      keeperCount: 0,
      lineupSlotCounts: { "0": 1, "2": 1, "4": 1, "7": 1, "16": 1, "17": 1, "20": 6, "23": 2 },
      positionLimits: { "1": 2, "2": 3, "3": 5, "4": 2, "16": 1, "17": 1 },
    },
    binding: {
      tabId: 91,
      dashboardLoadedAt: "2026-08-28T11:59:00.000Z",
      authenticatedImportAt: "2026-08-28T11:59:30.000Z",
      commandCenterSessionId: "command-center-session",
      commandCenterStartedAt: "2026-08-28T11:59:00.000Z",
    },
    runtime: {
      capturedAt,
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
      soundMuted: false,
      autopickActive: false,
      autoDraft: false,
      sourceCoverage: 5,
      sourceIds: ["espn", "ffc", "mfl", "tradyr", "gng"],
      sourceSnapshotId: `sha256:${"c".repeat(64)}`,
      sourceSnapshotGeneratedAt: "2026-08-28T11:59:30.000Z",
      actionState: "Draft room connected and fail-closed.",
    },
    draft: {
      totalPicks: 0,
      appRoster: [],
      espnRoster: [],
    },
    telemetry: { actions: [] },
    sleeperEvidence: { candidateCount: 0, candidates: [] },
    availability: {
      status: "READY",
      digest: `sha256:${"b".repeat(64)}`,
      evaluatedAt: capturedAt,
      freshUntil: "2026-08-28T12:30:00.000Z",
      blockingReasons: [],
      vetoedPlayerIds: [],
    },
    ...overrides,
  };
}

function envelope(entries = [snapshot()], releaseRevision = "0".repeat(40)) {
  return {
    schemaVersion: DRAFT_AUDIT_CHECKPOINT_SCHEMA,
    releaseRevision,
    writtenAt: capturedAt,
    snapshots: entries.map((item) => ({ digest: draftAuditCheckpointDigest(item), snapshot: item })),
  };
}

function activeSnapshot(index) {
  const playerId = 10_000 + index;
  let control = createLiveControlState(`checkpoint-control-${index}`, {
    espnContextAt: capturedAt,
    pickFeedAt: capturedAt,
    sourceSnapshotAt: "2026-08-28T11:59:30.000Z",
    lastActionAt: capturedAt,
  });
  control = appendLiveControlEvent(control, {
    occurredAt: capturedAt,
    kind: "ROSTER_ATTRIBUTION",
    player: { playerId, playerName: `Player ${index}`, position: "WR" },
    attribution: "DRAFTFORGE_CONFIRMED",
    actionId: `action-${index}`,
    decisionId: `decision-${index}`,
  });
  return snapshot({
    league: { ...snapshot().league, id: String(50_000 + index) },
    liveControl: control,
  });
}

test("draft audit checkpoint parser rejects malformed and duplicate records", () => {
  assert.equal(parsePersistedDraftAuditCheckpoint(null).ok, false);
  assert.equal(parsePersistedDraftAuditCheckpoint({
    schemaVersion: DRAFT_AUDIT_CHECKPOINT_SCHEMA,
    writtenAt: capturedAt,
    snapshots: [],
  }).ok, false);
  const exact = snapshot();
  assert.equal(parsePersistedDraftAuditCheckpoint(envelope([exact, exact])).ok, false);
  assert.equal(parsePersistedDraftAuditCheckpoint(envelope([exact], "1".repeat(40))).code, "DRAFT_AUDIT_CHECKPOINT_RELEASE_MISMATCH");
  const tampered = envelope([exact]);
  tampered.snapshots[0].snapshot.capturedAt = "2026-08-28T12:00:01.000Z";
  assert.equal(parsePersistedDraftAuditCheckpoint(tampered).ok, false);
});

test("critical digest ignores only explicit heartbeat fields and treats unknown changes as critical", () => {
  const base = activeSnapshot(9);
  base.operator = {
    room: { secondsRemaining: 22, currentBid: 10, leader: "OPPONENT" },
    recommendation: { action: "BID", offer: 11 },
  };
  base.leagueBoard = { rankingBasis: "AVERAGE_PROJECTION", teams: [{ rank: 1 }] };
  const heartbeat = structuredClone(base);
  heartbeat.capturedAt = "2026-08-28T12:00:01.000Z";
  heartbeat.runtime.capturedAt = "2026-08-28T12:00:01.000Z";
  heartbeat.liveControl.freshness.espnContextAt = "2026-08-28T12:00:01.000Z";
  heartbeat.liveControl.freshness.pickFeedAt = "2026-08-28T12:00:01.000Z";
  heartbeat.operator.room.secondsRemaining = 12;
  heartbeat.operator.room.currentBid = 14;
  heartbeat.operator.room.leader = "US";
  heartbeat.operator.recommendation.offer = 15;
  heartbeat.leagueBoard.teams[0].rank = 2;
  heartbeat.safety.actionState = "Observed auction presentation changed.";
  assert.equal(draftAuditCheckpointCriticalDigest(heartbeat), draftAuditCheckpointCriticalDigest(base));

  const changedSafety = structuredClone(heartbeat);
  changedSafety.safety.autoDraft = true;
  assert.notEqual(draftAuditCheckpointCriticalDigest(changedSafety), draftAuditCheckpointCriticalDigest(base));
  const unknownField = structuredClone(heartbeat);
  unknownField.futureSafetyField = true;
  assert.notEqual(draftAuditCheckpointCriticalDigest(unknownField), draftAuditCheckpointCriticalDigest(base));
});

test("10 Hz clock-only audits are bounded to seven writes per 30 seconds while safety changes persist immediately", () => {
  const base = activeSnapshot(10);
  let durability;
  let writes = 0;
  for (let elapsed = 0; elapsed <= 30_000; elapsed += 100) {
    const heartbeat = structuredClone(base);
    heartbeat.capturedAt = new Date(Date.parse(capturedAt) + elapsed).toISOString();
    heartbeat.runtime.capturedAt = heartbeat.capturedAt;
    heartbeat.liveControl.freshness.espnContextAt = heartbeat.capturedAt;
    const decision = draftAuditCheckpointPersistenceRequired(durability, heartbeat, elapsed, 5_000);
    if (decision.required) {
      writes += 1;
      durability = { criticalDigest: decision.criticalDigest, persistedAt: elapsed };
    }
  }
  assert.equal(writes, 7);

  for (const mutate of [
    (value) => { value.binding.tabId += 1; },
    (value) => { value.safety.autoDraft = true; },
    (value) => { value.safety.sourceSnapshotId = `sha256:${"d".repeat(64)}`; },
    (value) => { value.availability.vetoedPlayerIds = [999]; },
    (value) => { value.draft.totalPicks = 1; },
    (value) => { value.liveControl.uncontrolledRosterAdditionDetected = true; },
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.equal(
      draftAuditCheckpointPersistenceRequired(
        { criticalDigest: draftAuditCheckpointCriticalDigest(base), persistedAt: 30_000 },
        changed,
        30_001,
        5_000,
      ).required,
      true,
    );
  }
});

test("draft audit checkpoint protects active irreversible drafts from eviction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "draftforge-audit-checkpoint-active-"));
  try {
    await assert.rejects(
      () => persistDraftAuditCheckpoint(
        Array.from({ length: 5 }, (_, index) => activeSnapshot(index)),
        join(directory, "checkpoint.json"),
        capturedAt,
      ),
      /DRAFT_AUDIT_CHECKPOINT_ACTIVE_CAPACITY_EXCEEDED/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("four interrupted rooms require exact durable archive retirement before a fifth can enter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "draftforge-audit-checkpoint-retire-"));
  const checkpointPath = join(directory, "checkpoint.json");
  try {
    const interrupted = Array.from({ length: 4 }, (_, index) => activeSnapshot(index));
    const persisted = await persistDraftAuditCheckpoint(interrupted, checkpointPath, capturedAt);
    const target = persisted.snapshots.find(({ snapshot: item }) => item.league.id === "50000");
    assert.ok(target);
    await assert.rejects(
      () => persistDraftAuditCheckpoint([...interrupted, activeSnapshot(4)], checkpointPath, capturedAt),
      /DRAFT_AUDIT_CHECKPOINT_ACTIVE_CAPACITY_EXCEEDED/,
    );
    await assert.rejects(
      () => retirePersistedDraftAuditCheckpoint({
        leagueId: "50000",
        teamId: 7,
        expectedDigest: target.digest,
        confirmation: "wrong",
        checkpointPath,
        retiredAt: "2026-08-28T12:01:00.000Z",
      }),
      /RETIRE_AUTHORIZATION_INVALID/,
    );
    await assert.rejects(
      () => retirePersistedDraftAuditCheckpoint({
        leagueId: "50000",
        teamId: 7,
        expectedDigest: `sha256:${"f".repeat(64)}`,
        confirmation: DRAFT_AUDIT_CHECKPOINT_RETIRE_CONFIRMATION,
        checkpointPath,
        retiredAt: "2026-08-28T12:01:00.000Z",
      }),
      /RETIRE_DIGEST_MISMATCH/,
    );
    const retired = await retirePersistedDraftAuditCheckpoint({
      leagueId: "50000",
      teamId: 7,
      expectedDigest: target.digest,
      confirmation: DRAFT_AUDIT_CHECKPOINT_RETIRE_CONFIRMATION,
      checkpointPath,
      retiredAt: "2026-08-28T12:01:00.000Z",
    });
    assert.equal(retired.remaining, 3);
    assert.equal((await stat(retired.archivePath)).mode & 0o777, 0o600);
    const archived = JSON.parse(await readFile(retired.archivePath, "utf8"));
    assert.equal(archived.digest, target.digest);
    assert.equal(archived.snapshot.league.id, "50000");
    const remaining = await loadPersistedDraftAuditCheckpoint(checkpointPath);
    assert.equal(remaining.ok, true);
    assert.equal(remaining.value.snapshots.some(({ snapshot: item }) => item.league.id === "50000"), false);
    const admitted = await persistDraftAuditCheckpoint(
      [...remaining.value.snapshots.map(({ snapshot: item }) => item), activeSnapshot(4)],
      checkpointPath,
      "2026-08-28T12:02:00.000Z",
    );
    assert.equal(admitted.snapshots.length, 4);
    assert.equal(admitted.snapshots.some(({ snapshot: item }) => item.league.id === "50004"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("draft audit checkpoint rejects unsafe modes and symlinks, then quarantines them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "draftforge-audit-checkpoint-unsafe-"));
  const checkpointPath = join(directory, "checkpoint.json");
  try {
    await persistDraftAuditCheckpoint([snapshot()], checkpointPath, capturedAt);
    await chmod(checkpointPath, 0o644);
    assert.equal((await loadPersistedDraftAuditCheckpoint(checkpointPath)).code, "DRAFT_AUDIT_CHECKPOINT_INVALID");
    const quarantine = await quarantinePersistedDraftAuditCheckpoint(checkpointPath);
    assert.match(String(quarantine), /\.invalid-/);

    const target = join(directory, "target.json");
    await writeFile(target, JSON.stringify(envelope()), { mode: 0o600 });
    await symlink(target, checkpointPath);
    assert.equal((await loadPersistedDraftAuditCheckpoint(checkpointPath)).code, "DRAFT_AUDIT_CHECKPOINT_INVALID");
    await rm(checkpointPath, { force: true });
    await writeFile(checkpointPath, "x".repeat(MAX_DRAFT_AUDIT_CHECKPOINT_BYTES + 1), { mode: 0o600 });
    assert.equal((await loadPersistedDraftAuditCheckpoint(checkpointPath)).code, "DRAFT_AUDIT_CHECKPOINT_INVALID");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup scavenges only strict dead-writer checkpoint temps and preserves the active writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "draftforge-audit-checkpoint-temps-"));
  const checkpointPath = join(directory, "checkpoint.json");
  try {
    for (let index = 0; index < 100; index += 1) {
      await writeFile(`${checkpointPath}.${900_000 + index}.${randomUUID()}.tmp`, "orphan", { mode: 0o600 });
    }
    const activeName = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(activeName, "active", { mode: 0o600 });
    await writeFile(join(directory, "unrelated.tmp"), "keep", { mode: 0o600 });
    assert.equal(await scavengeDraftAuditCheckpointTemps(checkpointPath), 100);
    const remaining = await readdir(directory);
    assert.equal(remaining.filter((name) => name.startsWith("checkpoint.json.")).length, 1);
    assert.ok(remaining.includes("unrelated.tmp"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("draft audit checkpoint round trips atomically with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "draftforge-audit-checkpoint-"));
  const checkpointPath = join(directory, "checkpoint.json");
  try {
    const acceptedSnapshot = snapshot();
    const persisted = await persistDraftAuditCheckpoint([acceptedSnapshot], checkpointPath, capturedAt);
    assert.equal(persisted.snapshots.length, 1);
    assert.equal(
      persisted.snapshots[0].snapshot,
      acceptedSnapshot,
      "trusted materialization must return the exact accepted snapshot object",
    );
    assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600);
    const diskEnvelope = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(diskEnvelope.schemaVersion, DRAFT_AUDIT_CHECKPOINT_SCHEMA);
    const parsedDisk = parsePersistedDraftAuditCheckpoint(diskEnvelope);
    assert.equal(parsedDisk.ok, true, "independent disk bytes must pass the strict untrusted parser");
    assert.equal(parsedDisk.value.snapshots[0].digest, persisted.snapshots[0].digest);
    assert.equal(parsedDisk.value.snapshots[0].digest, draftAuditCheckpointDigest(parsedDisk.value.snapshots[0].snapshot));
    const loaded = await loadPersistedDraftAuditCheckpoint(checkpointPath);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.snapshots[0].snapshot.league.id, "44050");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("draft audit checkpoint retains only the latest snapshot per league and four leagues globally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "draftforge-audit-checkpoint-bound-"));
  const checkpointPath = join(directory, "checkpoint.json");
  try {
    const snapshots = Array.from({ length: 6 }, (_, index) => snapshot({
      capturedAt: new Date(Date.parse(capturedAt) + index).toISOString(),
      league: { ...snapshot().league, id: String(44050 + index) },
    }));
    const persisted = await persistDraftAuditCheckpoint(snapshots, checkpointPath, capturedAt);
    assert.equal(persisted.snapshots.length, 4);
    assert.deepEqual(persisted.snapshots.map((item) => item.snapshot.league.id), ["44055", "44054", "44053", "44052"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
