import assert from "node:assert/strict";
import test from "node:test";
import authenticatedEspnLeagues from "../config/authenticated-espn-leagues.json" with { type: "json" };
import { normalizeImportPicks, normalizePicks } from "../extension/draft-normalizers.js";
import { draftableRosterSizeFor, draftTypeFor, keeperCountFor } from "../extension/league-normalizers.js";

function lockedKeeperRoster() {
  return {
    id: 44050,
    seasonId: 2026,
    settings: { draftSettings: { type: "AUCTION", keeperCount: 2 } },
    draftDetail: {
      inProgress: false,
      drafted: false,
      keeperPicks: [],
      picks: [{ playerId: -1, teamId: 7, overallPickNumber: 1 }],
    },
    teams: [{
      id: 7,
      roster: { entries: [
        { playerId: 3121422, acquisitionType: "ADD", playerPoolEntry: { id: 3121422, player: { id: 3121422 }, onTeamId: 7, keeperValue: 1, keeperValueFuture: 0 } },
        { playerId: 3916148, acquisitionType: "ADD", playerPoolEntry: { id: 3916148, player: { id: 3916148 }, onTeamId: 7, keeperValue: 0, keeperValueFuture: 0 } },
      ] },
    }],
  };
}

test("the locked pre-room keeper fallback matches the exact checked-in event and preserves $0", () => {
  const expected = authenticatedEspnLeagues.profiles["salary-cap"];
  const raw = lockedKeeperRoster();
  const before = structuredClone(raw);
  assert.equal(String(raw.id), expected.id);
  assert.equal(raw.seasonId, expected.season);
  assert.equal(raw.teams[0].id, expected.teamId);
  assert.equal(raw.settings.draftSettings.type, expected.draftType);
  assert.equal(raw.settings.draftSettings.keeperCount, expected.keeperCount);
  const picks = normalizeImportPicks(raw);
  assert.deepEqual(picks, expected.event.selectedKeepers.map((keeper, index) => ({
    playerId: keeper.espnPlayerId, teamId: expected.teamId, overall: index + 1,
    round: 0, amount: keeper.amount, keeper: true,
  })));
  assert.equal(picks.reduce((sum, pick) => sum + pick.amount, 0), expected.event.keeperSpend);
  assert.equal(expected.auctionBudget - picks.reduce((sum, pick) => sum + pick.amount, 0), 199);
  assert.equal(expected.rosterSize - picks.length, 12);
  assert.deepEqual(raw, before, "normalization never changes authenticated evidence");
});

test("pre-room fallback fails closed without the exact explicit keeper identity, ownership and price proof", () => {
  const mutations = [
    (raw) => { delete raw.id; },
    (raw) => { raw.id = 44051; },
    (raw) => { raw.seasonId = 2027; },
    (raw) => { raw.settings.draftSettings.type = "SNAKE"; },
    (raw) => { raw.settings.draftSettings.keeperCount = 1; },
    (raw) => { delete raw.draftDetail.inProgress; },
    (raw) => { delete raw.draftDetail.drafted; },
    (raw) => { raw.draftDetail.inProgress = true; },
    (raw) => { raw.draftDetail.drafted = true; },
    (raw) => { raw.teams[0].id = 8; },
    (raw) => { raw.teams.push(structuredClone(raw.teams[0])); },
    (raw) => { raw.teams[0].roster.entries.pop(); },
    (raw) => { raw.teams[0].roster.entries.push({ playerId: 999 }); },
    (raw) => { raw.teams[0].roster.entries[1] = structuredClone(raw.teams[0].roster.entries[0]); },
    (raw) => { raw.teams[0].roster.entries[0].playerId = 999; },
    (raw) => { delete raw.teams[0].roster.entries[1].playerPoolEntry; },
    (raw) => { delete raw.teams[0].roster.entries[1].playerPoolEntry.keeperValue; },
    (raw) => { raw.teams[0].roster.entries[1].playerPoolEntry.keeperValue = null; },
    (raw) => { raw.teams[0].roster.entries[1].playerPoolEntry.keeperValue = "0"; },
    (raw) => { raw.teams[0].roster.entries[1].playerPoolEntry.keeperValue = 1; },
    (raw) => { raw.teams[0].roster.entries[0].playerPoolEntry.keeperValue = 0; },
    (raw) => { raw.teams[0].roster.entries[0].playerPoolEntry.onTeamId = 8; },
    (raw) => { raw.teams[0].roster.entries[0].playerPoolEntry.onTeamId = "7"; },
    (raw) => { raw.teams[0].roster.entries[0].playerPoolEntry.id = 999; },
    (raw) => { raw.teams[0].roster.entries[0].playerPoolEntry.player.id = 999; },
  ];
  mutations.forEach((mutate, index) => {
    const raw = lockedKeeperRoster();
    mutate(raw);
    assert.deepEqual(normalizeImportPicks(raw), [], `invalid keeper proof ${index}`);
  });
});

test("historical or partially declared picks never trigger supplementation from a pre-room roster", () => {
  const raw = lockedKeeperRoster();
  raw.draftDetail.picks.push({ playerId: 3121422, teamId: 7, bidAmount: 1, keeper: false });
  assert.deepEqual(normalizeImportPicks(raw), [], "historical nonkeeper picks disable the fallback");
  raw.draftDetail.picks[1].keeper = true;
  assert.deepEqual(normalizeImportPicks(raw), [{
    playerId: 3121422, teamId: 7, overall: 2, round: 0, amount: 1, keeper: true,
  }], "a partial explicit keeper feed stays partial so readiness can reject it");
  raw.draftDetail.inProgress = true;
  raw.draftDetail.picks[1].keeper = false;
  assert.deepEqual(normalizeImportPicks(raw), normalizePicks(raw), "live normalization remains unchanged");
});

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
