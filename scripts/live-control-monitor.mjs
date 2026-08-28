#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { sanitizeDraftOperatorSnapshot } from "../app/lib/draft-audit.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PRODUCTION_MINIMUM_INTERVAL_MS = 500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_OUTPUT_LINE_BYTES = 16_384;
const MAX_LOCK_BYTES = 4_096;
const INVALID_LOCK_STALE_AFTER_MS = 30_000;

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
    if (["--quiet", "--test-mode"].includes(argument)) flags.add(argument);
    else if (valueNames.has(argument)) {
      if (!argv[index + 1]) throw new Error(`${argument} requires a value`);
      values.set(argument, argv[index + 1]);
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  const leagueId = String(values.get("--league") || "");
  if (!/^\d{1,20}$/.test(leagueId)) throw new Error("--league must be an exact numeric ESPN league id");
  const testMode = flags.has("--test-mode");
  const intervalMs = integer(values.get("--interval-ms") || 1_000, "--interval-ms", {
    minimum: testMode ? 10 : PRODUCTION_MINIMUM_INTERVAL_MS,
    maximum: 60_000,
  });
  return {
    origin: normalizeLoopbackOrigin(values.get("--origin")),
    leagueId,
    teamId: integer(values.get("--team"), "--team", { minimum: 1, maximum: 10_000 }),
    polls: integer(values.get("--polls") || 1, "--polls", { minimum: 1, maximum: 20_000 }),
    intervalMs,
    timeoutMs: integer(values.get("--timeout-ms") || 1_000, "--timeout-ms", { minimum: 50, maximum: 10_000 }),
    maxBytes: integer(values.get("--max-bytes") || 131_072, "--max-bytes", { minimum: 256, maximum: 262_144 }),
    maxContextAgeMs: integer(values.get("--max-context-age-ms") || 1_000, "--max-context-age-ms", { minimum: 100, maximum: 60_000 }),
    maxPickAgeMs: integer(values.get("--max-pick-age-ms") || 4_000, "--max-pick-age-ms", { minimum: 100, maximum: 60_000 }),
    maxSourceAgeMs: integer(values.get("--max-source-age-ms") || 900_000, "--max-source-age-ms", { minimum: 1_000, maximum: 86_400_000 }),
    quiet: flags.has("--quiet"),
    testMode,
  };
}

function errorWithCode(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function monitorLockKey(options) {
  const origin = new URL(normalizeLoopbackOrigin(options.origin));
  const leagueId = String(options.leagueId || "");
  const teamId = Number(options.teamId);
  if (!/^\d{1,20}$/.test(leagueId) || !Number.isInteger(teamId) || teamId < 1 || teamId > 10_000) {
    throw errorWithCode("LIVE_CONTROL_MONITOR_LOCK_IDENTITY_INVALID");
  }
  // Collapse localhost, IPv4, and IPv6 loopback aliases. A monitor reached by
  // another alias is still observing the same loopback publisher and room.
  return `loopback:${origin.port || "80"}:league:${leagueId}:team:${teamId}`;
}

export function liveControlMonitorLockPath(options, { baseDirectory = tmpdir() } = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const directory = join(baseDirectory, `draftforge-live-control-monitor-${uid}`);
  const digest = createHash("sha256").update(monitorLockKey(options)).digest("hex");
  return { directory, path: join(directory, `${digest}.lock`) };
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function ensurePrivateLockDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw errorWithCode("LIVE_CONTROL_MONITOR_LOCK_DIRECTORY_UNSAFE");
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw errorWithCode("LIVE_CONTROL_MONITOR_LOCK_DIRECTORY_OWNER_MISMATCH");
  }
}

async function readMonitorLock(path) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_LOCK_BYTES) {
    return { metadata: null, status };
  }
  let metadata = null;
  try {
    metadata = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // A process can die between the exclusive create and metadata write. Only
    // an old malformed file is recoverable; a recent one remains fail closed.
  }
  return { metadata, status };
}

function validMonitorLock(metadata, key) {
  return metadata?.version === 1
    && metadata.key === key
    && Number.isInteger(metadata.pid)
    && metadata.pid > 0
    && typeof metadata.token === "string"
    && /^[a-f0-9-]{16,64}$/i.test(metadata.token)
    && Number.isFinite(Date.parse(metadata.startedAt));
}

/**
 * Acquire the process singleton used by the production CLI. The exclusive
 * file is scoped to one loopback port and exact ESPN league/team identity.
 * Programmatic load/chaos helpers intentionally do not call this function.
 */
export async function acquireLiveControlMonitorLock(options, {
  baseDirectory = tmpdir(),
  processId = process.pid,
  isProcessAlive = defaultProcessAlive,
  now = Date.now,
} = {}) {
  const key = monitorLockKey(options);
  const lock = liveControlMonitorLockPath(options, { baseDirectory });
  await ensurePrivateLockDirectory(lock.directory);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    const metadata = {
      version: 1,
      key,
      pid: processId,
      token,
      startedAt: new Date(now()).toISOString(),
    };
    let handle;
    let created = false;
    try {
      handle = await open(lock.path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      let released = false;
      return {
        ...lock,
        key,
        token,
        async release() {
          if (released) return false;
          released = true;
          try {
            const current = await readMonitorLock(lock.path);
            if (!validMonitorLock(current.metadata, key) || current.metadata.token !== token) return false;
            await unlink(lock.path);
            return true;
          } catch (error) {
            if (error?.code === "ENOENT") return false;
            throw error;
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) await unlink(lock.path).catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = await readMonitorLock(lock.path);
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (validMonitorLock(existing.metadata, key)) {
        if (isProcessAlive(existing.metadata.pid)) {
          throw errorWithCode("LIVE_CONTROL_MONITOR_ALREADY_RUNNING", `pid ${existing.metadata.pid}`);
        }
      } else if (now() - existing.status.mtimeMs < INVALID_LOCK_STALE_AFTER_MS) {
        throw errorWithCode("LIVE_CONTROL_MONITOR_LOCK_UNREADABLE");
      }
      // Serialize stale reclamation long enough to re-read the exact inode.
      // The stale lock itself is atomically moved to a unique quarantine path
      // before deletion, so a delayed reclaimer can never unlink a replacement.
      const reclaimPath = `${lock.path}.reclaim`;
      let reclaimHandle;
      let reclaimStatus;
      try {
        reclaimHandle = await open(reclaimPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        await reclaimHandle.writeFile(`${processId}:${randomUUID()}\n`, "utf8");
        await reclaimHandle.sync();
        reclaimStatus = await reclaimHandle.stat();
        await reclaimHandle.close();
        reclaimHandle = null;
      } catch (reclaimError) {
        await reclaimHandle?.close().catch(() => {});
        if (reclaimError?.code !== "EEXIST") throw reclaimError;
        await new Promise((resolve) => setTimeout(resolve, 2));
        continue;
      }
      try {
        let current;
        try {
          current = await readMonitorLock(lock.path);
        } catch (readError) {
          if (readError?.code === "ENOENT") continue;
          throw readError;
        }
        if (current.status.ino !== existing.status.ino || current.status.dev !== existing.status.dev) continue;
        if (validMonitorLock(current.metadata, key)) {
          if (isProcessAlive(current.metadata.pid)) {
            throw errorWithCode("LIVE_CONTROL_MONITOR_ALREADY_RUNNING", `pid ${current.metadata.pid}`);
          }
        } else if (now() - current.status.mtimeMs < INVALID_LOCK_STALE_AFTER_MS) {
          throw errorWithCode("LIVE_CONTROL_MONITOR_LOCK_UNREADABLE");
        }
        const stalePath = `${lock.path}.stale.${processId}.${randomUUID()}`;
        try {
          await rename(lock.path, stalePath);
        } catch (renameError) {
          if (renameError?.code === "ENOENT") continue;
          throw renameError;
        }
        const quarantined = await lstat(stalePath);
        if (quarantined.ino !== current.status.ino || quarantined.dev !== current.status.dev) {
          throw errorWithCode("LIVE_CONTROL_MONITOR_LOCK_RECLAIM_IDENTITY_MISMATCH");
        }
        await unlink(stalePath);
      } finally {
        const currentReclaim = await lstat(reclaimPath).catch(() => null);
        if (currentReclaim && reclaimStatus
          && currentReclaim.ino === reclaimStatus.ino
          && currentReclaim.dev === reclaimStatus.dev) {
          await unlink(reclaimPath).catch(() => {});
        }
      }
    }
  }
  throw errorWithCode("LIVE_CONTROL_MONITOR_LOCK_CONTENDED");
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

function validateControl(payload, since, limits, { allowTruncatedBootstrap = false } = {}) {
  if (!payload || typeof payload !== "object" || payload.ok !== true || payload.code !== "DRAFT_LIVE_CONTROL_READY") {
    throw errorWithCode("LIVE_CONTROL_NOT_READY", String(payload?.code || "UNKNOWN"));
  }
  const control = payload.control;
  if (String(payload.league?.id || "") !== String(limits.leagueId)
    || Number(payload.league?.teamId) !== Number(limits.teamId)) {
    throw errorWithCode("LIVE_CONTROL_IDENTITY_MISMATCH");
  }
  if (!control || typeof control !== "object" || !Number.isSafeInteger(control.sequence) || control.sequence < 0
    || !Number.isSafeInteger(control.earliestRetainedSequence) || control.earliestRetainedSequence < 0
    || typeof control.truncated !== "boolean"
    || typeof control.sessionId !== "string" || !control.sessionId || !Array.isArray(control.events)
    || typeof control.unchanged !== "boolean"
    || control.events.length > 256 || !control.agesMs
    || !Number.isSafeInteger(control.pendingActionCount) || control.pendingActionCount < 0
    || typeof control.historicalAutopickDetected !== "boolean"
    || typeof control.uncontrolledRosterAdditionDetected !== "boolean"
    || !Number.isSafeInteger(control.unattributedRosterCount) || control.unattributedRosterCount < 0
    || !control.freshness || typeof control.freshness.pickFeedLagging !== "boolean") {
    throw errorWithCode("LIVE_CONTROL_SCHEMA_INVALID");
  }
  if (control.sequence < since) throw errorWithCode("LIVE_CONTROL_SEQUENCE_REGRESSION");
  const earliestRetainedSequence = control.earliestRetainedSequence;
  if ((control.sequence === 0 && earliestRetainedSequence !== 0)
    || (control.sequence > 0 && (earliestRetainedSequence < 1
      || earliestRetainedSequence > control.sequence
      || control.sequence - earliestRetainedSequence + 1 > 256))) {
    throw errorWithCode("LIVE_CONTROL_SCHEMA_INVALID");
  }
  const responseIsTruncated = earliestRetainedSequence > 0 && since + 1 < earliestRetainedSequence;
  if (control.truncated !== responseIsTruncated) throw errorWithCode("LIVE_CONTROL_SCHEMA_INVALID");
  if (control.truncated && (!allowTruncatedBootstrap || since !== 0)) {
    throw errorWithCode("LIVE_CONTROL_EVENT_GAP");
  }
  if (control.sequence === since) {
    if (!control.unchanged || control.events.length !== 0) throw errorWithCode("LIVE_CONTROL_EVENT_GAP");
  } else if (control.unchanged || control.events.length === 0) {
    throw errorWithCode("LIVE_CONTROL_EVENT_GAP");
  }
  let previous = control.truncated ? earliestRetainedSequence - 1 : since;
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
    ["pickFeedObserved", limits.maxPickAgeMs, "PICK_FEED_STALE"],
    ["sourceSnapshot", limits.maxSourceAgeMs, "SOURCE_SNAPSHOT_STALE"],
  ]) {
    const age = control.agesMs[field];
    if (!Number.isFinite(age) || age < 0 || age > maximum) freshnessFailures.push(code);
  }
  if (control.freshness.pickFeedLagging) freshnessFailures.push("PICK_FEED_LAGGING");
  if (freshnessFailures.length) throw errorWithCode("LIVE_CONTROL_STALE", freshnessFailures.join(","));
  return control;
}

function validatedOperator(payload) {
  if (!Object.hasOwn(payload, "operator")) throw errorWithCode("LIVE_CONTROL_OPERATOR_MISSING");
  if (payload.operator === null) return null;
  const operator = sanitizeDraftOperatorSnapshot(payload.operator);
  if (!operator) throw errorWithCode("LIVE_CONTROL_OPERATOR_INVALID");
  return operator;
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
    const since = options.since || 0;
    const allowTruncatedBootstrap = options.allowTruncatedBootstrap === undefined
      ? since === 0
      : options.allowTruncatedBootstrap === true;
    const control = validateControl(payload, since, options, { allowTruncatedBootstrap });
    const operator = validatedOperator(payload);
    return { payload, control, operator, bytes: size, latencyMs: performance.now() - startedAt };
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

function sanitizedString(value, maximum = 160) {
  if (typeof value !== "string") return undefined;
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("").slice(0, maximum);
}

function sanitizedNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function sanitizedPlayer(value) {
  if (!value || typeof value !== "object") return undefined;
  const playerId = Number(value.playerId);
  const playerName = sanitizedString(value.playerName);
  if (!Number.isSafeInteger(playerId) || playerId < 1 || !playerName) return undefined;
  return {
    playerId,
    playerName,
    ...(sanitizedString(value.position, 8) ? { position: sanitizedString(value.position, 8) } : {}),
  };
}

function sanitizedDecision(value) {
  if (!value || typeof value !== "object") return null;
  const intendedPlayer = sanitizedPlayer(value.intendedPlayer);
  if (!intendedPlayer) return null;
  return {
    decisionId: sanitizedString(value.decisionId, 128),
    decidedAt: sanitizedString(value.decidedAt, 32),
    contextCapturedAt: sanitizedString(value.contextCapturedAt, 32),
    operation: sanitizedString(value.operation, 16),
    sourceSnapshotId: sanitizedString(value.sourceSnapshotId, 128),
    expectedPick: sanitizedNumber(value.expectedPick),
    submitNotBeforeAt: sanitizedString(value.submitNotBeforeAt, 32),
    submitTargetSeconds: sanitizedNumber(value.submitTargetSeconds),
    intendedPlayer,
    resolvedPlayer: sanitizedPlayer(value.resolvedPlayer),
    expectedCurrentBid: sanitizedNumber(value.expectedCurrentBid),
    intendedOffer: sanitizedNumber(value.intendedOffer),
    resolvedOffer: sanitizedNumber(value.resolvedOffer),
    maxApprovedBid: sanitizedNumber(value.maxApprovedBid),
    alternatives: Array.isArray(value.alternatives)
      ? value.alternatives.slice(0, 5).map(sanitizedPlayer).filter(Boolean)
      : [],
  };
}

function sanitizedEvent(value) {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.sequence)) return null;
  const base = {
    sequence: value.sequence,
    occurredAt: sanitizedString(value.occurredAt, 32),
    kind: sanitizedString(value.kind, 32),
  };
  if (value.kind === "ACTION_LIFECYCLE") {
    return {
      ...base,
      actionId: sanitizedString(value.actionId, 128),
      decisionId: sanitizedString(value.decisionId, 128),
      operation: sanitizedString(value.operation, 16),
      phase: sanitizedString(value.phase, 32),
      intendedPlayer: sanitizedPlayer(value.intendedPlayer),
      resolvedPlayer: sanitizedPlayer(value.resolvedPlayer),
      intendedOffer: sanitizedNumber(value.intendedOffer),
      resolvedOffer: sanitizedNumber(value.resolvedOffer),
      code: sanitizedString(value.code, 128),
    };
  }
  if (value.kind === "SAFETY") {
    return {
      ...base,
      condition: sanitizedString(value.condition, 32),
      active: value.active === true,
      code: sanitizedString(value.code, 128),
    };
  }
  if (value.kind === "ROSTER_ATTRIBUTION") {
    return {
      ...base,
      player: sanitizedPlayer(value.player),
      attribution: sanitizedString(value.attribution, 32),
      actionId: sanitizedString(value.actionId, 128),
      decisionId: sanitizedString(value.decisionId, 128),
    };
  }
  return base;
}

function monitorOutputBase(sample, kind) {
  const { poll, control, bytes, latencyMs } = sample;
  return {
    ok: true,
    kind,
    poll,
    sequence: control.sequence,
    earliestRetainedSequence: control.earliestRetainedSequence,
    truncated: control.truncated,
    bytes,
    latencyMs: Number(latencyMs.toFixed(2)),
    pendingActionCount: control.pendingActionCount,
    safety: {
      historicalAutopickDetected: control.historicalAutopickDetected,
      uncontrolledRosterAdditionDetected: control.uncontrolledRosterAdditionDetected,
      unattributedRosterCount: control.unattributedRosterCount,
      pickFeedLagging: control.freshness.pickFeedLagging,
    },
    agesMs: {
      espnContext: sanitizedNumber(control.agesMs.espnContext) ?? null,
      pickFeedObserved: sanitizedNumber(control.agesMs.pickFeedObserved) ?? null,
      sourceSnapshot: sanitizedNumber(control.agesMs.sourceSnapshot) ?? null,
      lastAction: sanitizedNumber(control.agesMs.lastAction) ?? null,
    },
  };
}

function boundedChangeOutput(sample, maxLineBytes) {
  const events = sample.control.events.map(sanitizedEvent).filter(Boolean);
  const output = {
    ...monitorOutputBase(sample, "change"),
    operator: sample.operator,
    decision: sanitizedDecision(sample.control.decision),
    events: [],
    eventsOmitted: events.length,
  };
  // On a rolled bootstrap prefer the newest lifecycle evidence while retaining
  // chronological order within the bounded emitted suffix.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const candidate = { ...output, events: [event, ...output.events], eventsOmitted: index };
    if (Buffer.byteLength(JSON.stringify(candidate)) > maxLineBytes) break;
    output.events.unshift(event);
    output.eventsOmitted = index;
  }
  let serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized) > maxLineBytes) {
    // A future decision schema cannot turn the monitor into an unbounded log
    // sink. Retain only the operational identity needed by a chat observer.
    output.decision = output.decision ? {
      decisionId: output.decision.decisionId,
      operation: output.decision.operation,
      intendedPlayer: output.decision.intendedPlayer,
      intendedOffer: output.decision.intendedOffer,
      maxApprovedBid: output.decision.maxApprovedBid,
    } : null;
    if (output.operator) output.operator.alternatives = output.operator.alternatives.slice(0, 3);
    serialized = JSON.stringify(output);
  }
  if (Buffer.byteLength(serialized) > maxLineBytes) {
    throw errorWithCode("LIVE_CONTROL_MONITOR_OUTPUT_TOO_LARGE");
  }
  return { output, serialized };
}

/**
 * Emit one sanitized change record when sequence state advances. Stable polls
 * stay silent except for a compact periodic health record.
 */
export function createLiveControlSampleReporter({
  writeLine = (line) => console.log(line),
  now = Date.now,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  maxLineBytes = MAX_OUTPUT_LINE_BYTES,
} = {}) {
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000 || heartbeatIntervalMs > 300_000) {
    throw errorWithCode("LIVE_CONTROL_MONITOR_HEARTBEAT_INVALID");
  }
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1_024 || maxLineBytes > MAX_OUTPUT_LINE_BYTES) {
    throw errorWithCode("LIVE_CONTROL_MONITOR_OUTPUT_BOUND_INVALID");
  }
  let lastOutputAt = Number.NEGATIVE_INFINITY;
  let lastOperator = null;
  return (sample) => {
    const observedAt = now();
    const operatorIdentity = JSON.stringify(sample.operator);
    const changed = sample.control.unchanged === false
      || sample.control.events.length > 0
      || operatorIdentity !== lastOperator;
    if (!changed && observedAt - lastOutputAt < heartbeatIntervalMs) return null;
    const record = changed
      ? boundedChangeOutput(sample, maxLineBytes)
      : (() => {
          const output = monitorOutputBase(sample, "health");
          return { output, serialized: JSON.stringify(output) };
        })();
    if (Buffer.byteLength(record.serialized) > maxLineBytes) {
      throw errorWithCode("LIVE_CONTROL_MONITOR_OUTPUT_TOO_LARGE");
    }
    writeLine(record.serialized);
    lastOutputAt = observedAt;
    lastOperator = operatorIdentity;
    return { ...record.output, outputBytes: Buffer.byteLength(record.serialized) };
  };
}

export async function runLiveControlMonitor(options, { fetchImpl = fetch, signal, onSample } = {}) {
  const latencies = [];
  let sequence = 0;
  let eventsObserved = 0;
  let maxBytes = 0;
  let finalControl = null;
  let sessionId = null;
  let bootstrap = null;
  for (let poll = 0; poll < options.polls; poll += 1) {
    if (signal?.aborted) throw signal.reason || errorWithCode("LIVE_CONTROL_MONITOR_ABORTED");
    // Only a new observer may adopt sticky aggregate state plus a truncated
    // retained window. Every poll after this one must prove exact continuity.
    const sample = await fetchLiveControlSnapshot({
      ...options,
      since: sequence,
      allowTruncatedBootstrap: poll === 0,
    }, { fetchImpl, signal });
    if (sample.control.sequence < sequence) throw errorWithCode("LIVE_CONTROL_SEQUENCE_REGRESSION");
    if (sessionId !== null && sample.control.sessionId !== sessionId) throw errorWithCode("LIVE_CONTROL_SESSION_CHANGED");
    sessionId = sample.control.sessionId;
    sequence = sample.control.sequence;
    eventsObserved += sample.control.events.length;
    maxBytes = Math.max(maxBytes, sample.bytes);
    latencies.push(sample.latencyMs);
    finalControl = sample.control;
    bootstrap ??= {
      sequence: sample.control.sequence,
      earliestRetainedSequence: sample.control.earliestRetainedSequence,
      truncated: sample.control.truncated,
    };
    onSample?.({ poll: poll + 1, ...sample });
    if (poll + 1 < options.polls) await wait(options.intervalMs, signal);
  }
  return {
    ok: true,
    code: "LIVE_CONTROL_MONITOR_COMPLETE",
    polls: options.polls,
    finalSequence: sequence,
    eventsObserved,
    bootstrap,
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
      message: sanitizedString(error instanceof Error ? error.message : String(error), 512),
      usage: "npm run draft-day:monitor -- --league <id> --team <id> [--polls 1] [--interval-ms 1000]",
    }));
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(errorWithCode("LIVE_CONTROL_MONITOR_INTERRUPTED"));
  let monitorLock = null;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    monitorLock = await acquireLiveControlMonitorLock(options);
    const reporter = options.quiet ? null : createLiveControlSampleReporter();
    const result = await runLiveControlMonitor(options, {
      signal: controller.signal,
      onSample: reporter || undefined,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error?.code || "LIVE_CONTROL_MONITOR_FAILED",
      message: sanitizedString(error instanceof Error ? error.message : String(error), 512),
    }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await monitorLock?.release();
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        code: "LIVE_CONTROL_MONITOR_LOCK_CLEANUP_FAILED",
        message: sanitizedString(error instanceof Error ? error.message : String(error), 512),
      }));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
