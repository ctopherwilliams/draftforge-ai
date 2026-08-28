import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PRODUCTION_SUPERVISION_SCHEMA_VERSION = 1;
export const PRODUCTION_SUPERVISION_HEARTBEAT_MS = 400;
export const PRODUCTION_SUPERVISION_TTL_MS = 2_000;
export const PRODUCTION_RUNTIME_LOG_MAX_BYTES = 256 * 1024;

export function defaultProductionSupervisionPath(projectRoot = process.cwd()) {
  return path.join(path.resolve(projectRoot), ".draftforge", "production-supervision.json");
}

export function writeProductionSupervisionState(statePath, state) {
  const exactPath = path.resolve(statePath);
  mkdirSync(path.dirname(exactPath), { recursive: true, mode: 0o700 });
  const temporary = `${exactPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, exactPath);
  return state;
}

export function removeProductionSupervisionState(statePath, token) {
  try {
    const current = JSON.parse(readFileSync(statePath, "utf8"));
    if (current?.token !== token) return false;
    rmSync(statePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function inspectProductionSupervision({
  statePath = defaultProductionSupervisionPath(),
  listenerPids = [],
  now = Date.now(),
  processAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
} = {}) {
  let state;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); }
  catch { return { ok: false, code: "PRODUCTION_SUPERVISOR_HEARTBEAT_MISSING" }; }
  const updatedAt = Date.parse(String(state?.updatedAt || ""));
  const supervisorPid = Number(state?.supervisorPid);
  const childPid = Number(state?.childPid);
  const valid = state?.schemaVersion === PRODUCTION_SUPERVISION_SCHEMA_VERSION
    && /^[a-f0-9]{32}$/.test(String(state?.token || ""))
    && Number.isInteger(supervisorPid) && supervisorPid > 0
    && Number.isInteger(childPid) && childPid > 0
    && Number.isFinite(updatedAt)
    && now - updatedAt >= -1_000
    && now - updatedAt <= PRODUCTION_SUPERVISION_TTL_MS;
  if (!valid) return { ok: false, code: "PRODUCTION_SUPERVISOR_HEARTBEAT_STALE" };
  if (!processAlive(supervisorPid)) return { ok: false, code: "PRODUCTION_SUPERVISOR_PROCESS_MISSING" };
  if (!listenerPids.map(Number).includes(childPid)) {
    return { ok: false, code: "PRODUCTION_SUPERVISOR_CHILD_MISMATCH" };
  }
  return { ok: true, code: "PRODUCTION_SUPERVISION_CURRENT", state };
}

export function createBoundedProductionRuntimeLog({
  logPath,
  maximumBytes = PRODUCTION_RUNTIME_LOG_MAX_BYTES,
} = {}) {
  if (!logPath || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1024) {
    throw new Error("PRODUCTION_RUNTIME_LOG_CONFIG_INVALID");
  }
  const exactPath = path.resolve(logPath);
  mkdirSync(path.dirname(exactPath), { recursive: true, mode: 0o700 });
  let buffer;
  try { buffer = readFileSync(exactPath).subarray(-maximumBytes); }
  catch { buffer = Buffer.alloc(0); }
  const persist = () => writeFileSync(exactPath, buffer, { mode: 0o600 });
  persist();
  return Object.freeze({
    path: exactPath,
    append(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      buffer = Buffer.concat([buffer, incoming]).subarray(-maximumBytes);
      persist();
    },
    size() { return buffer.length; },
    text() { return buffer.toString("utf8"); },
  });
}
