import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  actionAvailabilityDeadlineStatus,
  actionDeadlineStatus,
  actionPayloadMatchesBinding,
  reboundMatchesActionBinding,
  restoredBindingMatchesEvidence,
  resultMatchesActionBinding,
  sanitizeActionBinding,
  tabRemovalInvalidatesActionBinding,
} from "../extension/action-binding.js";
import { createLiveRoomHandoffCoordinator } from "../extension/live-room-watch.js";

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
  assert.equal(restoredBindingMatchesEvidence(binding, { ...evidence, appTabUrl: "https://draftforge-ai.workspace-231977.chatgpt.site/" }, appOrigins), false);
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

test("an action carries one bounded absolute click deadline across MV3 delivery", () => {
  assert.equal(actionDeadlineStatus({ notAfter: 15_000 }, 10_000), "ACTION_DEADLINE_VALID");
  assert.equal(actionDeadlineStatus({}, 10_000), "ACTION_DEADLINE_INVALID");
  assert.equal(actionDeadlineStatus({ notAfter: 10_000 }, 10_000), "ACTION_EXPIRED");
  assert.equal(actionDeadlineStatus({ notAfter: 20_001 }, 10_000), "ACTION_DEADLINE_INVALID");
});

test("an action cannot outlive or reach the availability-veto expiry", () => {
  const payload = { notAfter: 14_000, availabilityNotAfter: 15_000 };
  assert.equal(actionAvailabilityDeadlineStatus(payload, 10_000), "AVAILABILITY_DEADLINE_VALID");
  assert.equal(actionAvailabilityDeadlineStatus({ notAfter: 15_001, availabilityNotAfter: 15_000 }, 10_000), "ACTION_AFTER_AVAILABILITY");
  assert.equal(actionAvailabilityDeadlineStatus({ notAfter: 14_000 }, 10_000), "AVAILABILITY_DEADLINE_INVALID");
  assert.equal(actionAvailabilityDeadlineStatus(payload, 15_000), "AVAILABILITY_EXPIRED");
  assert.equal(actionAvailabilityDeadlineStatus(payload, 15_001), "AVAILABILITY_EXPIRED");
});

test("removing either side of the two-tab binding revokes action authority", () => {
  assert.equal(tabRemovalInvalidatesActionBinding(binding, binding.appTabId), true);
  assert.equal(tabRemovalInvalidatesActionBinding(binding, binding.tabId), true);
  assert.equal(tabRemovalInvalidatesActionBinding(binding, 999), false);
  assert.equal(tabRemovalInvalidatesActionBinding(null, binding.tabId), false);
});

test("overlapping room-open contexts join one exact handoff", async () => {
  const coordinator = createLiveRoomHandoffCoordinator();
  const watch = { sourceLeagueId: "44050", armedAt: 1234 };
  let importCount = 0;
  let release;
  const operation = () => {
    importCount += 1;
    return new Promise((resolve) => { release = resolve; });
  };
  const first = coordinator.run(watch, operation);
  const second = coordinator.run(watch, operation);
  const unrelated = coordinator.run({ ...watch }, operation);
  await Promise.resolve();
  assert.equal(importCount, 1, "only one import/bind/broadcast transaction may start");
  assert.equal(await unrelated, null, "a different watch cannot join the active claim");
  release({ recovered: true });
  assert.deepEqual(await Promise.all([first, second]), [{ recovered: true }, { recovered: true }]);
  assert.equal(coordinator.active(), false);
});

test("background persists restart state, re-registers result delivery, and clears failed watch claims", async () => {
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /ACTION_BINDING_STORAGE_KEY = "draftForgeActionBindingV1"/);
  assert.match(source, /const actionBindingRestore = restoreActionBinding\(\)/);
  assert.match(source, /chrome\.tabs\.sendMessage\(stored\.tabId, \{ type: "DF_GET_CONTEXT" \}\)/);
  assert.match(source, /appTabs\.add\(stored\.appTabId\)/);
  assert.match(source, /if \(\["app", "app-observer"\]\.includes\(authorization\.senderKind\) && sender\.tab\?\.id\) appTabs\.add\(sender\.tab\.id\)/);
  assert.match(source, /resultMatchesActionBinding\(actionBinding, action, context, senderTabId\)/);
  assert.match(source, /await broadcastBoundActionResult\("DF_ACTION_RESOLVED"/);
  assert.match(source, /await broadcastBoundActionResult\("DF_ACTION_SUBMITTED"/);
  assert.match(source, /await broadcastBoundActionResult\("DF_ACTION_RESULT"/);
  assert.match(source, /return sendBoundedAppMessage\(appTabId, type, payload\)/);
  assert.match(source, /reboundMatchesActionBinding\(actionBinding, context, sender\.tab\?\.id\)/);
  assert.match(source, /await establishActionBinding\(\s*context,\s*actionBinding,\s*context\.tabId,\s*sender\.tab\.id,\s*message\.payload\.commandCenterSessionId/);
  assert.match(source, /watch\.processingTabId = null;\s+await persistLiveRoomWatch\(watch\)/);
  assert.match(source, /tabRemovalInvalidatesActionBinding\(actionBinding, tabId\)/);
  assert.match(source, /catch \{\s+actionBinding = null;\s+try \{ await persistActionBinding\(null\); \} catch/);
  assert.match(source, /validCommandCenterSessionId\(message\.payload\?\.commandCenterSessionId\)/);
  assert.match(source, /commandCenterSessionMatchesBinding\(message\.payload\)/);
  assert.match(source, /actionDeadlineStatus\(message\.payload\)/);
  assert.match(source, /actionDeadlineStatus\(exactAction\)/);
  assert.match(source, /actionAvailabilityDeadlineStatus\(message\.payload\)/);
  assert.match(source, /actionAvailabilityDeadlineStatus\(exactAction\)/);
  assert.match(source, /WORKSPACE_WRITER_STORAGE_KEY = "draftForgeWorkspaceWriterV1"/);
  assert.match(source, /workspaceMessageAuthorization\(sender\.tab\?\.id, message\.type\)/);
  assert.match(source, /APP_BROADCAST_TIMEOUT_MS = 250/);
  assert.match(source, /await sendBoundedAppMessage\(writerTabId, type, payload\)/);
  assert.match(source, /Promise\.allSettled\(observers\.map/);
  assert.match(source, /workspaceWriterMutationTail\.then\(async \(\) => \{\s+await Promise\.all\(\[actionBindingRestore, liveRoomWatchRestore, workspaceWriterRestore\]\)/);
  const workspaceLifecycle = await readFile(new URL("../extension/workspace-lifecycle.js", import.meta.url), "utf8");
  assert.match(workspaceLifecycle, /WORKSPACE_OBSERVER_READ_ONLY/);
  assert.match(source, /authorization\.senderKind === "app"\s*\? await reconcileWorkspaceHello\(sender\.tab\?\.id\)/);
  assert.match(source, /protectedWriterTabId = resolveWorkspaceWriterTabId/);
  assert.match(source, /electNewest: !Number\.isInteger\(protectedWriterTabId\)/);
  assert.match(source, /cleanupTabIds\.includes\(exactSenderTabId\)/);
  assert.match(source, /code: "WORKSPACE_REMOTE_OBSERVER",\s*role: "observer"/);
});
