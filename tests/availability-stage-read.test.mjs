import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { availabilityStageReadLabel, classifyAvailabilityStageRead } from "../app/lib/availability-stage-read.ts";

test("explicit missing and invalid stages are not transport failures or cached evidence", () => {
  assert.deepEqual(classifyAvailabilityStageRead(404, { code: "AVAILABILITY_STAGE_MISSING" }), { status: "missing", stage: null });
  for (const [status, body] of [[409, { code: "AVAILABILITY_STAGE_RECOVERY_INVALID" }], [200, null], [403, {}], [404, null]]) {
    assert.deepEqual(classifyAvailabilityStageRead(status, body), { status: "invalid", stage: null });
  }
  assert.equal(availabilityStageReadLabel("missing", false), " · stage missing");
  assert.equal(availabilityStageReadLabel("invalid", true), " · stage invalid");
  assert.equal(availabilityStageReadLabel("unavailable", false), " · live read unavailable");
  assert.equal(availabilityStageReadLabel("unavailable", true), " · cached (live read degraded)");
});

test("successful and blocked artifact responses still flow through the mandatory freshness/veto evaluator", () => {
  const stage = { artifact: { generatedAt: "stale" }, policy: {}, stagedAt: "old" };
  for (const status of [200, 409]) assert.deepEqual(classifyAvailabilityStageRead(status, stage), { status: "ready", stage });
  assert.deepEqual(classifyAvailabilityStageRead(503, {}), { status: "unavailable", stage: null });
});

test("the page revokes cached stage and frozen authority on explicit loss, but retains it through transient transport loss", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "refreshAvailability") callback = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback);
  for (const kind of ["missing", "invalid", "server", "network"]) {
    const retained = { artifact: {}, policy: {}, stagedAt: "earlier" };
    let stage = retained;
    let status;
    const disarmed = [];
    const sandbox = {
      cancelled: false,
      AVAILABILITY_STAGE_PATH: "/api/availability",
      fetch: async () => {
        if (kind === "network") throw new Error("offline");
        return { status: kind === "missing" ? 404 : kind === "invalid" ? 409 : 503,
          json: async () => ({ code: kind === "missing" ? "AVAILABILITY_STAGE_MISSING" : "AVAILABILITY_STAGE_RECOVERY_INVALID" }) };
      },
      classifyAvailabilityStageRead,
      setAvailabilityStageReadStatus: (value) => { status = value; },
      setAvailabilityStage: (value) => { stage = value; },
      evaluateAvailabilityGate: () => ({ armingAllowed: false }),
      availabilityGateRef: { current: { armingAllowed: true } },
      deferredAvailabilityGateRef: { current: { armingAllowed: true } },
      setAvailabilityGate: () => {},
      setAutoDraft: (value) => disarmed.push(value),
    };
    vm.createContext(sandbox);
    vm.runInContext(ts.transpileModule(`globalThis.refresh = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    await sandbox.refresh();
    if (kind === "missing" || kind === "invalid") {
      assert.equal(stage, null);
      assert.equal(status, kind);
      assert.equal(sandbox.availabilityGateRef.current.armingAllowed, false);
      assert.equal(sandbox.deferredAvailabilityGateRef.current.armingAllowed, false);
      assert.deepEqual(disarmed, [false]);
    } else {
      assert.equal(stage, retained);
      assert.equal(status, "unavailable");
      assert.deepEqual(disarmed, []);
    }
  }
});
