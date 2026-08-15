export function draftPollKey(context) {
  const tabId = Number(context?.tabId);
  const leagueId = String(context?.leagueId || "");
  return Number.isInteger(tabId) && leagueId ? `${tabId}:${leagueId}` : "";
}

export function createPollCoordinator({ minIntervalMs = 1800, now = () => Date.now() } = {}) {
  const lastStartedAt = new Map();
  const inFlight = new Map();

  function run(context, task) {
    const key = draftPollKey(context);
    if (!key) return Promise.resolve({ skipped: true, reason: "INVALID_CONTEXT" });
    const running = inFlight.get(key);
    if (running) return running;

    const startedAt = now();
    const previousStart = lastStartedAt.get(key);
    if (Number.isFinite(previousStart) && startedAt - previousStart < minIntervalMs) {
      return Promise.resolve({ skipped: true, reason: "THROTTLED" });
    }

    lastStartedAt.set(key, startedAt);
    const request = Promise.resolve()
      .then(task)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  }

  return { run };
}
