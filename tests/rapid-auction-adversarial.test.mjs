import assert from "node:assert/strict";
import test from "node:test";
import {
  actionDeadlineStatus,
  actionPayloadMatchesBinding,
  restoredBindingMatchesEvidence,
} from "../extension/action-binding.js";
import {
  appendLiveControlEvent,
  buildLiveControlCompactView,
  createLiveControlState,
  validateLiveControlTransition,
} from "../app/lib/live-control.ts";
import { buildDraftDayBridgeResult, prepareDraftDayBridge } from "../app/lib/draft-day-bridge.ts";
import { openStarterSlots, recommendPlayers } from "../app/lib/draft-engine.ts";
import { resolveOwnNominationIntent } from "../app/lib/espn-context-state.ts";
import { shouldReevaluateSupersededBid } from "../app/lib/live-draft-orchestration.ts";

const EVALUATED_AT = "2026-08-28T02:00:00.000Z";
const SOURCE_UPDATED_AT = "2026-08-28T01:59:00.000Z";
const OUR_TEAM_ID = 7;

const players = [
  [101, "Anchor Runner", "RB", 335, 52],
  [102, "Anchor Receiver", "WR", 330, 50],
  [103, "Quarterback One", "QB", 395, 36],
  [104, "Tight End One", "TE", 275, 25],
  [105, "Runner Two", "RB", 305, 42],
  [106, "Receiver Two", "WR", 302, 40],
  [107, "Runner Three", "RB", 280, 31],
  [108, "Receiver Three", "WR", 278, 30],
  [109, "Quarterback Two", "QB", 375, 24],
  [110, "Tight End Two", "TE", 250, 15],
  [111, "Runner Four", "RB", 260, 20],
  [112, "Receiver Four", "WR", 258, 19],
  [113, "Kicker One", "K", 150, 1],
  [114, "Defense One", "DST", 155, 1],
  [115, "Kicker Two", "K", 145, 1],
  [116, "Defense Two", "DST", 148, 1],
  [117, "Depth Quarterback", "QB", 350, 12],
  [118, "Depth Tight End", "TE", 230, 8],
  [119, "Depth Runner", "RB", 240, 10],
  [120, "Depth Receiver", "WR", 238, 9],
].map(([id, name, pos, projected, auction], index) => ({
  id,
  name,
  team: `NFL${index + 1}`,
  pos,
  rank: index + 1,
  adp: index + 1,
  auction,
  projected,
}));

const league = Object.freeze({
  id: "44050",
  name: "Rapid Auction QA",
  season: 2026,
  size: 2,
  teamId: OUR_TEAM_ID,
  draftType: "AUCTION",
  secondsPerPick: 30,
  rosterSize: 8,
  auctionBudget: 200,
  lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1 },
  positionLimits: { QB: 2, RB: 4, WR: 4, TE: 2, K: 1, DST: 1 },
  scoringLabel: "PPR",
  scoringRules: 46,
  keeperCount: 0,
  pickOrder: [OUR_TEAM_ID, 8],
  teams: [
    { id: OUR_TEAM_ID, name: "Us", abbrev: "US" },
    { id: 8, name: "Rival", abbrev: "RIV" },
  ],
});

const sources = [
  ["ffc", "market", 0.15],
  ["mfl", "market", 0.15],
  ["tradyr", "composite", 0.2],
  ["gng", "model", 0.2],
].map(([id, kind, weight]) => ({
  id,
  name: String(id).toUpperCase(),
  kind,
  weight,
  status: "ok",
  updatedAt: SOURCE_UPDATED_AT,
  attribution: String(id),
  players: players.map((player) => ({
    name: player.name,
    team: player.team,
    pos: player.pos,
    rank: player.rank,
    adp: player.adp,
    auction: player.auction,
  })),
}));

const prepared = prepareDraftDayBridge(league, players, sources, EVALUATED_AT);

function room(overrides = {}) {
  return {
    leagueId: league.id,
    teamId: league.teamId,
    season: league.season,
    inDraftRoom: true,
    onClock: false,
    remainingSeconds: 20,
    soundMuted: true,
    autopickActive: false,
    actionSurfaceReady: true,
    ownRoster: [],
    availablePlayerIds: players.map((player) => player.id),
    availablePlayerNames: players.map((player) => player.name),
    ...overrides,
  };
}

function decide(roomOverrides = {}, picks = []) {
  return buildDraftDayBridgeResult({
    league,
    espnPlayers: players,
    picks,
    sources,
    room: room(roomOverrides),
    strategy: "BALANCED",
    evaluatedAt: EVALUATED_AT,
    prepared,
  });
}

function actionableNominees(count = 2) {
  return decide().recommendations.filter((player) => player.maxBid >= 4).slice(0, count);
}

test("rapid offer churn invalidates a planned bid instead of retargeting it", () => {
  const [first, second] = actionableNominees();
  assert.ok(first && second, "fixture needs two actionable salary-cap players");
  const initial = decide({
    nominatedPlayer: first.name,
    nominatedPlayerId: first.id,
    currentBid: 1,
    maxLegalBid: 193,
    leadingBid: false,
  });
  assert.equal(initial.code, "BID_READY");
  assert.equal(initial.action.expectedCurrentBid, 1);
  assert.equal(initial.action.amount, 2);

  const priceJump = decide({
    nominatedPlayer: first.name,
    nominatedPlayerId: first.id,
    currentBid: 2,
    maxLegalBid: 193,
    leadingBid: false,
  });
  assert.notEqual(priceJump.action?.expectedCurrentBid, initial.action.expectedCurrentBid);
  assert.notEqual(priceJump.action?.amount, initial.action.amount);

  const samePriceNextNominee = decide({
    nominatedPlayer: second.name,
    nominatedPlayerId: second.id,
    currentBid: 1,
    maxLegalBid: 193,
    leadingBid: false,
  });
  assert.equal(samePriceNextNominee.code, "BID_READY");
  assert.equal(samePriceNextNominee.action.expectedCurrentBid, 1);
  assert.equal(samePriceNextNominee.action.playerId, second.id);
  assert.notEqual(samePriceNextNominee.action.playerId, initial.action.playerId);

  for (const [overrides, expectedCode] of [
    [{ leadingBid: true }, "HOLD_LEADING_BID"],
    [{ leadingBid: null }, "LEADING_BID_UNKNOWN"],
    [{ remainingSeconds: 4 }, "CLOCK_TOO_SHORT"],
    [{ remainingSeconds: null }, "CLOCK_TOO_SHORT"],
    [{ maxLegalBid: 1 }, "WALK_AWAY"],
  ]) {
    const changed = decide({
      nominatedPlayer: first.name,
      nominatedPlayerId: first.id,
      currentBid: 1,
      maxLegalBid: 193,
      leadingBid: false,
      ...overrides,
    });
    assert.equal(changed.code, expectedCode);
    assert.equal(changed.action, null);
  }
});

test("every rapid bid is exactly one dollar and bounded by both source and ESPN ceilings", () => {
  const [nominee] = actionableNominees(1);
  assert.ok(nominee, "fixture needs an actionable salary-cap player");
  const sourceCeiling = nominee.maxBid;
  for (let currentBid = 1; currentBid <= sourceCeiling + 2; currentBid += 1) {
    const result = decide({
      nominatedPlayer: nominee.name,
      nominatedPlayerId: nominee.id,
      currentBid,
      maxLegalBid: Math.min(17, sourceCeiling),
      leadingBid: false,
    });
    const hardCeiling = Math.min(17, sourceCeiling);
    if (currentBid + 1 <= hardCeiling) {
      assert.equal(result.code, "BID_READY");
      assert.equal(result.action.amount, currentBid + 1);
      assert.equal(result.action.maxApprovedBid, hardCeiling);
      assert.ok(result.action.amount <= result.action.maxApprovedBid);
    } else {
      assert.equal(result.code, "WALK_AWAY");
      assert.equal(result.action, null);
    }
  }
});

test("a superseded bid schedules one fresh +$1 decision without retrying an uncertain click", () => {
  const [nominee] = actionableNominees(1);
  assert.ok(nominee && nominee.maxBid >= 13, "fixture needs room for a superseded bid");
  const original = decide({
    nominatedPlayer: nominee.name,
    nominatedPlayerId: nominee.id,
    currentBid: 10,
    maxLegalBid: nominee.maxBid,
    leadingBid: false,
  });
  assert.equal(original.code, "BID_READY");
  assert.equal(original.action.amount, 11);

  assert.equal(shouldReevaluateSupersededBid({
    ok: true,
    code: "BID_SUPERSEDED",
    action: { operation: "BID" },
  }), true);
  const fresh = decide({
    nominatedPlayer: nominee.name,
    nominatedPlayerId: nominee.id,
    currentBid: 12,
    maxLegalBid: nominee.maxBid,
    leadingBid: false,
  });
  assert.equal(fresh.code, "BID_READY");
  assert.equal(fresh.action.expectedCurrentBid, 12);
  assert.equal(fresh.action.amount, 13);
  assert.ok(fresh.action.amount <= fresh.action.maxApprovedBid);

  assert.equal(shouldReevaluateSupersededBid({
    ok: false,
    code: "BID_ACK_UNCERTAIN",
    action: { operation: "BID" },
  }), false, "an uncertain click must remain fail closed");
  assert.equal(shouldReevaluateSupersededBid({
    ok: true,
    code: "BID_SUPERSEDED",
    action: { operation: "NOMINATE" },
  }), false, "a non-bid result cannot schedule a bid pass");

  const alreadyLeading = decide({
    nominatedPlayer: nominee.name,
    nominatedPlayerId: nominee.id,
    currentBid: 12,
    maxLegalBid: nominee.maxBid,
    leadingBid: true,
  });
  assert.equal(alreadyLeading.code, "HOLD_LEADING_BID");
  assert.equal(alreadyLeading.action, null, "fresh state never raises our own offer");
});

test("context arriving before a terminal result is reconsidered once after in-flight clears", () => {
  const [nominee] = actionableNominees(1);
  assert.ok(nominee && nominee.maxBid >= 13, "fixture needs room for a later exact bid");
  let actionInFlight = true;
  let lastActionKey = `${league.id}:bid:${nominee.id}:11`;
  const submissions = [];
  const newestRoom = {
    nominatedPlayer: nominee.name,
    nominatedPlayerId: nominee.id,
    currentBid: 12,
    maxLegalBid: nominee.maxBid,
    leadingBid: false,
  };
  const runBidEffect = () => {
    if (actionInFlight) return;
    const result = decide(newestRoom);
    if (result.code !== "BID_READY" || !result.action) return;
    const key = `${league.id}:bid:${result.action.playerId}:${result.action.amount}`;
    if (lastActionKey === key) return;
    lastActionKey = key;
    submissions.push(result.action);
  };

  // ESPN's $12 context can beat the old $11 acknowledgement to React. The
  // first pass observes it but must not compete with the old in-flight click.
  runBidEffect();
  assert.equal(submissions.length, 0);

  // Terminal acknowledgement is a wake edge even when the room context does
  // not change again. The next pass derives a brand-new exact +$1 command.
  actionInFlight = false;
  runBidEffect();
  runBidEffect();
  assert.equal(submissions.length, 1, "the settled wake produces no duplicate");
  assert.equal(submissions[0].expectedCurrentBid, 12);
  assert.equal(submissions[0].amount, 13);
  assert.ok(submissions[0].amount <= submissions[0].maxApprovedBid);

  // The same wake mechanism also reconsiders a nomination turn that arrived
  // while the prior action was pending, without bypassing the normal engine.
  actionInFlight = true;
  const nominationSubmissions = [];
  let lastNominationKey = "";
  const runNominationEffect = () => {
    if (actionInFlight) return;
    const result = decide({
      onClock: true,
      currentBid: 0,
      nominatedPlayer: null,
      maxLegalBid: 193,
    });
    if (result.code !== "NOMINATION_READY" || !result.action) return;
    const key = `${league.id}:1:${result.action.playerId}:AUCTION:${result.action.nominationIntent}:0`;
    if (lastNominationKey === key) return;
    lastNominationKey = key;
    nominationSubmissions.push(result.action);
  };
  runNominationEffect();
  assert.equal(nominationSubmissions.length, 0);
  actionInFlight = false;
  runNominationEffect();
  runNominationEffect();
  assert.equal(nominationSubmissions.length, 1);
  assert.equal(nominationSubmissions[0].operation, "NOMINATE");

  const snakeLeague = { ...league, draftType: "SNAKE" };
  const snakePrepared = prepareDraftDayBridge(snakeLeague, players, sources, EVALUATED_AT);
  const snakeSubmissions = [];
  let lastSnakeKey = "";
  actionInFlight = true;
  const runSnakeEffect = () => {
    if (actionInFlight) return;
    const result = buildDraftDayBridgeResult({
      league: snakeLeague,
      espnPlayers: players,
      picks: [],
      sources,
      room: room({ onClock: true, currentPick: 2 }),
      strategy: "BALANCED",
      evaluatedAt: EVALUATED_AT,
      prepared: snakePrepared,
    });
    if (result.code !== "SELECT_READY" || !result.action) return;
    const key = `${snakeLeague.id}:2:${result.action.playerId}:SNAKE:PICK:0`;
    if (lastSnakeKey === key) return;
    lastSnakeKey = key;
    snakeSubmissions.push(result.action);
  };
  runSnakeEffect();
  assert.equal(snakeSubmissions.length, 0);
  actionInFlight = false;
  runSnakeEffect();
  runSnakeEffect();
  assert.equal(snakeSubmissions.length, 1, "the newest consecutive snake turn wakes once");
  assert.equal(snakeSubmissions[0].operation, "SELECT");
});

test("MV3 binding recovery never renews an action's absolute click deadline", () => {
  const binding = {
    leagueId: league.id,
    teamId: league.teamId,
    season: league.season,
    tabId: 77,
    appTabId: 88,
    commandCenterSessionId: "rapid-auction-session",
  };
  const context = {
    leagueId: league.id,
    teamId: league.teamId,
    season: league.season,
    tabId: binding.tabId,
    inDraftRoom: true,
  };
  const evidence = {
    appTabUrl: "http://127.0.0.1:3000/",
    espnTabUrl: `https://fantasy.espn.com/football/draft?leagueId=${league.id}&teamId=${league.teamId}&seasonId=${league.season}`,
    context,
  };
  const now = 10_000;
  const payload = {
    expectedLeagueId: league.id,
    expectedTeamId: league.teamId,
    expectedSeason: league.season,
    expectedTabId: binding.tabId,
    commandCenterSessionId: binding.commandCenterSessionId,
    actionRequestId: 501,
    notAfter: now + 2_000,
  };

  assert.equal(restoredBindingMatchesEvidence(structuredClone(binding), evidence, ["http://127.0.0.1:3000"]), true);
  const restoredPayload = structuredClone(payload);
  assert.equal(restoredPayload.notAfter, payload.notAfter);
  assert.equal(actionPayloadMatchesBinding(binding, restoredPayload, context, binding.tabId), true);
  assert.equal(actionDeadlineStatus(restoredPayload, now), "ACTION_DEADLINE_VALID");
  assert.equal(actionDeadlineStatus(restoredPayload, payload.notAfter), "ACTION_EXPIRED");
  assert.equal(actionDeadlineStatus({ ...restoredPayload, notAfter: now + 10_001 }, now), "ACTION_DEADLINE_INVALID");
});

test("an uncertain DRAIN acknowledgement remains an exact no-bid veto across recovery", () => {
  const [nominee, other] = actionableNominees();
  assert.ok(nominee && other, "fixture needs two salary-cap players");
  const pending = { playerId: nominee.id, playerName: nominee.name, intent: "DRAIN" };
  const recoveredIntent = resolveOwnNominationIntent({}, nominee, pending);
  assert.equal(recoveredIntent, "DRAIN");

  const recovered = decide({
    nominatedPlayer: nominee.name,
    nominatedPlayerId: nominee.id,
    currentBid: 1,
    maxLegalBid: 193,
    leadingBid: false,
    ownNominationIntent: recoveredIntent,
    ownNominationPlayerId: nominee.id,
  });
  assert.equal(recovered.code, "PASS_DRAIN_NOMINEE");
  assert.equal(recovered.action, null);

  assert.equal(resolveOwnNominationIntent({}, other, pending), null);
  const nextNominee = decide({
    nominatedPlayer: other.name,
    nominatedPlayerId: other.id,
    currentBid: 1,
    maxLegalBid: 193,
    leadingBid: false,
    ownNominationIntent: "DRAIN",
    ownNominationPlayerId: nominee.id,
  });
  assert.equal(nextNominee.code, "BID_READY");
  assert.equal(nextNominee.action.playerId, other.id);
});

test("read-only monitor polling cannot reorder or mutate the single-writer action ledger", async () => {
  const at = (offset) => new Date(Date.parse(EVALUATED_AT) + offset).toISOString();
  const intendedPlayer = { playerId: 101, playerName: "Anchor Runner", position: "RB" };
  const decision = {
    decisionId: "auction-decision-1",
    decidedAt: at(0),
    contextCapturedAt: at(0),
    leagueId: league.id,
    teamId: league.teamId,
    tabId: 77,
    operation: "BID",
    sourceSnapshotId: "five-source-snapshot",
    expectedCurrentBid: 20,
    intendedOffer: 21,
    maxApprovedBid: 28,
    intendedPlayer,
    alternatives: [],
  };
  let writer = createLiveControlState("rapid-auction-control", {
    espnContextAt: at(0),
    pickFeedAt: at(0),
    sourceSnapshotAt: at(0),
  });
  const initial = writer;
  writer = {
    ...appendLiveControlEvent(writer, {
      kind: "ACTION_LIFECYCLE",
      occurredAt: at(1),
      actionId: "auction-action-1",
      decisionId: decision.decisionId,
      operation: "BID",
      phase: "PLANNED",
      intendedPlayer,
      intendedOffer: 21,
    }),
    decision,
  };
  const planned = writer;
  writer = appendLiveControlEvent(writer, {
    kind: "ACTION_LIFECYCLE",
    occurredAt: at(2),
    actionId: "auction-action-1",
    decisionId: decision.decisionId,
    operation: "BID",
    phase: "RESOLVED",
    intendedPlayer,
    resolvedPlayer: intendedPlayer,
    intendedOffer: 21,
    resolvedOffer: 21,
  });
  writer = { ...writer, decision: { ...decision, resolvedPlayer: intendedPlayer, resolvedOffer: 21 } };
  const resolved = writer;
  writer = appendLiveControlEvent(writer, {
    kind: "ACTION_LIFECYCLE",
    occurredAt: at(3),
    actionId: "auction-action-1",
    decisionId: decision.decisionId,
    operation: "BID",
    phase: "CLICK_SENT",
    intendedOffer: 21,
    resolvedOffer: 21,
  });
  const clicked = writer;
  writer = appendLiveControlEvent(writer, {
    kind: "ACTION_LIFECYCLE",
    occurredAt: at(4),
    actionId: "auction-action-1",
    decisionId: decision.decisionId,
    operation: "BID",
    phase: "ESPN_ACKNOWLEDGED",
    intendedOffer: 21,
    resolvedOffer: 21,
  });
  writer = appendLiveControlEvent(writer, {
    kind: "ACTION_LIFECYCLE",
    occurredAt: at(5),
    actionId: "auction-action-1",
    decisionId: decision.decisionId,
    operation: "BID",
    phase: "ACTION_COMPLETED",
    intendedOffer: 21,
    resolvedOffer: 21,
  });
  const completed = writer;

  const snapshots = await Promise.all([
    Promise.resolve(buildLiveControlCompactView(planned, 0, Date.parse(at(6)))),
    Promise.resolve(buildLiveControlCompactView(resolved, planned.sequence, Date.parse(at(6)))),
    Promise.resolve(buildLiveControlCompactView(clicked, resolved.sequence, Date.parse(at(6)))),
    Promise.resolve(buildLiveControlCompactView(completed, clicked.sequence, Date.parse(at(6)))),
  ]);
  assert.deepEqual(snapshots.map((view) => view.sequence), [1, 2, 3, 5]);
  assert.deepEqual(snapshots.flatMap((view) => view.events).map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.equal(snapshots.every((view) => view.decision?.intendedOffer === 21), true);
  assert.equal(completed.pendingActionCount, 0);
  assert.equal(initial.sequence, 0, "monitor and writer transitions leave earlier immutable snapshots untouched");
  assert.equal(planned.sequence, 1);
  assert.equal(validateLiveControlTransition(planned, resolved).ok, true);
  assert.equal(validateLiveControlTransition(resolved, clicked).ok, true);
  assert.equal(validateLiveControlTransition(clicked, completed).ok, true);
});

test("late salary-cap recommendations preserve reserve and force mandatory completion", () => {
  const ownedIds = [103, 104, 105, 106, 113, 114];
  const picks = ownedIds.map((playerId, index) => ({
    playerId,
    teamId: league.teamId,
    overall: index + 1,
    round: 0,
    amount: [70, 42, 30, 25, 1, 1][index],
  }));
  const rosterPositions = picks.map((pick) => players.find((player) => player.id === pick.playerId).pos);
  assert.equal(openStarterSlots(league, rosterPositions), 2);

  const recommendations = recommendPlayers(players, picks, league, "BALANCED", picks.length + 1);
  const remainingBudget = league.auctionBudget - picks.reduce((sum, pick) => sum + pick.amount, 0);
  const legalMaximum = remainingBudget - (league.rosterSize - picks.length - 1);
  assert.equal(legalMaximum, 30);
  assert.equal(recommendations[0].fillsMandatoryStarter, true);
  assert.ok(recommendations.every((player) => player.maxBid <= legalMaximum));
  assert.ok(recommendations.filter((player) => !player.fillsMandatoryStarter).every((player) => player.maxBid === 0));
  assert.equal(recommendations.some((player) => player.id === 115), false, "a second kicker is never legal");
  assert.equal(recommendations.some((player) => player.id === 116), false, "a second defense is never legal");
});
