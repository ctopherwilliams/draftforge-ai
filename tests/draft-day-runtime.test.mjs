import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildDraftDayDecisionExpression,
  buildDraftDayRuntimeExpression,
  buildExecuteDraftDayActionExpression,
  buildGuardedDraftLoopExpression,
  buildLeagueSpecificMockLaunchExpression,
  buildSourceWarmupExpression,
} from "../scripts/draft-day-browser-runtime.mjs";
import { OPTIONS } from "../app/api/draft-day/route.ts";

test("chat runtime reuses the companion's fail-closed context and action implementation", async () => {
  const expression = await buildDraftDayRuntimeExpression();
  assert.match(expression, /function getContext\(/);
  assert.match(expression, /async function executeAction\(/);
  assert.match(expression, /function preflightAction\(/);
  assert.match(expression, /globalThis\.__DRAFTFORGE_CHAT_RUNTIME__/);
  assert.match(expression, /contextObserver\.disconnect\(\)/);
});

test("cold-start expressions enforce warmup before one-tab league-specific launch", () => {
  const warmup = buildSourceWarmupExpression({ leagueId: "44050", teamId: 7, season: 2026 });
  const launch = buildLeagueSpecificMockLaunchExpression({ leagueId: "44050", draftPosition: 1 });
  const decision = buildDraftDayDecisionExpression({ strategy: "BALANCED" });
  const action = buildExecuteDraftDayActionExpression({ operation: "SELECT", playerId: 1 });
  assert.match(warmup, /operation: "WARM"/);
  assert.match(warmup, /sourceCoverage !== 5/);
  assert.match(launch, /api\.V/);
  assert.match(launch, /location\.assign\(url\)/);
  assert.match(decision, /operation: "DECIDE"/);
  assert.match(decision, /operation: "PREPARE"/);
  assert.match(decision, /__DRAFTFORGE_CHAT_SESSION__/);
  assert.match(decision, /__DRAFTFORGE_CHAT_DATA__/);
  assert.match(action, /executeAction/);
  const hostile = '";globalThis.__DRAFTFORGE_INJECTED__=true;//';
  assert.doesNotThrow(() => new Function(`return ${buildSourceWarmupExpression({ leagueId: hostile, teamId: 7, season: 2026 })}`));
  assert.doesNotThrow(() => new Function(`return ${buildLeagueSpecificMockLaunchExpression({ leagueId: hostile, draftPosition: 1 })}`));
  assert.doesNotThrow(() => new Function(`return ${buildDraftDayDecisionExpression({ strategy: hostile })}`));
  const loop = buildGuardedDraftLoopExpression({ strategy: "BALANCED", pollMs: 100 });
  assert.match(loop, /if \(!needsPrepare && !context\.onClock && !activeAuctionOffer\) return/);
  assert.match(loop, /disableAutopick/);
  assert.match(loop, /handledSignature/);
  assert.match(loop, /retriableActionCodes/);
  assert.match(loop, /"BID_CHANGED"/);
  assert.match(loop, /"BID_OUT_OF_SEQUENCE"/);
  assert.match(loop, /state\.retriableActions \+= 1/);
  assert.match(loop, /state\.failedActions \+= 1/);
  assert.match(loop, /stop\(result\.code \|\| "ACTION_FAILED"\)/);
  assert.match(loop, /walkedNomineeKey/);
  assert.match(loop, /decision\.code === "WALK_AWAY"/);
  assert.match(loop, /successfulActions/);
  assert.match(loop, /THREE_CONSECUTIVE_ERRORS/);
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
  const source = await readFile(new URL("../scripts/draft-day-warm.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(source, /\/api\/draft-day/);
  assert.match(source, /operation: "WARM"/);
  assert.match(source, /profile: \{ scoring, teams, season, qbs \}/);
  assert.match(source, /DASHBOARD_RUNTIME_NOT_READY/);
  assert.match(source, /_next\/static\/chunks/);
  assert.doesNotMatch(source, /\/api\/intelligence\?/);
  assert.match(packageJson.scripts.start, /--hostname 127\.0\.0\.1/);
});

test("the one-command doctor warms the exact ESPN quarterback profile", async () => {
  const source = await readFile(new URL("../scripts/draft-day-doctor.mjs", import.meta.url), "utf8");
  assert.match(source, /intelligenceQuarterbackMode\(expected\.lineupSlotCounts\)/);
  assert.match(source, /profile: \{ scoring: expected\.scoringLabel, teams: expected\.size, season: expected\.season, qbs \}/);
});
