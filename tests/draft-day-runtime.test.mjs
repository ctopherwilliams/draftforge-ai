import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildDraftDayDecisionExpression,
  buildDraftDayRuntimeExpression,
  buildExecuteDraftDayActionExpression,
  buildGuardedDraftLoopExpression,
  buildLeagueSpecificMockLaunchExpression,
  buildSourceWarmupExpression,
  LAB_BROWSER_RUNTIME_MODE,
} from "../scripts/draft-day-browser-runtime.mjs";
import {
  createDraftDaySourceSnapshotCoordinator,
  MAX_DRAFT_DAY_SOURCE_RESPONSE_BYTES,
  MAX_RETAINED_DRAFT_DAY_SOURCE_SNAPSHOTS,
  OPTIONS,
  POST,
} from "../app/api/draft-day/route.ts";

const lab = { mode: LAB_BROWSER_RUNTIME_MODE, companionDisabled: true };

test("lab runtime reuses the companion context scanner but exposes no competing writer", async () => {
  await assert.rejects(() => buildDraftDayRuntimeExpression(), /REQUIRES_DISABLED_COMPANION/);
  const expression = await buildDraftDayRuntimeExpression(lab);
  assert.match(expression, /function getContext\(/);
  assert.match(expression, /async function executeAction\(/);
  assert.match(expression, /function preflightAction\(/);
  assert.match(expression, /globalThis\.__DRAFTFORGE_LAB_RUNTIME__/);
  assert.match(expression, /mode: "READ_ONLY_LAB"/);
  assert.doesNotMatch(expression, /enforceMutedDraftSound\(context\);/);
  assert.doesNotMatch(expression, /__DRAFTFORGE_LAB_RUNTIME__ = Object\.freeze\(\{[\s\S]*executeAction,/);
  assert.doesNotMatch(expression, /__DRAFTFORGE_LAB_RUNTIME__ = Object\.freeze\(\{[\s\S]*disableAutopick,/);
  assert.match(expression, /contextObserver\.disconnect\(\)/);
});

test("cold-start expressions enforce warmup before one-tab league-specific launch", () => {
  const warmup = buildSourceWarmupExpression({ leagueId: "44050", teamId: 7, season: 2026, ...lab });
  const launch = buildLeagueSpecificMockLaunchExpression({ leagueId: "44050", draftPosition: 1, ...lab });
  const decision = buildDraftDayDecisionExpression({ strategy: "BALANCED", ...lab });
  assert.match(warmup, /operation: "WARM"/);
  assert.match(warmup, /sourceCoverage !== 5/);
  assert.match(launch, /api\.V/);
  assert.match(launch, /location\.assign\(url\)/);
  assert.match(decision, /operation: "DECIDE"/);
  assert.match(decision, /operation: "PREPARE"/);
  assert.match(decision, /__DRAFTFORGE_CHAT_SESSION__/);
  assert.match(decision, /__DRAFTFORGE_CHAT_DATA__/);
  assert.match(decision, /__DRAFTFORGE_LAB_RUNTIME__/);
  const hostile = '";globalThis.__DRAFTFORGE_INJECTED__=true;//';
  assert.doesNotThrow(() => new Function(`return ${buildSourceWarmupExpression({ leagueId: hostile, teamId: 7, season: 2026, ...lab })}`));
  assert.doesNotThrow(() => new Function(`return ${buildLeagueSpecificMockLaunchExpression({ leagueId: hostile, draftPosition: 1, ...lab })}`));
  assert.doesNotThrow(() => new Function(`return ${buildDraftDayDecisionExpression({ strategy: hostile, ...lab })}`));
  assert.throws(() => buildExecuteDraftDayActionExpression({ operation: "SELECT", playerId: 1 }), /ACTIONS_DISABLED_USE_COMPANION/);
  assert.throws(() => buildGuardedDraftLoopExpression(), /AUTOPILOT_DISABLED_USE_COMPANION/);
});

test("draft-day bridge permits only ESPN and loopback browser origins", async () => {
  const espn = await OPTIONS(new Request("http://127.0.0.1:3000/api/draft-day", {
    method: "OPTIONS",
    headers: { Origin: "https://fantasy.espn.com" },
  }));
  assert.equal(espn.status, 204);
  assert.equal(espn.headers.get("access-control-allow-origin"), "https://fantasy.espn.com");
  assert.equal(espn.headers.get("access-control-allow-private-network"), "true");

  const denied = await OPTIONS(new Request("http://127.0.0.1:3000/api/draft-day", {
    method: "OPTIONS",
    headers: { Origin: "https://example.com" },
  }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  const deniedLan = await OPTIONS(new Request("http://192.168.1.25:3000/api/draft-day", {
    method: "OPTIONS",
    headers: { Origin: "https://fantasy.espn.com" },
  }));
  assert.equal(deniedLan.status, 403);
});

test("terminal warmup targets the same draft-day route used for decisions", async () => {
  const scriptUrl = new URL("../scripts/draft-day-warm.mjs", import.meta.url);
  const source = await readFile(scriptUrl, "utf8");
  const startSource = await readFile(new URL("../scripts/start-production.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(source, /\/api\/draft-day/);
  assert.match(source, /operation: "WARM"/);
  assert.match(source, /profile: \{ scoring, teams, season, qbs \}/);
  assert.match(source, /DASHBOARD_RUNTIME_NOT_READY/);
  assert.match(source, /_next\/static\/chunks/);
  assert.match(source, /sourceSnapshotId/);
  assert.match(source, /isDraftDaySourceSnapshotId/);
  assert.match(source, /isDraftDaySourceSnapshotFresh/);
  assert.match(source, /SOURCE_SNAPSHOT_IDENTITY_INVALID/);
  assert.match(source, /SOURCE_SNAPSHOT_STALE/);
  assert.doesNotMatch(source, /snapshot\.sourceGeneratedAt \|\| snapshot\.generatedAt/);
  assert.doesNotMatch(source, /\/api\/intelligence\?/);
  const unknownArgument = spawnSync(process.execPath, [fileURLToPath(scriptUrl), "--league", "44050"], { encoding: "utf8" });
  assert.equal(unknownArgument.status, 2);
  assert.match(unknownArgument.stderr, /UNKNOWN_ARGUMENT/);
  assert.match(packageJson.scripts.start, /start-production\.mjs/);
  assert.match(startSource, /DRAFTFORGE_PERSIST_AVAILABILITY_STAGE:\s*"1"/);
  assert.match(startSource, /"--hostname",\s*"127\.0\.0\.1"/);
  assert.match(startSource, /"--port",\s*"3000"/);
});

test("the one-command doctor warms the exact ESPN quarterback profile", async () => {
  const source = await readFile(new URL("../scripts/draft-day-doctor.mjs", import.meta.url), "utf8");
  assert.match(source, /intelligenceQuarterbackMode\(expected\.lineupSlotCounts\)/);
  assert.match(source, /profile: \{ scoring: expected\.scoringLabel, teams: expected\.size, season: expected\.season, qbs \}/);
  assert.ok(source.indexOf("audit = await fetchActiveAudit()") < source.indexOf("expectedSourceSnapshotId,"));
  assert.match(source, /expectedSourceSnapshotId,[\s\S]*expectedSourceGeneratedAt,/);
  assert.match(source, /Re-read after the exact WARM/);
  assert.match(source, /sourceWarmSnapshotId/);
  assert.match(source, /sourceWarmSnapshotGeneratedAt/);
  assert.match(source, /sourceSnapshotIdentityMatch/);
});

test("dashboard retains the server source identity atomically and never synthesizes a fallback digest", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/draft-day/route.ts", import.meta.url), "utf8");
  assert.match(page, /type AcceptedIntelligenceSnapshot = Readonly<\{/);
  assert.match(page, /sources: IntelligenceSource\[\];[\s\S]*sourceSnapshotId: string;[\s\S]*sourceSnapshotGeneratedAt: string;/);
  assert.match(page, /acceptDraftDayWarmResponse\(await response\.json\(\), expectedProfile\)/);
  assert.match(page, /operation: "WARM",[\s\S]*includeSourceSnapshot: true/);
  assert.doesNotMatch(page, /fetch\(intelligenceUrl/);
  assert.match(page, /response\.scoring !== expected\.scoring/);
  assert.match(page, /Object\.entries\(EXPECTED_INTELLIGENCE_WEIGHTS\)/);
  assert.match(page, /isDraftAuditSourceSnapshotId\(response\.sourceSnapshotId\)/);
  assert.match(page, /isCanonicalDraftAuditUtcTimestamp\(response\.generatedAt\)/);
  assert.match(page, /deferredIntelligenceSnapshotRef/);
  assert.match(page, /INTELLIGENCE_REFRESH_MS = 4 \* 60 \* 1000 \+ 15 \* 1000/);
  assert.match(page, /INTELLIGENCE_REFRESH_TIMEOUT_MS/);
  assert.match(page, /filterFreshIntelligenceSources\(sources, sourceFreshnessEvaluatedAt\)/);
  assert.doesNotMatch(page, /sources\.filter\(isIntelligenceSourceFresh\)/);
  assert.doesNotMatch(page, /liveSourceSnapshotId|Math\.imul\(hash|sources-\$\{/);

  assert.match(route, /sourceSnapshotId: intelligence\.sourceSnapshotId/g);
  assert.match(route, /sourceSnapshotId: session\.sourceSnapshotId/);
  assert.match(route, /DRAFT_DAY_SOURCE_EXPECTATION_NOT_RETAINED/);
  assert.match(route, /Exact expectations are lookup-only/);
  assert.match(route, /sourceGeneratedAt/);
});

function retainedSnapshot(generatedAt, digestCharacter, profile = { scoring: "PPR", teams: 12, season: 2026, qbs: 1 }) {
  const weights = { ffc: .15, mfl: .15, tradyr: .20, gng: .20 };
  return {
    ...profile,
    generatedAt,
    sourceSnapshotId: `sha256:${digestCharacter.repeat(64)}`,
    sources: Object.entries(weights).map(([id, weight]) => ({
      id,
      name: id,
      kind: "market",
      weight,
      status: "ok",
      attribution: id,
      players: [{ name: `${id} player`, pos: "WR", rank: 1 }],
    })),
    methodology: {
      weights: { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 },
      method: "freshness-gated weighted percentile consensus",
    },
  };
}

test("source snapshot retention is globally bounded, exact, LRU, and expires deterministically", () => {
  let now = Date.parse("2026-08-28T01:00:00.000Z");
  const profile = { scoring: "PPR", teams: 12, season: 2026, qbs: 1 };
  const coordinator = createDraftDaySourceSnapshotCoordinator({ maxEntries: 2, now: () => now });
  const first = retainedSnapshot("2026-08-28T01:00:00.000Z", "a");
  const second = retainedSnapshot("2026-08-28T01:00:01.000Z", "b");
  const third = retainedSnapshot("2026-08-28T01:00:02.000Z", "c");

  assert.equal(coordinator.retain(profile, first), true);
  assert.equal(coordinator.retain(profile, second), true);
  assert.strictEqual(coordinator.exact(profile, first.sourceSnapshotId, first.generatedAt), first);
  assert.equal(coordinator.retain(profile, third), true);
  assert.equal(coordinator.stats().entries, 2);
  assert.equal(coordinator.stats().maxEntries, 2);
  assert.equal(coordinator.exact(profile, second.sourceSnapshotId, second.generatedAt), null, "least-recent exact snapshot must be evicted");
  assert.strictEqual(coordinator.exact(profile, first.sourceSnapshotId, first.generatedAt), first);
  assert.equal(coordinator.exact(profile, third.sourceSnapshotId, first.generatedAt), null, "id and generation time are one exact tuple");
  assert.equal(coordinator.exact({ ...profile, teams: 10 }, first.sourceSnapshotId, first.generatedAt), null, "profile identity is part of the tuple");

  now += 10 * 60_000 + 3_001;
  assert.equal(coordinator.exact(profile, first.sourceSnapshotId, first.generatedAt), null);
  assert.deepEqual(coordinator.stats(), { entries: 0, maxEntries: 2 });
  const fresh = retainedSnapshot(new Date(now).toISOString(), "d");
  assert.equal(coordinator.retain(profile, { ...fresh, sourceSnapshotId: "sha256:not-a-digest" }), false);
  assert.equal(coordinator.retain(profile, { ...fresh, sources: fresh.sources.slice(1) }), false);
  assert.equal(MAX_RETAINED_DRAFT_DAY_SOURCE_SNAPSHOTS, 8);
  assert.equal(MAX_DRAFT_DAY_SOURCE_RESPONSE_BYTES, 8 * 1024 * 1024);
});

test("profile WARM rejects invalid or unavailable exact expectations without fetching a substitute", async () => {
  const profile = { scoring: "PPR", teams: 12, season: 2026, qbs: 1 };
  const request = (body) => new Request("http://127.0.0.1:3000/api/draft-day", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const malformed = await POST(request({
    operation: "WARM",
    profile,
    expectedSourceSnapshotId: "sha256:not-a-digest",
    expectedSourceGeneratedAt: "2026-08-28T01:00:00.000Z",
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "DRAFT_DAY_SOURCE_EXPECTATION_INVALID");

  const partial = await POST(request({
    operation: "WARM",
    profile,
    expectedSourceSnapshotId: `sha256:${"e".repeat(64)}`,
  }));
  assert.equal(partial.status, 400);
  assert.equal((await partial.json()).code, "DRAFT_DAY_SOURCE_EXPECTATION_INVALID");

  const invalidMode = await POST(request({
    operation: "WARM",
    profile,
    includeSourceSnapshot: "yes",
  }));
  assert.equal(invalidMode.status, 400);
  assert.equal((await invalidMode.json()).code, "DRAFT_DAY_SOURCE_RESPONSE_MODE_INVALID");

  const missing = await POST(request({
    operation: "WARM",
    profile,
    expectedSourceSnapshotId: `sha256:${"f".repeat(64)}`,
    expectedSourceGeneratedAt: "2026-08-28T01:00:00.000Z",
  }));
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).code, "DRAFT_DAY_SOURCE_EXPECTATION_NOT_RETAINED");
});
