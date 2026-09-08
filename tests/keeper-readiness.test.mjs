import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import config from "../config/authenticated-espn-leagues.json" with { type: "json" };
import { normalizeImportPicks } from "../extension/draft-normalizers.js";
import { reconcileEspnPicks } from "../app/lib/espn-reconciliation.ts";
import { exactSelectedKeepersReady, pinnedKeeperPicksReady } from "../app/lib/keeper-readiness.ts";

const league = config.profiles["salary-cap"];
const keepers = league.event.selectedKeepers;
const players = keepers.map((keeper) => ({ id: keeper.espnPlayerId, pos: keeper.position, name: keeper.name }));
const picks = keepers.map((keeper, index) => ({ playerId: keeper.espnPlayerId, teamId: 7, amount: keeper.amount, overall: index + 1, round: 0, keeper: true }));

test("the shared keeper gate rejects missing, partial, duplicate, wrong-owner, identity, price, and position proof", () => {
  assert.equal(pinnedKeeperPicksReady(league, picks, players), true);
  for (const changed of [[], picks.slice(1), [...picks, picks[0]],
    picks.map((pick, index) => index ? pick : { ...pick, playerId: 999 }),
    picks.map((pick, index) => index ? pick : { ...pick, amount: 1 }),
    picks.map((pick, index) => index ? pick : { ...pick, teamId: 8 }),
  ]) assert.equal(pinnedKeeperPicksReady(league, changed, players), false);
  assert.equal(pinnedKeeperPicksReady(league, picks, players.slice(1)), false);
  assert.equal(pinnedKeeperPicksReady(league, picks, players.map((player) => ({ ...player, pos: "QB" }))), false);
  assert.equal(pinnedKeeperPicksReady({ ...league, keeperCount: 0 }, picks, players), false);
  assert.equal(pinnedKeeperPicksReady({ ...league, draftType: "SNAKE" }, picks, players), false);
  assert.equal(exactSelectedKeepersReady([...keepers, keepers[0]], 3, []), false);
});

test("a live import replacing pre-room keepers stays blocked until exact live proof restores the $199/12 opening state", () => {
  const raw = { id: 44050, seasonId: 2026, settings: { draftSettings: { type: "AUCTION", keeperCount: 2 } },
    draftDetail: { inProgress: false, drafted: false, picks: [] },
    teams: [{ id: 7, roster: { entries: picks.map((pick) => ({ playerId: pick.playerId,
      playerPoolEntry: { onTeamId: 7, keeperValue: pick.amount } })) } }],
  };
  assert.equal(pinnedKeeperPicksReady(league, normalizeImportPicks(raw), players), true);
  raw.draftDetail.inProgress = true;
  const livePicks = normalizeImportPicks(raw);
  for (const ownRoster of [[], [picks[0]]]) {
    const imported = reconcileEspnPicks(livePicks, { inDraftRoom: true, ownRoster }, 7, players, league);
    assert.equal(pinnedKeeperPicksReady(league, imported, players), false);
  }
  const restored = reconcileEspnPicks(livePicks, { inDraftRoom: true, ownRoster: picks }, 7, players, league);
  assert.equal(pinnedKeeperPicksReady(league, restored, players), true);
  assert.equal(league.auctionBudget - restored.reduce((sum, pick) => sum + pick.amount, 0), 199);
  assert.equal(league.rosterSize - restored.length, 12);
  const purchased = [...restored, { playerId: 999, teamId: 7, amount: 25 }];
  assert.equal(pinnedKeeperPicksReady(league, purchased, players), true, "live purchases do not change keeper requirements");
});

test("pinned keeper requirements never leak into another team, season, league, or practice room", () => {
  for (const other of [{ ...league, id: "practice-44050" }, { ...league, teamId: 8 }, { ...league, season: 2027 }, config.profiles.snake]) {
    assert.equal(pinnedKeeperPicksReady(other, [], []), true);
  }
});

test("the page gates arming and both manual windows, resets import proof, and rechecks keeper authority after awaits", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const actionWindowOpen =[^;]*&& pinnedKeepersReady/);
  assert.match(page, /const bidWindowOpen =[\s\S]*?&& pinnedKeepersReady/);
  assert.match(page, /label: "Exact selected keeper identities and prices[^\n]*ok: pinnedKeepersReady/);
  assert.match(page, /keeperAuthorizationPicksRef\.current = importedPicks;/);
  assert.match(page, /const currentAuthorizationStatus = \(\) => \{[\s\S]*?return "EXACT_KEEPERS_UNVERIFIED"/);
  assert.match(page, /const preClickAuthorization = currentAuthorizationStatus\(\)/);
  assert.match(page, /const postAuditAuthorization = currentAuthorizationStatus\(\)/);
});
