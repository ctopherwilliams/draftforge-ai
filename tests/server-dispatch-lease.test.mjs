import assert from "node:assert/strict";
import test from "node:test";
import { GET, dispatchLeaseMatchesAudit } from "../app/api/draft-day/route.ts";
import {
  SERVER_DISPATCH_LEASE_TIMEOUT_MS,
  verifyServerDispatchLease,
} from "../extension/server-dispatch-lease.js";

const dashboardLoadedAt = "2026-08-28T12:00:00.000Z";
const expectation = {
  leagueId: "701",
  teamId: 5,
  tabId: 77,
  commandCenterSessionId: "command-center-session",
  dashboardLoadedAt,
  decisionId: "decision-1",
  operation: "BID",
  playerId: 12345,
};
const snapshot = {
  league: { id: "701", teamId: 5 },
  binding: {
    tabId: 77,
    commandCenterSessionId: "command-center-session",
    dashboardLoadedAt,
  },
  liveControl: {
    decision: {
      decisionId: "decision-1",
      operation: "BID",
      intendedPlayer: { playerId: 12345, playerName: "Exact Player" },
    },
  },
};

test("the final server dispatch lease binds exact dashboard, publisher, decision, operation, and player", () => {
  assert.equal(dispatchLeaseMatchesAudit(snapshot, expectation, "2026-08-28T11:59:59.999Z"), true);
  for (const [field, value] of [
    ["leagueId", "702"],
    ["teamId", 6],
    ["tabId", 78],
    ["commandCenterSessionId", "other-command-center"],
    ["dashboardLoadedAt", "2026-08-28T12:00:00.001Z"],
    ["decisionId", "decision-2"],
    ["operation", "NOMINATE"],
    ["playerId", 54321],
  ]) {
    assert.equal(dispatchLeaseMatchesAudit(snapshot, { ...expectation, [field]: value }, "2026-08-28T11:59:59.999Z"), false, field);
  }
});

test("a production child restart invalidates an acknowledged old-dashboard action", () => {
  assert.equal(dispatchLeaseMatchesAudit(snapshot, expectation, dashboardLoadedAt), true);
  assert.equal(
    dispatchLeaseMatchesAudit(snapshot, expectation, "2026-08-28T12:00:00.001Z"),
    false,
    "the server instance starts after both the old dashboard and its checkpoint-restored decision",
  );
});

test("the extension-side lease accepts only an exact successful JSON acknowledgement", async () => {
  const payload = {
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedTabId: 77,
    commandCenterSessionId: "command-center-session",
    dashboardLoadedAt,
    decisionId: "decision-1",
    operation: "BID",
    playerId: 12345,
    notAfter: 20_000,
  };
  const now = () => 10_000;
  const exact = await verifyServerDispatchLease(payload, {
    now,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("decisionId"), "decision-1");
      assert.equal(parsed.searchParams.get("playerId"), "12345");
      assert.equal(options.cache, "no-store");
      return Response.json({ ok: true, code: "DRAFT_ACTION_SERVER_LEASE_CURRENT" });
    },
  });
  assert.deepEqual(exact, { ok: true, code: "DRAFT_ACTION_SERVER_LEASE_CURRENT" });

  for (const response of [
    new Response("not json", { status: 200 }),
    Response.json({ ok: false, code: "DRAFT_ACTION_SERVER_LEASE_STALE" }, { status: 409 }),
    Response.json({ ok: true, code: "WRONG_ACK" }),
  ]) {
    const rejected = await verifyServerDispatchLease(payload, { now, fetchImpl: async () => response });
    assert.equal(rejected.ok, false);
  }
  const transportFailure = await verifyServerDispatchLease(payload, {
    now,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(transportFailure, { ok: false, code: "SERVER_DISPATCH_LEASE_UNVERIFIED" });
});

test("the server lease check is bounded inside the rapid-bid dispatch budget", async () => {
  assert.equal(SERVER_DISPATCH_LEASE_TIMEOUT_MS, 350);
  const startedAt = Date.now();
  const result = await verifyServerDispatchLease({ ...expectation, expectedLeagueId: "701", expectedTeamId: 5, expectedTabId: 77, notAfter: startedAt + 25 }, {
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
  });
  assert.equal(result.code, "SERVER_DISPATCH_LEASE_UNVERIFIED");
  assert.ok(Date.now() - startedAt < 150, "the lease deadline is bounded by the action's remaining budget");
});

test("only the exact Chrome extension origin receives dispatch-lease CORS", async () => {
  const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
  const allowed = await GET(new Request("http://127.0.0.1:3000/api/draft-day?view=dispatch-lease&leagueId=missing&teamId=5", {
    headers: { Origin: extensionOrigin },
  }));
  assert.equal(allowed.headers.get("access-control-allow-origin"), extensionOrigin);
  const rejected = await GET(new Request("http://127.0.0.1:3000/api/draft-day?view=status&leagueId=missing&teamId=5", {
    headers: { Origin: extensionOrigin },
  }));
  assert.equal(rejected.status, 403);
});
