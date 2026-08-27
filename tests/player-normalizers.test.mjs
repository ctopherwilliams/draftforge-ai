import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlayers } from "../extension/player-normalizers.js";

test("ESPN positional rank fields are never mistaken for overall player rank", () => {
  const [defense, receiver] = normalizePlayers({
    players: [
      { player: { id: 1, fullName: "Defense", defaultPositionId: 16, proTeamId: 34, draftRanksByRankType: { PPR: { rank: 1, eligibleSlotId: 16 } }, ownership: { averageDraftPosition: 180.5, auctionValueAverage: 1 } } },
      { player: { id: 2, fullName: "Receiver", defaultPositionId: 3, proTeamId: 4, draftRanksByRankType: { PPR: { rank: 1, eligibleSlotId: 4 } }, ownership: { averageDraftPosition: 1.4, auctionValueAverage: 56 } } },
    ],
  });
  assert.equal(defense.rank, 180.5);
  assert.equal(receiver.rank, 1.4);
  assert.notEqual(defense.rank, 16);
  assert.notEqual(receiver.rank, 4);
});

test("ESPN ADP remains authoritative and invalid market data fails to unranked defaults", () => {
  const normalized = normalizePlayers({
    players: [
      { player: { id: 3, fullName: "Ranked", defaultPositionId: 2, draftRanksByRankType: { STANDARD: { rank: 7, eligibleSlotId: 2 } }, ownership: { averageDraftPosition: 12 } } },
      { player: { id: 4, fullName: "Unranked", defaultPositionId: 1, draftRanksByRankType: { STANDARD: { eligibleSlotId: 0 } }, ownership: {} } },
    ],
  });
  assert.equal(normalized[0].rank, 12);
  assert.equal(normalized[0].adp, 12);
  assert.equal(normalized[1].rank, 999);
  assert.equal(normalized[1].adp, 999);
});

test("ESPN definitive inactive statuses fail closed while day-to-day designations remain draftable", () => {
  const normalized = normalizePlayers({
    players: [
      { player: { id: 5, fullName: "Questionable Player", defaultPositionId: 3, injuryStatus: "QUESTIONABLE", ownership: { averageDraftPosition: 20 } } },
      { player: { id: 6, fullName: "Reserve Player", defaultPositionId: 2, injuryStatus: "INJURY_RESERVE", ownership: { averageDraftPosition: 1 } } },
      { player: { id: 7, fullName: "Suspended Player", defaultPositionId: 1, injuryStatus: "SUSPENSION", ownership: { averageDraftPosition: 2 } } },
    ],
  });

  assert.equal(normalized[0].injured, true);
  assert.equal(normalized[0].unavailable, false);
  assert.equal(normalized[1].unavailable, true);
  assert.equal(normalized[2].unavailable, true);
});
