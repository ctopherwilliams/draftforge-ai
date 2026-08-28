import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_SNAKE_MONITOR_LEAD_MS,
  advanceAuthoritativePickFeed,
  authoritativePickFeedHealth,
  buildSnakePlanTiming,
  inferAuctionSaleCountFromBudgets,
  nextPickFeedRuntimeHealth,
  snakePlanKey,
  snakePlanReadyToSubmit,
} from "../app/lib/live-draft-orchestration.ts";
import {
  appendLiveControlEvent,
  buildLiveControlCompactView,
  createLiveControlState,
} from "../app/lib/live-control.ts";

const pick = (overall, playerId, teamId = 2, amount = 0) => ({
  overall,
  playerId,
  teamId,
  round: 1,
  amount,
});

test("authoritative pick-feed freshness ignores zero-pick and repeated ESPN heartbeats", () => {
  const zero = advanceAuthoritativePickFeed(null, []);
  assert.equal(zero.accepted, true);
  assert.equal(zero.advanced, false);
  assert.equal(zero.cursor, null);

  const first = advanceAuthoritativePickFeed(zero.cursor, [pick(1, 101)]);
  assert.equal(first.accepted, true);
  assert.equal(first.advanced, true);
  assert.equal(first.cursor?.sequence, 1);

  const repeated = advanceAuthoritativePickFeed(first.cursor, [pick(1, 101)]);
  assert.equal(repeated.accepted, true);
  assert.equal(repeated.advanced, false);
  assert.equal(repeated.cursor, first.cursor);
});

test("pick-feed health separates unchanged observation from event advance and detects only completed-event lag", () => {
  const pickOne = authoritativePickFeedHealth(null, [], { currentPick: 1 }, "SNAKE");
  assert.equal(pickOne.advanced, false);
  assert.equal(pickOne.lagging, false);

  const first = authoritativePickFeedHealth(null, [pick(1, 101)], { currentPick: 2 }, "SNAKE");
  assert.equal(first.advanced, true);
  assert.equal(first.lagging, false);
  const slowOpponent = authoritativePickFeedHealth(first.cursor, [pick(1, 101)], { currentPick: 2 }, "SNAKE");
  assert.equal(slowOpponent.advanced, false);
  assert.equal(slowOpponent.lagging, false);
  const apiBehind = authoritativePickFeedHealth(first.cursor, [pick(1, 101)], { currentPick: 3 }, "SNAKE");
  assert.equal(apiBehind.lagging, true);

  const auctionCaughtUp = authoritativePickFeedHealth(null, [pick(1, 101, 8, 22)], { auctionSales: [{ sequence: 1 }] }, "AUCTION");
  assert.equal(auctionCaughtUp.lagging, false);
  const auctionBehind = authoritativePickFeedHealth(auctionCaughtUp.cursor, [pick(1, 101, 8, 22)], { auctionSales: [{ sequence: 1 }, { sequence: 2 }] }, "AUCTION");
  assert.equal(auctionBehind.lagging, true);
  const commonModeOmission = authoritativePickFeedHealth(
    auctionCaughtUp.cursor,
    [pick(1, 101, 8, 22)],
    { auctionSales: [{ sequence: 1 }], budgetInferredSaleCount: 2 },
    "AUCTION",
  );
  assert.equal(commonModeOmission.lagging, true, "complete budgets independently expose a sale omitted by both ledgers");
  assert.equal(authoritativePickFeedHealth(
    auctionCaughtUp.cursor,
    [pick(1, 101, 8, 22)],
    { auctionSales: [{ sequence: 1 }], budgetInferredSaleCount: null },
    "AUCTION",
  ).lagging, true, "invalid complete budget evidence fails closed");
  assert.equal(authoritativePickFeedHealth(
    null,
    [],
    { auctionSales: [], budgetInferredSaleCount: undefined },
    "AUCTION",
  ).lagging, true, "a cold restart cannot mark an auction feed healthy before the complete budget table is readable");
});

test("complete salary-cap budgets deterministically infer rostered-player count", () => {
  const league = { size: 2, rosterSize: 3 };
  assert.equal(inferAuctionSaleCountFromBudgets([
    { teamName: "Alpha", remaining: 190, maxOffer: 189 },
    { teamName: "Bravo", remaining: 175, maxOffer: 175 },
  ], league), 3);
  assert.equal(inferAuctionSaleCountFromBudgets([
    { teamName: "Alpha", remaining: 190, maxOffer: 189 },
  ], league), undefined, "an incomplete budget table is not independent evidence");
  assert.equal(inferAuctionSaleCountFromBudgets([
    { teamName: "Alpha", remaining: 190, maxOffer: 189 },
    { teamName: "Alpha", remaining: 175, maxOffer: 175 },
  ], league), null, "duplicate teams are ambiguous");
  assert.equal(inferAuctionSaleCountFromBudgets([
    { teamName: "Alpha", remaining: 0, maxOffer: 0 },
    { teamName: "Bravo", remaining: 175, maxOffer: 175 },
  ], league), null, "$0/$0 cannot independently prove a full roster");
});

test("authoritative pick-feed cursor rejects a lagging API response and advances on a real sale", () => {
  const current = advanceAuthoritativePickFeed(null, [pick(1, 101), pick(2, 202)]).cursor;
  const lagging = advanceAuthoritativePickFeed(current, [pick(1, 101)]);
  assert.equal(lagging.accepted, false);
  assert.equal(lagging.advanced, false);
  assert.equal(lagging.cursor, current);

  const sale = advanceAuthoritativePickFeed(current, [pick(1, 101), pick(2, 202), pick(3, 303, 7, 41)]);
  assert.equal(sale.accepted, true);
  assert.equal(sale.advanced, true);
  assert.equal(sale.cursor?.sequence, 3);
  assert.match(sale.cursor?.fingerprint || "", /3:303:7:41/);
});

test("authoritative pick-feed rejects empty-after-progress, gaps, duplicates, and historical rewrites", () => {
  const accepted = advanceAuthoritativePickFeed(null, [pick(1, 101), pick(2, 202)]);
  const current = accepted.cursor;

  assert.equal(advanceAuthoritativePickFeed(current, []).accepted, false);
  assert.equal(advanceAuthoritativePickFeed(current, [pick(1, 101), pick(3, 303)]).accepted, false);
  assert.equal(advanceAuthoritativePickFeed(current, [pick(1, 101), pick(2, 202), pick(2, 303)]).accepted, false);
  assert.equal(advanceAuthoritativePickFeed(current, [pick(1, 999), pick(2, 202)]).accepted, false);
  assert.equal(advanceAuthoritativePickFeed(current, [pick(1, 101), pick(2, 999), pick(3, 303)]).accepted, false);
  assert.equal(advanceAuthoritativePickFeed(current, [pick(1, 101), pick(2, 202), pick(3, 303)]).accepted, true);
});

test("a rejected feed response immediately closes local action health until an accepted reconciliation", () => {
  const prior = { observedAt: "2026-08-28T01:00:00.000Z", lagging: false, fresh: true };
  const rejected = nextPickFeedRuntimeHealth(
    prior,
    "2026-08-28T01:00:01.000Z",
    { accepted: false, lagging: false },
  );
  assert.deepEqual(rejected, {
    observedAt: prior.observedAt,
    lagging: true,
    fresh: false,
  });

  const recovered = nextPickFeedRuntimeHealth(
    rejected,
    "2026-08-28T01:00:02.000Z",
    { accepted: true, lagging: false },
  );
  assert.deepEqual(recovered, {
    observedAt: "2026-08-28T01:00:02.000Z",
    lagging: false,
    fresh: true,
  });
});

test("a normal 60-second snake turn publishes one idempotent plan at least five seconds before click", () => {
  const start = Date.parse("2026-08-28T01:00:00.000Z");
  const identity = {
    leagueId: "1603083723",
    teamId: 6,
    tabId: 41,
    expectedPick: 14,
    playerId: 101,
    sourceSnapshotId: "snapshot-five-source-20260828",
    availabilityDigest: `sha256:${"a".repeat(64)}`,
    submitTargetSeconds: 27,
  };
  const firstKey = snakePlanKey(identity);
  assert.equal(snakePlanKey({ ...identity }), firstKey, "repeated renders must resolve the same plan key");

  const timing = buildSnakePlanTiming(start, 60, identity.submitTargetSeconds);
  const target = Date.parse(timing.submitNotBeforeAt);
  assert.equal(target - start, 33_000);
  assert.ok(target - start >= MIN_SNAKE_MONITOR_LEAD_MS);
  const intendedPlayer = { playerId: 101, playerName: "Intended Receiver", position: "WR" };
  const decision = {
    decisionId: "decision-14",
    decidedAt: timing.decidedAt,
    contextCapturedAt: timing.decidedAt,
    leagueId: identity.leagueId,
    teamId: identity.teamId,
    tabId: identity.tabId,
    operation: "SELECT",
    sourceSnapshotId: identity.sourceSnapshotId,
    availabilityDigest: identity.availabilityDigest,
    availabilityDecisionDigest: `sha256:${"b".repeat(64)}`,
    expectedPick: identity.expectedPick,
    submitNotBeforeAt: timing.submitNotBeforeAt,
    submitTargetSeconds: timing.submitTargetSeconds,
    intendedPlayer,
    alternatives: [{ playerId: 202, playerName: "Alternative Runner", position: "RB" }],
  };
  const empty = createLiveControlState("snake-monitor-session");
  const published = {
    ...appendLiveControlEvent(empty, {
      kind: "ACTION_LIFECYCLE",
      occurredAt: timing.decidedAt,
      actionId: "action-14",
      decisionId: decision.decisionId,
      operation: "SELECT",
      phase: "PLANNED",
      intendedPlayer,
      code: "AUTO_ACTION_PLANNED",
    }),
    decision,
  };
  const monitor = buildLiveControlCompactView(published, 0, start);
  assert.equal(monitor.decision?.intendedPlayer.playerName, "Intended Receiver");
  assert.equal(monitor.events.filter((event) => event.kind === "ACTION_LIFECYCLE").length, 1);
  assert.equal(snakePlanReadyToSubmit(timing, start + 32_000, 28), false);
  assert.equal(snakePlanReadyToSubmit(timing, target, 27), true);
});

test("a late snake observation cannot click before the monitor lead window", () => {
  const start = Date.parse("2026-08-28T01:00:00.000Z");
  const timing = buildSnakePlanTiming(start, 28, 27);
  assert.equal(snakePlanReadyToSubmit(timing, start + 1_000, 27), false);
  assert.equal(snakePlanReadyToSubmit(timing, start + MIN_SNAKE_MONITOR_LEAD_MS, 23), true);
});
