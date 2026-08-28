import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const PRODUCTION_SUPERVISOR_READY_TIMEOUT_MS = 20_000;
export const PRODUCTION_SUPERVISOR_TERMINATION_GRACE_MS = 2_000;
export const PRODUCTION_STARTUP_LOG_MAX_READ_BYTES = 32 * 1024;
export const PRODUCTION_STARTUP_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const PRODUCTION_STARTUP_LOG_RETAIN_BYTES = 128 * 1024;

function outcomePromise(child) {
  return new Promise((resolveOutcome) => {
    child.once("error", (error) => resolveOutcome({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolveOutcome({ code, signal, error: null }));
  });
}

async function waitForOutcome(outcome, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      outcome,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function boundedProductionStartupLog(logPath, maximumBytes = PRODUCTION_STARTUP_LOG_MAX_READ_BYTES) {
  let fd = null;
  try {
    fd = openSync(logPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maximumBytes);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, Math.max(0, size - length));
    return bytes.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function rotateOversizedProductionStartupLog(
  logPath,
  rotateBytes = PRODUCTION_STARTUP_LOG_ROTATE_BYTES,
  retainBytes = PRODUCTION_STARTUP_LOG_RETAIN_BYTES,
) {
  try {
    if (statSync(logPath).size <= rotateBytes) return null;
    const retained = boundedProductionStartupLog(logPath, retainBytes);
    const previousPath = `${logPath}.previous`;
    const temporaryPath = `${previousPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, retained, { encoding: "utf8", mode: 0o600 });
    try { unlinkSync(previousPath); } catch { /* no prior rotation */ }
    renameSync(temporaryPath, previousPath);
    return previousPath;
  } catch {
    return null;
  }
}

export function startProductionSupervisor({
  projectRoot = process.cwd(),
  spawnImpl = spawn,
  logPath = path.join(projectRoot, ".draftforge", "production-startup.log"),
} = {}) {
  const exactRoot = path.resolve(projectRoot);
  const exactLogPath = path.resolve(logPath);
  mkdirSync(path.dirname(exactLogPath), { recursive: true, mode: 0o700 });
  const previousLogPath = rotateOversizedProductionStartupLog(exactLogPath);
  const logFd = openSync(exactLogPath, "w", 0o600);
  let child;
  try {
    child = spawnImpl(process.execPath, [path.join(exactRoot, "scripts", "start-production.mjs")], {
      cwd: exactRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log" },
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  const outcome = outcomePromise(child);
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    const error = new Error("PRODUCTION_SUPERVISOR_SPAWN_FAILED");
    error.outcome = outcome;
    throw error;
  }
  return Object.freeze({ child, outcome, logPath: exactLogPath, previousLogPath });
}

export async function waitForProductionSupervisorReady(
  supervisor,
  timeoutMs = PRODUCTION_SUPERVISOR_READY_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = boundedProductionStartupLog(supervisor.logPath);
    if (log.split(/\r?\n/).some((line) => {
      try {
        const event = JSON.parse(line);
        return event?.ok === true && event?.code === "PRODUCTION_SERVER_READY";
      } catch {
        return false;
      }
    })) return true;
    const exited = await waitForOutcome(supervisor.outcome, 100);
    if (exited) {
      const error = new Error(exited.error
        ? "PRODUCTION_SUPERVISOR_SPAWN_FAILED"
        : "PRODUCTION_SUPERVISOR_EXITED_BEFORE_READY");
      error.outcome = exited;
      throw error;
    }
  }
  throw new Error("PRODUCTION_SUPERVISOR_READY_TIMEOUT");
}

export async function terminateProductionSupervisor(
  supervisor,
  {
    graceMs = PRODUCTION_SUPERVISOR_TERMINATION_GRACE_MS,
    killImpl = process.kill.bind(process),
  } = {},
) {
  if (await waitForOutcome(supervisor.outcome, 0)) return true;
  const signal = (value) => {
    try {
      if (process.platform === "win32") supervisor.child.kill(value);
      else killImpl(-supervisor.child.pid, value);
      return true;
    } catch {
      try { return supervisor.child.kill(value); } catch { return false; }
    }
  };
  signal("SIGTERM");
  if (await waitForOutcome(supervisor.outcome, graceMs)) return true;
  signal("SIGKILL");
  return Boolean(await waitForOutcome(supervisor.outcome, graceMs));
}
