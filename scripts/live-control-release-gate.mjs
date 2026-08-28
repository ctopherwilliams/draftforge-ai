#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = [
  "tests/auto-draft-safety.test.mjs",
  "tests/draft-audit.test.mjs",
  "tests/draft-day-bridge.test.mjs",
  "tests/draft-day-runtime.test.mjs",
  "tests/espn-clock-context.test.mjs",
  "tests/espn-context-state.test.mjs",
  "tests/live-control.test.mjs",
  "tests/live-control-sre-tools.test.mjs",
  "tests/live-room-watch.test.mjs",
  "tests/recovery-context.test.mjs",
];

function terminate(child, signal = "SIGTERM") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function runBoundedNode(arguments_, timeoutMs) {
  const child = spawn(process.execPath, arguments_, {
    cwd: projectRoot,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: { ...process.env, NODE_ENV: "test" },
  });
  let timedOut = false;
  let killTimer = null;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
    killTimer = setTimeout(() => terminate(child, "SIGKILL"), 2_000);
    killTimer.unref();
  }, timeoutMs);
  const forward = () => terminate(child);
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (timedOut) throw new Error(`LIVE_CONTROL_TEST_TIMEOUT_${timeoutMs}MS`);
    if (result.code !== 0) throw new Error(`LIVE_CONTROL_TEST_FAILED_${result.code ?? result.signal}`);
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
    terminate(child);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === "--timeout-ms")) {
    console.error(JSON.stringify({ ok: false, code: "USAGE", message: "usage: npm run test:live-control -- [--timeout-ms 180000]" }));
    process.exitCode = 2;
    return;
  }
  const timeoutIndex = process.argv.indexOf("--timeout-ms");
  const timeoutMs = timeoutIndex >= 0 ? Number(process.argv[timeoutIndex + 1]) : 180_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
    console.error(JSON.stringify({ ok: false, code: "USAGE", message: "--timeout-ms must be an integer from 10000 to 600000" }));
    process.exitCode = 2;
    return;
  }
  try {
    await runBoundedNode(["--test", "--test-concurrency=1", ...testFiles], timeoutMs);
    await runBoundedNode(["scripts/live-control-chaos.mjs"], 30_000);
    await runBoundedNode([
      "scripts/live-control-load.mjs",
      "--fixture",
      "--requests", "1000",
      "--concurrency", "8",
      "--max-duration-ms", "30000",
      "--p95-ms", "25",
      "--p99-ms", "50",
      "--require-stable-sequence",
    ], 45_000);
    console.log(JSON.stringify({
      ok: true,
      code: "LIVE_CONTROL_RELEASE_GATE_PASSED",
      testFiles,
      boundedLoadRequests: 1_000,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: "LIVE_CONTROL_RELEASE_GATE_FAILED", message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

await main();
