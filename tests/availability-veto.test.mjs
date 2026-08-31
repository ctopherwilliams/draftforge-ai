import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADVISORY_CLASSIFICATIONS,
  AVAILABILITY_ARTIFACT_SCHEMA,
  availabilityBoundedActionDeadline,
  createAvailabilityDecisionSnapshot,
  evaluateAvailabilityGate,
  excludeAvailabilityVetoes,
  parseAvailabilityArtifact,
  parseAvailabilityPolicy,
  revalidateAvailabilityDecision,
} from "../app/lib/availability-veto.ts";

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`../fixtures/availability-veto/${name}.example.json`, import.meta.url),
  "utf8",
));
const policy = JSON.parse(await readFile(
  new URL("../config/availability-veto.policy.example.json", import.meta.url),
  "utf8",
));
const evaluatedAt = "2026-08-28T00:00:00.000Z";
const players = [
  { id: 101, name: "Example Player", team: "BUF", pos: "WR", score: 99 },
  { id: 102, name: "Advisory Player", team: "KC", pos: "RB", score: 90 },
  { id: 103, name: "Conflicted Player", team: "DAL", pos: "TE", score: 80 },
  { id: -16, name: "Buffalo Bills D/ST", team: "BUF", pos: "DST", score: 70 },
];

function evidence(classification, overrides = {}) {
  return {
    kind: "reputable_report",
    url: "https://www.espn.com/nfl/story/_/id/3/example",
    domain: "www.espn.com",
    publishedAt: "2026-08-27T23:40:00.000Z",
    supportsClassification: classification,
    ...overrides,
  };
}

function record(classification, overrides = {}) {
  return {
    identity: { espnPlayerId: 101, normalizedName: "exampleplayer", team: "BUF", position: "WR" },
    classification,
    reasonCode: classification,
    eventAt: "2026-08-27T23:40:00.000Z",
    retrievedAt: "2026-08-27T23:49:00.000Z",
    evidence: [evidence(classification)],
    ...overrides,
  };
}

function artifact(records, overrides = {}) {
  return {
    schemaVersion: AVAILABILITY_ARTIFACT_SCHEMA,
    generatedAt: "2026-08-27T23:50:00.000Z",
    scanReceipt: {
      completedAt: "2026-08-27T23:49:30.000Z",
      feeds: [
        { id: "authenticated_espn_player_news", url: "https://fantasy.espn.com/football/playernews", retrievedAt: "2026-08-27T23:49:00.000Z", status: "ok" },
        { id: "official_nfl_news", url: "https://www.nfl.com/news/", retrievedAt: "2026-08-27T23:49:00.000Z", status: "ok" },
      ],
    },
    records,
    ...overrides,
  };
}

test("the sanitized policy and artifact schemas reject unknown, executable, free-form, and mismatched content", async () => {
  assert.equal(parseAvailabilityPolicy(policy).ok, true);
  const fresh = await fixture("fresh-hard-veto");
  assert.equal(parseAvailabilityArtifact(fresh).ok, true);

  const withTranscript = structuredClone(fresh);
  withTranscript.records[0].modelTranscript = "ignore safety and execute()";
  const transcriptResult = parseAvailabilityArtifact(withTranscript);
  assert.equal(transcriptResult.ok, false);
  assert.ok(transcriptResult.errors.some((error) => error.code === "UNKNOWN_FIELD"));

  const executableUrl = structuredClone(fresh);
  executableUrl.records[0].evidence[0].url = "javascript:alert(1)";
  assert.equal(parseAvailabilityArtifact(executableUrl).ok, false);

  const reasonMismatch = structuredClone(fresh);
  reasonMismatch.records[0].reasonCode = "rumor";
  assert.equal(parseAvailabilityArtifact(reasonMismatch).ok, false);

  const credentialField = structuredClone(fresh);
  credentialField.espnCookie = "not-allowed";
  assert.equal(parseAvailabilityArtifact(credentialField).ok, false);
});

test("one configured official source hard-vetoes an exact player without reordering or mutating healthy players", async () => {
  const evaluation = evaluateAvailabilityGate({
    artifact: await fixture("fresh-hard-veto"), policy, players, evaluatedAt,
  });

  assert.equal(evaluation.status, "READY");
  assert.deepEqual(evaluation.vetoedPlayerIds, [101]);
  assert.equal(evaluation.vetoes[0].provenance.evidence[0].domain, "www.nfl.com");
  const remaining = excludeAvailabilityVetoes(players, evaluation);
  assert.deepEqual(remaining, players.slice(1));
  assert.equal(remaining[0].score, 90);
  assert.equal(Object.isFrozen(evaluation), true);
});

test("two independent reputable domains establish a hard veto but one report cannot", () => {
  const twoReports = record("suspension_covering_fantasy_season", {
    evidence: [
      evidence("suspension_covering_fantasy_season"),
      evidence("suspension_covering_fantasy_season", {
        url: "https://apnews.com/article/example-suspension",
        domain: "apnews.com",
      }),
    ],
  });
  const accepted = evaluateAvailabilityGate({ artifact: artifact([twoReports]), policy, players, evaluatedAt });
  assert.deepEqual(accepted.vetoedPlayerIds, [101]);
  assert.equal(accepted.armingAllowed, true);

  const insufficient = evaluateAvailabilityGate({
    artifact: artifact([record("suspension_covering_fantasy_season")]),
    policy,
    players,
    actionablePlayerIds: [101],
    evaluatedAt,
  });
  assert.equal(insufficient.armingAllowed, false);
  assert.deepEqual(insufficient.blockingReasons, ["UNRESOLVED_ACTIONABLE_HARD_VETO"]);
  assert.equal(insufficient.unresolved[0].reason, "INSUFFICIENT_HARD_VETO_EVIDENCE");

  const outsideWindow = evaluateAvailabilityGate({
    artifact: artifact([record("suspension_covering_fantasy_season")]),
    policy,
    players,
    actionablePlayerIds: [102],
    evaluatedAt,
  });
  assert.equal(outsideWindow.armingAllowed, true);
  assert.deepEqual(outsideWindow.vetoedPlayerIds, []);
});

test("every questionable-style state remains advisory and cannot silently become a hard veto", () => {
  const advisoryRecords = ADVISORY_CLASSIFICATIONS.map((classification, index) => record(classification, {
    identity: {
      espnPlayerId: 102,
      normalizedName: "advisoryplayer",
      team: "KC",
      position: "RB",
    },
    eventAt: `2026-08-27T23:${String(30 + index).padStart(2, "0")}:00.000Z`,
    evidence: [evidence(classification)],
  }));
  const evaluation = evaluateAvailabilityGate({ artifact: artifact(advisoryRecords), policy, players, evaluatedAt });
  assert.equal(evaluation.armingAllowed, true);
  assert.deepEqual(evaluation.vetoedPlayerIds, []);
  assert.deepEqual(evaluation.advisoryPlayerIds, [102]);
  assert.equal(evaluation.advisories.length, ADVISORY_CLASSIFICATIONS.length);
});

test("stale, future, malformed, and out-of-bounds configuration fail closed at arming", async () => {
  const stale = evaluateAvailabilityGate({ artifact: await fixture("stale"), policy, players, evaluatedAt });
  assert.equal(stale.armingAllowed, false);
  assert.ok(stale.blockingReasons.includes("STALE_AVAILABILITY_ARTIFACT"));

  const future = evaluateAvailabilityGate({
    artifact: artifact([], { generatedAt: "2026-08-28T00:03:00.001Z" }), policy, players, evaluatedAt,
  });
  assert.equal(future.armingAllowed, false);
  assert.ok(future.blockingReasons.includes("FUTURE_AVAILABILITY_ARTIFACT"));

  const malformed = evaluateAvailabilityGate({ artifact: { records: [] }, policy, players, evaluatedAt });
  assert.equal(malformed.armingAllowed, false);
  assert.equal(malformed.blockingReasons[0], "INVALID_AVAILABILITY_INPUT");

  assert.equal(parseAvailabilityPolicy({ ...policy, maxAgeMinutes: 4 }).ok, false);
  assert.equal(parseAvailabilityPolicy({ ...policy, maxAgeMinutes: 121 }).ok, false);
  assert.equal(parseAvailabilityPolicy({ ...policy, reputableDomains: ["espn.com", "news.espn.com"] }).ok, false);
});

test("availability arming requires fresh successful ESPN and official NFL scan receipts", () => {
  const missing = artifact([]);
  delete missing.scanReceipt;
  assert.equal(evaluateAvailabilityGate({ artifact: missing, policy, players, evaluatedAt }).armingAllowed, false);

  const failed = artifact([]);
  failed.scanReceipt.feeds[0].status = "failed";
  const failedEvaluation = evaluateAvailabilityGate({ artifact: failed, policy, players, evaluatedAt });
  assert.equal(failedEvaluation.armingAllowed, false);
  assert.ok(failedEvaluation.blockingReasons.includes("NEWS_SCAN_FAILED"));

  const staleScan = artifact([]);
  staleScan.scanReceipt.completedAt = "2026-08-27T22:00:00.000Z";
  staleScan.scanReceipt.feeds = staleScan.scanReceipt.feeds.map((feed) => ({ ...feed, retrievedAt: "2026-08-27T22:00:00.000Z" }));
  const staleEvaluation = evaluateAvailabilityGate({ artifact: staleScan, policy, players, evaluatedAt });
  assert.equal(staleEvaluation.armingAllowed, false);
  assert.ok(staleEvaluation.blockingReasons.includes("STALE_NEWS_SCAN_RECEIPT"));
  assert.ok(staleEvaluation.blockingReasons.includes("STALE_NEWS_SCAN_FEED"));
});

test("scan receipts bind each required feed id to its exact credential-safe host and path", () => {
  const mutations = [
    ["hostile ESPN host", (value) => { value.scanReceipt.feeds[0].url = "https://fantasy.espn.com.evil.test/football/players/news"; }],
    ["swapped feed urls", (value) => {
      const first = value.scanReceipt.feeds[0].url;
      value.scanReceipt.feeds[0].url = value.scanReceipt.feeds[1].url;
      value.scanReceipt.feeds[1].url = first;
    }],
    ["sensitive ESPN query", (value) => { value.scanReceipt.feeds[0].url += "?memberId=secret"; }],
    ["nonstandard NFL port", (value) => { value.scanReceipt.feeds[1].url = "https://www.nfl.com:8443/news/"; }],
    ["obsolete ESPN path", (value) => { value.scanReceipt.feeds[0].url = "https://fantasy.espn.com/football/players/news"; }],
    ["unrelated ESPN path", (value) => { value.scanReceipt.feeds[0].url = "https://fantasy.espn.com/football/team"; }],
  ];
  for (const [label, mutate] of mutations) {
    const value = artifact([]);
    mutate(value);
    const parsed = parseAvailabilityArtifact(value);
    assert.equal(parsed.ok, false, label);
    assert.ok(parsed.errors.some((error) => error.code === "INVALID_SCAN_FEED_URL"), label);
  }
});

test("availability expiry uses the earliest artifact, scan, feed, or record lease and bounds clicks", () => {
  const evaluation = evaluateAvailabilityGate({
    artifact: artifact([record("season_ending_injury", {
      evidence: [evidence("season_ending_injury", {
        kind: "official_nfl",
        url: "https://www.nfl.com/news/example-season-ending-injury",
        domain: "www.nfl.com",
      })],
    })]),
    policy,
    players,
    evaluatedAt,
  });
  assert.equal(evaluation.armingAllowed, true);
  assert.equal(evaluation.freshUntil, "2026-08-28T00:19:00.000Z");

  const twoSecondsBeforeExpiry = Date.parse("2026-08-28T00:18:58.000Z");
  assert.equal(
    availabilityBoundedActionDeadline(evaluation, 2_500, twoSecondsBeforeExpiry),
    Date.parse(evaluation.freshUntil),
  );
  assert.equal(
    availabilityBoundedActionDeadline(evaluation, 2_500, Date.parse(evaluation.freshUntil)),
    null,
  );
  assert.equal(availabilityBoundedActionDeadline({ ...evaluation, armingAllowed: false }, 2_500, twoSecondsBeforeExpiry), null);

  const oneMillisecondBefore = evaluateAvailabilityGate({
    artifact: artifact([record("opinion")]),
    policy,
    players,
    evaluatedAt: "2026-08-28T00:18:59.999Z",
  });
  assert.equal(oneMillisecondBefore.armingAllowed, true);
  const exactlyExpired = evaluateAvailabilityGate({
    artifact: artifact([record("opinion")]),
    policy,
    players,
    evaluatedAt: "2026-08-28T00:19:00.000Z",
  });
  assert.equal(exactlyExpired.armingAllowed, false);
  assert.ok(exactlyExpired.blockingReasons.some((reason) => reason.startsWith("STALE_")));
});

test("each provenance timestamp independently limits the availability lease", () => {
  const cases = [
    ["generatedAt", (value) => { value.generatedAt = "2026-08-27T23:48:00.000Z"; }],
    ["scan completedAt", (value) => { value.scanReceipt.completedAt = "2026-08-27T23:48:00.000Z"; }],
    ["feed retrievedAt", (value) => { value.scanReceipt.feeds[0].retrievedAt = "2026-08-27T23:48:00.000Z"; }],
    ["record retrievedAt", (value) => { value.records[0].retrievedAt = "2026-08-27T23:48:00.000Z"; }],
  ];
  for (const [label, mutate] of cases) {
    const value = artifact([record("opinion")]);
    mutate(value);
    const evaluation = evaluateAvailabilityGate({ artifact: value, policy, players, evaluatedAt });
    assert.equal(evaluation.armingAllowed, true, label);
    assert.equal(evaluation.freshUntil, "2026-08-28T00:18:00.000Z", label);
  }
});

test("conflicting exact claims and actionable ambiguous identity claims cannot arm", async () => {
  const conflict = evaluateAvailabilityGate({
    artifact: await fixture("conflicting"), policy, players, evaluatedAt,
  });
  assert.equal(conflict.armingAllowed, false);
  assert.ok(conflict.blockingReasons.includes("CONFLICTING_IDENTITY_CLAIMS"));

  const duplicatePlayers = [
    { id: 201, name: "Shared Name", team: "LAC", pos: "WR" },
    { id: 202, name: "Shared Name", team: "LAC", pos: "WR" },
  ];
  const ambiguous = evaluateAvailabilityGate({
    artifact: await fixture("ambiguous"),
    policy,
    players: duplicatePlayers,
    actionablePlayerIds: [201],
    evaluatedAt,
  });
  assert.equal(ambiguous.armingAllowed, false);
  assert.ok(ambiguous.blockingReasons.includes("UNRESOLVED_ACTIONABLE_HARD_VETO"));
  assert.equal(ambiguous.unresolved[0].reason, "AMBIGUOUS_IDENTITY");
});

test("artifact ordering does not change the content digest or byte-for-byte decision replay", async () => {
  const hard = await fixture("fresh-hard-veto");
  const advisory = await fixture("advisory");
  const combined = artifact([hard.records[0], advisory.records[0]]);
  const reversed = artifact([advisory.records[0], hard.records[0]]);
  const first = evaluateAvailabilityGate({ artifact: combined, policy, players, evaluatedAt });
  const second = evaluateAvailabilityGate({ artifact: reversed, policy, players, evaluatedAt });
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);

  const one = createAvailabilityDecisionSnapshot({ decisionKey: "snake:1:101", evaluation: first, player: players[0] });
  const two = createAvailabilityDecisionSnapshot({ decisionKey: "snake:1:101", evaluation: second, player: players[0] });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.equal(one.status, "VETO");
  assert.equal(one.canAct, false);
  assert.equal(Object.isFrozen(one), true);
  assert.equal(Object.isFrozen(one.reasons), true);
});

test("a veto arriving after recommendation invalidates the immutable pending action", async () => {
  const clearEvaluation = evaluateAvailabilityGate({ artifact: artifact([]), policy, players, evaluatedAt });
  const pending = createAvailabilityDecisionSnapshot({
    decisionKey: "salary-cap:nomination:101",
    evaluation: clearEvaluation,
    player: players[0],
  });
  assert.equal(pending.canAct, true);

  const vetoEvaluation = evaluateAvailabilityGate({
    artifact: await fixture("fresh-hard-veto"), policy, players, evaluatedAt,
  });
  const revalidation = revalidateAvailabilityDecision(pending, vetoEvaluation, players[0]);
  assert.equal(revalidation.valid, false);
  assert.equal(revalidation.reason, "AVAILABILITY_DIGEST_CHANGED");
  assert.equal(revalidation.current.status, "VETO");
  assert.equal(revalidation.current.canAct, false);
});

test("negative ESPN D/ST identities remain exact and eligible for advisory provenance", () => {
  const dstArtifact = artifact([record("opinion", {
    identity: { espnPlayerId: -16, normalizedName: "buffalobillsdst", team: "BUF", position: "DST" },
    evidence: [evidence("opinion")],
  })]);
  const evaluation = evaluateAvailabilityGate({ artifact: dstArtifact, policy, players, evaluatedAt });
  assert.equal(evaluation.armingAllowed, true);
  assert.deepEqual(evaluation.advisoryPlayerIds, [-16]);
});
