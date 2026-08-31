import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPANION_BRIDGE_PROTOCOL_VERSION,
  COMPANION_EXTENSION_SOURCE,
  companionBridgeEnvelopeMatches,
  electCompanionRuntime,
} from "../app/lib/companion-bridge.ts";

const runtimeA = "a".repeat(32);
const runtimeB = "b".repeat(32);

test("the first valid companion runtime is elected and remains exact", () => {
  assert.deepEqual(electCompanionRuntime("", runtimeA), {
    ok: true,
    runtimeId: runtimeA,
    code: "COMPANION_RUNTIME_ELECTED",
  });
  assert.deepEqual(electCompanionRuntime(runtimeA, runtimeA), {
    ok: true,
    runtimeId: runtimeA,
    code: "COMPANION_RUNTIME_CURRENT",
  });
});

test("a second or malformed companion runtime fails closed", () => {
  assert.equal(electCompanionRuntime(runtimeA, runtimeB).code, "MULTIPLE_COMPANION_RUNTIMES");
  assert.equal(electCompanionRuntime("", "not-an-extension-id").code, "COMPANION_RUNTIME_ID_INVALID");
});

test("only the elected versioned bridge envelope is accepted", () => {
  const exact = {
    source: COMPANION_EXTENSION_SOURCE,
    bridgeProtocolVersion: COMPANION_BRIDGE_PROTOCOL_VERSION,
    extensionRuntimeId: runtimeA,
  };
  assert.equal(companionBridgeEnvelopeMatches(exact, runtimeA), true);
  assert.equal(companionBridgeEnvelopeMatches({ ...exact, extensionRuntimeId: runtimeB }, runtimeA), false);
  assert.equal(companionBridgeEnvelopeMatches({ ...exact, bridgeProtocolVersion: 1 }, runtimeA), false);
  assert.equal(companionBridgeEnvelopeMatches({ ...exact, source: "draftforge-extension" }, runtimeA), false);
});
