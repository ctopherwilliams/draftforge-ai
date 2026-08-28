#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function integer(value, name, { minimum, maximum }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function normalizeLoopbackOrigin(value) {
  const url = new URL(String(value || "http://127.0.0.1:3000"));
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password
    || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw new Error("LIVE_CONTROL_ORIGIN_MUST_BE_LOOPBACK_HTTP");
  }
  return url.origin;
}

export function parseLiveControlMonitorArguments(argv) {
  const values = new Map();
  const flags = new Set();
  const valueNames = new Set([
    "--origin", "--league", "--team", "--polls", "--interval-ms", "--timeout-ms",
    "--max-bytes", "--max-context-age-ms", "--max-pick-age-ms", "--max-source-age-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--quiet") flags.add(argument);
    else if (valueNames.has(argument)) {
      if (!argv[index + 1]) throw new Error(`${argument} requires a value`);
      values.set(argument, argv[index + 1]);
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  const leagueId = String(values.get("--league") || "");
  if (!/^\d{1,20}$/.test(leagueId)) throw new Error("--league must be an exact numeric ESPN league id");
  return {
    origin: normalizeLoopbackOrigin(values.get("--origin")),
    leagueId,
    teamId: integer(values.get("--team"), "--team", { minimum: 1, maximum: 10_000 }),
    polls: integer(values.get("--polls") || 1, "--polls", { minimum: 1, maximum: 20_000 }),
    intervalMs: integer(values.get("--interval-ms") || 1_000, "--interval-ms", { minimum: 10, maximum: 60_000 }),
    timeoutMs: integer(values.get("--timeout-ms") || 1_000, "--timeout-ms", { minimum: 50, maximum: 10_000 }),
    maxBytes: integer(values.get("--max-bytes") || 16_384, "--max-bytes", { minimum: 256, maximum: 65_536 }),
    maxContextAgeMs: integer(values.get("--max-context-age-ms") || 1_000, "--max-context-age-ms", { minimum: 100, maximum: 60_000 }),
    maxPickAgeMs: integer(values.get("--max-pick-age-ms") || 2_500, "--max-pick-age-ms", { minimum: 100, maximum: 60_000 }),
    maxSourceAgeMs: integer(values.get("--max-source-age-ms") || 900_000, "--max-source-age-ms", { minimum: 1_000, maximum: 86_400_000 }),
    quiet: flags.has("--quiet"),
  };
}

function errorWithCode(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

async function readBoundedJson(response, maxBytes, controller) {
  if (!response.body) throw errorWithCode("LIVE_CONTROL_EMPTY_RESPONSE");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    controller.abort(errorWithCode("LIVE_CONTROL_RESPONSE_TOO_LARGE"));
    throw errorWithCode("LIVE_CONTROL_RESPONSE_TOO_LARGE", `${declaredLength} > ${maxBytes}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        controller.abort(errorWithCode("LIVE_CONTROL_RESPONSE_TOO_LARGE"));
        throw errorWithCode("LIVE_CONTROL_RESPONSE_TOO_LARGE", `${size} > ${maxBytes}`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw errorWithCode("LIVE_CONTROL_INVALID_JSON");
  }
  return { payload, size };
}

function validateControl(payload, since, limits) {
  if (!payload || typeof payload !== "object" || payload.ok !== true || payload.code !== "DRAFT_LIVE_CONTROL_READY") {
    throw errorWithCode("LIVE_CONTROL_NOT_READY", String(payload?.code || "UNKNOWN"));
  }
  const control = payload.control;
  if (String(payload.league?.id || "") !== String(limits.leagueId)
    || Number(payload.league?.teamId) !== Number(limits.teamId)) {
    throw errorWithCode("LIVE_CONTROL_IDENTITY_MISMATCH");
  }
  if (!control || typeof control !== "object" || !Number.isSafeInteger(control.sequence) || control.sequence < 0
    || typeof control.sessionId !== "string" || !control.sessionId || !Array.isArray(control.events)
    || typeof control.unchanged !== "boolean"
    || control.events.length > 256 || !control.agesMs
    || !Number.isSafeInteger(control.pendingActionCount) || control.pendingActionCount < 0
    || typeof control.historicalAutopickDetected !== "boolean"
    || typeof control.uncontrolledRosterAdditionDetected !== "boolean"
    || !Number.isSafeInteger(control.unattributedRosterCount) || control.unattributedRosterCount < 0) {
    throw errorWithCode("LIVE_CONTROL_SCHEMA_INVALID");
  }
  if (control.sequence < since) throw errorWithCode("LIVE_CONTROL_SEQUENCE_REGRESSION");
  if (control.sequence === since) {
    if (!control.unchanged || control.events.length !== 0) throw errorWithCode("LIVE_CONTROL_EVENT_GAP");
  } else if (control.unchanged || control.events.length === 0) {
    throw errorWithCode("LIVE_CONTROL_EVENT_GAP");
  }
  let previous = since;
  for (const event of control.events) {
    if (!Number.isSafeInteger(event?.sequence) || event.sequence <= since || event.sequence > control.sequence) {
      throw errorWithCode("LIVE_CONTROL_EVENT_SEQUENCE_INVALID");
    }
    if (event.sequence !== previous + 1) throw errorWithCode("LIVE_CONTROL_EVENT_GAP");
    previous = event.sequence;
  }
  if (control.sequence > since && previous !== control.sequence) throw errorWithCode("LIVE_CONTROL_EVENT_GAP");
  const freshnessFailures = [];
  for (const [field, maximum, code] of [
    ["espnContext", limits.maxContextAgeMs, "ESPN_CONTEXT_STALE"],
    ["pickFeed", limits.maxPickAgeMs, "PICK_FEED_STALE"],
    ["sourceSnapshot", limits.maxSourceAgeMs, "SOURCE_SNAPSHOT_STALE"],
  ]) {
    const age = control.agesMs[field];
    if (!Number.isFinite(age) || age < 0 || age > maximum) freshnessFailures.push(code);
  }
  if (freshnessFailures.length) throw errorWithCode("LIVE_CONTROL_STALE", freshnessFailures.join(","));
  return control;
}

export function liveControlUrl({ origin, leagueId, teamId, since = 0 }) {
  const url = new URL("/api/draft-day", normalizeLoopbackOrigin(origin));
  url.searchParams.set("leagueId", String(leagueId));
  url.searchParams.set("teamId", String(teamId));
  url.searchParams.set("view", "control");
  url.searchParams.set("since", String(since));
  return url;
}

export async function fetchLiveControlSnapshot(options, { fetchImpl = fetch, signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(errorWithCode("LIVE_CONTROL_TIMEOUT")), options.timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort(signal.reason);
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(liveControlUrl(options), {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      signal: controller.signal,
    });
    const { payload, size } = await readBoundedJson(response, options.maxBytes, controller);
    if (!response.ok) throw errorWithCode(`LIVE_CONTROL_HTTP_${response.status}`, String(payload?.code || ""));
    const control = validateControl(payload, options.since || 0, options);
    return { payload, control, bytes: size, latencyMs: performance.now() - startedAt };
  } catch (error) {
    if (controller.signal.aborted && error?.code !== "LIVE_CONTROL_RESPONSE_TOO_LARGE") {
      throw errorWithCode("LIVE_CONTROL_TIMEOUT", error instanceof Error ? error.message : String(error));
    }
    if (error?.code) throw error;
    throw errorWithCode("LIVE_CONTROL_TRANSPORT_ERROR", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)];
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || errorWithCode("LIVE_CONTROL_MONITOR_ABORTED"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(signal.reason || errorWithCode("LIVE_CONTROL_MONITOR_ABORTED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runLiveControlMonitor(options, { fetchImpl = fetch, signal, onSample } = {}) {
  const latencies = [];
  let sequence = 0;
  let eventsObserved = 0;
  let maxBytes = 0;
  let finalControl = null;
  let sessionId = null;
  for (let poll = 0; poll < options.polls; poll += 1) {
    if (signal?.aborted) throw signal.reason || errorWithCode("LIVE_CONTROL_MONITOR_ABORTED");
    const sample = await fetchLiveControlSnapshot({ ...options, since: sequence }, { fetchImpl, signal });
    if (sample.control.sequence < sequence) throw errorWithCode("LIVE_CONTROL_SEQUENCE_REGRESSION");
    if (sessionId !== null && sample.control.sessionId !== sessionId) throw errorWithCode("LIVE_CONTROL_SESSION_CHANGED");
    sessionId = sample.control.sessionId;
    sequence = sample.control.sequence;
    eventsObserved += sample.control.events.length;
    maxBytes = Math.max(maxBytes, sample.bytes);
    latencies.push(sample.latencyMs);
    finalControl = sample.control;
    onSample?.({ poll: poll + 1, ...sample });
    if (poll + 1 < options.polls) await wait(options.intervalMs, signal);
  }
  return {
    ok: true,
    code: "LIVE_CONTROL_MONITOR_COMPLETE",
    polls: options.polls,
    finalSequence: sequence,
    eventsObserved,
    maxBytes,
    latencyMs: {
      p50: percentile(latencies, .5),
      p95: percentile(latencies, .95),
      p99: percentile(latencies, .99),
      max: Math.max(...latencies),
    },
    safety: finalControl ? {
      pendingActionCount: finalControl.pendingActionCount,
      historicalAutopickDetected: finalControl.historicalAutopickDetected,
      uncontrolledRosterAdditionDetected: finalControl.uncontrolledRosterAdditionDetected,
      unattributedRosterCount: finalControl.unattributedRosterCount,
      agesMs: finalControl.agesMs,
    } : null,
  };
}

async function main() {
  let options;
  try {
    options = parseLiveControlMonitorArguments(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: "USAGE",
      message: error instanceof Error ? error.message : String(error),
      usage: "npm run draft-day:monitor -- --league <id> --team <id> [--polls 1] [--interval-ms 1000]",
    }));
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(errorWithCode("LIVE_CONTROL_MONITOR_INTERRUPTED"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runLiveControlMonitor(options, {
      signal: controller.signal,
      onSample: options.quiet ? undefined : ({ poll, control, bytes, latencyMs }) => {
        console.log(JSON.stringify({
          ok: true,
          poll,
          sequence: control.sequence,
          unchanged: control.unchanged,
          bytes,
          latencyMs: Number(latencyMs.toFixed(2)),
          pendingActionCount: control.pendingActionCount,
          decision: control.decision,
          events: control.events,
        }));
      },
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error?.code || "LIVE_CONTROL_MONITOR_FAILED", message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
