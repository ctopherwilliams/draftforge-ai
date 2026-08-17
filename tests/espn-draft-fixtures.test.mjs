import assert from "node:assert/strict";
import test from "node:test";
import { normalizeImportPicks, normalizePicks } from "../extension/draft-normalizers.js";
import { draftableRosterSizeFor, draftTypeFor, keeperCountFor } from "../extension/league-normalizers.js";

test("ESPN unfilled draft slots do not count as selected players", () => {
  // Sanitized shape observed for an authenticated ESPN league before its scheduled draft.
  const raw = {
    draftDetail: {
      picks: [
        { playerId: -1, teamId: 1, overallPickNumber: 1, roundId: 1 },
        { playerId: 12345, teamId: 2, overallPickNumber: 2, roundId: 1 },
        { playerId: null, teamId: 3, overallPickNumber: 3, roundId: 1 },
        { playerId: -16014, teamId: 4, overallPickNumber: 4, roundId: 1 },
      ],
    },
  };

  assert.deepEqual(normalizePicks(raw), [{
    playerId: 12345,
    teamId: 2,
    overall: 2,
    round: 1,
    amount: 0,
    keeper: false,
  }, {
    playerId: -16014,
    teamId: 4,
    overall: 4,
    round: 1,
    amount: 0,
    keeper: false,
  }]);
});

test("pre-draft imports discard historical picks while preserving declared keepers", () => {
  const raw = {
    draftDetail: {
      inProgress: false,
      drafted: false,
      picks: [
        { playerId: 101, teamId: 7, overallPickNumber: 1, bidAmount: 20, keeper: false },
        { playerId: 102, teamId: 7, overallPickNumber: 2, bidAmount: 15, keeper: true },
      ],
    },
  };
  assert.deepEqual(normalizeImportPicks(raw), [{
    playerId: 102,
    teamId: 7,
    overall: 2,
    round: 0,
    amount: 15,
    keeper: true,
  }]);
  assert.equal(normalizeImportPicks({ ...raw, draftDetail: { ...raw.draftDetail, inProgress: true } }).length, 2);
});

test("ESPN salary-cap draft settings normalize string types and configured keepers", () => {
  // Sanitized draftSettings observed for an authenticated ESPN Salary Cap league.
  const draft = { type: "AUCTION", auctionBudget: 200, keeperCount: 2 };
  assert.equal(draftTypeFor(draft.type), "AUCTION");
  assert.equal(draftTypeFor(2), "AUCTION");
  assert.equal(keeperCountFor(draft), 2);
});

test("ESPN IR slots do not consume a draft pick or salary reserve", () => {
  const draft = { slotCount: 17 };
  const roster = { lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "21": 1, "23": 1 } };
  assert.equal(draftableRosterSizeFor(draft, roster), 16);
});
