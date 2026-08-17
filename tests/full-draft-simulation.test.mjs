import assert from "node:assert/strict";
import test from "node:test";
import { buildDraftDecision, buildPlayerPoolIndex, chooseAuctionNomination, recommendPlayers } from "../app/lib/draft-engine.ts";

const STRATEGIES = ["BALANCED", "HERO_RB", "ZERO_RB", "ELITE_QB"];
const TEAM_COUNT = 8;
const ROSTER_SIZE = 16;

function makeLeague(draftType, seed, teamId = 1) {
  return {
    id: `acceptance-${draftType.toLowerCase()}-${seed}`,
    name: `Acceptance ${draftType} ${seed}`,
    season: 2026,
    size: TEAM_COUNT,
    teamId,
    draftType,
    secondsPerPick: 30,
    rosterSize: ROSTER_SIZE,
    auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "21": 1, "23": 1 },
    positionLimits: { QB: 4, RB: 8, WR: 8, TE: 3, K: 3, DST: 3 },
    scoringLabel: "PPR",
    scoringRules: 46,
    keeperCount: 0,
    pickOrder: [],
    teams: Array.from({ length: TEAM_COUNT }, (_, index) => ({
      id: index + 1,
      name: `Team ${index + 1}`,
      abbrev: `T${index + 1}`,
    })),
  };
}

function makePlayers(seed) {
  // Keep enough undrafted depth for every format while avoiding repeated
  // scoring of players who cannot fit in any league roster.
  const counts = { QB: 28, RB: 60, WR: 60, TE: 28, K: 20, DST: 20 };
  const base = { QB: 395, RB: 330, WR: 335, TE: 275, K: 165, DST: 175 };
  const decay = { QB: 4.8, RB: 2.35, WR: 2.3, TE: 3.2, K: 1.4, DST: 1.6 };
  const players = [];
  let id = 1;
  for (const [pos, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) {
      const wobble = ((seed * 17 + index * 11 + pos.charCodeAt(0)) % 13) - 6;
      const projected = Math.max(35, base[pos] - index * decay[pos] + wobble);
      players.push({
        id: id++,
        name: `${pos} Player ${index + 1}`,
        team: `NFL${(index % 32) + 1}`,
        pos,
        depthIndex: index,
        rank: 0,
        adp: 0,
        auction: 1,
        projected,
        consensusScore: 0,
        injured: (seed + index) % 47 === 0,
      });
    }
  }
  players.sort((left, right) => right.projected - left.projected || left.id - right.id);
  return players.map((player, index) => {
    const sleeperCandidate = ["RB", "WR"].includes(player.pos) && player.depthIndex === 8 + seed % 4;
    const marketAdp = index + 1 + ((seed * 7 + player.id) % 9 - 4) * .35;
    const marketAuction = Math.max(1, Math.round(62 * Math.exp(-index / 42)));
    return {
      ...player,
      rank: index + 1,
      adp: sleeperCandidate ? TEAM_COUNT * 10 + seed % TEAM_COUNT : marketAdp,
      auction: sleeperCandidate ? Math.max(1, Math.round(marketAuction * .45)) : marketAuction,
      consensusScore: Math.max(0, 100 - index * .32),
      sourceCount: 5,
      marketSourceCount: 3,
      modelSourceCount: 2,
      modelMarketEdge: sleeperCandidate ? 22 : 0,
      modelSpread: sleeperCandidate ? 3 : 8,
    };
  });
}

function snakeTeamForPick(overall, seed) {
  const round = Math.floor((overall - 1) / TEAM_COUNT);
  const slot = (overall - 1) % TEAM_COUNT;
  const rotated = round % 2 === 0 ? slot : TEAM_COUNT - 1 - slot;
  return ((rotated + seed) % TEAM_COUNT) + 1;
}

function assertCompleteRosters(players, picks, league) {
  assert.equal(picks.length, TEAM_COUNT * ROSTER_SIZE);
  assert.equal(new Set(picks.map((pick) => pick.playerId)).size, picks.length);
  for (const team of league.teams) {
    const roster = picks
      .filter((pick) => pick.teamId === team.id)
      .map((pick) => players.find((player) => player.id === pick.playerId));
    const counts = roster.reduce((totals, player) => {
      totals[player.pos] = Number(totals[player.pos] || 0) + 1;
      return totals;
    }, {});
    assert.equal(roster.length, ROSTER_SIZE, `${team.name} did not fill its roster`);
    assert.ok(Number(counts.QB || 0) >= 1, `${team.name} missed QB`);
    assert.ok(Number(counts.RB || 0) >= 2, `${team.name} missed RB`);
    assert.ok(Number(counts.WR || 0) >= 2, `${team.name} missed WR`);
    assert.ok(Number(counts.TE || 0) >= 1, `${team.name} missed TE`);
    assert.ok(Number(counts.K || 0) >= 1, `${team.name} missed K`);
    assert.ok(Number(counts.DST || 0) >= 1, `${team.name} missed DST`);
    assert.ok(Number(counts.RB || 0) + Number(counts.WR || 0) + Number(counts.TE || 0) >= 6, `${team.name} missed FLEX`);
  }
}

function runSnake(seed) {
  const players = makePlayers(seed);
  const league = makeLeague("SNAKE", seed);
  const playerPool = buildPlayerPoolIndex(players, league);
  const picks = [];
  let sleeperBoardObserved = false;
  for (let overall = 1; overall <= TEAM_COUNT * ROSTER_SIZE; overall += 1) {
    const teamId = snakeTeamForPick(overall, seed);
    const teamLeague = { ...league, teamId };
    const strategy = STRATEGIES[(teamId + seed) % STRATEGIES.length];
    const recommendations = recommendPlayers(players, picks, teamLeague, strategy, overall, [], playerPool);
    sleeperBoardObserved ||= recommendations.some((player) => player.sleeperLabel !== "NONE");
    const recommendation = recommendations[0];
    assert.ok(recommendation, `no snake recommendation at pick ${overall}`);
    picks.push({ playerId: recommendation.id, teamId, overall, round: Math.ceil(overall / TEAM_COUNT), amount: 0 });
  }
  assert.equal(sleeperBoardObserved, true, "snake simulation never exercised the sleeper board");
  assertCompleteRosters(players, picks, league);
  return picks.map((pick) => `${pick.teamId}:${pick.playerId}`).join("|");
}

function liveBudgetsFor(league, picks) {
  return league.teams.map((team) => {
    const teamPicks = picks.filter((pick) => pick.teamId === team.id);
    const spent = teamPicks.reduce((sum, pick) => sum + pick.amount, 0);
    const remaining = league.auctionBudget - spent;
    const openSlots = league.rosterSize - teamPicks.length;
    return {
      teamName: team.name,
      remaining,
      maxOffer: openSlots > 0 ? Math.max(1, remaining - (openSlots - 1)) : 0,
    };
  });
}

function runAuction(seed) {
  const players = makePlayers(seed);
  const league = makeLeague("AUCTION", seed);
  const playerPool = buildPlayerPoolIndex(players, league);
  const picks = [];
  let sleeperBoardObserved = false;
  let nominationCursor = seed % TEAM_COUNT;
  while (picks.length < TEAM_COUNT * ROSTER_SIZE) {
    const budgets = liveBudgetsFor(league, picks);
    const openTeams = league.teams.filter((team) => picks.filter((pick) => pick.teamId === team.id).length < ROSTER_SIZE);
    assert.ok(openTeams.length, "auction ended before every roster was full");
    let nominator = null;
    for (let offset = 0; offset < TEAM_COUNT; offset += 1) {
      const teamId = ((nominationCursor + offset) % TEAM_COUNT) + 1;
      if (openTeams.some((team) => team.id === teamId)) {
        nominator = league.teams.find((team) => team.id === teamId);
        nominationCursor = teamId % TEAM_COUNT;
        break;
      }
    }
    assert.ok(nominator, "no legal auction nominator");
    const nominatorLeague = { ...league, teamId: nominator.id };
    const nominatorStrategy = STRATEGIES[(nominator.id + seed) % STRATEGIES.length];
    const decision = buildDraftDecision(players, picks, nominatorLeague, nominatorStrategy, picks.length + 1, budgets, playerPool);
    sleeperBoardObserved ||= decision.recommendations.some((player) => player.sleeperLabel !== "NONE");
    const nomination = chooseAuctionNomination(decision.recommendations, nominatorLeague, decision.auctionPlan);
    const nominationDiagnostics = nomination?.player ? "" : JSON.stringify({
      roster: picks.filter((pick) => pick.teamId === nominator.id).map((pick) => ({
        amount: pick.amount,
        player: players.find((player) => player.id === pick.playerId)?.name,
        position: players.find((player) => player.id === pick.playerId)?.pos,
      })),
      plan: decision.auctionPlan.positionBudgets,
      recommendations: decision.recommendations.slice(0, 12).map((player) => ({
        fills: player.fillsMandatoryStarter,
        maxBid: player.maxBid,
        name: player.name,
        position: player.pos,
        score: Math.round(player.score),
      })),
    });
    assert.ok(nomination?.player, `no auction nomination at sale ${picks.length + 1} for seed ${seed}, team ${nominator.id}: ${nominationDiagnostics}`);

    const bidders = openTeams.flatMap((team) => {
      const teamLeague = { ...league, teamId: team.id };
      const strategy = STRATEGIES[(team.id + seed) % STRATEGIES.length];
      const candidate = recommendPlayers(players, picks, teamLeague, strategy, picks.length + 1, budgets, playerPool)
        .find((player) => player.id === nomination.player.id);
      if (!candidate || candidate.maxBid < 1) return [];
      const ceiling = nomination.intent === "DRAIN" && team.id === nominator.id ? 1 : candidate.maxBid;
      return [{ teamId: team.id, ceiling }];
    }).sort((left, right) => right.ceiling - left.ceiling || ((left.teamId + seed) % TEAM_COUNT) - ((right.teamId + seed) % TEAM_COUNT));
    assert.ok(bidders.length, `no legal bidder for ${nomination.player.name}`);
    const winner = bidders[0];
    const runnerUp = bidders[1]?.ceiling || 0;
    const price = Math.max(nomination.openingBid, Math.min(winner.ceiling, runnerUp + 1));
    const winnerBudget = budgets.find((budget) => budget.teamName === `Team ${winner.teamId}`);
    assert.ok(price <= winner.ceiling, "auction price exceeded the model walk-away");
    assert.ok(price <= winnerBudget.maxOffer, "auction price violated the one-dollar roster reserve");
    picks.push({ playerId: nomination.player.id, teamId: winner.teamId, overall: picks.length + 1, round: 0, amount: price });
  }

  assert.equal(sleeperBoardObserved, true, "salary-cap simulation never exercised the sleeper board");
  assertCompleteRosters(players, picks, league);
  for (const team of league.teams) {
    const spend = picks.filter((pick) => pick.teamId === team.id).reduce((sum, pick) => sum + pick.amount, 0);
    assert.ok(spend <= league.auctionBudget, `${team.name} exceeded its salary cap`);
  }
  return picks.map((pick) => `${pick.teamId}:${pick.playerId}:${pick.amount}`).join("|");
}

test("frozen engine completes 20 deterministic snake drafts", { timeout: 120_000 }, (t) => {
  const hashes = [];
  for (let seed = 0; seed < 20; seed += 1) hashes.push(runSnake(seed));
  assert.equal(runSnake(0), hashes[0], "snake replay was not deterministic");
  t.diagnostic(`completed ${hashes.length} full snake drafts (${hashes.length * TEAM_COUNT * ROSTER_SIZE} picks)`);
});

test("frozen engine completes 20 deterministic salary-cap drafts", { timeout: 120_000 }, (t) => {
  const hashes = [];
  for (let seed = 0; seed < 20; seed += 1) hashes.push(runAuction(seed));
  assert.equal(runAuction(0), hashes[0], "salary-cap replay was not deterministic");
  t.diagnostic(`completed ${hashes.length} full salary-cap drafts (${hashes.length * TEAM_COUNT * ROSTER_SIZE} sales)`);
});
