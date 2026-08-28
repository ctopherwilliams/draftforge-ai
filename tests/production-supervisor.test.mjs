import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  boundedProductionStartupLog,
  PRODUCTION_STARTUP_LOG_RETAIN_BYTES,
  rotateOversizedProductionStartupLog,
  startProductionSupervisor,
  terminateProductionSupervisor,
  waitForProductionSupervisorReady,
} from "../scripts/production-supervisor-lib.mjs";

function child(pid) {
  const value = new EventEmitter();
  value.pid = pid;
  value.exitCode = null;
  value.signalCode = null;
  value.kill = () => true;
  value.unref = () => {};
  return value;
}

test("production supervisor waits for the exact SERVER_READY record and bounds diagnostics", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-supervisor-ready-"));
  try {
    const processChild = child(778801);
    const supervisor = startProductionSupervisor({
      projectRoot: root,
      spawnImpl: () => processChild,
    });
    const ready = waitForProductionSupervisorReady(supervisor, 1_000);
    appendFileSync(supervisor.logPath, "vinext booting\n", "utf8");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    appendFileSync(supervisor.logPath, `${JSON.stringify({ ok: true, code: "PRODUCTION_SERVER_READY" })}\n`, "utf8");
    assert.equal(await ready, true);

    writeFileSync(supervisor.logPath, `${"x".repeat(100)}TAIL`, "utf8");
    assert.equal(boundedProductionStartupLog(supervisor.logPath, 8), "xxxxTAIL");
    processChild.exitCode = 0;
    processChild.emit("exit", 0, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production supervisor reports early exit and escalates ignored termination", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-supervisor-exit-"));
  try {
    const earlyChild = child(778802);
    const early = startProductionSupervisor({ projectRoot: root, spawnImpl: () => earlyChild });
    queueMicrotask(() => {
      earlyChild.exitCode = 1;
      earlyChild.emit("exit", 1, null);
    });
    await assert.rejects(() => waitForProductionSupervisorReady(early, 1_000), /EXITED_BEFORE_READY/);

    const stubbornChild = child(778803);
    const stubborn = startProductionSupervisor({ projectRoot: root, spawnImpl: () => stubbornChild });
    const signals = [];
    const terminated = await terminateProductionSupervisor(stubborn, {
      graceMs: 10,
      killImpl: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") {
          stubbornChild.signalCode = signal;
          queueMicrotask(() => stubbornChild.emit("exit", null, signal));
        }
      },
    });
    assert.equal(terminated, true);
    assert.deepEqual(signals, [[-778803, "SIGTERM"], [-778803, "SIGKILL"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized startup log rotates to a bounded tail retaining the latest READY and fault", () => {
  const root = mkdtempSync(path.join(tmpdir(), "draftforge-supervisor-log-"));
  const logPath = path.join(root, "production-startup.log");
  try {
    const ready = JSON.stringify({ ok: true, code: "PRODUCTION_SERVER_READY" });
    const fault = JSON.stringify({ ok: false, code: "PRODUCTION_SERVER_RESTARTS_EXHAUSTED" });
    writeFileSync(logPath, `${"x".repeat(10 * 1024 * 1024)}\n${ready}\n${fault}\n`, "utf8");
    const previous = rotateOversizedProductionStartupLog(logPath);
    assert.equal(previous, `${logPath}.previous`);
    assert.ok(statSync(previous).size <= PRODUCTION_STARTUP_LOG_RETAIN_BYTES);
    const retained = readFileSync(previous, "utf8");
    assert.match(retained, /PRODUCTION_SERVER_READY/);
    assert.match(retained, /PRODUCTION_SERVER_RESTARTS_EXHAUSTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("draft-day doctor owns startup cleanup and treats listener-probe errors as blockers", () => {
  const doctor = readFileSync(new URL("../scripts/draft-day-doctor.mjs", import.meta.url), "utf8");
  assert.match(doctor, /productionListenerPids\(\)/);
  assert.match(doctor, /serverListenerProbeFailed/);
  assert.match(doctor, /waitForProductionSupervisorReady/);
  assert.match(doctor, /terminateProductionSupervisor/);
  assert.match(doctor, /inspectProductionSupervision/);
  assert.match(doctor, /productionSupervisorUnavailable/);
  assert.doesNotMatch(doctor, /spawn\("npm", \["run", "start"\]/);
  assert.doesNotMatch(doctor, /stdio: "ignore"/);
});
