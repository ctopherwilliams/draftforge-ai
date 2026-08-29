import assert from "node:assert/strict";
import test from "node:test";
import { waitForChromeDebuggerTarget } from "../scripts/lib/chrome-debugger-readiness.mjs";

function response({ ok = true, status = 200, json = {} } = {}) {
  return { ok, status, json: async () => json };
}

test("a delayed valid debugger port and target succeed within one absolute budget", async () => {
  let clock = 0;
  let reads = 0;
  const requests = [];
  const result = await waitForChromeDebuggerTarget({
    child: { exitCode: null, signalCode: null },
    activePortFile: "/tmp/profile/DevToolsActivePort",
    origin: "http://127.0.0.1:3000",
    timeoutMs: 500,
    now: () => clock,
    delay: async (milliseconds) => { clock += milliseconds; },
    readFileImpl: async () => {
      reads += 1;
      if (reads < 3) throw new Error("not ready");
      return "9222\n/devtools/browser/example\n";
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method || "GET", hasSignal: Boolean(options.signal) });
      if (url.endsWith("/json/version")) return response();
      return response({ json: { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" } });
    },
  });

  assert.equal(result.debuggerPort, 9222);
  assert.equal(result.target.webSocketDebuggerUrl, "ws://127.0.0.1:9222/devtools/page/1");
  assert.equal(clock, 200);
  assert.deepEqual(requests.map(({ method, hasSignal }) => ({ method, hasSignal })), [
    { method: "GET", hasSignal: true },
    { method: "PUT", hasSignal: true },
  ]);
});

test("an early Chrome exit fails immediately with bounded diagnostics", async () => {
  let delayed = false;
  await assert.rejects(
    waitForChromeDebuggerTarget({
      child: { exitCode: 1, signalCode: null },
      activePortFile: "/tmp/profile/DevToolsActivePort",
      origin: "http://127.0.0.1:3000",
      timeoutMs: 30_000,
      delay: async () => { delayed = true; },
      stderr: () => "fatal startup detail",
    }),
    /exited before debugger readiness; Chrome exit=1; signal=none; stderr=fatal startup detail/,
  );
  assert.equal(delayed, false);
});

test("malformed ports and unavailable endpoints time out with the last exact failure", async () => {
  let clock = 0;
  let mode = "malformed";
  const options = {
    child: { exitCode: null, signalCode: null },
    activePortFile: "/tmp/profile/DevToolsActivePort",
    origin: "http://127.0.0.1:3000",
    timeoutMs: 20,
    pollIntervalMs: 10,
    now: () => clock,
    delay: async (milliseconds) => { clock += milliseconds; },
    readFileImpl: async () => (mode === "malformed" ? "not-a-port\n" : "9222\n"),
    fetchImpl: async () => response({ ok: false, status: 503 }),
    stderr: () => "startup tail",
  };

  await assert.rejects(
    waitForChromeDebuggerTarget(options),
    /last=DevToolsActivePort did not contain a numeric port; Chrome exit=running; signal=none; stderr=startup tail/,
  );

  clock = 0;
  mode = "endpoint";
  await assert.rejects(
    waitForChromeDebuggerTarget(options),
    /last=debugger version endpoint returned HTTP 503; Chrome exit=running; signal=none; stderr=startup tail/,
  );
});
