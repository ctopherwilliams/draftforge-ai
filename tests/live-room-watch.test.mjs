import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT,
  authenticatedEspnPlayerPoolEnvelopeMatches,
  contextCanTriggerLiveRoomWatch,
  createAuthenticatedEspnPlayerPoolEnvelope,
  createLiveRoomWatch,
  liveLeagueMatchesWatch,
  liveRoomRuleSignature,
  sanitizeLiveRoomWatchForStorage,
  validStoredLiveRoomWatch,
} from "../extension/live-room-watch.js";

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
const sourcePlayersFetchedAt = "2026-08-28T12:00:00.000Z";
const sourcePlayers = Array.from({ length: AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT }, (_, index) => ({
  id: index + 1,
  name: `Player ${index + 1}`,
}));
const sourcePlayerEnvelope = createAuthenticatedEspnPlayerPoolEnvelope({
  players: sourcePlayers,
  fetchedAt: sourcePlayersFetchedAt,
  leagueId: sourceLeague.id,
  teamId: sourceLeague.teamId,
  season: sourceLeague.season,
});

function watchInput(overrides = {}) {
  return {
    appTabId: 7,
    sourceContext,
    sourceLeague,
    sourcePlayers,
    sourcePlayersFetchedAt,
    sourcePlayerEnvelope,
    ...overrides,
  };
}

test("one exact authenticated source arms a bounded live-room watch", () => {
  const watch = createLiveRoomWatch(watchInput({ autoArmRequested: true, now: 1000, windowMs: 5000 }));
  assert.equal(watch.appTabId, 7);
  assert.equal(watch.sourceTabId, 41);
  assert.equal(watch.expiresAt, 6000);
  assert.equal(watch.rules, liveRoomRuleSignature(sourceLeague));
  assert.deepEqual(watch.sourcePlayers, sourcePlayers);
  assert.equal(watch.sourcePlayersFetchedAt, sourcePlayersFetchedAt);
  assert.deepEqual(watch.sourcePlayerEnvelope, {
    schemaVersion: 1,
    requestedCount: 500,
    fetchedAt: sourcePlayersFetchedAt,
    leagueId: sourceLeague.id,
    teamId: sourceLeague.teamId,
    season: sourceLeague.season,
    playerCount: 500,
    uniquePlayerCount: 500,
  });
  assert.equal(Object.isFrozen(watch.sourcePlayerEnvelope), true);
  assert.equal(watch.autoArmRequested, true);
});

test("an honestly persisted watch restores after serialization while malformed or tampered records fail closed", () => {
  const watch = createLiveRoomWatch(watchInput({ now: 1000, windowMs: 5000 }));
  watch.commandCenterSessionId = "command-center-restart";
  watch.commandCenterDocumentId = "command-document-restart";
  const persisted = sanitizeLiveRoomWatchForStorage(watch);
  const restoredAfterWorkerRestart = JSON.parse(JSON.stringify(persisted));
  const restoreOptions = {
    now: 2000,
    commandCenterSessionIdIsValid: (value) => value === "command-center-restart",
    commandCenterDocumentIdIsValid: (value) => value === "command-document-restart",
  };

  assert.notDeepEqual(
    Object.keys(restoredAfterWorkerRestart.sourcePlayerEnvelope),
    Object.keys(sourcePlayerEnvelope),
    "persistence intentionally normalizes envelope field order",
  );
  assert.equal(authenticatedEspnPlayerPoolEnvelopeMatches(restoredAfterWorkerRestart.sourcePlayerEnvelope, {
    players: restoredAfterWorkerRestart.sourcePlayers,
    fetchedAt: sourcePlayersFetchedAt,
    leagueId: sourceLeague.id,
    teamId: sourceLeague.teamId,
    season: sourceLeague.season,
  }), true, "field order cannot invalidate an otherwise exact authenticated envelope");
  assert.equal(validStoredLiveRoomWatch(restoredAfterWorkerRestart, restoreOptions), true);

  const tamperedRecords = [
    { ...structuredClone(restoredAfterWorkerRestart), unexpected: true },
    {
      ...structuredClone(restoredAfterWorkerRestart),
      sourcePlayerEnvelope: {
        ...restoredAfterWorkerRestart.sourcePlayerEnvelope,
        unexpected: true,
      },
    },
    {
      ...structuredClone(restoredAfterWorkerRestart),
      sourcePlayerEnvelope: {
        ...restoredAfterWorkerRestart.sourcePlayerEnvelope,
        playerCount: 499,
      },
    },
    {
      ...structuredClone(restoredAfterWorkerRestart),
      sourcePlayers: restoredAfterWorkerRestart.sourcePlayers.map((player, index) => (
        index === 0 ? { ...player, rank: "999" } : player
      )),
    },
    {
      ...structuredClone(restoredAfterWorkerRestart),
      processingTabId: -1,
    },
  ];
  for (const tampered of tamperedRecords) {
    assert.equal(validStoredLiveRoomWatch(tampered, restoreOptions), false);
  }
  assert.equal(validStoredLiveRoomWatch(restoredAfterWorkerRestart, {
    ...restoreOptions,
    commandCenterSessionIdIsValid: () => false,
  }), false, "an unverified command-center session cannot restore");
  assert.equal(validStoredLiveRoomWatch(restoredAfterWorkerRestart, {
    ...restoreOptions,
    commandCenterDocumentIdIsValid: () => false,
  }), false, "an unverified command-center document cannot restore");
});

test("a source draft room or mismatched source identity cannot arm", () => {
  assert.equal(createLiveRoomWatch(watchInput({ sourceContext: { ...sourceContext, inDraftRoom: true } })), null);
  assert.equal(createLiveRoomWatch(watchInput({ sourceContext: { ...sourceContext, leagueId: "other" } })), null);
  assert.equal(createLiveRoomWatch(watchInput({
    sourcePlayers: [{ id: 1, name: "Unstamped player pool" }],
    sourcePlayerEnvelope: undefined,
  })), null, "a nonempty player pool may never receive a synthetic fresh timestamp");
});

test("authenticated watch certification rejects 1, roster-total, and 499 players and accepts exactly 500 unique players", () => {
  for (const playerCount of [1, sourceLeague.size * sourceLeague.rosterSize, 499]) {
    const players = sourcePlayers.slice(0, playerCount);
    assert.equal(createAuthenticatedEspnPlayerPoolEnvelope({
      players,
      fetchedAt: sourcePlayersFetchedAt,
      leagueId: sourceLeague.id,
      teamId: sourceLeague.teamId,
      season: sourceLeague.season,
    }), null, `${playerCount} players cannot be certified`);
  }
  assert.equal(sourcePlayerEnvelope?.playerCount, 500);
  assert.equal(authenticatedEspnPlayerPoolEnvelopeMatches(sourcePlayerEnvelope, {
    players: sourcePlayers,
    fetchedAt: sourcePlayersFetchedAt,
    leagueId: sourceLeague.id,
    teamId: sourceLeague.teamId,
    season: sourceLeague.season,
  }), true);
  const duplicate = [...sourcePlayers];
  duplicate[499] = { ...duplicate[0] };
  assert.equal(createAuthenticatedEspnPlayerPoolEnvelope({
    players: duplicate,
    fetchedAt: sourcePlayersFetchedAt,
    leagueId: sourceLeague.id,
    teamId: sourceLeague.teamId,
    season: sourceLeague.season,
  }), null, "500 rows with a duplicate ESPN id cannot be certified");
});

test("only one exact team, season, live room, and unexpired watch can trigger", () => {
  const watch = createLiveRoomWatch(watchInput({ now: 1000, windowMs: 5000 }));
  const live = { leagueId: "900", teamId: 6, season: 2026, tabId: 88, inDraftRoom: true };
  assert.equal(contextCanTriggerLiveRoomWatch(watch, live, 2000), true);
  assert.equal(contextCanTriggerLiveRoomWatch(watch, { ...live, teamId: 7 }, 2000), false);
  assert.equal(contextCanTriggerLiveRoomWatch(watch, { ...live, season: 2027 }, 2000), false);
  assert.equal(contextCanTriggerLiveRoomWatch(watch, { ...live, inDraftRoom: false }, 2000), false);
  assert.equal(contextCanTriggerLiveRoomWatch(watch, live, 7000), false);
});

test("a practice room must preserve every source rule and exact generated name", () => {
  const watch = createLiveRoomWatch(watchInput({ now: Date.now() }));
  const context = { leagueId: "900", teamId: 6, season: 2026, tabId: 88, inDraftRoom: true };
  const liveLeague = { ...sourceLeague, id: "900", name: "Practice Draft for SOMFAB", secondsPerPick: 30 };
  assert.equal(liveLeagueMatchesWatch(watch, liveLeague, context), true);
  assert.equal(liveLeagueMatchesWatch(watch, { ...liveLeague, rosterSize: 15 }, context), false);
  assert.equal(liveLeagueMatchesWatch(watch, { ...liveLeague, name: "Practice Draft for Other" }, context), false);
});

test("the real league id is allowed only with the same exact rules", () => {
  const watch = createLiveRoomWatch(watchInput({ now: Date.now() }));
  const context = { leagueId: sourceLeague.id, teamId: 6, season: 2026, tabId: 88, inDraftRoom: true };
  assert.equal(liveLeagueMatchesWatch(watch, sourceLeague, context), true);
  assert.equal(liveLeagueMatchesWatch(watch, { ...sourceLeague, scoringRules: 28 }, context), false);
});
