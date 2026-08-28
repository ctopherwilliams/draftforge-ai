#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { startLiveControlFixture } from "./live-control-fixture.mjs";
import { fetchLiveControlSnapshot, normalizeLoopbackOrigin } from "./live-control-monitor.mjs";

function integer(value, name, { minimum, maximum }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function number(value, name, { minimum, maximum }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function parseLiveControlLoadArguments(argv) {
  const values = new Map();
  const flags = new Set();
  const valueNames = new Set([
    "--origin", "--league", "--team", "--requests", "--concurrency", "--timeout-ms",
    "--max-duration-ms", "--max-bytes", "--p95-ms", "--p99-ms", "--max-context-age-ms",
    "--max-pick-age-ms", "--max-source-age-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--fixture", "--full-events", "--require-stable-sequence"].includes(argument)) flags.add(argument);
    else if (valueNames.has(argument)) {
      if (!argv[index + 1]) throw new Error(`${argument} requires a value`);
      values.set(argument, argv[index + 1]);
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  const fixture = flags.has("--fixture") || !values.has("--origin");
  const leagueId = String(values.get("--league") || (fixture ? "1603083723" : ""));
  if (!/^\d{1,20}$/.test(leagueId)) throw new Error("--league must be an exact numeric ESPN league id");
  return {
    fixture,
    origin: values.has("--origin") ? normalizeLoopbackOrigin(values.get("--origin")) : null,
    leagueId,
    teamId: integer(values.get("--team") || (fixture ? 6 : NaN), "--team", { minimum: 1, maximum: 10_000 }),
    requests: integer(values.get("--requests") || 1_000, "--requests", { minimum: 1, maximum: 100_000 }),
    concurrency: integer(values.get("--concurrency") || 8, "--concurrency", { minimum: 1, maximum: 64 }),
    timeoutMs: integer(values.get("--timeout-ms") || 1_000, "--timeout-ms", { minimum: 50, maximum: 10_000 }),
    maxDurationMs: integer(values.get("--max-duration-ms") || 60_000, "--max-duration-ms", { minimum: 100, maximum: 600_000 }),
    maxBytes: integer(values.get("--max-bytes") || 16_384, "--max-bytes", { minimum: 256, maximum: 65_536 }),
    p95BudgetMs: number(values.get("--p95-ms") || 25, "--p95-ms", { minimum: 1, maximum: 10_000 }),
    p99BudgetMs: number(values.get("--p99-ms") || 50, "--p99-ms", { minimum: 1, maximum: 10_000 }),
    maxContextAgeMs: integer(values.get("--max-context-age-ms") || 1_000, "--max-context-age-ms", { minimum: 100, maximum: 60_000 }),
    maxPickAgeMs: integer(values.get("--max-pick-age-ms") || 2_500, "--max-pick-age-ms", { minimum: 100, maximum: 60_000 }),
    maxSourceAgeMs: integer(values.get("--max-source-age-ms") || 900_000, "--max-source-age-ms", { minimum: 1_000, maximum: 86_400_000 }),
    fullEvents: flags.has("--full-events"),
    requireStableSequence: flags.has("--require-stable-sequence") || fixture,
  };
}

function percentile(values, quantile) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)];
}

export async function runLiveControlLoad(options, { fetchImpl = fetch, signal } = {}) {
  const globalController = new AbortController();
  const timeout = setTimeout(() => globalController.abort(new Error("LIVE_CONTROL_LOAD_DEADLINE")), options.maxDurationMs);
  const onAbort = () => globalController.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let fixture = null;
  try {
    fixture = options.fixture ? await startLiveControlFixture() : null;
    const origin = fixture?.origin || options.origin;
    const requestOptions = { ...options, origin, since: 0 };
    const warmup = await fetchLiveControlSnapshot(requestOptions, { fetchImpl, signal: globalController.signal });
    const baselineSequence = warmup.control.sequence;
    const baselineSessionId = warmup.control.sessionId;
    let nextIndex = 0;
    let completed = 0;
    let failed = 0;
    let maxSequence = baselineSequence;
    let maxBytes = warmup.bytes;
    const latencies = [];
    const errors = [];
    const startedAt = performance.now();
    const worker = async () => {
      while (!globalController.signal.aborted) {
        const requestIndex = nextIndex;
        nextIndex += 1;
        if (requestIndex >= options.requests) return;
        try {
          const sample = await fetchLiveControlSnapshot({
            ...requestOptions,
            since: options.fullEvents ? 0 : baselineSequence,
          }, { fetchImpl, signal: globalController.signal });
          if (sample.control.sequence < baselineSequence) throw new Error("LIVE_CONTROL_SEQUENCE_REGRESSION");
          if (sample.control.sessionId !== baselineSessionId) throw new Error("LIVE_CONTROL_SESSION_CHANGED");
          if (options.requireStableSequence && sample.control.sequence !== baselineSequence) {
            throw new Error("LIVE_CONTROL_READ_MUTATED_SEQUENCE");
          }
          maxSequence = Math.max(maxSequence, sample.control.sequence);
          maxBytes = Math.max(maxBytes, sample.bytes);
          latencies.push(sample.latencyMs);
          completed += 1;
        } catch (error) {
          failed += 1;
          if (errors.length < 10) errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, options.requests) }, worker));
    const durationMs = performance.now() - startedAt;
    const p95 = percentile(latencies, .95);
    const p99 = percentile(latencies, .99);
    const deadlineExceeded = globalController.signal.aborted && completed + failed < options.requests;
    const passed = completed === options.requests
      && failed === 0
      && !deadlineExceeded
      && p95 <= options.p95BudgetMs
      && p99 <= options.p99BudgetMs
      && maxBytes <= options.maxBytes;
    return {
      ok: passed,
      code: passed ? "LIVE_CONTROL_LOAD_PASSED" : "LIVE_CONTROL_LOAD_FAILED",
      target: options.fixture ? "bounded-loopback-fixture" : origin,
      requests: options.requests,
      completed,
      failed,
      concurrency: options.concurrency,
      durationMs,
      throughputPerSecond: durationMs > 0 ? completed / (durationMs / 1_000) : completed,
      baselineSequence,
      maxSequence,
      maxBytes,
      latencyMs: { p50: percentile(latencies, .5), p95, p99, max: latencies.length ? Math.max(...latencies) : null },
      budgets: { p95Ms: options.p95BudgetMs, p99Ms: options.p99BudgetMs, maxBytes: options.maxBytes },
      errors,
      deadlineExceeded,
      fixture: fixture ? { requests: fixture.stats.requests, methods: [...new Set(fixture.stats.methods)] } : null,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await fixture?.close();
  }
}

async function main() {
  let options;
  try {
    options = parseLiveControlLoadArguments(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: "USAGE",
      message: error instanceof Error ? error.message : String(error),
      usage: "npm run test:load -- [--fixture] [--origin http://127.0.0.1:3000 --league <id> --team <id>] [--requests 1000]",
    }));
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("LIVE_CONTROL_LOAD_INTERRUPTED"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runLiveControlLoad(options, { signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: "LIVE_CONTROL_LOAD_FAILED", message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
