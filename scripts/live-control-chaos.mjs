#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { liveControlFixturePayload, startLiveControlFixture } from "./live-control-fixture.mjs";
import { runLiveControlMonitor } from "./live-control-monitor.mjs";

const BASE_OPTIONS = {
  leagueId: "1603083723",
  teamId: 6,
  polls: 1,
  intervalMs: 10,
  timeoutMs: 150,
  maxBytes: 16_384,
  maxContextAgeMs: 1_000,
  maxPickAgeMs: 4_000,
  maxSourceAgeMs: 900_000,
  quiet: true,
};

function requestedSince(request) {
  const value = Number(new URL(request.url || "/", "http://127.0.0.1").searchParams.get("since") || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function expectedFailure(name, fixtureOptions, expectedCode, optionOverrides = {}) {
  const fixture = await startLiveControlFixture(fixtureOptions);
  const startedAt = performance.now();
  try {
    await runLiveControlMonitor({ ...BASE_OPTIONS, ...optionOverrides, origin: fixture.origin });
    return { name, passed: false, expectedCode, observedCode: "UNEXPECTED_SUCCESS", durationMs: performance.now() - startedAt };
  } catch (error) {
    const observedCode = error?.code || (error instanceof Error ? error.message.split(":")[0] : String(error));
    return { name, passed: observedCode === expectedCode, expectedCode, observedCode, durationMs: performance.now() - startedAt };
  } finally {
    await fixture.close();
  }
}

export async function runLiveControlChaosSuite() {
  const cases = [];
  const healthy = await startLiveControlFixture();
  try {
    const result = await runLiveControlMonitor({ ...BASE_OPTIONS, origin: healthy.origin, polls: 3 });
    cases.push({
      name: "bounded healthy polling",
      passed: result.ok && result.polls === 3 && healthy.stats.requests === 3 && healthy.stats.methods.every((method) => method === "GET"),
      observedCode: result.code,
      durationMs: result.latencyMs.max,
    });
  } finally {
    await healthy.close();
  }

  cases.push(await expectedFailure(
    "hung status response times out",
    { responder: () => ({ hang: true }) },
    "LIVE_CONTROL_TIMEOUT",
  ));
  cases.push(await expectedFailure(
    "oversized response is rejected before parsing",
    { responder: () => ({ status: 200, body: `${JSON.stringify(liveControlFixturePayload())}${" ".repeat(20_000)}` }) },
    "LIVE_CONTROL_RESPONSE_TOO_LARGE",
  ));
  cases.push(await expectedFailure(
    "HTTP failure is fail closed",
    { responder: () => ({ status: 503, body: { ok: false, code: "FIXTURE_UNAVAILABLE" } }) },
    "LIVE_CONTROL_HTTP_503",
  ));
  cases.push(await expectedFailure(
    "stale ESPN context is rejected",
    {
      responder: ({ request }) => ({
        status: 200,
        body: liveControlFixturePayload({ since: requestedSince(request), overrides: { agesMs: { espnContext: 5_000, pickFeed: 0, sourceSnapshot: 0, lastAction: null } } }),
      }),
    },
    "LIVE_CONTROL_STALE",
  ));
  cases.push(await expectedFailure(
    "sequence regression is rejected",
    {
      responder: ({ request, requestNumber }) => ({
        status: 200,
        body: liveControlFixturePayload({ sequence: requestNumber === 1 ? 9 : 8, since: requestedSince(request) }),
      }),
    },
    "LIVE_CONTROL_SEQUENCE_REGRESSION",
    { polls: 2 },
  ));
  cases.push(await expectedFailure(
    "wrong league identity is rejected",
    {
      responder: ({ request }) => ({
        status: 200,
        body: { ...liveControlFixturePayload({ since: requestedSince(request) }), league: { id: "999", teamId: 6, draftType: "SNAKE" } },
      }),
    },
    "LIVE_CONTROL_IDENTITY_MISMATCH",
  ));
  cases.push(await expectedFailure(
    "publisher session replacement is rejected",
    {
      responder: ({ request, requestNumber }) => ({
        status: 200,
        body: liveControlFixturePayload({ since: requestedSince(request), overrides: { sessionId: requestNumber === 1 ? "session-a" : "session-b" } }),
      }),
    },
    "LIVE_CONTROL_SESSION_CHANGED",
    { polls: 2 },
  ));
  cases.push(await expectedFailure(
    "connection reset is fail closed",
    { responder: () => ({ destroy: true }) },
    "LIVE_CONTROL_TRANSPORT_ERROR",
  ));

  const failures = cases.filter((entry) => !entry.passed);
  return {
    ok: failures.length === 0,
    code: failures.length ? "LIVE_CONTROL_CHAOS_FAILED" : "LIVE_CONTROL_CHAOS_PASSED",
    cases,
    failures: failures.map((entry) => entry.name),
  };
}

async function main() {
  try {
    const result = await runLiveControlChaosSuite();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: "LIVE_CONTROL_CHAOS_FAILED", message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
