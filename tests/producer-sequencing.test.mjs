import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const backgroundUrl = new URL("../extension/background.js", import.meta.url);
const pageUrl = new URL("../app/page.tsx", import.meta.url);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function callbackBody(source, variableName) {
  const ast = ts.createSourceFile("app/page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = null;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === variableName) {
      const initializer = node.initializer;
      callback = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, `${variableName} callback must exist`);
  return callback.getText(ast);
}

function context({ revision, capturedAt, session = "producer-a" }) {
  return {
    inDraftRoom: true,
    tabId: 41,
    leagueId: "701",
    teamId: 5,
    season: 2026,
    producerSessionId: session,
    producerRevision: revision,
    contextCapturedAt: capturedAt,
  };
}

test("the MV3 background rejects late context deliveries from the same or an older producer", async () => {
  const source = await readFile(backgroundUrl, "utf8");
  const helper = sourceBetween(source, "function acceptEspnProducerContext", "async function broadcastBoundActionResult");
  const sandbox = { espnContextProducerStates: new Map() };
  vm.runInNewContext(`${helper}\nglobalThis.accept = acceptEspnProducerContext;`, sandbox);

  const newer = context({ revision: 2, capturedAt: "2026-08-28T01:00:02.000Z" });
  const older = context({ revision: 1, capturedAt: "2026-08-28T01:00:01.000Z" });
  assert.equal(sandbox.accept(newer, 41), true);
  assert.equal(sandbox.accept(older, 41), false);
  assert.equal(sandbox.espnContextProducerStates.get("41:701:5:2026").producerRevision, 2);

  const restartedNewer = context({ revision: 1, capturedAt: "2026-08-28T01:00:03.000Z", session: "producer-b" });
  const restartedOlder = context({ revision: 99, capturedAt: "2026-08-28T01:00:00.000Z", session: "producer-c" });
  assert.equal(sandbox.accept(restartedNewer, 41), true, "a genuinely newer content-script session can recover after reload");
  assert.equal(sandbox.accept(restartedOlder, 41), false, "revision alone cannot revive an older producer session");
});

test("the command center applies the same monotonic producer fence before live state mutation", async () => {
  const source = await readFile(pageUrl, "utf8");
  const callback = callbackBody(source, "acceptLiveProducerContext");
  const sandbox = { espnProducerStatesRef: { current: new Map() } };
  vm.createContext(sandbox);
  const compiled = ts.transpileModule(`globalThis.accept = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInContext(compiled, sandbox);

  const newer = context({ revision: 7, capturedAt: "2026-08-28T01:00:07.000Z" });
  const duplicate = context({ revision: 7, capturedAt: "2026-08-28T01:00:08.000Z" });
  const older = context({ revision: 6, capturedAt: "2026-08-28T01:00:06.000Z" });
  assert.equal(sandbox.accept(newer), true);
  assert.equal(sandbox.accept(duplicate), false);
  assert.equal(sandbox.accept(older), false);
  assert.equal(sandbox.espnProducerStatesRef.current.get("41:701:5:2026").producerRevision, 7);

  assert.equal(sandbox.accept({ inDraftRoom: false }), true, "pre-room imports remain outside the live producer namespace");
  assert.equal(sandbox.accept({ ...newer, producerSessionId: "" }), false, "unsequenced live contexts fail closed");
});
