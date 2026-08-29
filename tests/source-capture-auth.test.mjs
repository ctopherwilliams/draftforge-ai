import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AUTHENTICATED_ESPN_CAPTURE_MAX_RECEIPTS,
  AUTHENTICATED_ESPN_CAPTURE_RECEIPT_TTL_MS,
  authenticatedEspnCaptureDigest,
  authenticatedEspnCaptureReceiptBindingMatchesAudit,
  buildAuthenticatedEspnCaptureAttestation,
  buildAuthenticatedEspnCaptureProfile,
  createAuthenticatedEspnCaptureReceiptStore,
  sanitizeAuthenticatedEspnLeague,
  sanitizeAuthenticatedEspnPlayers,
} from "../app/lib/authenticated-espn-capture.ts";
import {
  AUTHENTICATED_ESPN_CAPTURE_MAX_AGE_MS,
  consumeAuthenticatedEspnCaptureReceipt,
  normalizeAuthenticatedEspnCaptureOrigin,
  verifyAuthenticatedEspnCapture,
} from "../scripts/capture-source-snapshot.mjs";

const capturedAt = "2026-08-28T12:00:00.000Z";
const now = Date.parse(capturedAt) + 60_000;
const request = { scoring: "PPR", teams: 12, season: 2026, qbs: 2 };
const receipt = "a".repeat(32);

function baseArtifact(overrides = {}) {
  return {
    capturedAt,
    league: {
      id: "44050",
      teamId: 7,
      season: 2026,
      draftType: "AUCTION",
      size: 12,
      rosterSize: 14,
      auctionBudget: 200,
      scoringLabel: "PPR",
      scoringRules: 45,
      lineupSlotCounts: { "0": 1, "7": 1 },
      positionLimits: { QB: 3, RB: 6 },
      secondsPerPick: 60,
      keeperCount: 0,
      pickOrder: [7, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12],
      rawSettings: {
        scoringSettings: {
          scoringItems: Array.from({ length: 45 }, (_, index) => ({ statId: index + 1, points: index === 0 ? 1 : 0 })),
        },
      },
    },
    espnPlayers: Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      name: index === 0 ? "Player One" : index === 1 ? "Player Two" : `Player ${index + 1}`,
      pos: index % 2 === 0 ? "QB" : "RB",
      status: "ACTIVE",
    })),
    ...overrides,
  };
}

async function artifact(overrides = {}, proofOverrides = {}) {
  const raw = baseArtifact(overrides);
  const input = {
    capturedAt: raw.capturedAt,
    league: sanitizeAuthenticatedEspnLeague(raw.league),
    espnPlayers: sanitizeAuthenticatedEspnPlayers(raw.espnPlayers),
  };
  const digest = await authenticatedEspnCaptureDigest({
    capturedAt: input.capturedAt,
    league: input.league,
    espnPlayers: input.espnPlayers,
  });
  input.authenticatedPlayerPoolEnvelope = {
    schemaVersion: 1,
    requestedCount: 500,
    playerCount: 500,
    uniquePlayerCount: 500,
    fetchedAt: input.capturedAt,
    leagueId: input.league.id,
    teamId: input.league.teamId,
    season: input.league.season,
  };
  input.authenticatedEspnCapture = {
    ...buildAuthenticatedEspnCaptureAttestation({
      capturedAt: input.capturedAt,
      league: input.league,
      espnPlayers: input.espnPlayers,
      request,
      digest,
      receipt,
    }),
    ...proofOverrides,
  };
  return input;
}

test("source capture accepts exact bytes only with the SHA-256 proof", async () => {
  const input = await artifact();
  const verified = await verifyAuthenticatedEspnCapture(input, request, { now });
  assert.equal(verified.capturedAt, capturedAt);
  assert.deepEqual(verified.league, input.league);
  assert.deepEqual(verified.espnPlayers, input.espnPlayers);
  assert.equal(verified.authenticatedProfile.playerCount, 500);
  assert.match(verified.proof.digest, /^sha256:[a-f0-9]{64}$/);
});

test("timestamp edits and same-count player/status mutations invalidate the exact digest", async () => {
  const changedTimestamp = await artifact();
  changedTimestamp.capturedAt = "2026-08-28T12:00:01.000Z";
  changedTimestamp.authenticatedEspnCapture.capturedAt = changedTimestamp.capturedAt;
  await assert.rejects(
    () => verifyAuthenticatedEspnCapture(changedTimestamp, request, { now }),
    /ESPN_ARTIFACT_DIGEST_MISMATCH/,
  );

  for (const mutate of [
    (players) => { players[0].name = "Different Player"; },
    (players) => { players[0].availabilityStatus = "OUT"; },
    (players) => { players.reverse(); },
  ]) {
    const changed = await artifact();
    mutate(changed.espnPlayers);
    await assert.rejects(
      () => verifyAuthenticatedEspnCapture(changed, request, { now }),
      /ESPN_ARTIFACT_(DIGEST_MISMATCH|PLAYERS_NOT_EXACTLY_SANITIZED)/,
    );
  }
});

test("source capture rejects receipt-bound bytes outside the exact sanitized schema", async () => {
  for (const mutate of [
    (input) => { input.league.rawSettings = { credentials: "must-not-survive" }; },
    (input) => { input.espnPlayers[0].status = "ACTIVE"; },
  ]) {
    const input = await artifact();
    mutate(input);
    const digest = await authenticatedEspnCaptureDigest(input);
    input.authenticatedEspnCapture = buildAuthenticatedEspnCaptureAttestation({
      capturedAt: input.capturedAt,
      league: input.league,
      espnPlayers: input.espnPlayers,
      request,
      digest,
      receipt,
    });
    await assert.rejects(
      () => verifyAuthenticatedEspnCapture(input, request, { now }),
      /ESPN_ARTIFACT_(LEAGUE|PLAYERS)_NOT_EXACTLY_SANITIZED/,
    );
  }
});

test("the sanitized capture digest binds every draft, roster, and scoring-rule value", async () => {
  const input = baseArtifact();
  const league = sanitizeAuthenticatedEspnLeague(input.league);
  const players = sanitizeAuthenticatedEspnPlayers(input.espnPlayers);
  const digest = await authenticatedEspnCaptureDigest({ capturedAt, league, espnPlayers: players });
  for (const mutate of [
    (candidate) => { candidate.secondsPerPick += 1; },
    (candidate) => { candidate.keeperCount += 1; candidate.rulesFingerprint.keeperCount += 1; },
    (candidate) => { candidate.pickOrder.reverse(); candidate.rulesFingerprint.pickOrder.reverse(); },
    (candidate) => { candidate.lineupSlotCounts["7"] = 0; candidate.rulesFingerprint.lineupSlotCounts["7"] = 0; },
    (candidate) => { candidate.positionLimits.QB = 4; candidate.rulesFingerprint.positionLimits.QB = 4; },
    (candidate) => { candidate.rulesFingerprint.scoringItems[0].points = 2; },
  ]) {
    const changed = structuredClone(league);
    mutate(changed);
    assert.notEqual(
      await authenticatedEspnCaptureDigest({ capturedAt, league: changed, espnPlayers: players }),
      digest,
    );
  }
});

test("source capture rejects malformed, future, and stale authenticated times", async () => {
  for (const [value, error] of [
    ["2026-08-28T12:00:00Z", /ESPN_ARTIFACT_CAPTURED_AT_INVALID/],
    [new Date(now + 5_001).toISOString(), /ESPN_ARTIFACT_CAPTURED_IN_FUTURE/],
    [new Date(now - AUTHENTICATED_ESPN_CAPTURE_MAX_AGE_MS - 1).toISOString(), /ESPN_ARTIFACT_STALE/],
  ]) {
    const input = await artifact({ capturedAt: value });
    await assert.rejects(() => verifyAuthenticatedEspnCapture(input, request, { now }), error);
  }
});

test("source capture rejects missing proof and profile mismatches", async () => {
  const missing = await artifact();
  delete missing.authenticatedEspnCapture;
  await assert.rejects(
    () => verifyAuthenticatedEspnCapture(missing, request, { now }),
    /ESPN_ARTIFACT_AUTH_PROOF_REQUIRED/,
  );

  const mismatched = await artifact();
  mismatched.authenticatedEspnCapture.profile.teamId = 8;
  await assert.rejects(
    () => verifyAuthenticatedEspnCapture(mismatched, request, { now }),
    /ESPN_ARTIFACT_PROFILE_MISMATCH:teamId/,
  );
});

function receiptBinding(input, digest = `sha256:${"b".repeat(64)}`) {
  return {
    digest,
    capturedAt,
    profile: buildAuthenticatedEspnCaptureProfile({ league: input.league, espnPlayers: input.espnPlayers, request }),
    tabId: 91,
    dashboardLoadedAt: "2026-08-28T11:59:00.000Z",
    commandCenterSessionId: "command-center-session",
  };
}

function matchingAudit(input, binding, auditCapturedAt = new Date(now - 1_000).toISOString()) {
  return {
    capturedAt: auditCapturedAt,
    league: input.league,
    binding: {
      tabId: binding.tabId,
      dashboardLoadedAt: binding.dashboardLoadedAt,
      commandCenterSessionId: binding.commandCenterSessionId,
      authenticatedImportAt: binding.capturedAt,
      authenticatedPlayerPool: {
        schemaVersion: 1,
        requestedCount: 500,
        playerCount: 500,
        uniquePlayerCount: 500,
        fetchedAt: binding.capturedAt,
        leagueId: input.league.id,
        teamId: input.league.teamId,
        season: input.league.season,
      },
    },
    safety: { extensionConnected: true, settingsConfirmed: true, sourceCoverage: 5 },
  };
}

test("receipt issuance requires the exact current league, team, tab, profile, and dashboard audit", () => {
  const input = baseArtifact();
  const binding = receiptBinding(input);
  const audit = matchingAudit(input, binding);
  assert.equal(authenticatedEspnCaptureReceiptBindingMatchesAudit(binding, audit, { now }), true);

  const failures = [
    [{ ...binding, tabId: 92 }, audit],
    [{ ...binding, dashboardLoadedAt: "2026-08-28T11:58:00.000Z" }, audit],
    [{ ...binding, commandCenterSessionId: "other-command-center" }, audit],
    [{ ...binding, profile: { ...binding.profile, teamId: 8 } }, audit],
    [binding, { ...audit, league: { ...audit.league, id: "1603083723" } }],
    [binding, { ...audit, safety: { ...audit.safety, extensionConnected: false } }],
    [binding, { ...audit, capturedAt: new Date(now - 15_001).toISOString() }],
  ];
  for (const [candidate, recorded] of failures) {
    assert.equal(authenticatedEspnCaptureReceiptBindingMatchesAudit(candidate, recorded, { now }), false);
  }
});

test("receipt store is globally bounded, expires, and accepts each exact proof once", async () => {
  let clock = now;
  let sequence = 0;
  const store = createAuthenticatedEspnCaptureReceiptStore({
    maxEntries: 2,
    ttlMs: 1_000,
    now: () => clock,
    randomReceipt: () => (++sequence).toString(16).padStart(32, "0"),
  });
  const input = baseArtifact();
  const digest = await authenticatedEspnCaptureDigest(input);
  const binding = receiptBinding(input, digest);
  const first = store.issue(binding);
  const second = store.issue({ ...binding, digest: `sha256:${"c".repeat(64)}` });
  store.issue({ ...binding, digest: `sha256:${"d".repeat(64)}` });
  assert.deepEqual(store.stats(), { entries: 2, maxEntries: 2, ttlMs: 1_000 });

  const proof = buildAuthenticatedEspnCaptureAttestation({
    capturedAt, league: input.league, espnPlayers: input.espnPlayers, request, digest, receipt: first.receipt,
  });
  assert.equal(store.consume(proof), false, "oldest receipt must be evicted at the global bound");
  const secondProof = { ...proof, digest: `sha256:${"c".repeat(64)}`, receipt: second.receipt };
  assert.equal(store.consume({ ...secondProof, digest: `sha256:${"e".repeat(64)}` }), false, "a recomputed digest without its receipt must fail");
  assert.equal(store.consume(secondProof), true);
  assert.equal(store.consume(secondProof), false, "a consumed receipt must never replay");

  const expiring = store.issue(binding);
  clock += 1_000;
  assert.equal(store.consume({ ...proof, receipt: expiring.receipt }), false);
  assert.equal(AUTHENTICATED_ESPN_CAPTURE_MAX_RECEIPTS, 8);
  assert.equal(AUTHENTICATED_ESPN_CAPTURE_RECEIPT_TTL_MS, 30 * 60_000);
});

test("CLI validates loopback origin and consumes the receipt through the same server", async () => {
  assert.equal(normalizeAuthenticatedEspnCaptureOrigin(), "http://127.0.0.1:3000");
  assert.equal(normalizeAuthenticatedEspnCaptureOrigin("http://localhost:3100"), "http://localhost:3100");
  for (const origin of ["https://127.0.0.1:3000", "http://example.com:3000", "http://127.0.0.1:3000/path", "http://user@127.0.0.1:3000"]) {
    assert.throws(() => normalizeAuthenticatedEspnCaptureOrigin(origin), /ESPN_CAPTURE_ORIGIN_INVALID/);
  }
  const input = await artifact();
  let requestedUrl = "";
  assert.equal(await consumeAuthenticatedEspnCaptureReceipt(input.authenticatedEspnCapture, {
    origin: "http://localhost:3100",
    fetchImpl: async (url, init) => {
      requestedUrl = url;
      assert.equal(JSON.parse(init.body).operation, "CONSUME_ESPN_CAPTURE_RECEIPT");
      return new Response(JSON.stringify({ ok: true, code: "ESPN_CAPTURE_RECEIPT_CONSUMED" }), { status: 200 });
    },
  }), true);
  assert.equal(requestedUrl, "http://localhost:3100/api/draft-day");
});

test("CLI consumes proof before provider I/O, rechecks freshness, and writes atomically", async () => {
  const source = await readFile(new URL("../scripts/capture-source-snapshot.mjs", import.meta.url), "utf8");
  const consumeAt = source.lastIndexOf("await consumeAuthenticatedEspnCaptureReceipt");
  const publicFetchAt = source.lastIndexOf("await fetchCapturedIntelligenceSnapshot");
  const currentAt = source.lastIndexOf("evaluateCurrentSourceSnapshot(snapshot");
  const temporaryWriteAt = source.lastIndexOf("writeFileSync(temporary");
  const renameAt = source.lastIndexOf("renameSync(temporary, output)");
  assert.ok(consumeAt > 0 && consumeAt < publicFetchAt);
  assert.ok(publicFetchAt < currentAt && currentAt < temporaryWriteAt && temporaryWriteAt < renameAt);
  assert.match(source, /SOURCE_SNAPSHOT_NOT_CURRENT_AFTER_FETCH/);
  assert.match(source, /SOURCE_SNAPSHOT_DIGEST_CHANGED_BEFORE_WRITE/);
});
