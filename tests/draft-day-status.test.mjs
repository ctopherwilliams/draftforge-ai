import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_DAY_STATUS_MAX_OUTPUT_BYTES,
  DRAFT_DAY_STATUS_MAX_RESPONSE_BYTES,
  fetchDraftDayStatus,
  parseDraftDayStatusArguments,
} from "../scripts/draft-day-status.mjs";

const leagueId = "1603083723";
const teamId = 6;
const capturedAt = "2026-08-28T01:23:45.000Z";
const statusNow = Date.parse(capturedAt) + 500;
const sourceSnapshotId = `sha256:${"a".repeat(64)}`;

function operatorSnapshot() {
  return {
    room: {
      round: 4,
      pick: 37,
      onClock: true,
      secondsRemaining: 24,
      nominee: null,
      currentBid: null,
      leader: null,
      maxLegalBid: null,
    },
    team: {
      remainingBudget: null,
      openRosterSlots: 13,
      primaryNeeds: [{ position: "RB", count: 2 }, { position: "WR", count: 2 }],
    },
    recommendation: {
      state: "ACTIVE",
      action: "SELECT",
      player: { playerId: 403, playerName: "Next Receiver", position: "WR", team: "MIN" },
      offer: null,
      maxLegalBid: null,
    },
    alternatives: [],
    lastDecision: {
      operation: "SELECT",
      phase: "ROSTER_CONFIRMED",
      player: { playerId: 402, playerName: "Our Receiver", position: "WR", team: "DAL" },
      offer: null,
      occurredAt: capturedAt,
      code: "ROSTER_CONFIRMED",
    },
  };
}

function healthSnapshot(overrides = {}) {
  return {
    liveReady: true,
    blockers: [],
    auditAgeMs: 500,
    espnContextAgeMs: 250,
    pickFeedObservedAgeMs: 300,
    sourceSnapshotAgeMs: 1_000,
    availabilityRemainingMs: 60_000,
    extensionConnected: true,
    inDraftRoom: true,
    autopickActive: false,
    autoDraft: true,
    liveChecklistReady: true,
    sourceCoverage: 5,
    pickFeedLagging: false,
    ...overrides,
  };
}

function statusResponse(overrides = {}) {
  return {
    ok: true,
    code: "DRAFT_DAY_STATUS_SNAPSHOT_READY",
    capturedAt,
    league: { id: leagueId, teamId, draftType: "SNAKE" },
    control: {
      schemaVersion: 1,
      sequence: 18,
      pendingActionCount: 0,
      decisionActive: true,
      historicalAutopickDetected: false,
      uncontrolledRosterAdditionDetected: false,
      unattributedRosterCount: 0,
    },
    health: healthSnapshot(),
    operator: operatorSnapshot(),
    leagueBoard: boardSnapshot(),
    ...overrides,
  };
}

function boardSnapshot() {
  const opponentPick = {
    overall: 35,
    round: 4,
    teamSlot: 1,
    ours: false,
    player: { playerId: 401, playerName: "Public Running Back", position: "RB", team: "ATL" },
    amount: null,
  };
  const ourPick = {
    overall: 36,
    round: 4,
    teamSlot: 2,
    ours: true,
    player: { playerId: 402, playerName: "Our Receiver", position: "WR", team: "DAL" },
    amount: null,
  };
  return {
    draftType: "SNAKE",
    auctionBudget: null,
    rankingBasis: "AVERAGE_PROJECTION",
    recentPicks: [opponentPick, ourPick],
    ourRoster: [ourPick],
    teams: [{
      teamSlot: 1,
      ours: false,
      rank: 2,
      playerCount: 1,
      projectedPoints: 280.2,
      averageProjectedPoints: 280.2,
      spent: null,
      remainingBudget: null,
      positionCounts: { RB: 1 },
    }, {
      teamSlot: 2,
      ours: true,
      rank: 1,
      playerCount: 1,
      projectedPoints: 301.4,
      averageProjectedPoints: 301.4,
      spent: null,
      remainingBudget: null,
      positionCounts: { WR: 1 },
    }],
    recommendation: {
      player: { playerId: 403, playerName: "Next Receiver", position: "WR", team: "MIN" },
      confidence: 84,
      reasons: ["Best projected value", "Receiver tier drop approaching"],
      sourceCount: 5,
      sourceSnapshotId,
    },
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixtureFetch({ status = statusResponse(), calls = [] } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.includes("view=status")) return jsonResponse(status);
    throw new Error("unexpected URL");
  };
}

test("status arguments require exact positive safe identities and a loopback-only origin", () => {
  assert.deepEqual(parseDraftDayStatusArguments([
    "--league", leagueId,
    "--team", String(teamId),
    "--origin", "http://localhost:3000/",
  ]), {
    origin: "http://localhost:3000",
    leagueId,
    teamId,
  });
  for (const argv of [
    ["--team", "6"],
    ["--league", leagueId],
    ["--league", "0", "--team", "6"],
    ["--league", "01", "--team", "6"],
    ["--league", "9007199254740992", "--team", "6"],
    ["--league", leagueId, "--team", "0"],
    ["--league", leagueId, "--team", "06"],
    ["--league", leagueId, "--team", "6", "--origin", "http://192.168.1.5:3000"],
    ["--league", leagueId, "--team", "6", "--polls", "2"],
    ["--league", leagueId, "--team", "6", "--league", leagueId],
  ]) assert.throws(() => parseDraftDayStatusArguments(argv));
});

test("one-shot status makes exactly one no-store GET and returns only bounded sanitized state", async () => {
  const calls = [];
  const priorChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let chromeTouches = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: new Proxy({}, {
      get() {
        chromeTouches += 1;
        throw new Error("STATUS_TOUCHED_CHROME");
      },
    }),
  });
  let result;
  try {
    result = await fetchDraftDayStatus({ leagueId, teamId, origin: "http://127.0.0.1:3000" }, {
      fetchImpl: fixtureFetch({ calls }),
      now: () => statusNow,
    });
  } finally {
    if (priorChrome) Object.defineProperty(globalThis, "chrome", priorChrome);
    else delete globalThis.chrome;
  }
  assert.equal(chromeTouches, 0);
  assert.deepEqual(calls.map((call) => call.url), [
    `http://127.0.0.1:3000/api/draft-day?leagueId=${leagueId}&teamId=${teamId}&view=status`,
  ]);
  assert.equal(calls.length, 1);
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["Cache-Control"], "no-store");
    assert.equal(options.body, undefined);
  }
  assert.equal(result.room.pick, 37);
  assert.equal(result.room.secondsRemaining, 24);
  assert.equal(result.ourRoster[0].player.playerName, "Our Receiver");
  assert.equal(result.recentPicks.length, 2);
  assert.deepEqual(result.teamRanks.map((team) => team.rank), [2, 1]);
  assert.equal(result.recommendation.action.action, "SELECT");
  assert.equal(result.recommendation.analysis.confidence, 84);
  assert.equal(result.controlActionState.pendingActionCount, 0);
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized) <= DRAFT_DAY_STATUS_MAX_OUTPUT_BYTES);
  assert.doesNotMatch(serialized, /sessionId|private-control-session|private-decision|tabId|memberId|cookie|rawAudit|events|rosterAttributions/);
});

test("status fails closed on exact response identity mismatch", async () => {
  for (const league of [
    { id: "999", teamId, draftType: "SNAKE" },
    { id: leagueId, teamId: 7, draftType: "SNAKE" },
  ]) {
    await assert.rejects(
      fetchDraftDayStatus({ leagueId, teamId }, {
        fetchImpl: fixtureFetch({ status: statusResponse({ league }) }),
        now: () => statusNow,
      }),
      /DRAFT_DAY_STATUS_IDENTITY_MISMATCH/,
    );
  }
});

test("status rejects stale and future-skewed audit snapshots independently of server claims", async () => {
  await assert.rejects(
    fetchDraftDayStatus({ leagueId, teamId }, {
      fetchImpl: fixtureFetch(),
      now: () => Date.parse(capturedAt) + 15_001,
    }),
    /DRAFT_DAY_STATUS_STALE/,
  );
  await assert.rejects(
    fetchDraftDayStatus({ leagueId, teamId }, {
      fetchImpl: fixtureFetch(),
      now: () => Date.parse(capturedAt) - 2_001,
    }),
    /DRAFT_DAY_STATUS_CLOCK_SKEW/,
  );
});

test("blocked live health suppresses recommendations while retaining read-only situational status", async () => {
  for (const [code, healthPatch] of [
    ["ESPN_CONTEXT_STALE", { espnContextAgeMs: 20_000 }],
    ["PICK_FEED_STALE", { pickFeedObservedAgeMs: 20_000 }],
    ["PICK_FEED_LAGGING", { pickFeedLagging: true }],
    ["SOURCE_SNAPSHOT_STALE", { sourceSnapshotAgeMs: 700_000 }],
    ["AVAILABILITY_STALE", { availabilityRemainingMs: 0 }],
    ["ESPN_AUTOPICK_ACTIVE", { autopickActive: true }],
    ["EXTENSION_DISCONNECTED", { extensionConnected: false }],
    ["NOT_IN_DRAFT_ROOM", { inDraftRoom: false }],
    ["LIVE_CHECKLIST_NOT_READY", { liveChecklistReady: false }],
    ["SOURCE_COVERAGE_INCOMPLETE", { sourceCoverage: 4 }],
    ["ROSTER_ATTRIBUTION_UNRESOLVED", {}],
  ]) {
    const calls = [];
    const result = await fetchDraftDayStatus({ leagueId, teamId }, {
      fetchImpl: fixtureFetch({
        calls,
        status: statusResponse({
          health: healthSnapshot({ liveReady: false, blockers: [code], ...healthPatch }),
        }),
      }),
      now: () => statusNow,
    });
    assert.equal(result.code, "DRAFT_DAY_STATUS_BLOCKED");
    assert.equal(result.liveReady, false);
    assert.deepEqual(result.blockers, [code]);
    assert.deepEqual(result.recommendation, { action: null, analysis: null });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.body, undefined);
  }
});

test("one atomic response cannot straddle a concurrent writer publication", async () => {
  const calls = [];
  let published = statusResponse();
  const result = await fetchDraftDayStatus({ leagueId, teamId }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const captured = jsonResponse(published);
      published = statusResponse({
        capturedAt: "2026-08-28T01:23:46.000Z",
        operator: { ...operatorSnapshot(), room: { ...operatorSnapshot().room, pick: 38 } },
      });
      return captured;
    },
    now: () => statusNow,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.capturedAt, { control: capturedAt, board: capturedAt });
  assert.equal(result.room.pick, 37);
});

test("status fails closed on missing or malformed sanitized views", async () => {
  await assert.rejects(
    fetchDraftDayStatus({ leagueId, teamId }, {
      fetchImpl: fixtureFetch({ status: statusResponse({ operator: null }) }),
      now: () => statusNow,
    }),
    /DRAFT_DAY_STATUS_SNAPSHOT_MALFORMED/,
  );
  const privateBoard = boardSnapshot();
  privateBoard.teams[0].memberId = "private-member";
  await assert.rejects(
    fetchDraftDayStatus({ leagueId, teamId }, {
      fetchImpl: fixtureFetch({ status: statusResponse({ leagueBoard: privateBoard }) }),
      now: () => statusNow,
    }),
    /DRAFT_DAY_STATUS_SNAPSHOT_MALFORMED/,
  );
});

test("each status response is hard-limited to 64 KiB before parsing", async () => {
  const oversized = "x".repeat(DRAFT_DAY_STATUS_MAX_RESPONSE_BYTES + 1);
  const fetchImpl = async () => new Response(oversized, { status: 200 });
  await assert.rejects(
    fetchDraftDayStatus({ leagueId, teamId }, { fetchImpl, now: () => statusNow }),
    /DRAFT_DAY_STATUS_RESPONSE_TOO_LARGE/,
  );
});

test("the complete one-shot request fails closed at the bounded timeout", async () => {
  let requests = 0;
  const fetchImpl = async (_url, { signal }) => {
    requests += 1;
    return await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  await assert.rejects(
    fetchDraftDayStatus({ leagueId, teamId }, { fetchImpl, timeoutMs: 10, now: () => statusNow }),
    /DRAFT_DAY_STATUS_TIMEOUT/,
  );
  assert.equal(requests, 1);
});
