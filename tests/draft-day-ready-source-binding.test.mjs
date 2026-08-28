import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/draft-day-ready.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const leagues = JSON.parse(await readFile(new URL("../config/authenticated-espn-leagues.json", import.meta.url), "utf8"));
const expected = leagues.profiles["salary-cap"];
const sourceSnapshotId = `sha256:${"a".repeat(64)}`;

function auditSnapshot({ sourceId, generatedAt }) {
  const capturedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    capturedAt,
    league: structuredClone(expected),
    binding: {
      tabId: 123,
      commandCenterSessionId: "ready-binding-test",
      commandCenterStartedAt: capturedAt,
    },
    runtime: { managedCleanupReady: true },
    safety: {
      settingsConfirmed: true,
      extensionConnected: true,
      sourceCoverage: 5,
      sourceIds: ["espn", "ffc", "mfl", "tradyr", "gng"],
      sourceSnapshotId: sourceId,
      sourceSnapshotGeneratedAt: generatedAt,
      autoDraft: false,
      autopickActive: false,
      actionState: "Pre-room checks confirmed.",
    },
    telemetry: { actions: [] },
    sleeperEvidence: { candidateCount: 0, candidates: [] },
    availability: {
      status: "READY",
      digest: `sha256:${"b".repeat(64)}`,
      evaluatedAt: capturedAt,
      freshUntil: new Date(Date.parse(capturedAt) + 20 * 60_000).toISOString(),
      blockingReasons: [],
      vetoedPlayerIds: [],
    },
  };
}

function warmPayload({ sourceId = sourceSnapshotId, generatedAt, overrides = {} }) {
  return {
    ok: true,
    code: "FIVE_SOURCE_READY",
    sourceCoverage: 5,
    sourceSnapshotId: sourceId,
    sourceGeneratedAt: generatedAt,
    profile: { scoring: "PPR", teams: 12, season: 2026, qbs: 2 },
    sources: ["ffc", "mfl", "tradyr", "gng"].map((id) => ({ id, status: "ok", players: 100 })),
    ...overrides,
  };
}

async function runReady({
  firstAuditSourceId = sourceSnapshotId,
  secondAuditSourceId = firstAuditSourceId,
  exactWarmSourceId = firstAuditSourceId,
  sourceAgeMs = 0,
} = {}) {
  const generatedAt = new Date(Date.now() - sourceAgeMs).toISOString();
  const requests = [];
  let auditReads = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/draft-day") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        const exact = parsed.expectedSourceSnapshotId !== undefined;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(warmPayload({
          sourceId: exact ? exactWarmSourceId : sourceSnapshotId,
          generatedAt,
        })));
      });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/draft-day?")) {
      auditReads += 1;
      const sourceId = auditReads === 1 ? firstAuditSourceId : secondAuditSourceId;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        code: "DRAFT_AUDIT_READY",
        snapshot: auditSnapshot({ sourceId, generatedAt }),
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: false, code: "NOT_FOUND" }));
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
      "--format", "salary-cap",
      "--origin", `http://127.0.0.1:${address.port}`,
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("DRAFT_DAY_READY_TEST_TIMEOUT"));
      }, 7_000);
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
    return { status, stdout, stderr, requests, auditReads, generatedAt };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("draft-day ready leases the audit's exact source identity and rechecks it", async () => {
  const execution = await runReady();
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.auditReads, 2);
  assert.equal(execution.requests.length, 2);
  const exactRequest = execution.requests[1];
  assert.equal(exactRequest.expectedSourceSnapshotId, sourceSnapshotId);
  assert.equal(exactRequest.expectedSourceGeneratedAt, execution.generatedAt);
  assert.deepEqual(exactRequest.profile, { scoring: "PPR", teams: 12, season: 2026, qbs: 2 });
  const result = JSON.parse(execution.stdout);
  assert.equal(result.code, "DRAFT_DAY_READY");
  assert.equal(result.sourceSnapshotId, sourceSnapshotId);
  assert.equal(result.sourceGeneratedAt, execution.generatedAt);
});

test("draft-day ready fails closed if exact WARM substitutes another source snapshot", async () => {
  const execution = await runReady({ exactWarmSourceId: `sha256:${"c".repeat(64)}` });
  assert.equal(execution.status, 1, execution.stdout);
  assert.equal(execution.auditReads, 1);
  assert.equal(JSON.parse(execution.stderr).code, "SOURCE_IDENTITY_RECHECK_FAILED");
});

test("draft-day ready fails closed if the active audit advances during its exact check", async () => {
  const execution = await runReady({ secondAuditSourceId: `sha256:${"d".repeat(64)}` });
  assert.equal(execution.status, 1, execution.stdout);
  assert.equal(execution.auditReads, 2);
  assert.equal(JSON.parse(execution.stderr).code, "SOURCE_AUDIT_IDENTITY_CHANGED");
});

test("draft-day ready rejects an audit without canonical source identity before exact WARM", async () => {
  const execution = await runReady({ firstAuditSourceId: null });
  assert.equal(execution.status, 1, execution.stdout);
  assert.equal(execution.auditReads, 1);
  assert.equal(execution.requests.length, 1, "only the initial cache-prime WARM may run");
  assert.equal(JSON.parse(execution.stderr).code, "SOURCE_AUDIT_IDENTITY_INVALID");
});

test("draft-day ready rejects an expired audit source lease before exact WARM", async () => {
  const execution = await runReady({ sourceAgeMs: 10 * 60_000 + 1 });
  assert.equal(execution.status, 1, execution.stdout);
  assert.equal(execution.auditReads, 1);
  assert.equal(execution.requests.length, 1);
  assert.equal(JSON.parse(execution.stderr).code, "SOURCE_AUDIT_IDENTITY_INVALID");
});
