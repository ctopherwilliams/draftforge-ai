import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/draft-day-warm.mjs", import.meta.url));
const sourceSnapshotId = `sha256:${"e".repeat(64)}`;

function warmPayload(overrides = {}) {
  return {
    ok: true,
    code: "FIVE_SOURCE_READY",
    profile: { scoring: "PPR", teams: 12, season: 2026, qbs: 1 },
    sourceSnapshotId,
    sourceGeneratedAt: new Date().toISOString(),
    sources: ["ffc", "mfl", "tradyr", "gng"].map((id) => ({
      id,
      status: "ok",
      players: 500,
      error: null,
    })),
    ...overrides,
  };
}

async function runWarm(payload) {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<html><script src="/_next/static/chunks/app.js"></script></html>');
      return;
    }
    if (request.method === "GET" && request.url === "/_next/static/chunks/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(`/*${"x".repeat(150)}*/`);
      return;
    }
    if (request.method === "POST" && request.url === "/api/draft-day") {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let child;
  let stdout = "";
  let stderr = "";
  try {
    child = spawn(process.execPath, [
      scriptPath,
      "--origin", `http://127.0.0.1:${address.port}`,
      "--scoring", "PPR",
      "--teams", "12",
      "--season", "2026",
      "--qbs", "1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("DRAFT_DAY_WARM_TEST_TIMEOUT"));
      }, 5_000);
      timeout.unref();
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    return { status, stdout, stderr };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("terminal WARM accepts a fresh cryptographic source snapshot", async () => {
  const execution = await runWarm(warmPayload());
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.code, "FIVE_SOURCE_READY");
  assert.equal(result.sourceCoverage, 5);
  assert.equal(result.sourceSnapshotId, sourceSnapshotId);
  assert.ok(result.sourceSnapshotAgeMs >= 0);
});

test("terminal WARM fails closed when snapshot identity is absent or malformed", async () => {
  for (const sourceSnapshotIdOverride of [undefined, "sha256:not-a-digest"]) {
    const payload = warmPayload({ sourceSnapshotId: sourceSnapshotIdOverride });
    const execution = await runWarm(payload);
    assert.equal(execution.status, 1, execution.stderr);
    const result = JSON.parse(execution.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.code, "SOURCE_SNAPSHOT_IDENTITY_INVALID");
    assert.equal(result.sourceCoverage, 5);
    assert.equal(result.sourceSnapshotId, null);
  }
});

test("terminal WARM rejects stale or noncanonical source generation time", async () => {
  const stale = await runWarm(warmPayload({
    sourceGeneratedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
  }));
  assert.equal(stale.status, 1, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).code, "SOURCE_SNAPSHOT_STALE");

  const fallbackOnly = warmPayload({ sourceGeneratedAt: undefined, generatedAt: new Date().toISOString() });
  const malformed = await runWarm(fallbackOnly);
  assert.equal(malformed.status, 1, malformed.stderr);
  const malformedResult = JSON.parse(malformed.stdout);
  assert.equal(malformedResult.code, "SOURCE_SNAPSHOT_TIMESTAMP_INVALID");
  assert.equal(malformedResult.sourceGeneratedAt, null);
});
