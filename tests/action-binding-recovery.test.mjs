import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  actionPayloadMatchesBinding,
  reboundMatchesActionBinding,
  restoredBindingMatchesEvidence,
  resultMatchesActionBinding,
  sanitizeActionBinding,
  tabRemovalInvalidatesActionBinding,
} from "../extension/action-binding.js";

const binding = Object.freeze({
  leagueId: "44050",
  teamId: 7,
  season: 2026,
  tabId: 41,
  appTabId: 17,
  commandCenterSessionId: "command-center-old",
});
const context = Object.freeze({
  leagueId: "44050",
  teamId: 7,
  season: 2026,
  tabId: 41,
  inDraftRoom: true,
});
const payload = Object.freeze({
  expectedLeagueId: "44050",
  expectedTeamId: 7,
  expectedSeason: 2026,
  expectedTabId: 41,
  commandCenterSessionId: "command-center-old",
  actionRequestId: 9001,
});
const appOrigins = ["http://127.0.0.1:3000", "http://localhost:3000"];

test("MV3 restart restores only a live exact binding with both authorized tabs", () => {
  const evidence = {
    appTabUrl: "http://127.0.0.1:3000/",
    espnTabUrl: "https://fantasy.espn.com/football/draft?leagueId=44050&teamId=7&seasonId=2026",
    context,
  };
  assert.deepEqual(sanitizeActionBinding(binding), binding);
  assert.equal(restoredBindingMatchesEvidence(binding, evidence, appOrigins), true);

  assert.equal(restoredBindingMatchesEvidence(binding, { ...evidence, appTabUrl: "https://attacker.example/" }, appOrigins), false);
  assert.equal(restoredBindingMatchesEvidence(binding, { ...evidence, espnTabUrl: "https://example.com/" }, appOrigins), false);
  assert.equal(restoredBindingMatchesEvidence(binding, { ...evidence, context: { ...context, teamId: 8 } }, appOrigins), false);
  assert.equal(restoredBindingMatchesEvidence(binding, { ...evidence, context: { ...context, inDraftRoom: false } }, appOrigins), false);
  assert.equal(restoredBindingMatchesEvidence({ ...binding, appTabId: 0 }, evidence, appOrigins), false);
  assert.equal(restoredBindingMatchesEvidence({ ...binding, commandCenterSessionId: 12345678 }, evidence, appOrigins), false);
});

test("exact tab rebound updates only the already-bound command center identity", () => {
  const rebound = { ...context, tabId: 99 };
  assert.equal(reboundMatchesActionBinding(binding, rebound, 17), true);
  assert.equal(reboundMatchesActionBinding(binding, rebound, 18), false);
  assert.equal(reboundMatchesActionBinding(binding, { ...rebound, leagueId: "999" }, 17), false);
  assert.equal(reboundMatchesActionBinding(binding, { ...rebound, teamId: 8 }, 17), false);
  assert.equal(reboundMatchesActionBinding(binding, { ...rebound, season: 2025 }, 17), false);
  assert.equal(reboundMatchesActionBinding(binding, { ...rebound, inDraftRoom: false }, 17), false);
});

test("commands and asynchronous results require exact binding and sender evidence", () => {
  assert.equal(actionPayloadMatchesBinding(binding, payload, context, 41), true);
  assert.equal(resultMatchesActionBinding(binding, payload, context, 41), true);
  assert.equal(resultMatchesActionBinding(binding, payload, context, 42), false);
  assert.equal(resultMatchesActionBinding(binding, { ...payload, expectedTabId: 42 }, context, 41), false);
  assert.equal(resultMatchesActionBinding(binding, { ...payload, expectedTeamId: 8 }, context, 41), false);
  assert.equal(resultMatchesActionBinding(binding, payload, { ...context, inDraftRoom: false }, 41), false);
  assert.equal(resultMatchesActionBinding(binding, {
    ...payload,
    commandCenterSessionId: "command-center-new",
    actionRequestId: payload.actionRequestId,
  }, context, 41), false, "a new page session cannot reuse the old page's request id");
});

test("removing either side of the two-tab binding revokes action authority", () => {
  assert.equal(tabRemovalInvalidatesActionBinding(binding, binding.appTabId), true);
  assert.equal(tabRemovalInvalidatesActionBinding(binding, binding.tabId), true);
  assert.equal(tabRemovalInvalidatesActionBinding(binding, 999), false);
  assert.equal(tabRemovalInvalidatesActionBinding(null, binding.tabId), false);
});

test("background persists restart state, re-registers result delivery, and clears failed watch claims", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /ACTION_BINDING_STORAGE_KEY = "draftForgeActionBindingV1"/);
  assert.match(source, /const actionBindingRestore = restoreActionBinding\(\)/);
  assert.match(source, /chrome\.tabs\.sendMessage\(stored\.tabId, \{ type: "DF_GET_CONTEXT" \}\)/);
  assert.match(source, /appTabs\.add\(stored\.appTabId\)/);
  assert.match(source, /if \(authorization\.senderKind === "app" && sender\.tab\?\.id\) appTabs\.add\(sender\.tab\.id\)/);
  assert.match(source, /resultMatchesActionBinding\(actionBinding, action, context, senderTabId\)/);
  assert.match(source, /await broadcastBoundActionResult\("DF_ACTION_RESOLVED"/);
  assert.match(source, /await broadcastBoundActionResult\("DF_ACTION_SUBMITTED"/);
  assert.match(source, /await broadcastBoundActionResult\("DF_ACTION_RESULT"/);
  assert.match(source, /chrome\.tabs\.sendMessage\(appTabId, \{ type, payload \}\)/);
  assert.match(source, /reboundMatchesActionBinding\(actionBinding, context, sender\.tab\?\.id\)/);
  assert.match(source, /await establishActionBinding\(\s*context,\s*actionBinding,\s*context\.tabId,\s*sender\.tab\.id,\s*message\.payload\.commandCenterSessionId/);
  assert.match(source, /watch\.processingTabId = null;\s+await persistLiveRoomWatch\(watch\)/);
  assert.match(source, /tabRemovalInvalidatesActionBinding\(actionBinding, tabId\)/);
  assert.match(source, /catch \{\s+actionBinding = null;\s+try \{ await persistActionBinding\(null\); \} catch/);
  assert.match(source, /validCommandCenterSessionId\(message\.payload\?\.commandCenterSessionId\)/);
  assert.match(source, /commandCenterSessionMatchesBinding\(message\.payload\)/);
});
