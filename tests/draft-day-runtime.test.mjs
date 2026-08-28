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
  LAB_BROWSER_RUNTIME_MODE,
} from "../scripts/draft-day-browser-runtime.mjs";
import { OPTIONS } from "../app/api/draft-day/route.ts";

const lab = { mode: LAB_BROWSER_RUNTIME_MODE, companionDisabled: true };

test("lab runtime reuses the companion context scanner but exposes no competing writer", async () => {
  await assert.rejects(() => buildDraftDayRuntimeExpression(), /REQUIRES_DISABLED_COMPANION/);
  const expression = await buildDraftDayRuntimeExpression(lab);
  assert.match(expression, /function getContext\(/);
  assert.match(expression, /async function executeAction\(/);
  assert.match(expression, /function preflightAction\(/);
  assert.match(expression, /globalThis\.__DRAFTFORGE_LAB_RUNTIME__/);
  assert.match(expression, /mode: "READ_ONLY_LAB"/);
  assert.match(expression, /LAB OBSERVER: never mutate ESPN sound/);
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
