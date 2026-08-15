import assert from "node:assert/strict";
import test from "node:test";
import { createPollCoordinator, draftPollKey } from "../extension/poll-coordinator.js";

test("draft polling is keyed by exact ESPN tab and league", () => {
  assert.equal(draftPollKey({ tabId: 41, leagueId: "701" }), "41:701");
  assert.equal(draftPollKey({ tabId: 42, leagueId: "701" }), "42:701");
  assert.equal(draftPollKey({ tabId: 41 }), "");
});

test("draft polling coalesces overlap and throttles only the same room", async () => {
  let clock = 10_000;
  let calls = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const coordinator = createPollCoordinator({ minIntervalMs: 1800, now: () => clock });
  const room = { tabId: 41, leagueId: "701" };

  const first = coordinator.run(room, async () => {
    calls += 1;
    await firstGate;
    return { ok: true, sequence: 1 };
  });
  const overlap = coordinator.run(room, async () => {
    calls += 1;
    return { ok: true, sequence: 2 };
  });
  assert.equal(first, overlap);
  assert.equal(calls, 0, "poll work starts in the next microtask");
  releaseFirst();
  assert.deepEqual(await first, { ok: true, sequence: 1 });
  assert.equal(calls, 1);

  const throttled = await coordinator.run(room, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.deepEqual(throttled, { skipped: true, reason: "THROTTLED" });
  assert.equal(calls, 1);

  const otherRoom = await coordinator.run({ tabId: 42, leagueId: "701" }, async () => {
    calls += 1;
    return { ok: true, sequence: 2 };
  });
  assert.deepEqual(otherRoom, { ok: true, sequence: 2 });
  assert.equal(calls, 2);

  clock += 1800;
  await coordinator.run(room, async () => {
    calls += 1;
    return { ok: true, sequence: 3 };
  });
  assert.equal(calls, 3);
});
