import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultProductionSupervisionPath,
  createBoundedProductionRuntimeLog,
  inspectProductionSupervision,
  removeProductionSupervisionState,
  writeProductionSupervisionState,
} from "../scripts/production-supervision-lib.mjs";

function state(overrides = {}) {
  return {
    schemaVersion: 1,
    token: "a".repeat(32),
    supervisorPid: 101,
    childPid: 202,
    releaseRevision: "b".repeat(40),
    serverInstanceStartedAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:01.000Z",
    ...overrides,
  };
}

test("doctor supervision evidence binds a fresh living supervisor to the exact listener", () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-supervision-"));
  const statePath = defaultProductionSupervisionPath(root);
  try {
    assert.equal(inspectProductionSupervision({ statePath }).code, "PRODUCTION_SUPERVISOR_HEARTBEAT_MISSING");
    writeProductionSupervisionState(statePath, state());
    const exact = inspectProductionSupervision({
      statePath,
      listenerPids: [202],
      now: Date.parse("2026-08-28T12:00:02.000Z"),
      processAlive: (pid) => pid === 101,
    });
    assert.equal(exact.ok, true);
    assert.equal(inspectProductionSupervision({
      statePath,
      listenerPids: [202],
      now: Date.parse("2026-08-28T12:00:04.001Z"),
      processAlive: () => true,
    }).code, "PRODUCTION_SUPERVISOR_HEARTBEAT_STALE");
    assert.equal(inspectProductionSupervision({
      statePath,
      listenerPids: [202],
      now: Date.parse("2026-08-28T12:00:02.000Z"),
      processAlive: () => false,
    }).code, "PRODUCTION_SUPERVISOR_PROCESS_MISSING");
    assert.equal(inspectProductionSupervision({
      statePath,
      listenerPids: [203],
      now: Date.parse("2026-08-28T12:00:02.000Z"),
      processAlive: () => true,
    }).code, "PRODUCTION_SUPERVISOR_CHILD_MISMATCH");
    assert.equal(removeProductionSupervisionState(statePath, "wrong"), false);
    assert.equal(removeProductionSupervisionState(statePath, "a".repeat(32)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production stdout, stderr, and Wrangler diagnostics share a bounded tail log", () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-runtime-log-"));
  try {
    const log = createBoundedProductionRuntimeLog({
      logPath: path.join(root, "runtime.log"),
      maximumBytes: 1_024,
    });
    log.append(`READY:${"a".repeat(700)}`);
    log.append(`FAULT:${"b".repeat(700)}`);
    assert.equal(log.size(), 1_024);
    assert.match(log.text(), /FAULT:/, "the latest fault remains in the retained tail");
    assert.doesNotMatch(log.text(), /^READY:/, "old runtime chatter is evicted at the hard cap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an orphaned production child self-exits after its supervisor evidence disappears", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-child-guard-"));
  const statePath = defaultProductionSupervisionPath(root);
  const token = "c".repeat(32);
  const fakeSupervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const child = spawn(process.execPath, [
    "--import",
    new URL("../scripts/production-child-guard.mjs", import.meta.url).pathname,
    "-e",
    "setInterval(() => {}, 1000)",
  ], {
    env: {
      ...process.env,
      DRAFTFORGE_PRODUCTION_SUPERVISION_PATH: statePath,
      DRAFTFORGE_PRODUCTION_SUPERVISION_TOKEN: token,
      DRAFTFORGE_PRODUCTION_SUPERVISOR_PID: String(fakeSupervisor.pid),
    },
    stdio: "ignore",
  });
  try {
    writeProductionSupervisionState(statePath, {
      ...state(),
      token,
      supervisorPid: fakeSupervisor.pid,
      childPid: child.pid,
      updatedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const supervisorExited = new Promise((resolve) => fakeSupervisor.once("exit", resolve));
    fakeSupervisor.kill("SIGKILL");
    await supervisorExited;
    const outcome = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("guard did not reap orphan")), 3_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    assert.deepEqual(outcome, { code: 70, signal: null });
  } finally {
    try { fakeSupervisor.kill("SIGKILL"); } catch { /* already exited */ }
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    rmSync(root, { recursive: true, force: true });
  }
});
