import assert from "node:assert/strict";
import test from "node:test";
import { GET, dispatchLeaseMatchesAudit } from "../app/api/draft-day/route.ts";
import {
  SERVER_DISPATCH_LEASE_TIMEOUT_MS,
  verifyServerDispatchLease,
} from "../extension/server-dispatch-lease.js";

const dashboardLoadedAt = "2026-08-28T12:00:00.000Z";
const actionId = "action-1";
const notAfter = Date.parse("2026-08-28T12:00:06.000Z");
const sourceSnapshotId = `sha256:${"c".repeat(64)}`;
const availabilityDigest = `sha256:${"a".repeat(64)}`;
const availabilityDecisionDigest = `sha256:${"b".repeat(64)}`;
const expectation = {
  leagueId: "701",
  teamId: 5,
  tabId: 77,
  commandCenterSessionId: "command-center-session",
  dashboardLoadedAt,
  actionId,
  decisionId: "decision-1",
  sourceSnapshotId,
  availabilityDigest,
  availabilityDecisionDigest,
  operation: "BID",
  playerId: 12345,
  notAfter,
  expectedCurrentBid: 27,
  amount: 28,
  maxApprovedBid: 35,
};
const snapshot = {
  league: { id: "701", teamId: 5 },
  binding: {
    tabId: 77,
    commandCenterSessionId: "command-center-session",
    dashboardLoadedAt,
  },
  liveControl: {
    events: [{ kind: "ACTION_LIFECYCLE", actionId, decisionId: "decision-1" }],
    decision: {
      decisionId: "decision-1",
      sourceSnapshotId,
      availabilityDigest,
      availabilityDecisionDigest,
      operation: "BID",
      intendedPlayer: { playerId: 12345, playerName: "Exact Player" },
      expectedCurrentBid: 27,
      intendedOffer: 28,
      maxApprovedBid: 35,
      notAfter,
    },
  },
};

test("the final BID server dispatch lease binds every exact source, availability, identity, and price field", () => {
  assert.equal(dispatchLeaseMatchesAudit(snapshot, expectation, "2026-08-28T11:59:59.999Z"), true);
  for (const [field, value] of [
    ["leagueId", "702"],
    ["teamId", 6],
    ["tabId", 78],
    ["commandCenterSessionId", "other-command-center"],
    ["dashboardLoadedAt", "2026-08-28T12:00:00.001Z"],
    ["actionId", "action-2"],
    ["decisionId", "decision-2"],
    ["sourceSnapshotId", `sha256:${"d".repeat(64)}`],
    ["availabilityDigest", `sha256:${"e".repeat(64)}`],
    ["availabilityDecisionDigest", `sha256:${"f".repeat(64)}`],
    ["operation", "NOMINATE"],
    ["playerId", 54321],
    ["notAfter", notAfter + 1],
    ["expectedCurrentBid", 26],
    ["amount", 29],
    ["maxApprovedBid", 36],
  ]) {
    assert.equal(dispatchLeaseMatchesAudit(snapshot, { ...expectation, [field]: value }, "2026-08-28T11:59:59.999Z"), false, field);
  }
  const ambiguousLineage = structuredClone(snapshot);
  ambiguousLineage.liveControl.events.push({ kind: "ACTION_LIFECYCLE", actionId: "action-2", decisionId: "decision-1" });
  assert.equal(dispatchLeaseMatchesAudit(ambiguousLineage, expectation), false, "a decision cannot authorize two action identities");
});

test("SELECT and NOMINATE leases bind only their exact operation-specific decisions", () => {
  const selectDecision = {
    decisionId: "decision-select",
    sourceSnapshotId,
    availabilityDigest,
    availabilityDecisionDigest,
    operation: "SELECT",
    intendedPlayer: { playerId: 101, playerName: "Exact Receiver" },
    expectedPick: 14,
    notAfter,
  };
  const selectSnapshot = {
    ...snapshot,
    liveControl: {
      events: [{ kind: "ACTION_LIFECYCLE", actionId: "action-select", decisionId: selectDecision.decisionId }],
      decision: selectDecision,
    },
  };
  const selectExpectation = {
    ...expectation,
    decisionId: selectDecision.decisionId,
    actionId: "action-select",
    operation: "SELECT",
    playerId: selectDecision.intendedPlayer.playerId,
    expectedPick: 14,
  };
  delete selectExpectation.expectedCurrentBid;
  delete selectExpectation.amount;
  delete selectExpectation.maxApprovedBid;
  assert.equal(dispatchLeaseMatchesAudit(selectSnapshot, selectExpectation), true);
  assert.equal(dispatchLeaseMatchesAudit(selectSnapshot, { ...selectExpectation, expectedPick: 15 }), false);
  assert.equal(dispatchLeaseMatchesAudit(selectSnapshot, { ...selectExpectation, amount: 0 }), false, "unrelated price fields are not accepted");

  const nominateDecision = {
    decisionId: "decision-nominate",
    sourceSnapshotId,
    availabilityDigest,
    availabilityDecisionDigest,
    operation: "NOMINATE",
    intendedPlayer: { playerId: 202, playerName: "Exact Runner" },
    intendedOffer: 2,
    nominationIntent: "DRAIN",
    notAfter,
  };
  const nominateSnapshot = {
    ...snapshot,
    liveControl: {
      events: [{ kind: "ACTION_LIFECYCLE", actionId: "action-nominate", decisionId: nominateDecision.decisionId }],
      decision: nominateDecision,
    },
  };
  const nominateExpectation = {
    ...expectation,
    decisionId: nominateDecision.decisionId,
    actionId: "action-nominate",
    operation: "NOMINATE",
    playerId: nominateDecision.intendedPlayer.playerId,
    amount: 2,
    nominationIntent: "DRAIN",
  };
  delete nominateExpectation.expectedCurrentBid;
  delete nominateExpectation.maxApprovedBid;
  assert.equal(dispatchLeaseMatchesAudit(nominateSnapshot, nominateExpectation), true);
  assert.equal(dispatchLeaseMatchesAudit(nominateSnapshot, { ...nominateExpectation, amount: 1 }), false);
  assert.equal(dispatchLeaseMatchesAudit(nominateSnapshot, { ...nominateExpectation, nominationIntent: "TARGET" }), false);
});

test("missing or malformed operation-specific query values never coerce to an audited zero", () => {
  const zeroBidSnapshot = structuredClone(snapshot);
  zeroBidSnapshot.liveControl.decision.expectedCurrentBid = 0;
  zeroBidSnapshot.liveControl.decision.intendedOffer = 1;
  const zeroBid = { ...expectation, expectedCurrentBid: 0, amount: 1 };
  assert.equal(dispatchLeaseMatchesAudit(zeroBidSnapshot, zeroBid), true);
  for (const field of ["expectedCurrentBid", "amount", "maxApprovedBid"]) {
    const missing = { ...zeroBid };
    delete missing[field];
    assert.equal(dispatchLeaseMatchesAudit(zeroBidSnapshot, missing), false, `missing ${field}`);
  }
  for (const malformed of ["", "00", "-0", "NaN", "1.0", null]) {
    assert.equal(dispatchLeaseMatchesAudit(zeroBidSnapshot, { ...zeroBid, expectedCurrentBid: malformed }), false, String(malformed));
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
    actionId,
    decisionId: "decision-1",
    sourceSnapshotId,
    availabilityDigest,
    availabilityDecisionDigest,
    operation: "BID",
    playerId: 12345,
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
    notAfter: 20_000,
  };
  const now = () => 10_000;
  const exact = await verifyServerDispatchLease(payload, {
    now,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("decisionId"), "decision-1");
      assert.equal(parsed.searchParams.get("actionId"), actionId);
      assert.equal(parsed.searchParams.get("playerId"), "12345");
      assert.equal(parsed.searchParams.get("sourceSnapshotId"), sourceSnapshotId);
      assert.equal(parsed.searchParams.get("availabilityDigest"), availabilityDigest);
      assert.equal(parsed.searchParams.get("availabilityDecisionDigest"), availabilityDecisionDigest);
      assert.equal(parsed.searchParams.get("expectedCurrentBid"), "27");
      assert.equal(parsed.searchParams.get("amount"), "28");
      assert.equal(parsed.searchParams.get("maxApprovedBid"), "35");
      assert.equal(parsed.searchParams.get("notAfter"), "20000");
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

test("a server acknowledgement arriving at the absolute deadline authorizes no click", async () => {
  let clock = 10_000;
  const result = await verifyServerDispatchLease({
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedTabId: 77,
    commandCenterSessionId: "command-center-session",
    dashboardLoadedAt,
    actionId,
    decisionId: "decision-1",
    sourceSnapshotId,
    availabilityDigest,
    availabilityDecisionDigest,
    operation: "BID",
    playerId: 12345,
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
    notAfter: 10_001,
  }, {
    now: () => clock,
    fetchImpl: async () => {
      clock = 10_001;
      return Response.json({ ok: true, code: "DRAFT_ACTION_SERVER_LEASE_CURRENT" });
    },
  });
  assert.deepEqual(result, { ok: false, code: "ACTION_DEADLINE_EXPIRED" });
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
