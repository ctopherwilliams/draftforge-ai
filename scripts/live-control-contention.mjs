#!/usr/bin/env node

import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { appendLiveControlEvent, createLiveControlState } from "../app/lib/live-control.ts";
import * as availabilityRoute from "../app/api/availability/route.ts";
import * as draftDayRoute from "../app/api/draft-day/route.ts";

const OPERATOR_ORIGIN = "http://127.0.0.1:3000";
const REQUEST_TIMEOUT_MS = 300;
const CONTENTION_DURATION_MS = 25_000;
const CONTENTION_WARM_DURATION_MS = 5_000;
const MIB = 1024 * 1024;
export const CONTENTION_MEMORY_BUDGETS = Object.freeze({
  peakRssMb: 300,
  postGcHeapUsedMb: 64,
  postGcExternalMb: 32,
  retainedHeapGrowthMb: 4,
  retainedExternalGrowthMb: 2,
});
const CONTENTION_CADENCES = Object.freeze({
  normalObserver: Object.freeze({ intervalMs: 1_000, phaseOffsetMs: 0 }),
  burstObserver: Object.freeze({ intervalMs: 250, phaseOffsetMs: 62.5 }),
  writer: Object.freeze({ intervalMs: 500, phaseOffsetMs: 125 }),
  availability: Object.freeze({ intervalMs: 250, phaseOffsetMs: 187.5 }),
});

export function contentionCadencePlan(durationMs = CONTENTION_DURATION_MS) {
  if (!Number.isInteger(durationMs) || durationMs < 5_000 || durationMs > CONTENTION_DURATION_MS) {
    throw new Error("CONTENTION_DURATION_MUST_BE_5000_TO_25000_MS");
  }
  return Object.fromEntries(Object.entries(CONTENTION_CADENCES).map(([name, cadence]) => [name, {
    ...cadence,
    samples: Math.ceil(durationMs / cadence.intervalMs),
  }]));
}

function percentile(values, quantile) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)];
}

function summarize(values) {
  return {
    count: values.length,
    p50: percentile(values, .5),
    p95: percentile(values, .95),
    p99: percentile(values, .99),
    max: values.length ? Math.max(...values) : null,
  };
}

function memoryMb(bytes) {
  return Number(bytes || 0) / MIB;
}

export function evaluateContentionMemory({ baseline, postRun, peakRss }) {
  const validMeasurements = [baseline?.rss, baseline?.heapUsed, baseline?.external,
    postRun?.rss, postRun?.heapUsed, postRun?.external, peakRss]
    .every((value) => Number.isFinite(value) && value >= 0)
    && Number(baseline?.rss) > 0
    && Number(baseline?.heapUsed) > 0
    && Number(postRun?.rss) > 0
    && Number(postRun?.heapUsed) > 0
    && Number(peakRss) >= Number(baseline?.rss);
  const baselineHeapUsedMb = memoryMb(baseline?.heapUsed);
  const baselineExternalMb = memoryMb(baseline?.external);
  const postGcHeapUsedMb = memoryMb(postRun?.heapUsed);
  const postGcExternalMb = memoryMb(postRun?.external);
  const retainedHeapGrowthMb = Math.max(0, postGcHeapUsedMb - baselineHeapUsedMb);
  const retainedExternalGrowthMb = Math.max(0, postGcExternalMb - baselineExternalMb);
  const peakRssMb = memoryMb(peakRss);
  const checks = {
    measurements: validMeasurements,
    peakRss: peakRssMb <= CONTENTION_MEMORY_BUDGETS.peakRssMb,
    postGcHeap: postGcHeapUsedMb <= CONTENTION_MEMORY_BUDGETS.postGcHeapUsedMb,
    postGcExternal: postGcExternalMb <= CONTENTION_MEMORY_BUDGETS.postGcExternalMb,
    retainedHeap: retainedHeapGrowthMb <= CONTENTION_MEMORY_BUDGETS.retainedHeapGrowthMb,
    retainedExternal: retainedExternalGrowthMb <= CONTENTION_MEMORY_BUDGETS.retainedExternalGrowthMb,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    baselinePostGc: {
      rssMb: memoryMb(baseline?.rss),
      heapUsedMb: baselineHeapUsedMb,
      externalMb: baselineExternalMb,
    },
    postRunGc: {
      rssMb: memoryMb(postRun?.rss),
      heapUsedMb: postGcHeapUsedMb,
      externalMb: postGcExternalMb,
    },
    retainedGrowthMb: {
      heapUsed: retainedHeapGrowthMb,
      external: retainedExternalGrowthMb,
    },
    peakRssMb,
  };
}

async function collectPostGcMemory() {
  if (typeof globalThis.gc !== "function") {
    throw new Error("CONTENTION_REQUIRES_EXPOSE_GC");
  }
  // GC and one event-loop turn are deliberately outside every latency epoch.
  // Repeating the pair drains fetch/body finalizers without adding artificial
  // pauses to the response-time samples being certified.
  for (let cycle = 0; cycle < 4; cycle += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return process.memoryUsage();
}

function timestamp(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function maxLedgerAudit() {
  const capturedAt = timestamp(-1_000);
  let liveControl = createLiveControlState("contention-session-20260828", {
    espnContextAt: capturedAt,
    pickFeedAt: capturedAt,
    pickFeedObservedAt: capturedAt,
    sourceSnapshotAt: capturedAt,
    lastActionAt: null,
  });
  for (let index = 0; index < 256; index += 1) {
    liveControl = appendLiveControlEvent(liveControl, {
      occurredAt: new Date(Date.parse(capturedAt) + index).toISOString(),
      kind: "SAFETY",
      condition: "CODE_FREEZE",
      active: false,
      code: "CODE_FREEZE_READY",
    });
  }
  return {
    schemaVersion: 1,
    capturedAt,
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
      scoringRules: 45,
      keeperCount: 0,
      lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "23": 1 },
      positionLimits: { "1": 4, "2": 8, "3": 8, "4": 3, "16": 1, "17": 1 },
    },
    binding: {
      tabId: 7001,
      commandCenterSessionId: "contention-writer-20260828",
      commandCenterStartedAt: capturedAt,
      authenticatedImportAt: capturedAt,
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
      soundMuted: true,
      autopickActive: false,
      autoDraft: false,
      sourceCoverage: 5,
      sourceIds: ["espn", "ffc", "mfl", "tradyr", "gng"],
      sourceSnapshotId: `sha256:${"c".repeat(64)}`,
      sourceSnapshotGeneratedAt: capturedAt,
      actionState: "Contention certification fixture",
    },
    draft: { totalPicks: 0, appRoster: [], espnRoster: [] },
    telemetry: { actions: [] },
    salaryCapEvidence: { sales: [] },
    sleeperEvidence: { candidateCount: 0, candidates: [] },
    availability: {
      status: "READY",
      digest: `sha256:${"b".repeat(64)}`,
      evaluatedAt: capturedAt,
      freshUntil: timestamp(20 * 60_000),
      blockingReasons: [],
      vetoedPlayerIds: [],
    },
    liveControl,
  };
}

async function readNodeBody(request, maximum = 512 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("CONTENT_LENGTH_EXCEEDED");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function startProductionRouteServer() {
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      const body = ["GET", "HEAD"].includes(request.method || "GET") ? undefined : await readNodeBody(request);
      const target = new URL(request.url || "/", "http://127.0.0.1");
      const route = target.pathname === "/api/draft-day"
        ? draftDayRoute
        : target.pathname === "/api/availability"
          ? availabilityRoute
          : null;
      const handler = route?.[String(request.method || "GET").toUpperCase()];
      if (typeof handler !== "function") {
        response.writeHead(route ? 405 : 404).end();
        return;
      }
      const webRequest = new Request(`http://127.0.0.1${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
      });
      const webResponse = await handler(webRequest);
      const responseBody = Buffer.from(await webResponse.arrayBuffer());
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
      response.end(responseBody);
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, code: "CONTENTION_ROUTE_FAILURE" }));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CONTENTION_BIND_FAILED");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function measuredFetch(url, init = {}, expectedStatus = 200) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) throw new Error(`HTTP_${response.status}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("INVALID_JSON");
  }
  return { latencyMs: performance.now() - startedAt, bytes: Buffer.byteLength(text), body };
}

async function runCadence({ samples: sampleCount, intervalMs, phaseOffsetMs, startedAt, operation }) {
  const samples = [];
  const errors = [];
  let target = startedAt + phaseOffsetMs;
  for (let index = 0; index < sampleCount; index += 1) {
    const waitMs = target - performance.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      samples.push(await operation());
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    target += intervalMs;
  }
  return { samples, errors };
}

async function runContentionEpoch({ cadencePlan, compactUrl, availabilityUrl, auditUrl, commonHeaders, jsonHeaders, audit }) {
  const cadenceStartedAt = performance.now() + 25;
  // The browser serializes the audit outside the server process in production.
  // Keep that fixed client-side allocation out of the measured server event
  // loop so this gate isolates the route and mutation queue under contention.
  const auditRequestBody = JSON.stringify({ operation: "AUDIT", audit });
  const [normalObserver, burstObserver, writer, availability] = await Promise.all([
    runCadence({
      ...cadencePlan.normalObserver,
      startedAt: cadenceStartedAt,
      operation: () => measuredFetch(compactUrl, { headers: commonHeaders }),
    }),
    runCadence({
      ...cadencePlan.burstObserver,
      startedAt: cadenceStartedAt,
      operation: () => measuredFetch(compactUrl, { headers: commonHeaders }),
    }),
    runCadence({
      ...cadencePlan.writer,
      startedAt: cadenceStartedAt,
      operation: () => measuredFetch(auditUrl, {
        method: "POST",
        headers: jsonHeaders,
        body: auditRequestBody,
      }),
    }),
    runCadence({
      ...cadencePlan.availability,
      startedAt: cadenceStartedAt,
      operation: () => measuredFetch(availabilityUrl, { headers: commonHeaders }),
    }),
  ]);
  return { normalObserver, burstObserver, writer, availability };
}

function epochCounts(epoch) {
  return {
    normalObserver: epoch.normalObserver.samples.length,
    burstObserver: epoch.burstObserver.samples.length,
    writer: epoch.writer.samples.length,
    availability: epoch.availability.samples.length,
  };
}

function epochErrors(epoch) {
  return [
    ...epoch.normalObserver.errors,
    ...epoch.burstObserver.errors,
    ...epoch.writer.errors,
    ...epoch.availability.errors,
  ];
}

function stableControl(body) {
  return JSON.stringify({
    sessionId: body.control.sessionId,
    sequence: body.control.sequence,
    decision: body.control.decision,
    freshness: body.control.freshness,
    rosterAttributions: body.control.rosterAttributions,
    events: body.control.events,
  });
}

export async function runLiveControlContention({ durationMs = CONTENTION_DURATION_MS } = {}) {
  if (typeof globalThis.gc !== "function") throw new Error("CONTENTION_REQUIRES_EXPOSE_GC");
  const cadencePlan = contentionCadencePlan(durationMs);
  const warmCadencePlan = contentionCadencePlan(CONTENTION_WARM_DURATION_MS);
  const server = await startProductionRouteServer();
  let peakRss = process.memoryUsage().rss;
  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  memorySampler.unref();
  const audit = maxLedgerAudit();
  const commonHeaders = { origin: OPERATOR_ORIGIN };
  const jsonHeaders = { ...commonHeaders, "content-type": "application/json" };
  const controlUrl = `${server.origin}/api/draft-day?view=control&leagueId=${audit.league.id}&teamId=${audit.league.teamId}&since=0`;
  const compactUrl = `${server.origin}/api/draft-day?view=control&leagueId=${audit.league.id}&teamId=${audit.league.teamId}&since=256`;
  const availabilityUrl = `${server.origin}/api/availability`;
  const auditUrl = `${server.origin}/api/draft-day`;
  try {
    const policy = JSON.parse(await readFile(new URL("../config/availability-veto.policy.example.json", import.meta.url), "utf8"));
    const retrievedAt = timestamp(-2_000);
    const artifact = {
      schemaVersion: "draftforge.availability/v1",
      generatedAt: timestamp(-1_000),
      scanReceipt: {
        completedAt: timestamp(-1_500),
        feeds: [
          { id: "authenticated_espn_player_news", url: "https://fantasy.espn.com/football/playernews", retrievedAt, status: "ok" },
          { id: "official_nfl_news", url: "https://www.nfl.com/news/", retrievedAt, status: "ok" },
        ],
      },
      records: [],
    };
    const staged = await measuredFetch(availabilityUrl, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ artifact, policy }),
    });
    if (staged.body.code !== "AVAILABILITY_STAGE_RECORDED") throw new Error("AVAILABILITY_STAGE_FAILED");
    const recorded = await measuredFetch(auditUrl, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ operation: "AUDIT", audit }),
    });
    if (recorded.body.code !== "DRAFT_AUDIT_RECORDED") throw new Error("AUDIT_STAGE_FAILED");

    // Warm the same concurrent readers, writer, route adapters, fetch pool, and
    // JSON serialization paths used by the measured epoch. Memory retained by
    // this one-time initialization belongs in the baseline, not in a leak rate.
    let warmEpoch = await runContentionEpoch({
      cadencePlan: warmCadencePlan,
      compactUrl,
      availabilityUrl,
      auditUrl,
      commonHeaders,
      jsonHeaders,
      audit,
    });
    const warmExpectedCounts = Object.fromEntries(Object.entries(warmCadencePlan)
      .map(([name, cadence]) => [name, cadence.samples]));
    const warmActualCounts = epochCounts(warmEpoch);
    const warmErrors = epochErrors(warmEpoch);
    const warmComplete = warmErrors.length === 0
      && Object.entries(warmExpectedCounts).every(([key, count]) => warmActualCounts[key] === count);
    warmEpoch = null;

    let before = await measuredFetch(controlUrl, { headers: commonHeaders });
    const stableBefore = stableControl(before.body);
    const sequenceBefore = before.body.control.sequence;
    const beforeBytes = before.bytes;
    let baselineControl = [];
    let baselineAvailability = [];
    for (let index = 0; index < 50; index += 1) {
      const control = await measuredFetch(compactUrl, { headers: commonHeaders });
      const availability = await measuredFetch(availabilityUrl, { headers: commonHeaders });
      baselineControl.push(control.latencyMs);
      baselineAvailability.push(availability.latencyMs);
    }
    const baselineControlSummary = summarize(baselineControl);
    const baselineAvailabilitySummary = summarize(baselineAvailability);
    baselineControl = null;
    baselineAvailability = null;
    before = null;

    // The retained-memory baseline is taken only after warm-up and full GC.
    // No GC executes inside the latency/event-loop measurement window.
    const baselineMemory = await collectPostGcMemory();

    let eventLoop = monitorEventLoopDelay({ resolution: 10 });
    peakRss = Math.max(peakRss, baselineMemory.rss);
    eventLoop.enable();
    let measuredEpoch;
    try {
      measuredEpoch = await runContentionEpoch({
        cadencePlan,
        compactUrl,
        availabilityUrl,
        auditUrl,
        commonHeaders,
        jsonHeaders,
        audit,
      });
    } finally {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      eventLoop.disable();
    }
    let after = await measuredFetch(controlUrl, { headers: commonHeaders });
    let controlLatencies = [
      ...measuredEpoch.normalObserver.samples,
      ...measuredEpoch.burstObserver.samples,
    ].map((sample) => sample.latencyMs);
    let availabilityLatencies = measuredEpoch.availability.samples.map((sample) => sample.latencyMs);
    let writerLatencies = measuredEpoch.writer.samples.map((sample) => sample.latencyMs);
    const controlSummary = summarize(controlLatencies);
    const availabilitySummary = summarize(availabilityLatencies);
    const writerSummary = summarize(writerLatencies);
    const eventLoopP99Ms = eventLoop.percentile(99) / 1_000_000;
    const eventLoopMeanMs = eventLoop.mean / 1_000_000;
    const eventLoopMaxMs = eventLoop.max / 1_000_000;
    const errors = [...warmErrors, ...epochErrors(measuredEpoch)];
    const observerAllowanceMs = Math.max(50, baselineControlSummary.p95 * .05);
    const stable = stableBefore === stableControl(after.body);
    const sequenceAfter = after.body.control.sequence;
    const expectedCounts = Object.fromEntries(Object.entries(cadencePlan).map(([name, cadence]) => [name, cadence.samples]));
    const actualCounts = epochCounts(measuredEpoch);
    const maximumControlBytes = Math.max(
      beforeBytes,
      after.bytes,
      ...measuredEpoch.normalObserver.samples.map((sample) => sample.bytes),
      ...measuredEpoch.burstObserver.samples.map((sample) => sample.bytes),
    );

    // Release every measured response body/sample before the post-run GC so
    // only genuinely retained route/fetch state remains eligible to fail.
    measuredEpoch = null;
    after = null;
    controlLatencies = null;
    availabilityLatencies = null;
    writerLatencies = null;
    eventLoop = null;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const postRunMemory = await collectPostGcMemory();
    peakRss = Math.max(peakRss, postRunMemory.rss);
    const memory = evaluateContentionMemory({ baseline: baselineMemory, postRun: postRunMemory, peakRss });
    const passed = errors.length === 0
      && warmComplete
      && Object.entries(expectedCounts).every(([key, count]) => actualCounts[key] === count)
      && stable
      && sequenceBefore === 256
      && sequenceAfter === 256
      && controlSummary.p95 <= 25
      && controlSummary.p99 <= 50
      && controlSummary.p95 <= baselineControlSummary.p95 + observerAllowanceMs
      && availabilitySummary.p95 <= 25
      && availabilitySummary.p99 <= 75
      && writerSummary.p99 <= 100
      && eventLoopP99Ms <= 50
      && memory.passed;
    return {
      ok: passed,
      code: passed ? "LIVE_CONTROL_CONTENTION_PASSED" : "LIVE_CONTROL_CONTENTION_FAILED",
      route: "production handlers over loopback HTTP",
      durationMs,
      cadencePlan,
      warmup: {
        durationMs: CONTENTION_WARM_DURATION_MS,
        cadencePlan: warmCadencePlan,
        counts: { expected: warmExpectedCounts, actual: warmActualCounts },
        complete: warmComplete,
      },
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      ledger: { sequenceBefore, sequenceAfter, stable },
      counts: { expected: expectedCounts, actual: actualCounts },
      latencyMs: {
        baselineControl: baselineControlSummary,
        baselineAvailability: baselineAvailabilitySummary,
        observers: controlSummary,
        writer: writerSummary,
        availability: availabilitySummary,
      },
      budgets: {
        observerP95Ms: 25,
        observerP99Ms: 50,
        observerRegressionAllowanceMs: observerAllowanceMs,
        availabilityP95Ms: 25,
        availabilityP99Ms: 75,
        writerP99Ms: 100,
        eventLoopP99Ms: 50,
        ...CONTENTION_MEMORY_BUDGETS,
      },
      resources: {
        eventLoopDelayMs: {
          mean: eventLoopMeanMs,
          p99: eventLoopP99Ms,
          max: eventLoopMaxMs,
        },
        memory,
      },
      maximumControlBytes,
      errors: errors.slice(0, 10),
    };
  } finally {
    clearInterval(memorySampler);
    await server.close();
  }
}

async function main() {
  try {
    const result = await runLiveControlContention();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: "LIVE_CONTROL_CONTENTION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
