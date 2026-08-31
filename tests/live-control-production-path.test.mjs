import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PRODUCTION_PATH_MEMORY_BUDGETS,
  evaluateProductionPathMemory,
  percentile,
  runObserverCadence,
  runCertifiedLiveControlProductionPath,
  runLiveControlProductionPath,
} from "../scripts/live-control-production-path.mjs";
import {
  CONTENTION_MEMORY_BUDGETS,
  contentionCadencePlan,
  evaluateContentionMemory,
  runLiveControlContention,
} from "../scripts/live-control-contention.mjs";

test("production-path percentile accounting is deterministic", () => {
  assert.equal(percentile([8, 2, 5, 1, 9], .5), 5);
  assert.equal(percentile([8, 2, 5, 1, 9], .95), 9);
  assert.equal(percentile([], .99), Number.POSITIVE_INFINITY);
});

test("production-path memory gate bounds absolute RSS and post-GC retention", async () => {
  const mib = 1024 * 1024;
  const allocatorExpansion = evaluateProductionPathMemory({
    baselineRss: 100 * mib,
    peakRss: 225 * mib,
  });
  assert.equal(allocatorExpansion.passed, true);
  assert.equal(allocatorExpansion.rssGrowthMb, 125);
  assert.equal(allocatorExpansion.checks.peakRss, true);

  const overAbsoluteCeiling = evaluateProductionPathMemory({
    baselineRss: 100 * mib,
    peakRss: (PRODUCTION_PATH_MEMORY_BUDGETS.peakRssMb + 1) * mib,
  });
  assert.equal(overAbsoluteCeiling.passed, false);
  assert.equal(overAbsoluteCeiling.checks.peakRss, false);

  const invalid = evaluateProductionPathMemory({ baselineRss: 0, peakRss: 0 });
  assert.equal(invalid.passed, false);
  assert.equal(invalid.checks.measurements, false);

  const baseline = { rss: 110 * mib, heapUsed: 16 * mib, external: 8 * mib };
  const retained = evaluateProductionPathMemory({
    baseline,
    postRun: { rss: 180 * mib, heapUsed: 32 * mib, external: 9 * mib },
    peakRss: 350 * mib,
    requireRetention: true,
  });
  assert.equal(retained.passed, true);
  assert.deepEqual(retained.checks, {
    measurements: true,
    peakRss: true,
    postGcHeap: true,
    postGcExternal: true,
    retainedHeap: true,
    retainedExternal: true,
  });
  assert.deepEqual(retained.retainedGrowthMb, { heapUsed: 16, external: 1 });

  for (const [label, input, failedCheck] of [
    ["post-GC heap", { postRun: { rss: 180 * mib, heapUsed: 65 * mib, external: 9 * mib }, peakRss: 350 * mib }, "postGcHeap"],
    ["post-GC external", { postRun: { rss: 180 * mib, heapUsed: 32 * mib, external: 33 * mib }, peakRss: 350 * mib }, "postGcExternal"],
    ["retained heap", { postRun: { rss: 180 * mib, heapUsed: 41 * mib, external: 9 * mib }, peakRss: 350 * mib }, "retainedHeap"],
    ["retained external", { postRun: { rss: 180 * mib, heapUsed: 32 * mib, external: 13 * mib }, peakRss: 350 * mib }, "retainedExternal"],
    ["absolute peak", { postRun: { rss: 180 * mib, heapUsed: 32 * mib, external: 9 * mib }, peakRss: 385 * mib }, "peakRss"],
  ]) {
    const failed = evaluateProductionPathMemory({ baseline, ...input, requireRetention: true });
    assert.equal(failed.passed, false, label);
    assert.equal(failed.checks[failedCheck], false, label);
  }

  if (typeof globalThis.gc !== "function") {
    await assert.rejects(
      runCertifiedLiveControlProductionPath({ observerDurationMs: 1_000, actionSamplesPerOperation: 5 }),
      /PRODUCTION_PATH_REQUIRES_EXPOSE_GC/,
    );
  }
});

test("contention cadences are phase-separated with meaningful tail samples", () => {
  const plan = contentionCadencePlan();
  assert.deepEqual(plan, {
    normalObserver: { intervalMs: 1_000, phaseOffsetMs: 0, samples: 25 },
    burstObserver: { intervalMs: 250, phaseOffsetMs: 62.5, samples: 100 },
    writer: { intervalMs: 500, phaseOffsetMs: 125, samples: 50 },
    availability: { intervalMs: 250, phaseOffsetMs: 187.5, samples: 100 },
  });
  assert.equal(plan.normalObserver.samples + plan.burstObserver.samples, 125);
  assert.equal(new Set(Object.values(plan).map((cadence) => cadence.phaseOffsetMs)).size, 4);
  assert.throws(() => contentionCadencePlan(4_999), /CONTENTION_DURATION/);
  assert.throws(() => contentionCadencePlan(25_001), /CONTENTION_DURATION/);
});

test("contention memory gate distinguishes allocator RSS expansion from post-GC retention", () => {
  const mib = 1024 * 1024;
  const baseline = { rss: 116 * mib, heapUsed: 14 * mib, external: 8 * mib };
  const allocatorExpansion = evaluateContentionMemory({
    baseline,
    postRun: { rss: 141 * mib, heapUsed: 14.5 * mib, external: 8.25 * mib },
    peakRss: 145 * mib,
  });
  assert.equal(allocatorExpansion.passed, true);
  assert.equal(allocatorExpansion.checks.peakRss, true);
  assert.equal(allocatorExpansion.retainedGrowthMb.heapUsed, .5);
  assert.equal(allocatorExpansion.retainedGrowthMb.external, .25);

  for (const [label, input, failedCheck] of [
    ["absolute peak RSS", {
      baseline,
      postRun: baseline,
      peakRss: (CONTENTION_MEMORY_BUDGETS.peakRssMb + 1) * mib,
    }, "peakRss"],
    ["retained heap", {
      baseline,
      postRun: { ...baseline, heapUsed: baseline.heapUsed + (CONTENTION_MEMORY_BUDGETS.retainedHeapGrowthMb + .01) * mib },
      peakRss: 150 * mib,
    }, "retainedHeap"],
    ["retained external", {
      baseline,
      postRun: { ...baseline, external: baseline.external + (CONTENTION_MEMORY_BUDGETS.retainedExternalGrowthMb + .01) * mib },
      peakRss: 150 * mib,
    }, "retainedExternal"],
    ["absolute post-GC heap", {
      baseline,
      postRun: { ...baseline, heapUsed: (CONTENTION_MEMORY_BUDGETS.postGcHeapUsedMb + 1) * mib },
      peakRss: 150 * mib,
    }, "postGcHeap"],
    ["absolute post-GC external", {
      baseline,
      postRun: { ...baseline, external: (CONTENTION_MEMORY_BUDGETS.postGcExternalMb + 1) * mib },
      peakRss: 150 * mib,
    }, "postGcExternal"],
    ["missing measurements", {
      baseline: {},
      postRun: {},
      peakRss: 0,
    }, "measurements"],
  ]) {
    const result = evaluateContentionMemory(input);
    assert.equal(result.passed, false, label);
    assert.equal(result.checks[failedCheck], false, label);
  }
});

test("contention retention certification fails closed without exposed full GC", async () => {
  if (typeof globalThis.gc === "function") return;
  await assert.rejects(
    runLiveControlContention({ durationMs: 5_000 }),
    /CONTENTION_REQUIRES_EXPOSE_GC/,
  );
});

test("the production-path probe is a first-class package and release-gate command", async () => {
  const [packageJson, releaseGate] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/live-control-release-gate.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(JSON.parse(packageJson).scripts["test:production-path"], "node --expose-gc scripts/live-control-production-path.mjs");
  assert.equal(JSON.parse(packageJson).scripts["test:contention"], "node --expose-gc scripts/live-control-contention.mjs");
  assert.match(releaseGate, /runBoundedNode\(\["--expose-gc", "scripts\/live-control-production-path\.mjs"\], 30_000\)/);
  assert.match(releaseGate, /runBoundedNode\(\["--expose-gc", "scripts\/live-control-contention\.mjs"\], 40_000\)/);
  assert.match(releaseGate, /"tests\/live-control-production-path\.test\.mjs"/);
  assert.match(releaseGate, /contentionWarmSeconds: 5/);
  assert.match(releaseGate, /productionContentionSeconds: 25/);
});

test("observer attribution isolates synchronous observer writes from concurrent action tracking", async () => {
  let trackingRevision = 0;
  const content = {
    observe: () => ({ inDraftRoom: true }),
    trackingFingerprint: () => String(trackingRevision),
    hasCachedProducerContext: () => true,
  };
  const concurrentWriter = await runObserverCadence({
    durationMs: 1,
    intervalMs: 10,
    content,
    controlUrl: "http://127.0.0.1/control",
    expectedSequence: 7,
    readJsonImpl: async () => {
      trackingRevision += 1;
      return { status: 200, body: { control: { sequence: 7 } }, latencyMs: 1 };
    },
  });
  assert.equal(trackingRevision, 1, "the fixture must advance tracking during the route await");
  assert.equal(concurrentWriter.observerWrites, 0);
  assert.deepEqual(concurrentWriter.errors, []);

  trackingRevision = 0;
  const mutatingObserver = await runObserverCadence({
    durationMs: 1,
    intervalMs: 10,
    content: {
      observe() {
        trackingRevision += 1;
        return { inDraftRoom: true };
      },
      trackingFingerprint: () => String(trackingRevision),
      hasCachedProducerContext: () => true,
    },
    controlUrl: "http://127.0.0.1/control",
    expectedSequence: 7,
    readJsonImpl: async () => assert.fail("a mutating observer must fail before route I/O"),
  });
  assert.equal(mutatingObserver.observerWrites, 1);
  assert.deepEqual(mutatingObserver.errors, ["OBSERVER_MUTATED_CONTENT_STATE"]);

  const missingCache = await runObserverCadence({
    durationMs: 1,
    intervalMs: 10,
    content: {
      observe: () => assert.fail("an unprimed observer must fail before reading content"),
      trackingFingerprint: () => assert.fail("an unprimed observer must fail before fingerprinting content"),
    },
    controlUrl: "http://127.0.0.1/control",
    expectedSequence: 7,
    readJsonImpl: async () => assert.fail("an unprimed observer must fail before route I/O"),
  });
  assert.equal(missingCache.observerWrites, 0);
  assert.deepEqual(missingCache.errors, ["OBSERVER_PRODUCER_CACHE_MISSING"]);
});

test("the bounded production path covers snake and salary-cap actions under churn and observer pressure", async () => {
  const result = await runLiveControlProductionPath({
    observerDurationMs: 1_000,
    actionSamplesPerOperation: 5,
    enforcePerformance: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.code, "LIVE_CONTROL_PRODUCTION_PATH_PASSED");
  assert.deepEqual(result.scenario.formats, ["SNAKE", "AUCTION"]);
  assert.equal(result.scenario.bidChurnMs, 75);
  assert.deepEqual(result.scenario.observerCadenceHz, [1, 4]);
  assert.equal(result.scenario.producerDeliveries.staleRejected, 2);
  assert.equal(result.scenario.samplesPerOperation, 5);
  assert.equal(result.scenario.physicalClicks, 22);
  assert.equal(result.scenario.preliminaryNominationClicks, 5);
  assert.equal(result.scenario.exactAcknowledgements, 22);
  assert.equal(result.scenario.observerWrites, 0);
  assert.deepEqual(result.scenario.bindingRevocation, {
    code: "ACTION_BINDING_REVOKED",
    cancellationMessages: 1,
  });
  assert.deepEqual(result.scenario.snakeObserverOverlap, {
    delayedConfirmationMs: 450,
    physicalClicks: 1,
    exactAcknowledgements: 1,
    observerSamples: { normal: 1, burst: 4 },
    boardObserverSamples: { normal: 1, burst: 4 },
    statusObserverSamples: { normal: 1, burst: 4 },
    observerWrites: 0,
    maximumInFlight: 1,
  });
  assert.deepEqual(result.scenario.resultCodes, {
    SELECT: { ROSTER_CONFIRMED: 5 },
    NOMINATE: { NOMINATION_CONFIRMED: 5 },
    BID_INCREMENTAL: { BID_SUPERSEDED: 1, BID_CONFIRMED: 4 },
    BID_CUSTOM: { BID_SUPERSEDED: 1, BID_CONFIRMED: 4 },
  });
  assert.deepEqual(result.scenario.settlement, {
    playerId: 10001,
    amount: 9,
    remainingBudget: 191,
    maxLegalBid: 177,
    rosterAmount: 9,
    nextPlayerId: 10002,
    nextCurrentBid: 1,
    pending: false,
  });
  for (const operation of ["SELECT", "NOMINATE", "BID_INCREMENTAL", "BID_CUSTOM"]) {
    assert.equal(result.latencyMs.actionByOperation[operation].count, 5);
    assert.ok(result.latencyMs.actionByOperation[operation].p95 <= 1_000);
    assert.ok(result.latencyMs.actionByOperation[operation].p99 <= 1_500);
  }
  assert.equal(result.resources.maximumActiveAuditPosts, 1);
  assert.equal(result.resources.queue.maximumInFlight <= 1, true);
  assert.equal(result.resources.queue.matrixMaximumInFlight <= 1, true);
  assert.equal(result.resources.queue.final.inFlight, 0);
  assert.deepEqual(result.observers.errors, []);
  assert.deepEqual(result.observers.snake.boardActual, { normal: 1, burst: 4 });
  assert.equal(Number.isFinite(result.latencyMs.snakeBoardRoute.p99), true);
  assert.equal(Number.isFinite(result.latencyMs.statusRoute.p99), true);
  assert.equal(Number.isFinite(result.latencyMs.snakeStatusRoute.p99), true);
  assert.equal(result.scenario.persistentCheckpoint.enabled, true);
  assert.equal(result.scenario.persistentCheckpoint.entries, 4);
  assert.equal(result.scenario.persistentCheckpoint.minimumPreseedBytes, Math.ceil(1.8 * 1024 * 1024));
  assert.ok(result.scenario.persistentCheckpoint.preseedBytes >= Math.ceil(1.8 * 1024 * 1024));
  assert.ok(result.scenario.persistentCheckpoint.preseedBytes <= 2 * 1024 * 1024);
  assert.equal(result.scenario.persistentCheckpoint.preseedEntryBytes.length, 4);
  assert.ok(result.scenario.persistentCheckpoint.preseedEntryBytes.every((bytes) => bytes <= 508 * 1024));
  assert.equal(result.scenario.persistentCheckpoint.plannedDiskAck, true);
  assert.equal(result.scenario.persistentCheckpoint.finalDiskAck, true);
  assert.ok(result.scenario.persistentCheckpoint.finalBytes <= 2 * 1024 * 1024);
  assert.deepEqual(result.scenario.criticalAuditChurn, {
    writes: 12,
    intervalMs: 75,
    diskAcknowledgements: 13,
    maximumActiveWriters: 1,
    observerSamples: { normal: 1, burst: 4 },
    observerWrites: 0,
    observerErrors: [],
    finalCheckpointBytes: result.scenario.criticalAuditChurn.finalCheckpointBytes,
    finalSequence: 23,
  });
  assert.ok(result.scenario.criticalAuditChurn.finalCheckpointBytes <= 2 * 1024 * 1024);
  assert.equal(result.latencyMs.criticalAuditPosts.count, 12);
  assert.equal(Number.isFinite(result.latencyMs.criticalAuditPosts.p99), true);
  assert.ok([
    "INITIAL",
    "PRESEED",
    "ACTION_MATRIX",
    "CHECKPOINT_CHURN",
    "SNAKE_OVERLAP",
    "FINAL_AUCTION",
  ].includes(result.resources.peakRssPhase));
  assert.equal(result.resources.performanceEnforced, false);
  assert.deepEqual(result.finalControl, { sequence: 5, pendingActionCount: 0, eventCount: 5 });
});
