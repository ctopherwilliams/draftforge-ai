import { createServer } from "node:http";

export function liveControlFixturePayload({
  sequence = 7,
  now = Date.now(),
  since = 0,
  events,
  operator = null,
  overrides = {},
} = {}) {
  const capturedAt = new Date(now).toISOString();
  const earliestRetainedSequence = sequence === 0 ? 0 : Math.max(1, sequence - 255);
  const firstResponseSequence = Math.max(since + 1, earliestRetainedSequence);
  const resolvedEvents = events ?? Array.from(
    { length: Math.max(0, sequence - firstResponseSequence + 1) },
    (_, index) => ({ sequence: firstResponseSequence + index }),
  );
  return {
    ok: true,
    code: "DRAFT_LIVE_CONTROL_READY",
    capturedAt,
    league: { id: "1603083723", teamId: 6, draftType: "SNAKE" },
    control: {
      schemaVersion: 1,
      sessionId: "release-gate-fixture",
      sequence,
      earliestRetainedSequence,
      truncated: earliestRetainedSequence > 0 && since + 1 < earliestRetainedSequence,
      unchanged: sequence <= since,
      pendingActionCount: 0,
      historicalAutopickDetected: false,
      uncontrolledRosterAdditionDetected: false,
      unattributedRosterCount: 0,
      decision: null,
      freshness: {
        espnContextAt: capturedAt,
        pickFeedAt: capturedAt,
        pickFeedObservedAt: capturedAt,
        pickFeedLagging: false,
        sourceSnapshotAt: capturedAt,
        lastActionAt: null,
      },
      agesMs: {
        espnContext: 0,
        pickFeed: 0,
        pickFeedObserved: 0,
        sourceSnapshot: 0,
        lastAction: null,
      },
      rosterAttributions: [],
      events: resolvedEvents,
      ...overrides,
    },
    operator,
    evaluation: {
      complete: false,
      finalReady: false,
      parity: true,
      finalViolations: [],
    },
  };
}

function defaultResponse({ request } = {}) {
  const url = new URL(request?.url || "/", "http://127.0.0.1");
  const rawSince = Number(url.searchParams.get("since") || 0);
  const since = Number.isSafeInteger(rawSince) && rawSince >= 0 ? rawSince : 0;
  return { status: 200, body: liveControlFixturePayload({ since }) };
}

/**
 * Start a loopback-only HTTP fixture with bounded cleanup. The optional
 * responder receives request metadata and may return status/body/delayMs,
 * `hang: true`, or `destroy: true` for chaos tests.
 */
export async function startLiveControlFixture({ responder = defaultResponse } = {}) {
  const sockets = new Set();
  const stats = { requests: 0, methods: [], urls: [] };
  const pendingTimers = new Set();
  const server = createServer((request, response) => {
    stats.requests += 1;
    stats.methods.push(request.method || "");
    stats.urls.push(request.url || "");
    const behavior = responder({ request, requestNumber: stats.requests }) || defaultResponse();
    if (behavior.destroy) {
      request.socket.destroy();
      return;
    }
    if (behavior.hang) return;
    const send = () => {
      if (response.destroyed) return;
      const body = typeof behavior.body === "string" ? behavior.body : JSON.stringify(behavior.body ?? {});
      response.writeHead(Number(behavior.status || 200), {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
    };
    const delayMs = Math.max(0, Number(behavior.delayMs || 0));
    if (!delayMs) send();
    else {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        send();
      }, delayMs);
      pendingTimers.add(timer);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LIVE_CONTROL_FIXTURE_BIND_FAILED");
  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stats,
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
