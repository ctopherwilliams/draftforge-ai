import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Distribution,
  OPPONENT_ARCHETYPES,
  SYNTHETIC_POSITION_COUNTS,
  assertCompleteMonteCarloRun,
  assertCurrentSourceMonteCarloRun,
  deriveTrialSeed,
  makeConsensusPlayerSnapshot,
  makeLeagueScenario,
  renderMarkdownReport,
  runCounterfactuals,
  runMonteCarlo,
  selectCounterfactualCases,
  seedKeeperState,
  simulateDraft,
  splitForTrial,
  sumAcquiredDecisionRegret,
} from "../simulation/monte-carlo.mjs";
import { intelligenceQuarterbackMode } from "../app/lib/consensus.ts";
import { positionLimitFor } from "../app/lib/draft-engine.ts";
import {
  SOURCE_SNAPSHOT_SCHEMA_VERSION,
  createSourceSnapshot,
  stableSnapshotJson,
} from "../simulation/source-snapshot.mjs";
import {
  AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN,
  sanitizeAuthenticatedEspnLeague,
  sanitizeAuthenticatedEspnPlayers,
} from "../app/lib/authenticated-espn-capture.ts";

const ZERO_VIOLATIONS = {
  duplicatePlayers: 0,
  unavailableSelections: 0,
  invalidKeeperCount: 0,
  invalidKeeperPrice: 0,
  incompleteRosters: 0,
  unnecessarySecondSpecialist: 0,
  positionCap: 0,
  salaryCap: 0,
  reserve: 0,
  maxBid: 0,
  missingMandatoryStarter: 0,
};

test("bounded Monte Carlo quantiles track exact quantiles without value-dependent reservoir membership", () => {
  const count = 20_000;
  const limit = 4096;
  const seed = "quantile-regression";
  const values = Array.from({ length: count }, (_, index) => index);
  const transformedValues = values.map((value) => 100_000 - value * 3);
  const sampled = new Distribution(limit, seed);
  const transformed = new Distribution(limit, seed);
  values.forEach((value, index) => {
    sampled.add(value);
    transformed.add(transformedValues[index]);
  });

  // Identical seed and stream positions retain identical observation indexes,
  // regardless of the metric values occupying those positions.
  assert.deepEqual(
    transformed.samples,
    sampled.samples.map((value) => transformedValues[value]),
  );

  const summary = sampled.summary();
  const exact = (probability) => values[Math.round((values.length - 1) * probability)];
  for (const [key, probability] of [["p10", .1], ["p25", .25], ["median", .5], ["p75", .75], ["p90", .9]]) {
    assert.ok(
      Math.abs(summary[key] - exact(probability)) <= count * .01,
      `${key}=${summary[key]} should remain within 1% of exact ${exact(probability)}`,
    );
  }
});

function capturedSourceSnapshot(format, unavailableId = null, capturedAt = "2026-08-28T12:00:00.000Z") {
  const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
  const espnPlayers = Array.from({ length: 400 }, (_, index) => ({
    id: index + 1,
    name: `CLI Source Player ${index + 1}`,
    team: `T${index % 32}`,
    pos: positions[index % positions.length],
    rank: index + 1,
    adp: index + 1.25,
    auction: Math.max(1, 60 - index / 5),
    projected: Math.max(25, 400 - index / 2),
    unavailable: index + 1 === unavailableId,
  }));
  const sourcePlayers = espnPlayers.map(({ name, team, pos, rank, adp, auction }) => ({
    name,
    team,
    pos,
    rank,
    adp,
    auction,
  }));
  const sources = [
    ["ffc", "market", .15],
    ["mfl", "market", .15],
    ["tradyr", "composite", .20],
    ["gng", "model", .20],
  ].map(([id, kind, weight]) => ({
    id,
    name: String(id).toUpperCase(),
    kind,
    weight,
    status: "ok",
    updatedAt: capturedAt,
    retrievedAt: capturedAt,
    attribution: "CLI failure fixture",
    players: sourcePlayers,
    coverage: { players: sourcePlayers.length, corePositions: ["QB", "RB", "WR", "TE"] },
  }));
  const { league } = makeLeagueScenario(format, 0, deriveTrialSeed(20260820, format, 0));
  const exactLeague = {
    ...league,
    rawSettings: {
      scoringSettings: {
        scoringItems: Array.from({ length: Number(league.scoringRules || 0) }, (_, index) => ({ statId: index + 1, points: 0 })),
      },
    },
  };
  const exactLeagueSnapshot = sanitizeAuthenticatedEspnLeague(exactLeague);
  const exactPlayers = sanitizeAuthenticatedEspnPlayers(espnPlayers);
  return createSourceSnapshot({
    capturedAt,
    league: exactLeague,
    espnPlayers,
    intelligence: {
      scoring: league.scoringLabel,
      teams: league.size,
      season: league.season,
      qbs: intelligenceQuarterbackMode(league.lineupSlotCounts),
      sources,
    },
    provenance: {
      espnCapture: {
        schemaVersion: 2,
        transport: "draftforge-chrome-companion",
        capturedAt,
        digest: `sha256:${createHash("sha256").update(
          `${AUTHENTICATED_ESPN_CAPTURE_DIGEST_DOMAIN}\n${stableSnapshotJson({
            capturedAt,
            league: exactLeagueSnapshot,
            espnPlayers: exactPlayers,
          })}`,
        ).digest("hex")}`,
        receiptConsumed: true,
      },
      publicConsensus: {
        sourceSnapshotId: `sha256:${"e".repeat(64)}`,
        generatedAt: capturedAt,
        methodology: {
          weights: { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 },
          method: "freshness-gated weighted percentile consensus",
        },
      },
    },
  });
}

test("Monte Carlo seed splits and authenticated/adversarial mix are exact", () => {
  const splits = Array.from({ length: 10_000 }, (_, index) => splitForTrial(index, 10_000));
  assert.equal(splits.filter((split) => split === "discovery").length, 6_000);
  assert.equal(splits.filter((split) => split === "validation").length, 2_000);
  assert.equal(splits.filter((split) => split === "holdout").length, 2_000);

  for (const format of ["snake", "salary-cap"]) {
    const scenarios = Array.from({ length: 100 }, (_, trialIndex) => makeLeagueScenario(
      format,
      trialIndex,
      deriveTrialSeed(20260814, format, trialIndex),
    ));
    assert.equal(scenarios.filter((scenario) => scenario.realSettings).length, 80);
    assert.equal(scenarios.filter((scenario) => !scenario.realSettings).length, 20);
  }
  const snake = makeLeagueScenario("snake", 0, deriveTrialSeed(20260814, "snake", 0)).league;
  const salaryCap = makeLeagueScenario("salary-cap", 0, deriveTrialSeed(20260814, "salary-cap", 0)).league;
  assert.equal(snake.secondsPerPick, 60);
  assert.equal(snake.scoringRules, 29);
  assert.equal(salaryCap.secondsPerPick, 60);
  assert.equal(salaryCap.keeperCount, 2);
  assert.equal(salaryCap.scoringLabel, "PPR");
  assert.equal(salaryCap.scoringRules, 45);
  assert.deepEqual(
    Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((position) => [
      position,
      positionLimitFor(snake, position),
    ])),
    { QB: 4, RB: 8, WR: 8, TE: 3, K: 3, DST: 3 },
  );
  assert.deepEqual(
    Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map((position) => [
      position,
      positionLimitFor(salaryCap, position),
    ])),
    { QB: 6, RB: 6, WR: 6, TE: 6, K: 6, DST: 6 },
  );
});

test("seeded player snapshot preserves the production five-source contract", () => {
  const trialSeed = deriveTrialSeed(20260814, "snake", 0);
  const { league } = makeLeagueScenario("snake", 0, trialSeed);
  const first = makeConsensusPlayerSnapshot(trialSeed, league);
  const replay = makeConsensusPlayerSnapshot(trialSeed, league);
  assert.deepEqual(replay, first);
  assert.ok(first.length >= league.size * league.rosterSize);
  for (const player of first) {
    assert.equal(player.sourceCount, 5);
    assert.equal(player.marketSourceCount, 3);
    assert.equal(player.modelSourceCount, 2);
    assert.deepEqual(Object.keys(player.sourceRanks).sort(), ["espn", "ffc", "gng", "mfl", "tradyr"]);
  }
});

test("saved salary-cap trials seed deterministic legal keeper rosters, prices, and reserves", { timeout: 30_000 }, () => {
  const trialSeed = deriveTrialSeed(20260814, "salary-cap", 0);
  const { league } = makeLeagueScenario("salary-cap", 0, trialSeed);
  const players = makeConsensusPlayerSnapshot(trialSeed, league);
  const first = seedKeeperState(players, league, "salary-cap", trialSeed);
  const replay = seedKeeperState(players, league, "salary-cap", trialSeed);
  assert.deepEqual(replay.picks, first.picks);
  assert.equal(first.picks.length, league.size * league.keeperCount);
  assert.equal(new Set(first.picks.map((pick) => pick.playerId)).size, first.picks.length);
  for (const team of league.teams) {
    const keepers = first.picks.filter((pick) => pick.teamId === team.id);
    assert.equal(keepers.length, league.keeperCount);
    assert.ok(keepers.every((pick) => pick.keeper === true && pick.amount >= 1));
    const spent = keepers.reduce((sum, pick) => sum + pick.amount, 0);
    assert.ok(spent <= league.auctionBudget - (league.rosterSize - league.keeperCount));
    const counts = first.rosters.get(team.id).reduce((result, player) => {
      result[player.pos] = Number(result[player.pos] || 0) + 1;
      return result;
    }, {});
    for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
      assert.ok(Number(counts[position] || 0) <= positionLimitFor(league, position));
    }
  }

  const result = simulateDraft({ format: "salary-cap", baseSeed: 20260814, trialIndex: 0, drafts: 100 });
  assert.equal(result.keeperState.configuredPerTeam, 2);
  assert.equal(result.keeperState.totalPicks, 24);
  assert.equal(result.keeperState.controlledPicks, 2);
  assert.ok(result.keeperState.controlledSpend >= 2);
  assert.equal(result.roster.filter((pick) => pick.keeper === true).length, 2);
  assert.deepEqual(result.violations, ZERO_VIOLATIONS);
});

test("snake and salary-cap replays are deterministic and satisfy hard invariants", { timeout: 30_000 }, () => {
  for (const format of ["snake", "salary-cap"]) {
    const input = { format, baseSeed: 20260814, trialIndex: 3, drafts: 20 };
    const first = simulateDraft(input);
    const replay = simulateDraft(input);
    assert.equal(replay.draftDigest, first.draftDigest);
    assert.deepEqual(replay.metrics, first.metrics);
    assert.deepEqual(first.violations, ZERO_VIOLATIONS);
    assert.equal(first.roster.length, first.rosterSize);
  }
});

test("salary-cap production decisions rebuild after every authoritative sale", { timeout: 30_000 }, () => {
  const result = simulateDraft({
    format: "salary-cap",
    baseSeed: 20260814,
    trialIndex: 0,
    drafts: 100,
    captureTrace: true,
  });
  const events = result.counterfactualTrace.events;
  assert.equal(events.length, result.leagueSize * result.rosterSize - result.keeperState.totalPicks);
  assert.equal(result.productionDecisionBuilds, events.length);
  events.forEach((event, index) => {
    assert.equal(event.eventId, `auction-sale:${result.keeperState.totalPicks + index + 1}`);
    assert.equal(event.decisionBuildNumber, index + 1);
    assert.equal(
      event.decisionRoomPlayers,
      result.keeperState.totalPicks + index,
      `sale ${index + 1} must include all keepers and ${index} prior sales`,
    );
  });
  assert.ok(events.some((event, index) => index > 0
    && event.nominatorTeamId !== 1
    && events[index - 1].nominatorTeamId !== 1), "fixture must exercise consecutive opponent sales");
});

test("captured snake picks and salary-cap nominations never select an ESPN-unavailable ID", { timeout: 30_000 }, () => {
  for (const format of ["snake", "salary-cap"]) {
    const unavailableId = 1;
    const snapshot = capturedSourceSnapshot(format, unavailableId);
    assert.equal(snapshot.validation.valid, true, snapshot.validation.errors.join(" "));
    const result = simulateDraft({ format, baseSeed: 20260820, trialIndex: 0, drafts: 1, sourceSnapshot: snapshot });
    assert.equal(result.scenario, "captured-authenticated-settings");
    assert.equal(result.realSettings, true);
    assert.equal(result.violations.unavailableSelections, 0);
    assert.equal(result.roster.some((pick) => pick.playerId === unavailableId), false);
  }
});

test("salary-cap regret excludes nominations DraftForge did not acquire", { timeout: 30_000 }, () => {
  assert.equal(sumAcquiredDecisionRegret([
    { regret: 250, acquired: false },
    { regret: 7, acquired: false, countsTowardRegret: true },
    { regret: 99, acquired: true, countsTowardRegret: false },
    { regret: 12, acquired: true },
    { regret: 8 },
  ]), 27);
  const result = simulateDraft({
    format: "salary-cap",
    baseSeed: 20260814,
    trialIndex: 2768,
    drafts: 10_000,
    captureTrace: true,
  });
  assert.equal(result.regretCase.acquired, false);
  // Keep this as a material nomination proxy without coupling the assertion to
  // the exact composition of the synthetic player inventory.
  assert.ok(result.regretCase.regret > 150);
  assert.equal(result.metrics.decisionRegret, sumAcquiredDecisionRegret(result.counterfactualTrace.decisions));
  assert.ok(
    result.metrics.decisionRegret
      < result.counterfactualTrace.decisions.reduce((sum, decision) => sum + decision.regret, 0),
    "unacquired nomination proxies must be excluded from aggregate regret",
  );
});

test("salary-cap evidence records won, lost, pass, and drain bid outcomes without false non-action regret", { timeout: 30_000 }, () => {
  const input = { format: "salary-cap", baseSeed: 20260814, trialIndex: 0, drafts: 100, captureTrace: true };
  const baseline = simulateDraft(input);
  const bidDecisions = baseline.counterfactualTrace.decisions.filter((decision) => decision.decisionKind === "BID");
  assert.ok(bidDecisions.some((decision) => decision.bidOutcome === "WON"));
  assert.ok(bidDecisions.some((decision) => decision.bidOutcome === "LOST"));
  assert.ok(bidDecisions.some((decision) => decision.bidOutcome === "PASS"));
  assert.ok(bidDecisions.every((decision) => decision.alternativeIds.length <= 5));
  const nonAcquisitions = bidDecisions.filter((decision) => ["LOST", "PASS"].includes(decision.bidOutcome));
  const underbids = nonAcquisitions.filter((decision) => decision.underbidOpportunity === true);
  const properWalks = nonAcquisitions.filter((decision) => decision.underbidOpportunity !== true);
  assert.ok(underbids.length > 0, "the fixed seed must expose bounded retrospective underbid candidates");
  assert.ok(underbids.every((decision) => (
    decision.countsTowardRegret === true
      && decision.counterfactualEligible === true
      && decision.economicallyViableMissedOpportunity === true
      && decision.missedOpportunityClass === "RETROSPECTIVE_UNDERBID"
      && decision.approvedCeiling < decision.priceToWin
      && decision.priceToWin <= decision.evidenceOnlyCeiling
      && decision.regret > 0
  )));
  assert.ok(properWalks.every((decision) => (
    decision.countsTowardRegret === false
      && decision.counterfactualEligible === false
      && decision.economicallyViableMissedOpportunity === false
      && decision.missedOpportunityClass === null
      && decision.evidenceOnlyCeiling < decision.priceToWin
      && decision.regret === 0
  )));
  assert.ok(baseline.counterfactualTrace.events.every((event) => (
    event.controlledCeiling === null || event.controlledCeiling <= event.controlledProductionCeiling
  )), "a production baseline must never apply the evidence-only ceiling");
  assert.equal(baseline.metrics.auctionBidOpportunities, bidDecisions.length);
  assert.equal(baseline.metrics.auctionBidWins, bidDecisions.filter((decision) => ["WON", "WON_DRAIN"].includes(decision.bidOutcome)).length);
  assert.equal(baseline.metrics.auctionBidLosses, bidDecisions.filter((decision) => decision.bidOutcome === "LOST").length);
  assert.equal(baseline.metrics.auctionBidPasses, bidDecisions.filter((decision) => decision.bidOutcome === "PASS").length);
  assert.equal(
    baseline.metrics.missedBidOpportunityRegret,
    nonAcquisitions.reduce((sum, decision) => sum + decision.regret, 0),
  );
  const acquiredRegret = bidDecisions
    .filter((decision) => decision.acquired === true && decision.countsTowardRegret !== false)
    .reduce((sum, decision) => sum + decision.regret, 0);
  assert.ok(
    Math.abs(baseline.metrics.decisionRegret
      - acquiredRegret - baseline.metrics.missedBidOpportunityRegret) < 1e-9,
    "missed opportunities and acquisitions are each counted once",
  );
  assert.equal(baseline.metrics.decisionRegretPenalty, baseline.metrics.decisionRegret * .12);
  assert.ok(Math.abs(
    baseline.metrics.objective
      - (baseline.metrics.objectiveBeforeDecisionRegret - baseline.metrics.decisionRegretPenalty)
  ) < 1e-9);
  assert.ok(
    baseline.metrics.decisionRegretPenalty > acquiredRegret * .12,
    "a viable missed economic opportunity must worsen the objective's regret penalty",
  );

  const acquired = bidDecisions.find((decision) => decision.bidOutcome === "WON" && decision.price > 1);
  assert.ok(acquired, "fixture needs an acquired bid above $1");
  const passed = simulateDraft({
    ...input,
    override: { kind: "auction-bid", eventId: acquired.eventId, action: "PASS" },
  });
  const missed = passed.counterfactualTrace.decisions.find((decision) => (
    decision.decisionKind === "BID" && decision.eventId === acquired.eventId
  ));
  assert.equal(missed.bidOutcome, "PASS");
  assert.equal(missed.countsTowardRegret, true);
  assert.equal(missed.economicallyViableMissedOpportunity, true);
  assert.equal(missed.missedOpportunityClass, "PRODUCTION_BID_SUPPRESSED");
  assert.ok(missed.regret > 0, "a pass below a winnable production ceiling must record opportunity regret");
  assert.ok(passed.metrics.missedBidOpportunityRegret >= missed.regret);
  assert.equal(passed.metrics.decisionRegret, sumAcquiredDecisionRegret(passed.counterfactualTrace.decisions));

  const drainDraft = simulateDraft({
    format: "salary-cap",
    baseSeed: 20260814,
    trialIndex: 4,
    drafts: 100,
    captureTrace: true,
  });
  const drain = drainDraft.counterfactualTrace.decisions.find((decision) => decision.bidOutcome === "DRAIN_NON_ACTION");
  assert.ok(drain, "fixture needs an intentional drain walk");
  assert.equal(drain.regret, 0);
  assert.equal(drain.countsTowardRegret, false);
  assert.equal(drain.counterfactualEligible, false);
  assert.equal(
    drainDraft.metrics.missedBidOpportunityRegret,
    drainDraft.counterfactualTrace.decisions
      .filter((decision) => decision.decisionKind === "BID" && decision.economicallyViableMissedOpportunity === true)
      .reduce((sum, decision) => sum + decision.regret, 0),
    "intentional drain and non-viable walks must not enter missed-opportunity regret",
  );
});

test("bounded evidence-only ceiling discovers a harmful underbid without changing production maxBid", { timeout: 30_000 }, () => {
  const config = { drafts: 100, seed: 20260814 };
  const baseline = simulateDraft({
    format: "salary-cap",
    baseSeed: config.seed,
    trialIndex: 1,
    drafts: config.drafts,
    captureTrace: true,
  });
  assert.equal(baseline.trialSeed, 4217252530);
  assert.equal(baseline.underbidCase.eventId, "auction-sale:52");
  assert.ok(baseline.underbidCase.approvedCeiling < baseline.underbidCase.priceToWin);
  assert.ok(baseline.underbidCase.priceToWin <= baseline.underbidCase.evidenceOnlyCeiling);

  const [replay] = runCounterfactuals([baseline.underbidCase], config);
  const production = replay.branches.find((branch) => branch.action === "BID");
  const upside = replay.branches.find((branch) => branch.action.startsWith("ALTERNATE_CEILING_"));
  assert.equal(production.traceAudit.evidenceOnly, false);
  assert.ok(production.traceAudit.appliedCeiling <= production.traceAudit.productionCeiling);
  assert.equal(upside.traceAudit.evidenceOnly, true);
  assert.ok(upside.traceAudit.productionCeiling < upside.traceAudit.appliedCeiling);
  assert.ok(upside.traceAudit.appliedCeiling <= upside.traceAudit.evidenceOnlyCeiling);
  assert.ok(upside.objectiveDelta > 0, "the concrete hidden-outcome tail must be discoverable by full continuation");
  assert.ok(upside.lineupDelta > 0);
  assert.ok(Object.values(upside.violations).every((value) => value === 0));
});

test("acquired auction regret is price-aware and replays bounded bid, pass, and alternate-ceiling continuations", { timeout: 30_000 }, () => {
  const config = { drafts: 100, seed: 20260814 };
  const baseline = simulateDraft({
    format: "salary-cap",
    baseSeed: config.seed,
    trialIndex: 0,
    drafts: config.drafts,
    captureTrace: true,
  });
  const acquired = baseline.counterfactualTrace.decisions.filter((decision) => (
    decision.counterfactualClass === "auction-acquired"
  ));
  assert.ok(acquired.length > 0);
  for (const decision of acquired) {
    assert.equal(decision.regretBasis, "price-acquirability-bounded-continuation");
    assert.equal(decision.regret, Number(Math.max(0, decision.price - decision.acquisitionValue).toFixed(4)));
    assert.ok(decision.alternateCeiling < decision.price);
    assert.ok(decision.alternateCeiling <= decision.approvedCeiling);
  }
  const [replay] = runCounterfactuals([baseline.regretCases["auction-acquired"]], config);
  assert.deepEqual(replay.branches.map((branch) => branch.action.replace(/_\d+$/, "")), [
    "BID",
    "PASS",
    "ALTERNATE_CEILING",
  ]);
  assert.ok(replay.branches.every((branch) => !branch.error));
  const alternate = replay.branches[2];
  assert.equal(alternate.traceAudit.evidenceOnly, false);
  assert.ok(alternate.traceAudit.appliedCeiling <= alternate.traceAudit.productionCeiling);
});

test("counterfactual sampling round-robins independent decision classes", () => {
  const queues = {
    "snake-pick": [{ format: "snake", trialIndex: 1, decisionNumber: 1 }],
    "auction-acquired": [{ format: "salary-cap", trialIndex: 2, eventId: "a", decisionKind: "BID" }],
    "auction-underbid": [{ format: "salary-cap", trialIndex: 3, eventId: "b", decisionKind: "BID" }],
    "auction-target-nomination": [{ format: "salary-cap", trialIndex: 4, eventId: "c", decisionKind: "NOMINATION" }],
    "auction-drain-nomination": Array.from({ length: 20 }, (_, index) => ({
      format: "salary-cap",
      trialIndex: 100 + index,
      eventId: `drain-${index}`,
      decisionKind: "NOMINATION",
    })),
  };
  const selected = selectCounterfactualCases(queues, 5);
  assert.deepEqual(selected.map((item) => item.trialIndex), [1, 2, 3, 4, 100]);
  assert.equal(selected.filter((item) => String(item.eventId || "").startsWith("drain-")).length, 1);
});

test("auction regret decomposition is exact across real-settings and adversarial seeded rooms", { timeout: 30_000 }, () => {
  for (let trialIndex = 0; trialIndex < 5; trialIndex += 1) {
    const result = simulateDraft({
      format: "salary-cap",
      baseSeed: 73190422,
      trialIndex,
      drafts: 100,
      captureTrace: true,
    });
    const decisions = result.counterfactualTrace.decisions;
    const acquisitionRegret = decisions
      .filter((decision) => decision.acquired === true && decision.countsTowardRegret !== false)
      .reduce((sum, decision) => sum + Number(decision.regret || 0), 0);
    const missed = decisions.filter((decision) => decision.economicallyViableMissedOpportunity === true);
    const missedRegret = missed.reduce((sum, decision) => sum + Number(decision.regret || 0), 0);
    assert.ok(missed.every((decision) => (
      decision.acquired === false
        && decision.countsTowardRegret === true
        && decision.counterfactualEligible === true
        && decision.regret > 0
        && ["PRODUCTION_BID_SUPPRESSED", "RETROSPECTIVE_UNDERBID"].includes(decision.missedOpportunityClass)
    )));
    assert.ok(decisions
      .filter((decision) => decision.decisionKind === "BID"
        && decision.acquired === false
        && decision.economicallyViableMissedOpportunity !== true)
      .every((decision) => decision.countsTowardRegret === false && decision.regret === 0));
    assert.ok(Math.abs(result.metrics.missedBidOpportunityRegret - missedRegret) < 1e-9);
    assert.ok(Math.abs(result.metrics.decisionRegret - acquisitionRegret - missedRegret) < 1e-9);
    assert.ok(Math.abs(
      result.metrics.objective
        - (result.metrics.objectiveBeforeDecisionRegret
          - (acquisitionRegret + missedRegret) * .12)
    ) < 1e-9);
    assert.ok(result.counterfactualTrace.events.every((event) => (
      event.evidenceOnlyOverride === false
        && (event.controlledCeiling === null
          || event.controlledCeiling <= event.controlledProductionCeiling)
    )), "evidence accounting must not alter a production ceiling");
  }
});

test("one exact regret case can replay its bounded counterfactual branches", { timeout: 30_000 }, () => {
  const config = { drafts: 100, seed: 20260814 };
  const baseline = simulateDraft({ format: "snake", baseSeed: config.seed, trialIndex: 3, drafts: config.drafts });
  const [replay] = runCounterfactuals([baseline.regretCase], config);
  assert.equal(replay.trialIndex, 3);
  assert.equal(replay.branches.length, 5);
  assert.ok(replay.branches.every((branch) => !branch.error));
  assert.ok(replay.branches.every((branch) => Object.values(branch.violations).every((value) => value === 0)));
});

test("salary-cap counterfactuals are bound to one stable bid or nomination event", { timeout: 30_000 }, () => {
  const input = { format: "salary-cap", baseSeed: 20260814, trialIndex: 0, drafts: 100, captureTrace: true };
  const baseline = simulateDraft(input);
  const events = baseline.counterfactualTrace.events;
  const decisions = baseline.counterfactualTrace.decisions;
  assert.equal(new Set(decisions.map((decision) => decision.decisionNumber)).size, decisions.length);

  const assertStablePrefix = (candidate, eventId) => {
    const targetIndex = events.findIndex((event) => event.eventId === eventId);
    assert.ok(targetIndex >= 0);
    assert.deepEqual(
      candidate.counterfactualTrace.events.slice(0, targetIndex).map((event) => [event.eventId, event.preStateDigest, event.outcomeDigest]),
      events.slice(0, targetIndex).map((event) => [event.eventId, event.preStateDigest, event.outcomeDigest]),
    );
    assert.equal(candidate.counterfactualTrace.events[targetIndex].preStateDigest, events[targetIndex].preStateDigest);
    assert.deepEqual(
      candidate.counterfactualTrace.events.map((event) => [event.eventId, event.exogenousDigest]),
      events.map((event) => [event.eventId, event.exogenousDigest]),
    );
    const firstChanged = events.findIndex((event, index) => (
      candidate.counterfactualTrace.events[index].outcomeDigest !== event.outcomeDigest
    ));
    assert.equal(candidate.counterfactualTrace.events[firstChanged]?.eventId, eventId);
    return targetIndex;
  };

  const bidDecision = decisions.find((decision) => (
    decision.decisionKind === "BID" && events[decision.eventIndex - 1].price > 1
  ));
  assert.ok(bidDecision, "fixture needs one acquired bid above the opening offer");
  const passed = simulateDraft({
    ...input,
    override: { kind: "auction-bid", eventId: bidDecision.eventId, action: "PASS" },
  });
  const bidTargetIndex = assertStablePrefix(passed, bidDecision.eventId);
  assert.equal(passed.counterfactualTrace.events[bidTargetIndex].nominatedPlayerId, events[bidTargetIndex].nominatedPlayerId);
  assert.equal(passed.counterfactualTrace.events[bidTargetIndex].nominationIntent, events[bidTargetIndex].nominationIntent);
  assert.equal(passed.counterfactualTrace.events[bidTargetIndex].overrideApplied, "auction-bid:PASS");

  const nominationDecision = decisions.find((decision) => (
    decision.decisionKind === "NOMINATION"
    && decision.targetId
    && decision.drainId
    && decision.targetId !== decision.drainId
  ));
  assert.ok(nominationDecision, "fixture needs distinct target and drain nominees");
  const nominationAction = nominationDecision.nominationIntent === "TARGET" ? "DRAIN_NOMINATION" : "TARGET_NOMINATION";
  const expectedPlayerId = nominationAction === "DRAIN_NOMINATION" ? nominationDecision.drainId : nominationDecision.targetId;
  const renominated = simulateDraft({
    ...input,
    override: { kind: "auction-nomination", eventId: nominationDecision.eventId, action: nominationAction },
  });
  const nominationTargetIndex = assertStablePrefix(renominated, nominationDecision.eventId);
  assert.equal(renominated.counterfactualTrace.events[nominationTargetIndex].nominatedPlayerId, expectedPlayerId);
  assert.equal(
    renominated.counterfactualTrace.events[nominationTargetIndex].overrideApplied,
    `auction-nomination:${nominationAction}`,
  );
});

test("deep 14-team adversarial rooms retain enough legal late-round inventory", { timeout: 30_000 }, () => {
  for (const format of ["snake", "salary-cap"]) {
    const result = simulateDraft({ format, baseSeed: 20260814, trialIndex: 49, drafts: 10_000 });
    assert.equal(result.scenario, "adversarial-espn-compatible");
    assert.deepEqual(result.violations, ZERO_VIOLATIONS);
    assert.equal(result.roster.length, result.rosterSize);
  }
});

test("captured player truth exercises exact and adversarial ESPN-compatible league profiles at 80/20", { timeout: 30_000 }, async () => {
  const snapshot = capturedSourceSnapshot("salary-cap", null, new Date().toISOString());
  const summary = await runMonteCarlo({
    drafts: 10,
    seed: 20260814,
    formats: ["salary-cap"],
    sourceSnapshot: snapshot,
    exposeHoldout: true,
    skipCounterfactuals: true,
  });
  assert.equal(summary.scenarios["salary-cap:captured-authenticated-settings"].drafts, 8);
  assert.equal(summary.scenarios["salary-cap:captured-source-adversarial-espn-compatible"].drafts, 2);
  assert.equal(summary.config.realSettingsShare, .8);
  assert.equal(summary.config.adversarialSettingsShare, .2);
  assert.equal(summary.certification.status, "CURRENT_SOURCE_SNAPSHOT_V3");
  assert.deepEqual(summary.aggregate.violations, ZERO_VIOLATIONS);
});

test("salary-cap evidence is stratified across source, price, confidence, and run context", { timeout: 30_000 }, async () => {
  const summary = await runMonteCarlo({
    drafts: 5,
    seed: 20260814,
    formats: ["salary-cap"],
    exposeHoldout: true,
    skipCounterfactuals: true,
  });
  assert.deepEqual(Object.keys(summary.auctionOutcomeStrata).sort(), [
    "confidence",
    "positionalRunIntensity",
    "priceInputCoverage",
    "priceTier",
    "sourceCount",
  ]);
  const expectedOpportunities = summary.byFormat["salary-cap"].metrics.auctionBidOpportunities.mean * 5;
  for (const buckets of Object.values(summary.auctionOutcomeStrata)) {
    assert.equal(
      Object.values(buckets).reduce((sum, bucket) => sum + bucket.opportunities, 0),
      expectedOpportunities,
    );
  }
});

test("static-roster title and tail signals are smooth, deterministic, and non-zero at P25", { timeout: 30_000 }, async () => {
  const config = {
    drafts: 10,
    seed: 20260814,
    formats: ["snake", "salary-cap"],
    exposeHoldout: true,
    skipCounterfactuals: true,
  };
  const first = await runMonteCarlo(config);
  const replay = await runMonteCarlo(config);
  assert.equal(first.aggregate.metrics.seasonWinProbability.p25 > 0, true);
  assert.equal(first.aggregate.metrics.seasonStrengthPercentile.p25 > 0, true);
  assert.equal(first.aggregate.metrics.seasonStrengthPercentile.p75 < 1, true);
  assert.equal(first.determinismDigest, replay.determinismDigest);
  assert.deepEqual(first.aggregate.metrics.tailStrengthMargin, replay.aggregate.metrics.tailStrengthMargin);
});

test("synthetic inventory covers deepest position-cap demand plus late-news removals", () => {
  const trialIndex = 154;
  const trialSeed = deriveTrialSeed(18472631, "salary-cap", trialIndex);
  const { league, realSettings } = makeLeagueScenario("salary-cap", trialIndex, trialSeed);
  assert.equal(realSettings, false);
  assert.equal(league.size, 14);
  const cushion = { QB: 8, RB: 10, WR: 10, TE: 8 };
  for (const position of ["QB", "RB", "WR", "TE"]) {
    assert.ok(
      SYNTHETIC_POSITION_COUNTS[position] >= league.size * league.positionLimits[position] + cushion[position],
      `${position} inventory must exceed aggregate position caps plus late-news cushion`,
    );
  }
});

test("the depleted-TE salary-cap seed completes deterministically", { timeout: 30_000 }, () => {
  const input = { format: "salary-cap", baseSeed: 18472631, trialIndex: 154, drafts: 1_000 };
  const first = simulateDraft(input);
  const replay = simulateDraft(input);
  assert.equal(first.scenario, "adversarial-espn-compatible");
  assert.equal(first.roster.length, first.rosterSize);
  assert.deepEqual(first.violations, ZERO_VIOLATIONS);
  assert.equal(replay.draftDigest, first.draftDigest);
  assert.deepEqual(replay.metrics, first.metrics);
});

test("opponent field covers every required non-DraftForge archetype", { timeout: 30_000 }, async () => {
  const summary = await runMonteCarlo({
    drafts: 20,
    seed: 20260814,
    formats: ["snake", "salary-cap"],
    exposeHoldout: true,
    skipCounterfactuals: true,
  });
  assert.equal(summary.completedDrafts, 40);
  assert.equal(summary.requestedDrafts, 40);
  assert.equal(summary.complete, true);
  assert.equal(summary.failureSeeds.length, 0);
  assert.deepEqual(summary.aggregate.violations, ZERO_VIOLATIONS);
  for (const archetype of [...OPPONENT_ARCHETYPES.snake, ...OPPONENT_ARCHETYPES["salary-cap"]]) {
    assert.ok(summary.aggregate.archetypes[archetype] > 0, `${archetype} was not exercised`);
  }
});

test("baseline mode seals holdout metrics and keeps the replay digest stable", { timeout: 30_000 }, async () => {
  const config = {
    drafts: 10,
    seed: 20260814,
    formats: ["snake", "salary-cap"],
    exposeHoldout: false,
    skipCounterfactuals: true,
  };
  const first = await runMonteCarlo(config);
  const replay = await runMonteCarlo(config);
  assert.equal(first.determinismDigest, replay.determinismDigest);
  assert.equal(first.evidence.orderedTrialOutcomeDigest, replay.evidence.orderedTrialOutcomeDigest);
  assert.equal(first.evidence.identity.productionCodeDigest, replay.evidence.identity.productionCodeDigest);
  assert.equal(first.evidence.orderedTrialCount, first.requestedDrafts);
  assert.equal(first.evidence.boundedMemory, true);
  assert.equal(first.aggregate.drafts, 16);
  assert.equal(first.splits["snake:holdout"].sealed, true);
  assert.equal(first.splits["salary-cap:holdout"].sealed, true);
  assert.equal("metrics" in first.splits["snake:holdout"], false);
});

test("ordered-outcome evidence binds trial order even when the same formats are aggregated", { timeout: 30_000 }, async () => {
  const common = {
    drafts: 1,
    seed: 20260814,
    exposeHoldout: true,
    skipCounterfactuals: true,
  };
  const forward = await runMonteCarlo({ ...common, formats: ["snake", "salary-cap"] });
  const reversed = await runMonteCarlo({ ...common, formats: ["salary-cap", "snake"] });
  assert.equal(forward.evidence.identity.productionCodeDigest, reversed.evidence.identity.productionCodeDigest);
  assert.equal(forward.evidence.identity.digest, reversed.evidence.identity.digest);
  assert.notEqual(forward.evidence.orderedTrialOutcomeDigest, reversed.evidence.orderedTrialOutcomeDigest);
  assert.notEqual(forward.determinismDigest, reversed.determinismDigest);
});

test("synthetic mechanics evidence is explicit and rejected by the current-source certification guard", { timeout: 30_000 }, async () => {
  const synthetic = await runMonteCarlo({
    drafts: 1,
    seed: 20260814,
    formats: ["snake"],
    exposeHoldout: true,
    skipCounterfactuals: true,
  });
  assert.equal(synthetic.certification.status, "SYNTHETIC_NON_CERTIFYING");
  assert.equal(synthetic.certification.currentSource, false);
  assert.throws(() => assertCurrentSourceMonteCarloRun(synthetic), /MONTE_CARLO_CURRENT_SOURCE_REQUIRED/);
  assert.throws(() => assertCurrentSourceMonteCarloRun({
    ...synthetic,
    certification: {
      ...synthetic.certification,
      currentSource: true,
      currentSourceCertificationEligible: true,
    },
  }), /MONTE_CARLO_CURRENT_SOURCE_REQUIRED/);

  const snapshot = capturedSourceSnapshot("snake", 1, new Date().toISOString());
  const captured = await runMonteCarlo({
    drafts: 1,
    seed: 20260814,
    formats: ["snake"],
    exposeHoldout: true,
    skipCounterfactuals: true,
    sourceSnapshot: snapshot,
  });
  assert.equal(captured.certification.status, "CURRENT_SOURCE_SNAPSHOT_V3");
  assert.equal(captured.evidence.identity.source.schemaVersion, SOURCE_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(captured.evidence.identity.source.exactFormat, true);
  assert.equal(captured.certification.runtimeFreshness.schemaVersion, 3);
  assert.equal(captured.certification.runtimeFreshness.currentAtStart, true);
  assert.equal(captured.certification.runtimeFreshness.currentAtCompletion, true);
  assert.ok(Date.parse(captured.certification.runtimeFreshness.completedAt)
    >= Date.parse(captured.certification.runtimeFreshness.startedAt));
  assert.doesNotThrow(() => assertCurrentSourceMonteCarloRun(captured, snapshot));
  assert.throws(
    () => assertCurrentSourceMonteCarloRun(captured),
    /MONTE_CARLO_CURRENT_SOURCE_REQUIRED/,
    "a serialized summary cannot certify its own freshness",
  );
  assert.throws(() => assertCurrentSourceMonteCarloRun({
    ...captured,
    certification: {
      ...captured.certification,
      runtimeFreshness: {
        ...captured.certification.runtimeFreshness,
        snapshotDigest: "forged",
      },
    },
  }, snapshot), /MONTE_CARLO_CURRENT_SOURCE_REQUIRED/);

  const capturedReplay = await runMonteCarlo({
    drafts: 1,
    seed: 20260814,
    formats: ["snake"],
    exposeHoldout: true,
    skipCounterfactuals: true,
    sourceSnapshot: snapshot,
  });
  assert.equal(capturedReplay.determinismDigest, captured.determinismDigest);
  assert.equal(
    capturedReplay.evidence.orderedTrialOutcomeDigest,
    captured.evidence.orderedTrialOutcomeDigest,
    "runtime start/completion freshness metadata stays outside deterministic trial evidence",
  );

  const historicalSnapshot = capturedSourceSnapshot("snake", 1, "2020-01-01T00:00:00.000Z");
  await assert.rejects(() => runMonteCarlo({
    drafts: 1,
    seed: 20260814,
    formats: ["snake"],
    exposeHoldout: true,
    skipCounterfactuals: true,
    sourceSnapshot: historicalSnapshot,
    certificationNow: Date.parse(historicalSnapshot.capturedAt) + 60_000,
  }), /MONTE_CARLO_FRESHNESS_CLOCK_NOT_INJECTABLE/);
  const historical = await runMonteCarlo({
    drafts: 1,
    seed: 20260814,
    formats: ["snake"],
    exposeHoldout: true,
    skipCounterfactuals: true,
    sourceSnapshot: historicalSnapshot,
  });
  assert.equal(historical.complete, true);
  assert.equal(historical.certification.status, "CAPTURED_SOURCE_SNAPSHOT_V3_NON_CURRENT");
  assert.equal(historical.certification.currentSource, false);
  assert.match(historical.certification.blockers.join(" "), /SOURCE_SNAPSHOT_CAPTURE_STALE/);
  assert.throws(
    () => assertCurrentSourceMonteCarloRun(historical, historicalSnapshot),
    /MONTE_CARLO_CURRENT_SOURCE_REQUIRED/,
  );

  const forged = structuredClone(captured);
  forged.certification.runtimeFreshness.completedAt = new Date().toISOString();
  forged.certification.runtimeFreshness.ageAtCompletionMs = Date.parse(forged.certification.runtimeFreshness.completedAt)
    - Date.parse(forged.certification.runtimeFreshness.capturedAt);
  assert.throws(
    () => assertCurrentSourceMonteCarloRun(forged, historicalSnapshot),
    /MONTE_CARLO_CURRENT_SOURCE_REQUIRED/,
    "editing the serialized proof cannot replace the external captured snapshot",
  );
});

test("phase selection can run paired discovery and validation without touching holdout", { timeout: 30_000 }, async () => {
  const summary = await runMonteCarlo({
    drafts: 10,
    seed: 20260814,
    formats: ["snake", "salary-cap"],
    phases: ["discovery", "validation"],
    exposeHoldout: false,
    skipCounterfactuals: true,
  });
  assert.equal(summary.completedDrafts, 16);
  assert.equal(summary.requestedDrafts, 16);
  assert.equal(summary.complete, true);
  assert.equal(summary.aggregate.drafts, 16);
  assert.equal("snake:holdout" in summary.splits, false);
  assert.equal("salary-cap:holdout" in summary.splits, false);
});

test("captured-snapshot CLI auto-selects the exact format and rejects cross-format reuse", { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "draftforge-monte-carlo-profile-"));
  try {
    const snapshotPath = join(root, "source-snapshot.json");
    const output = join(root, "exact-output");
    const snapshot = capturedSourceSnapshot("snake", 1, new Date().toISOString());
    assert.equal(snapshot.validation.valid, true, snapshot.validation.errors.join(" "));
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    let result = spawnSync(process.execPath, [
      resolve("scripts/monte-carlo.mjs"),
      "--drafts", "1",
      "--snapshot", snapshotPath,
      "--output", output,
      "--expose-holdout",
      "--skip-counterfactuals",
      "--require-current-source",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    assert.equal(summary.requestedDrafts, 1);
    assert.equal(summary.completedDrafts, 1);
    assert.equal(summary.complete, true);
    assert.deepEqual(summary.config.formats, ["snake"]);
    assert.deepEqual(Object.keys(summary.scenarios), ["snake:captured-authenticated-settings"]);
    assert.equal(summary.certification.status, "CURRENT_SOURCE_SNAPSHOT_V3");
    assert.equal(summary.evidence.identity.source.schemaVersion, SOURCE_SNAPSHOT_SCHEMA_VERSION);

    const historicalSnapshotPath = join(root, "historical-source-snapshot.json");
    const historicalSnapshot = capturedSourceSnapshot("snake", 1, "2020-01-01T00:00:00.000Z");
    writeFileSync(historicalSnapshotPath, `${JSON.stringify(historicalSnapshot)}\n`);
    result = spawnSync(process.execPath, [
      resolve("scripts/monte-carlo.mjs"),
      "--drafts", "1",
      "--snapshot", historicalSnapshotPath,
      "--output", join(root, "historical-output"),
      "--expose-holdout",
      "--skip-counterfactuals",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const historicalSummary = JSON.parse(readFileSync(join(root, "historical-output", "summary.json"), "utf8"));
    assert.equal(historicalSummary.certification.status, "CAPTURED_SOURCE_SNAPSHOT_V3_NON_CURRENT");

    result = spawnSync(process.execPath, [
      resolve("scripts/monte-carlo.mjs"),
      "--drafts", "1",
      "--snapshot", historicalSnapshotPath,
      "--output", join(root, "historical-rejected"),
      "--expose-holdout",
      "--skip-counterfactuals",
      "--require-current-source",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MONTE_CARLO_CURRENT_SOURCE_REQUIRED/);

    result = spawnSync(process.execPath, [
      resolve("scripts/monte-carlo.mjs"),
      "--drafts", "1",
      "--formats", "snake",
      "--output", join(root, "synthetic-certification-rejected"),
      "--expose-holdout",
      "--skip-counterfactuals",
      "--require-current-source",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MONTE_CARLO_CURRENT_SOURCE_REQUIRED/);

    result = spawnSync(process.execPath, [
      resolve("scripts/monte-carlo.mjs"),
      "--drafts", "1",
      "--formats", "salary-cap",
      "--snapshot", snapshotPath,
      "--output", join(root, "wrong-format-output"),
      "--skip-counterfactuals",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--snapshot requires exactly --formats snake/);

    result = spawnSync(process.execPath, [
      resolve("scripts/monte-carlo.mjs"),
      "--snapshot",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--snapshot requires a value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captured-snapshot matrix CLI auto-selects the exact format and rejects cross-format reuse", { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "draftforge-monte-carlo-matrix-profile-"));
  try {
    const snapshotPath = join(root, "source-snapshot.json");
    const output = join(root, "exact-output");
    const snapshot = capturedSourceSnapshot("salary-cap", 1, new Date().toISOString());
    assert.equal(snapshot.validation.valid, true, snapshot.validation.errors.join(" "));
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    let result = spawnSync(process.execPath, [
      resolve("scripts/monte-carlo-matrix.mjs"),
      "--drafts", "1",
      "--seeds", "20260820",
      "--snapshot", snapshotPath,
      "--output", output,
      "--require-current-source",
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    assert.deepEqual(summary.formats, ["salary-cap"]);
    assert.equal(summary.runs[0].completedDrafts, 1);
    assert.equal(summary.runs[0].failures, 0);
    assert.equal(summary.certification.status, "CURRENT_SOURCE_SNAPSHOT_V3");
    assert.equal(summary.aggregate.byFormat["salary-cap"].safetyPassed, true);
    assert.equal(summary.runs[0].byFormat["salary-cap"].safetyPassed, true);

    result = spawnSync(process.execPath, [
      resolve("scripts/monte-carlo-matrix.mjs"),
      "--drafts", "1",
      "--seeds", "20260820",
      "--formats", "snake",
      "--snapshot", snapshotPath,
      "--output", join(root, "wrong-format-output"),
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--snapshot requires exactly --formats salary-cap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the completeness guard rejects every per-trial failure or requested-count shortfall", async () => {
  const failed = await runMonteCarlo({
    drafts: 1,
    seed: 20260814,
    formats: ["unsupported-format"],
    exposeHoldout: true,
    skipCounterfactuals: true,
  });
  assert.equal(failed.requestedDrafts, 1);
  assert.equal(failed.completedDrafts, 0);
  assert.equal(failed.failureSeeds.length, 1);
  assert.throws(() => assertCompleteMonteCarloRun(failed), /MONTE_CARLO_INCOMPLETE/);
  assert.throws(() => assertCompleteMonteCarloRun({
    ...failed,
    complete: true,
    failureSeeds: [],
  }), /MONTE_CARLO_INCOMPLETE/);
});

test("evidence sink failures abort instead of double-counting one trial as success and failure", async () => {
  await assert.rejects(() => runMonteCarlo({
    drafts: 1,
    seed: 20260814,
    formats: ["snake"],
    exposeHoldout: true,
    skipCounterfactuals: true,
  }, {
    onTrial() {
      throw new Error("EVIDENCE_SINK_FAILED");
    },
  }), /EVIDENCE_SINK_FAILED/);
});

test("paired comparison rejects a different seed and truncated baseline coverage", { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "draftforge-monte-carlo-pairing-"));
  const run = (args) => spawnSync(process.execPath, [
    resolve("scripts/monte-carlo.mjs"),
    "--drafts", "2",
    "--formats", "snake",
    "--expose-holdout",
    "--skip-counterfactuals",
    ...args,
  ], { cwd: resolve("."), encoding: "utf8" });
  try {
    const baseline = join(root, "baseline");
    let result = run(["--seed", "20260814", "--output", baseline]);
    assert.equal(result.status, 0, result.stderr);

    result = run([
      "--seed", "20260815",
      "--compare", baseline,
      "--output", join(root, "different-seed"),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PAIRED_COMPARISON_INVALID:.*identity-mismatch:snake:0:trialSeed/);

    const truncated = join(root, "truncated-baseline");
    mkdirSync(truncated, { recursive: true });
    const records = readFileSync(join(baseline, "trial-metrics.jsonl"), "utf8").trim().split("\n");
    assert.equal(records.length, 2);
    writeFileSync(join(truncated, "trial-metrics.jsonl"), `${records[0]}\n`);
    writeFileSync(join(truncated, "sealed-holdout.jsonl"), "");
    result = run([
      "--seed", "20260814",
      "--compare", truncated,
      "--output", join(root, "truncated-candidate"),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PAIRED_COMPARISON_INVALID:.*missing-baseline:snake:1/);

    result = run([
      "--seed", "20260814",
      "--compare", baseline,
      "--output", baseline,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--compare and --output must be different directories/);
    assert.equal(readFileSync(join(baseline, "trial-metrics.jsonl"), "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Monte Carlo report separates nomination proxies, bid opportunities, and source certification", { timeout: 30_000 }, async () => {
  const summary = await runMonteCarlo({
    drafts: 10,
    seed: 20260814,
    formats: ["salary-cap"],
    exposeHoldout: true,
    skipCounterfactuals: true,
  });
  summary.topRegretCases = [{
    format: "salary-cap",
    trialIndex: 1,
    split: "discovery",
    decisionNumber: 2,
    decisionKind: "NOMINATION",
    acquired: false,
    regret: 25,
  }];
  const report = renderMarkdownReport(summary);
  assert.match(report, /\| Nomination proxy \| 25\.00 \|/);
  assert.match(report, /Every legal salary-cap bid opportunity is logged separately/);
  assert.match(report, /SYNTHETIC_NON_CERTIFYING/);
  assert.match(report, /streaming bounded-memory digest/);
});
