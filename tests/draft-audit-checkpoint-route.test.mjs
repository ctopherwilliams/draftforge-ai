import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadPersistedDraftAuditCheckpoint,
  persistDraftAuditCheckpoint,
} from "../app/lib/draft-audit-checkpoint-store.ts";
import { appendLiveControlEvent, createLiveControlState } from "../app/lib/live-control.ts";

const releaseRevision = "d".repeat(40);
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
      commandCenterSessionId: "checkpoint-publisher",
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
    draft: { totalPicks: 0, appRoster: [], espnRoster: [] },
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

function localGet(GET, query) {
  return GET(new Request(`http://127.0.0.1:3000/api/draft-day?${query}`, {
    headers: { Origin: "http://127.0.0.1:3000" },
  }));
}

function localPost(POST, audit) {
  return POST(new Request("http://127.0.0.1:3000/api/draft-day", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "AUDIT", audit }),
  }));
}

function interruptedSnapshot(index, at) {
  const atMs = Date.parse(at);
  const dashboardLoadedAt = new Date(atMs - 60_000).toISOString();
  const authenticatedImportAt = new Date(atMs - 30_000).toISOString();
  let liveControl = createLiveControlState(`checkpoint-retention-${index}`, {
    espnContextAt: at,
    pickFeedAt: at,
    pickFeedObservedAt: at,
    sourceSnapshotAt: authenticatedImportAt,
    lastActionAt: at,
  });
  liveControl = appendLiveControlEvent(liveControl, {
    occurredAt: at,
    kind: "ROSTER_ATTRIBUTION",
    player: { playerId: 70_000 + index, playerName: `Retained Player ${index}`, position: "WR" },
    attribution: "DRAFTFORGE_CONFIRMED",
    actionId: `retained-action-${index}`,
    decisionId: `retained-decision-${index}`,
  });
  const base = snapshot();
  return snapshot({
    capturedAt: at,
    league: { ...base.league, id: String(70_000 + index) },
    binding: {
      ...base.binding,
      dashboardLoadedAt,
      authenticatedImportAt,
      commandCenterSessionId: `retained-publisher-${index}`,
      commandCenterStartedAt: dashboardLoadedAt,
    },
    runtime: { ...base.runtime, capturedAt: at },
    safety: { ...base.safety, sourceSnapshotGeneratedAt: authenticatedImportAt },
    availability: {
      ...base.availability,
      evaluatedAt: at,
      freshUntil: new Date(atMs + 30 * 60_000).toISOString(),
    },
    liveControl,
  });
}

test("route hydrates revision-bound evidence before reads and persists an accepted audit before ACK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "draftforge-checkpoint-route-"));
  const checkpointPath = join(directory, "checkpoint.json");
  const priorEnv = {
    enabled: process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT,
    path: process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH,
    revision: process.env.DRAFTFORGE_RELEASE_REVISION,
    startedAt: process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT,
  };
  try {
    process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT = "1";
    process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH = checkpointPath;
    process.env.DRAFTFORGE_RELEASE_REVISION = releaseRevision;
    delete process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT;
    await persistDraftAuditCheckpoint([snapshot()], checkpointPath, capturedAt, releaseRevision);

    const first = await import(`../app/api/draft-day/route.ts?checkpoint-first=${Date.now()}`);
    const hydrated = await localGet(first.GET, "view=hydrate");
    assert.equal(hydrated.status, 200);
    assert.equal((await hydrated.json()).recoveryEvidenceCount, 1);
    const recovered = await localGet(first.GET, "leagueId=44050&teamId=7");
    assert.equal((await recovered.json()).recoveryEvidence, true);

    const recoveredImport = snapshot({
      capturedAt: "2026-08-28T12:00:01.000Z",
      binding: {
        ...snapshot().binding,
        dashboardLoadedAt: "2026-08-28T12:00:00.500Z",
        authenticatedImportAt: "2026-08-28T12:00:00.500Z",
      },
    });
    const recorded = await localPost(first.POST, recoveredImport);
    assert.equal(recorded.status, 200);
    assert.equal((await recorded.json()).code, "DRAFT_AUDIT_RECORDED");
    const durable = await loadPersistedDraftAuditCheckpoint(checkpointPath, releaseRevision);
    assert.equal(durable.ok, true);
    assert.equal(durable.value.snapshots[0].snapshot.capturedAt, recoveredImport.capturedAt);

    const beforeHeartbeatBytes = await readFile(checkpointPath);
    let latestHeartbeat = recoveredImport;
    for (let index = 1; index <= 300; index += 1) {
      const at = new Date(Date.parse(recoveredImport.capturedAt) + index).toISOString();
      latestHeartbeat = {
        ...recoveredImport,
        capturedAt: at,
        runtime: { ...recoveredImport.runtime, capturedAt: at },
      };
      const heartbeatResponse = await localPost(first.POST, latestHeartbeat);
      assert.equal(heartbeatResponse.status, 200);
    }
    assert.deepEqual(await readFile(checkpointPath), beforeHeartbeatBytes);

    const critical = {
      ...latestHeartbeat,
      capturedAt: "2026-08-28T12:00:02.000Z",
      runtime: { ...latestHeartbeat.runtime, capturedAt: "2026-08-28T12:00:02.000Z" },
      safety: { ...latestHeartbeat.safety, actionState: "Critical authorization state changed." },
      availability: { ...latestHeartbeat.availability, digest: `sha256:${"e".repeat(64)}` },
    };
    const criticalResponse = await localPost(first.POST, critical);
    assert.equal(criticalResponse.status, 200);
    const durableCritical = await loadPersistedDraftAuditCheckpoint(checkpointPath, releaseRevision);
    assert.equal(durableCritical.ok, true);
    assert.equal(durableCritical.value.snapshots[0].snapshot.capturedAt, critical.capturedAt);
    const beforeObserverBytes = await readFile(checkpointPath);
    const beforeObserverMtime = (await stat(checkpointPath)).mtimeMs;
    for (let index = 0; index < 1_000; index += 1) {
      const observed = await localGet(first.GET, "leagueId=44050&teamId=7");
      assert.equal(observed.status, 200);
    }
    assert.deepEqual(await readFile(checkpointPath), beforeObserverBytes);
    assert.equal((await stat(checkpointPath)).mtimeMs, beforeObserverMtime);

    process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT = "0";
    for (let index = 0; index < 10_001; index += 1) {
      const at = new Date(Date.parse("2026-08-28T12:00:03.000Z") + index).toISOString();
      const candidate = snapshot({
        capturedAt: at,
        league: { ...snapshot().league, id: String(60_000 + index) },
        runtime: { ...snapshot().runtime, capturedAt: at },
      });
      const response = await localPost(first.POST, candidate);
      assert.equal(response.status, 200);
    }
    const bounded = first.draftAuditRuntimeLedgerStats();
    assert.ok(bounded.snapshots <= 8);
    assert.ok(bounded.captureIssueTokens <= bounded.snapshots);
    assert.ok(bounded.recoveryEvidence <= bounded.snapshots);
    assert.ok(bounded.durability <= bounded.snapshots);
    process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT = "1";

    const restarted = await import(`../app/api/draft-day/route.ts?checkpoint-restart=${Date.now()}`);
    const restartHydrated = await localGet(restarted.GET, "view=hydrate");
    assert.equal((await restartHydrated.json()).recoveryEvidenceCount, 1);
    const restartRecovered = await localGet(restarted.GET, "leagueId=44050&teamId=7");
    const restartBody = await restartRecovered.json();
    assert.equal(restartBody.recoveryEvidence, true);
    assert.equal(restartBody.snapshot.capturedAt, critical.capturedAt);
    const staleObserver = await localGet(restarted.GET, "leagueId=44050&teamId=7&view=status");
    assert.equal(staleObserver.status, 409);
    assert.equal((await staleObserver.json()).code, "DRAFT_DAY_RECOVERY_REQUIRED");
    const staleDispatchLease = await localGet(
      restarted.GET,
      "leagueId=44050&teamId=7&view=dispatch-lease&tabId=91&commandCenterSessionId=checkpoint-publisher&dashboardLoadedAt=2026-08-28T12%3A00%3A00.500Z&decisionId=none&operation=BID&playerId=1",
    );
    assert.equal(staleDispatchLease.status, 409);
    assert.equal((await staleDispatchLease.json()).code, "DRAFT_DAY_RECOVERY_REQUIRED");
  } finally {
    if (priorEnv.enabled === undefined) delete process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT;
    else process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT = priorEnv.enabled;
    if (priorEnv.path === undefined) delete process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH;
    else process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH = priorEnv.path;
    if (priorEnv.revision === undefined) delete process.env.DRAFTFORGE_RELEASE_REVISION;
    else process.env.DRAFTFORGE_RELEASE_REVISION = priorEnv.revision;
    if (priorEnv.startedAt === undefined) delete process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT;
    else process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT = priorEnv.startedAt;
    await rm(directory, { recursive: true, force: true });
  }
});

test("route retains expired interrupted recovery evidence and fails closed at durable capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "draftforge-checkpoint-route-retention-"));
  const checkpointPath = join(directory, "checkpoint.json");
  const priorEnv = {
    enabled: process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT,
    path: process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH,
    revision: process.env.DRAFTFORGE_RELEASE_REVISION,
    startedAt: process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT,
  };
  try {
    process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT = "1";
    process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH = checkpointPath;
    process.env.DRAFTFORGE_RELEASE_REVISION = releaseRevision;
    delete process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT;

    const now = Date.now();
    const oldBase = now - 26 * 60 * 60 * 1_000;
    const interrupted = Array.from({ length: 4 }, (_, index) => (
      interruptedSnapshot(index, new Date(oldBase + index).toISOString())
    ));
    await persistDraftAuditCheckpoint(
      interrupted,
      checkpointPath,
      new Date(oldBase + 10_000).toISOString(),
      releaseRevision,
    );
    const durableBefore = await readFile(checkpointPath);

    const route = await import(`../app/api/draft-day/route.ts?checkpoint-retention=${Date.now()}`);
    const hydrated = await localGet(route.GET, "view=hydrate");
    assert.equal(hydrated.status, 200);
    assert.equal((await hydrated.json()).recoveryEvidenceCount, 4);
    assert.deepEqual(route.draftAuditRuntimeLedgerStats(), {
      snapshots: 4,
      captureIssueTokens: 0,
      recoveryEvidence: 4,
      durability: 4,
    });

    for (const retained of interrupted) {
      const recovered = await localGet(
        route.GET,
        `leagueId=${retained.league.id}&teamId=${retained.league.teamId}`,
      );
      assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).recoveryEvidence, true);
    }

    const nowIso = new Date(now).toISOString();
    const base = snapshot();
    const nextRoom = snapshot({
      capturedAt: nowIso,
      league: { ...base.league, id: "79999" },
      binding: {
        ...base.binding,
        dashboardLoadedAt: new Date(now - 60_000).toISOString(),
        authenticatedImportAt: new Date(now - 30_000).toISOString(),
        commandCenterSessionId: "next-room-publisher",
        commandCenterStartedAt: new Date(now - 60_000).toISOString(),
      },
      runtime: { ...base.runtime, capturedAt: nowIso },
      safety: { ...base.safety, sourceSnapshotGeneratedAt: new Date(now - 30_000).toISOString() },
      availability: {
        ...base.availability,
        evaluatedAt: nowIso,
        freshUntil: new Date(now + 30 * 60_000).toISOString(),
      },
    });
    const blocked = await localPost(route.POST, nextRoom);
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).code, "DRAFT_AUDIT_CHECKPOINT_CAPACITY_BLOCKED");
    assert.deepEqual(await readFile(checkpointPath), durableBefore, "a different room cannot rewrite protected evidence");

    const durableAfter = await loadPersistedDraftAuditCheckpoint(checkpointPath, releaseRevision);
    assert.equal(durableAfter.ok, true);
    assert.deepEqual(
      durableAfter.value.snapshots.map(({ snapshot: item }) => item.league.id).sort(),
      interrupted.map((item) => item.league.id).sort(),
    );
    assert.equal((await localGet(route.GET, "leagueId=79999&teamId=7")).status, 404);
  } finally {
    if (priorEnv.enabled === undefined) delete process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT;
    else process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT = priorEnv.enabled;
    if (priorEnv.path === undefined) delete process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH;
    else process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH = priorEnv.path;
    if (priorEnv.revision === undefined) delete process.env.DRAFTFORGE_RELEASE_REVISION;
    else process.env.DRAFTFORGE_RELEASE_REVISION = priorEnv.revision;
    if (priorEnv.startedAt === undefined) delete process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT;
    else process.env.DRAFTFORGE_SERVER_INSTANCE_STARTED_AT = priorEnv.startedAt;
    await rm(directory, { recursive: true, force: true });
  }
});
