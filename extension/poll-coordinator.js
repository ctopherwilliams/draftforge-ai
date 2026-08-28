export function draftPollKey(context) {
  const tabId = Number(context?.tabId);
  const leagueId = String(context?.leagueId || "");
  return Number.isInteger(tabId) && leagueId ? `${tabId}:${leagueId}` : "";
}

export function createPollCoordinator({
  minIntervalMs = 1800,
  taskTimeoutMs = 5000,
  maxKeys = 128,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  const lastStartedAt = new Map();
  const inFlight = new Map();
  const timeoutMs = Number.isFinite(taskTimeoutMs) && taskTimeoutMs > 0
    ? Math.floor(taskTimeoutMs)
    : 5000;
  const maximumKeys = Number.isSafeInteger(maxKeys) && maxKeys > 0 ? maxKeys : 128;
  let generation = 0;

  function retireKey(key, reason = "RETIRED") {
    const entry = inFlight.get(key);
    if (entry) {
      inFlight.delete(key);
      clearTimer(entry.timeout);
      entry.controller.abort(new Error(`POLL_TASK_${reason}`));
      entry.resolveRetired({ type: "RETIRED", reason });
    }
    lastStartedAt.delete(key);
    return Boolean(entry);
  }

  function makeRoomFor(key) {
    if (!lastStartedAt.has(key)) {
      while (lastStartedAt.size >= maximumKeys) {
        const oldest = lastStartedAt.keys().next().value;
        if (oldest === undefined) break;
        retireKey(oldest, "CAPACITY_EVICTED");
      }
    }
    if (!inFlight.has(key)) {
      while (inFlight.size >= maximumKeys) {
        const oldest = inFlight.keys().next().value;
        if (oldest === undefined) break;
        retireKey(oldest, "CAPACITY_EVICTED");
      }
    }
  }

  function run(context, task) {
    const key = draftPollKey(context);
    if (!key) return Promise.resolve({ skipped: true, reason: "INVALID_CONTEXT" });
    const running = inFlight.get(key);
    if (running) return running.request;

    const startedAt = now();
    const previousStart = lastStartedAt.get(key);
    if (Number.isFinite(previousStart) && startedAt - previousStart < minIntervalMs) {
      return Promise.resolve({ skipped: true, reason: "THROTTLED" });
    }

    makeRoomFor(key);
    lastStartedAt.delete(key);
    lastStartedAt.set(key, startedAt);
    let timeout;
    const controller = new AbortController();
    const token = ++generation;
    const taskResult = Promise.resolve()
      .then(() => controller.signal.aborted
        ? { skipped: true, reason: "ABORTED_BEFORE_START" }
        : task(controller.signal, token))
      // Handle late rejection even when the timeout wins the race. Without
      // this branch a hung transport that eventually rejects can surface as an
      // unhandled rejection after its coordinator slot has already expired.
      .then(
        (value) => ({ type: "COMPLETED", value }),
        (error) => ({ type: "FAILED", error }),
      );
    const timeoutResult = new Promise((resolve) => {
      timeout = setTimer(() => {
        // Resolve the caller's bounded wait first, then ask the underlying
        // transport to stop. If a hostile/buggy task ignores AbortSignal, its
        // exact room remains quarantined instead of accumulating orphan polls.
        resolve({ type: "TIMED_OUT" });
        controller.abort(new Error("POLL_TASK_TIMEOUT"));
      }, timeoutMs);
    });
    let resolveRetired;
    const retiredResult = new Promise((resolve) => { resolveRetired = resolve; });
    let request;
    request = Promise.race([taskResult, timeoutResult, retiredResult])
      .then((result) => {
        if (result.type === "FAILED") throw result.error;
        if (result.type === "TIMED_OUT") return { skipped: true, reason: "TIMED_OUT" };
        if (result.type === "RETIRED") return { skipped: true, reason: result.reason };
        return result.value;
      });
    const entry = { request, taskResult, controller, token, timeout: null, resolveRetired };
    inFlight.set(key, entry);
    entry.timeout = timeout;
    // Release only after the underlying task actually settles. The public
    // deadline alone is not proof that an abort-ignorant transport is gone.
    void taskResult.then(() => {
      clearTimer(timeout);
      if (inFlight.get(key) === entry) inFlight.delete(key);
    });
    return request;
  }

  function retire(context, reason = "RETIRED") {
    const key = typeof context === "string" ? context : draftPollKey(context);
    return key ? retireKey(key, reason) : false;
  }

  function retireTab(tabId, reason = "TAB_RETIRED") {
    const prefix = `${Number(tabId)}:`;
    const keys = new Set([...lastStartedAt.keys(), ...inFlight.keys()]);
    let retired = 0;
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        retireKey(key, reason);
        retired += 1;
      }
    }
    return retired;
  }

  function isCurrent(context, token) {
    const entry = inFlight.get(draftPollKey(context));
    return Boolean(entry && entry.token === token && !entry.controller.signal.aborted);
  }

  function stats() {
    return { lastStartedAt: lastStartedAt.size, inFlight: inFlight.size, maxKeys: maximumKeys };
  }

  return { run, retire, retireTab, isCurrent, stats };
}
