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

test("a hung draft poll expires but quarantines its room until the underlying task settles", async () => {
  let clock = 10_000;
  let nextTimerId = 1;
  const timers = new Map();
  const setTimer = (callback, delay) => {
    const timerId = nextTimerId++;
    timers.set(timerId, { callback, dueAt: clock + delay });
    return timerId;
  };
  const clearTimer = (timerId) => timers.delete(timerId);
  const advance = async (milliseconds) => {
    clock += milliseconds;
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.dueAt <= clock)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [timerId, timer] of due) {
      timers.delete(timerId);
      timer.callback();
    }
    await Promise.resolve();
  };
  const coordinator = createPollCoordinator({
    minIntervalMs: 100,
    taskTimeoutMs: 500,
    now: () => clock,
    setTimer,
    clearTimer,
  });
  const room = { tabId: 41, leagueId: "701" };
  let rejectHung;
  let observedSignal;
  const hung = coordinator.run(room, (signal) => new Promise((_resolve, reject) => {
    observedSignal = signal;
    rejectHung = reject;
  }));
  const overlap = coordinator.run(room, () => ({ ok: true, sequence: 2 }));
  assert.equal(hung, overlap);

  await advance(499);
  let settled = false;
  hung.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  await advance(1);
  assert.deepEqual(await hung, { skipped: true, reason: "TIMED_OUT" });
  assert.equal(observedSignal.aborted, true);

  const quarantined = Array.from({ length: 1000 }, () => coordinator.run(room, async () => ({ ok: true, sequence: 3 })));
  assert.equal(new Set(quarantined).size, 1, "every retry shares the same quarantined public result");
  assert.equal(quarantined[0], hung);
  assert.deepEqual(await quarantined[0], { skipped: true, reason: "TIMED_OUT" });

  rejectHung(new Error("late transport failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 0);

  const recovered = await coordinator.run(room, async () => ({ ok: true, sequence: 3 }));
  assert.deepEqual(recovered, { ok: true, sequence: 3 });
});

test("poll bookkeeping stays bounded across 10k abort-ignorant room namespaces", async () => {
  const timers = new Map();
  let nextTimer = 1;
  const lateResolutions = [];
  const coordinator = createPollCoordinator({
    minIntervalMs: 0,
    taskTimeoutMs: 5_000,
    maxKeys: 32,
    setTimer(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) { timers.delete(id); },
  });
  const requests = [];
  for (let index = 1; index <= 10_000; index += 1) {
    requests.push(coordinator.run({ tabId: index, leagueId: `league-${index}` }, (_signal, token) => new Promise((resolve) => {
      lateResolutions.push({ resolve, token, context: { tabId: index, leagueId: `league-${index}` } });
    })));
  }
  await Promise.resolve();
  assert.deepEqual(coordinator.stats(), { lastStartedAt: 32, inFlight: 32, maxKeys: 32 });
  assert.equal(timers.size, 32);

  for (let index = 1; index <= 10_000; index += 1) coordinator.retireTab(index);
  assert.deepEqual(coordinator.stats(), { lastStartedAt: 0, inFlight: 0, maxKeys: 32 });
  assert.equal(timers.size, 0);
  for (const late of lateResolutions) {
    assert.equal(coordinator.isCurrent(late.context, late.token), false);
    late.resolve({ ok: true, stale: true });
  }
  await Promise.all(requests);
  assert.deepEqual(coordinator.stats(), { lastStartedAt: 0, inFlight: 0, maxKeys: 32 });
});

test("explicit navigation retirement suppresses an abort-ignorant late completion token", async () => {
  let resolveLate;
  let observedToken;
  const context = { tabId: 41, leagueId: "701" };
  const coordinator = createPollCoordinator({ minIntervalMs: 0, taskTimeoutMs: 5_000 });
  const request = coordinator.run(context, (_signal, token) => new Promise((resolve) => {
    observedToken = token;
    resolveLate = resolve;
  }));
  await Promise.resolve();
  assert.equal(coordinator.isCurrent(context, observedToken), true);
  assert.equal(coordinator.retire(context, "NAVIGATION"), true);
  assert.equal(coordinator.isCurrent(context, observedToken), false);
  assert.deepEqual(await request, { skipped: true, reason: "NAVIGATION" });
  resolveLate({ ok: true, stale: true });
});
