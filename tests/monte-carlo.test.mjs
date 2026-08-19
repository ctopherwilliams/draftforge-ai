import assert from "node:assert/strict";
import test from "node:test";
import {
  OPPONENT_ARCHETYPES,
  deriveTrialSeed,
  makeConsensusPlayerSnapshot,
  makeLeagueScenario,
  renderMarkdownReport,
  runCounterfactuals,
  runMonteCarlo,
  simulateDraft,
  splitForTrial,
  sumAcquiredDecisionRegret,
} from "../simulation/monte-carlo.mjs";

const ZERO_VIOLATIONS = {
  duplicatePlayers: 0,
  incompleteRosters: 0,
  unnecessarySecondSpecialist: 0,
  positionCap: 0,
  salaryCap: 0,
  reserve: 0,
  maxBid: 0,
  missingMandatoryStarter: 0,
};

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

test("salary-cap regret excludes nominations DraftForge did not acquire", { timeout: 30_000 }, () => {
  assert.equal(sumAcquiredDecisionRegret([
    { regret: 250, acquired: false },
    { regret: 12, acquired: true },
    { regret: 8 },
  ]), 20);
  const result = simulateDraft({ format: "salary-cap", baseSeed: 20260814, trialIndex: 2768, drafts: 10_000 });
  assert.equal(result.regretCase.acquired, false);
  assert.ok(result.regretCase.regret > 250);
  assert.ok(result.metrics.decisionRegret < 1_600);
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

test("deep 14-team adversarial rooms retain enough legal late-round inventory", { timeout: 30_000 }, () => {
  for (const format of ["snake", "salary-cap"]) {
    const result = simulateDraft({ format, baseSeed: 20260814, trialIndex: 49, drafts: 10_000 });
    assert.equal(result.scenario, "adversarial-espn-compatible");
    assert.deepEqual(result.violations, ZERO_VIOLATIONS);
    assert.equal(result.roster.length, result.rosterSize);
  }
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
  assert.equal(first.aggregate.drafts, 16);
  assert.equal(first.splits["snake:holdout"].sealed, true);
  assert.equal(first.splits["salary-cap:holdout"].sealed, true);
  assert.equal("metrics" in first.splits["snake:holdout"], false);
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
  assert.equal(summary.aggregate.drafts, 16);
  assert.equal("snake:holdout" in summary.splits, false);
  assert.equal("salary-cap:holdout" in summary.splits, false);
});

test("Monte Carlo report clearly separates nomination proxies from acquisition regret", { timeout: 30_000 }, async () => {
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
    acquired: false,
    regret: 25,
  }];
  const report = renderMarkdownReport(summary);
  assert.match(report, /\| Nomination proxy \| 25\.00 \|/);
  assert.match(report, /excluded from aggregate decision regret unless DraftForge actually acquires/);
});
