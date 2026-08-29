import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_TRADYR_KEYCHAIN_ACCOUNT,
  SERVER_TRADYR_KEYCHAIN_READ_MAX_BUFFER_BYTES,
  SERVER_TRADYR_KEYCHAIN_READ_TIMEOUT_MS,
  SERVER_TRADYR_KEYCHAIN_SERVICE,
  resolveServerOnlyTradyrEnvironment,
  withServerOnlyTradyrEnvironment,
} from "../scripts/server-only-tradyr-credential.mjs";
import { fetchCapturedIntelligenceSnapshot } from "../scripts/capture-source-snapshot.mjs";

test("shared server credential resolver preserves explicit precedence and bounded Keychain safety", () => {
  const credential = "private-keychain-token";
  let reads = 0;
  const explicit = resolveServerOnlyTradyrEnvironment({
    environment: { TRADYR_API_KEY: ` ${credential} ` },
    platform: "darwin",
    keychainReadImpl: () => { reads += 1; },
  });
  assert.equal(explicit.TRADYR_API_KEY, credential);
  assert.equal(reads, 0);

  const calls = [];
  const resolved = resolveServerOnlyTradyrEnvironment({
    environment: {},
    platform: "darwin",
    keychainReadImpl: (...args) => {
      calls.push(args);
      return { status: 0, stdout: `${credential}\n`, stderr: "must remain private" };
    },
  });
  assert.equal(resolved.TRADYR_API_KEY, credential);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], "/usr/bin/security");
  assert.deepEqual(calls[0][1], [
    "find-generic-password",
    "-s", SERVER_TRADYR_KEYCHAIN_SERVICE,
    "-a", SERVER_TRADYR_KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  assert.deepEqual(calls[0][2], {
    encoding: "utf8",
    timeout: SERVER_TRADYR_KEYCHAIN_READ_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: SERVER_TRADYR_KEYCHAIN_READ_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
});

test("shared server credential resolver fails closed on unsupported, denied, timed-out, and invalid reads", () => {
  const credential = "private-keychain-token";
  for (const result of [
    { status: 1, stdout: credential },
    { status: null, stdout: credential, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) },
    { status: 0, stdout: "short" },
    { status: 0, stdout: `${credential}\nsecond-line` },
  ]) {
    const resolved = resolveServerOnlyTradyrEnvironment({
      environment: {},
      platform: "darwin",
      keychainReadImpl: () => result,
    });
    assert.equal(resolved.TRADYR_API_KEY, undefined);
  }
  const denied = resolveServerOnlyTradyrEnvironment({
    environment: {},
    platform: "darwin",
    keychainReadImpl: () => { throw new Error("interaction denied"); },
  });
  assert.equal(denied.TRADYR_API_KEY, undefined);
  const unsupported = resolveServerOnlyTradyrEnvironment({
    environment: {},
    platform: "linux",
    keychainReadImpl: () => assert.fail("non-macOS capture must not invoke Keychain"),
  });
  assert.equal(unsupported.TRADYR_API_KEY, undefined);
});

test("snapshot capture borrows one server-only credential and restores its environment", async () => {
  const credential = "private-keychain-token";
  const environment = { PATH: "/usr/bin" };
  let fetches = 0;
  const result = await fetchCapturedIntelligenceSnapshot(
    { scoring: "PPR", teams: 12, season: 2026, qbs: 2 },
    {
      environment,
      platform: "darwin",
      keychainReadImpl: () => ({ status: 0, stdout: `${credential}\n`, stderr: credential }),
      fetchImpl: async (request) => {
        fetches += 1;
        assert.equal(environment.TRADYR_API_KEY, credential);
        assert.equal(request.qbs, 2);
        return { sourceSnapshotId: "captured" };
      },
    },
  );
  assert.deepEqual(result, { sourceSnapshotId: "captured" });
  assert.equal(fetches, 1);
  assert.equal(environment.TRADYR_API_KEY, undefined);

  environment.TRADYR_API_KEY = " explicit-private-token ";
  await fetchCapturedIntelligenceSnapshot({}, {
    environment,
    platform: "darwin",
    keychainReadImpl: () => assert.fail("explicit capture credential must win"),
    fetchImpl: async () => {
      assert.equal(environment.TRADYR_API_KEY, "explicit-private-token");
      throw new Error("provider failure");
    },
  }).then(
    () => assert.fail("provider failure must propagate"),
    (error) => assert.match(error.message, /provider failure/),
  );
  assert.equal(environment.TRADYR_API_KEY, " explicit-private-token ");
});

test("scoped server credential helper requires an operation and restores absence after failure", async () => {
  const environment = {};
  await assert.rejects(
    withServerOnlyTradyrEnvironment(
      async () => { throw new Error("capture failed"); },
      {
        environment,
        platform: "darwin",
        keychainReadImpl: () => ({ status: 0, stdout: "private-keychain-token" }),
      },
    ),
    /capture failed/,
  );
  assert.equal(environment.TRADYR_API_KEY, undefined);
  await assert.rejects(withServerOnlyTradyrEnvironment(null), /TRADYR_SERVER_OPERATION_REQUIRED/);
});
