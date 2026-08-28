import test from "node:test";
import assert from "node:assert/strict";
import { contextCanTriggerLiveRoomWatch, createLiveRoomWatch, liveLeagueMatchesWatch, liveRoomRuleSignature } from "../extension/live-room-watch.js";

const sourceLeague = {
  id: "1603083723",
  name: "SOMFAB",
  season: 2026,
  teamId: 6,
  size: 10,
  draftType: "SNAKE",
  rosterSize: 16,
  auctionBudget: 200,
  lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 7: 1, 16: 1, 17: 1, 20: 6, 23: 1 },
  positionLimits: { 0: 4, 2: 8, 4: 8, 6: 3, 16: 3, 17: 3 },
  scoringLabel: "Standard",
  scoringRules: 29,
  keeperCount: 0,
};
const sourceContext = { leagueId: sourceLeague.id, teamId: 6, season: 2026, tabId: 41, inDraftRoom: false };

test("one exact authenticated source arms a bounded live-room watch", () => {
  const sourcePlayers = [{ id: 1, name: "Player One" }];
  const sourcePlayersFetchedAt = "2026-08-28T12:00:00.000Z";
  const watch = createLiveRoomWatch({ appTabId: 7, sourceContext, sourceLeague, sourcePlayers, sourcePlayersFetchedAt, autoArmRequested: true, now: 1000, windowMs: 5000 });
  assert.equal(watch.appTabId, 7);
  assert.equal(watch.sourceTabId, 41);
  assert.equal(watch.expiresAt, 6000);
  assert.equal(watch.rules, liveRoomRuleSignature(sourceLeague));
  assert.deepEqual(watch.sourcePlayers, sourcePlayers);
  assert.equal(watch.sourcePlayersFetchedAt, sourcePlayersFetchedAt);
  assert.deepEqual(watch.sourcePlayerEnvelope, {
    fetchedAt: sourcePlayersFetchedAt,
    leagueId: sourceLeague.id,
    teamId: sourceLeague.teamId,
    season: sourceLeague.season,
    playerCount: 1,
  });
  assert.equal(Object.isFrozen(watch.sourcePlayerEnvelope), true);
  assert.equal(watch.autoArmRequested, true);
});

test("a source draft room or mismatched source identity cannot arm", () => {
  assert.equal(createLiveRoomWatch({ appTabId: 7, sourceContext: { ...sourceContext, inDraftRoom: true }, sourceLeague }), null);
  assert.equal(createLiveRoomWatch({ appTabId: 7, sourceContext: { ...sourceContext, leagueId: "other" }, sourceLeague }), null);
  assert.equal(createLiveRoomWatch({
    appTabId: 7,
    sourceContext,
    sourceLeague,
    sourcePlayers: [{ id: 1, name: "Unstamped player pool" }],
  }), null, "a nonempty player pool may never receive a synthetic fresh timestamp");
});

test("only one exact team, season, live room, and unexpired watch can trigger", () => {
  const watch = createLiveRoomWatch({ appTabId: 7, sourceContext, sourceLeague, now: 1000, windowMs: 5000 });
  const live = { leagueId: "900", teamId: 6, season: 2026, tabId: 88, inDraftRoom: true };
  assert.equal(contextCanTriggerLiveRoomWatch(watch, live, 2000), true);
  assert.equal(contextCanTriggerLiveRoomWatch(watch, { ...live, teamId: 7 }, 2000), false);
  assert.equal(contextCanTriggerLiveRoomWatch(watch, { ...live, season: 2027 }, 2000), false);
  assert.equal(contextCanTriggerLiveRoomWatch(watch, { ...live, inDraftRoom: false }, 2000), false);
  assert.equal(contextCanTriggerLiveRoomWatch(watch, live, 7000), false);
});

test("a practice room must preserve every source rule and exact generated name", () => {
  const watch = createLiveRoomWatch({ appTabId: 7, sourceContext, sourceLeague, now: Date.now() });
  const context = { leagueId: "900", teamId: 6, season: 2026, tabId: 88, inDraftRoom: true };
  const liveLeague = { ...sourceLeague, id: "900", name: "Practice Draft for SOMFAB", secondsPerPick: 30 };
  assert.equal(liveLeagueMatchesWatch(watch, liveLeague, context), true);
  assert.equal(liveLeagueMatchesWatch(watch, { ...liveLeague, rosterSize: 15 }, context), false);
  assert.equal(liveLeagueMatchesWatch(watch, { ...liveLeague, name: "Practice Draft for Other" }, context), false);
});

test("the real league id is allowed only with the same exact rules", () => {
  const watch = createLiveRoomWatch({ appTabId: 7, sourceContext, sourceLeague, now: Date.now() });
  const context = { leagueId: sourceLeague.id, teamId: 6, season: 2026, tabId: 88, inDraftRoom: true };
  assert.equal(liveLeagueMatchesWatch(watch, sourceLeague, context), true);
  assert.equal(liveLeagueMatchesWatch(watch, { ...sourceLeague, scoringRules: 28 }, context), false);
});
