import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import {
  actionPayloadMatchesBinding,
  reboundMatchesActionBinding,
  validCommandCenterSessionId,
  validProducerSessionId,
} from "../extension/action-binding.js";
import { authorizeRuntimeMessage } from "../extension/origin-policy.js";
import {
  computeExtensionDirectoryIntegrity,
  computeExtensionZipIntegrity,
} from "../scripts/release-integrity-lib.mjs";

const root = new URL("../extension/", import.meta.url);

test("extension is a narrowly scoped Manifest V3 ESPN companion", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  const release = JSON.parse(await readFile(new URL("../config/draft-day-release.json", import.meta.url), "utf8"));
  const companionZip = await readFile(new URL("../public/draftforge-espn-companion.zip", import.meta.url));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(release.schemaVersion, 2);
  assert.match(release.extensionSourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(release.extensionSourceFileCount, 19);
  assert.deepEqual([...manifest.permissions].sort(), ["storage", "tabs"]);
  assert.equal(manifest.version, release.extensionVersion);
  assert.equal(createHash("sha256").update(companionZip).digest("hex"), release.extensionPackageSha256);
  const packaged = computeExtensionZipIntegrity(fileURLToPath(new URL("../public/draftforge-espn-companion.zip", import.meta.url)));
  assert.equal(packaged.sha256, release.extensionSourceSha256);
  assert.equal(packaged.fileCount, release.extensionSourceFileCount);
  assert.deepEqual(manifest.host_permissions, [
    "http://127.0.0.1:3000/*",
    "https://fantasy.espn.com/*",
    "https://lm-api-reads.fantasy.espn.com/*",
  ]);
  assert.ok(manifest.content_scripts.some((script) => script.matches.includes("https://fantasy.espn.com/*")));
  const appMatches = manifest.content_scripts.find((script) => script.js.includes("app-bridge.js")).matches;
  assert.deepEqual(appMatches, [
    "http://localhost:3000/*",
    "http://127.0.0.1:3000/*",
    "https://draftforge-ai.workspace-231977.chatgpt.site/*",
  ]);
});

test("installed companion diagnostics hash the complete extension source tree", async () => {
  const background = await readFile(new URL("background.js", root), "utf8");
  const block = background.match(/const EXTENSION_SOURCE_FILES = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || "";
  const declared = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  const actual = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(declared, actual);
  assert.match(background, /draftforge-extension-tree-v1/);
  assert.match(background, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(background, /extensionSourceSha256: extensionIntegrity\.sha256/);
  assert.match(background, /extensionSourceFileCount: extensionIntegrity\.fileCount/);

  const runtimeSource = background.match(/const EXTENSION_INTEGRITY_DOMAIN[\s\S]+?(?=\nconst installedExtensionIntegrityPromise)/)?.[0];
  assert.ok(runtimeSource);
  const sandbox = {
    chrome: { runtime: { getURL: (path) => new URL(path, root).href } },
    crypto: webcrypto,
    fetch: async (url) => new Response(await readFile(new URL(url)), { status: 200 }),
    TextEncoder,
    Uint8Array,
  };
  vm.runInNewContext(`${runtimeSource}\nglobalThis.computeInstalled = computeInstalledExtensionIntegrity;`, sandbox);
  const installed = await sandbox.computeInstalled();
  const directory = computeExtensionDirectoryIntegrity(fileURLToPath(root));
  assert.equal(installed.sha256, directory.sha256);
  assert.equal(installed.fileCount, directory.fileCount);
});

test("privileged runtime messages require the exact DraftForge or ESPN sender origin", () => {
  const production = "https://draftforge-ai.workspace-231977.chatgpt.site/draft";
  const localhost = "http://localhost:3000/?reloadCompanion=1";
  const espn = "https://fantasy.espn.com/football/draft?leagueId=44050";
  assert.equal(authorizeRuntimeMessage("APP_HELLO", production).ok, true);
  assert.equal(authorizeRuntimeMessage("APP_HELLO", production).senderKind, "app-observer");
  assert.equal(authorizeRuntimeMessage("GET_RUNTIME_DIAGNOSTICS", production).ok, true);
  assert.equal(authorizeRuntimeMessage("RELOAD_EXTENSION", localhost).ok, true);
  assert.equal(authorizeRuntimeMessage("CLOSE_PRACTICE_ROOM", localhost).ok, true);
  assert.equal(authorizeRuntimeMessage("RECOVER_LIVE_WORKSPACE", localhost).ok, true);
  assert.equal(authorizeRuntimeMessage("ARM_LIVE_ROOM_WATCH", localhost).ok, true);
  assert.equal(authorizeRuntimeMessage("SUBMIT_ACTION", espn).ok, false);
  assert.equal(authorizeRuntimeMessage("ESPN_CONTEXT", espn).ok, true);
  assert.equal(authorizeRuntimeMessage("ESPN_CONTEXT", production).ok, false);
  assert.equal(authorizeRuntimeMessage("CONNECT_ESPN", "https://attacker.chatgpt.site/").ok, false);
  assert.equal(authorizeRuntimeMessage("SUBMIT_ACTION", "https://attacker.openai.site/").ok, false);
  assert.equal(authorizeRuntimeMessage("DISABLE_ESPN_AUTOPICK", "https://attacker.sites.openai.com/").ok, false);
  assert.equal(authorizeRuntimeMessage("SUBMIT_ACTION", "http://localhost:3000.attacker.example/").ok, false);
  assert.equal(authorizeRuntimeMessage("SUBMIT_ACTION", "not a URL").ok, false);
  assert.equal(authorizeRuntimeMessage("FUTURE_UNCLASSIFIED_ACTION", production).code, "UNKNOWN_MESSAGE");
  for (const type of [
    "RELOAD_EXTENSION",
    "ARM_LIVE_ROOM_WATCH",
    "CLOSE_PRACTICE_ROOM",
    "CLEAN_LOCAL_WORKSPACE",
    "RECOVER_LIVE_WORKSPACE",
    "REFRESH_ESPN_CONTEXT",
    "CONNECT_ESPN",
    "CANCEL_PENDING_ACTIONS",
    "SUBMIT_ACTION",
    "DISABLE_ESPN_AUTOPICK",
  ]) {
    assert.deepEqual(authorizeRuntimeMessage(type, production), {
      ok: false,
      code: "APP_WRITER_ORIGIN_REQUIRED",
    }, `${type} must remain loopback-writer-only`);
  }
});

test("bound draft actions require the exact tab, league, team, season, and ESPN producer document", async () => {
  const background = await readFile(new URL("background.js", root), "utf8");
  const bindHelper = background.match(/function proposedDraftActionBinding[\s\S]+?\n\}/)?.[0];
  const matchHelper = background.match(/function actionMatchesBinding[\s\S]+?\n\}/)?.[0];
  const helpers = bindHelper && matchHelper ? `${bindHelper}\n${matchHelper}` : "";
  assert.ok(helpers, "background should expose the pure action-binding helpers");
  const sandbox = { actionPayloadMatchesBinding, validCommandCenterSessionId, validProducerSessionId };
  vm.runInNewContext(`let actionBinding = null;\n${helpers}\nglobalThis.bind = (...args) => { actionBinding = proposedDraftActionBinding(...args); return actionBinding; }; globalThis.matches = actionMatchesBinding;`, sandbox);
  const bound = sandbox.bind(
    {
      leagueId: "701",
      teamId: 5,
      season: 2026,
      tabId: 41,
      producerSessionId: "espn-producer-document-a",
    },
    { id: "701", teamId: 5, season: 2026 },
    41,
    17,
    "command-center-test",
    "command-document-test",
  );
  assert.deepEqual({ ...bound }, {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: 41,
    appTabId: 17,
    producerSessionId: "espn-producer-document-a",
    commandCenterSessionId: "command-center-test",
    commandCenterDocumentId: "command-document-test",
  });
  const payload = {
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
    expectedProducerSessionId: "espn-producer-document-a",
    commandCenterSessionId: "command-center-test",
    commandCenterDocumentId: "command-document-test",
  };
  const context = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: 41,
    producerSessionId: "espn-producer-document-a",
    inDraftRoom: true,
  };

  assert.equal(sandbox.matches(payload, context, 41), true);
  assert.equal(sandbox.matches({ ...payload, expectedTeamId: 6 }, context, 41), false);
  assert.equal(sandbox.matches({ ...payload, expectedSeason: 2025 }, context, 41), false);
  assert.equal(sandbox.matches({ ...payload, expectedProducerSessionId: "espn-producer-document-b" }, context, 41), false);
  assert.equal(sandbox.matches({ ...payload, expectedProducerSessionId: undefined }, context, 41), false);
  assert.equal(sandbox.matches({ ...payload, commandCenterDocumentId: "command-document-other" }, context, 41), false);
  assert.equal(sandbox.matches(payload, { ...context, leagueId: "702" }, 41), false);
  assert.equal(sandbox.matches(payload, { ...context, tabId: 42 }, 41), false);
  assert.equal(sandbox.matches(payload, { ...context, producerSessionId: "espn-producer-document-b" }, 41), false);
  assert.equal(sandbox.matches(payload, { ...context, producerSessionId: undefined }, 41), false);
  assert.equal(sandbox.bind(
    { ...context, producerSessionId: "invalid producer session" },
    { id: "701", teamId: 5, season: 2026 },
    41,
    17,
    "command-center-test",
    "command-document-test",
  ), null, "an unsequenced or malformed ESPN document cannot acquire action authority");
});

test("producer identity is required while an exact rebound can adopt a new verified ESPN document", () => {
  assert.equal(validProducerSessionId("e7e61115-02a3-44ca-a04e-e8b4c647942f"), true);
  assert.equal(validProducerSessionId("producer-1770000000000-a1b2c3"), true);
  assert.equal(validProducerSessionId(""), false);
  assert.equal(validProducerSessionId("invalid producer"), false);
  assert.equal(validProducerSessionId("p".repeat(129)), false);

  const binding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: 41,
    appTabId: 17,
    producerSessionId: "espn-producer-document-a",
    commandCenterSessionId: "command-center-test",
    commandCenterDocumentId: "command-document-test",
  };
  const rebound = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: 42,
    producerSessionId: "espn-producer-document-b",
    inDraftRoom: true,
  };
  assert.equal(reboundMatchesActionBinding(binding, rebound, 17), true);
  assert.equal(reboundMatchesActionBinding(binding, { ...rebound, producerSessionId: binding.producerSessionId }, 17), false);
  assert.equal(reboundMatchesActionBinding(binding, { ...rebound, producerSessionId: "" }, 17), false);
  assert.equal(reboundMatchesActionBinding(binding, { ...rebound, producerSessionId: "invalid producer" }, 17), false);
  assert.equal(reboundMatchesActionBinding(binding, rebound, 18), false);
});

test("draft actions fail closed and private ESPN credentials are not persisted", async () => {
  const [background, content, bridge, page, workspaceLifecycle] = await Promise.all([
    readFile(new URL("background.js", root), "utf8"),
    readFile(new URL("espn-content.js", root), "utf8"),
    readFile(new URL("app-bridge.js", root), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("workspace-lifecycle.js", root), "utf8"),
  ]);
  assert.match(background, /chrome\.storage\.session/);
  assert.match(background, /LIVE_ROOM_WATCH_STORAGE_KEY/);
  assert.match(background, /sanitizeLiveRoomWatchForStorage/);
  assert.match(background, /persistLiveRoomWatch/);
  assert.match(background, /restoreLiveRoomWatch/);
  assert.match(background, /validStoredLiveRoomWatch\(stored, \{\s+commandCenterSessionIdIsValid: validCommandCenterSessionId/);
  assert.doesNotMatch(background, /espn_s2|SWID|memberId|cookie/i);
  assert.match(background, /authorizeRuntimeMessage\(message\?\.type, sender\.url \|\| sender\.tab\?\.url \|\| ""\)/);
  assert.doesNotMatch(content, /espn_s2|SWID/);
  assert.match(background, /findEspnContext\(expectedLeagueId, expectedTabId\)/);
  assert.match(background, /selectUniqueEspnContext\(contexts, expectedLeagueId\)/);
  assert.match(background, /CONNECT_CONTEXT_TIMEOUT_MS = 4000/);
  assert.match(background, /waitForEspnContext\(requestedLeagueId\)/);
  assert.match(background, /DRAFT_TAB_REQUIRED/);
  assert.match(background, /DRAFT_TAB_CHANGED/);
  assert.match(background, /function actionMatchesBinding\(payload, context, expectedTabId\)/);
  assert.match(background, /DRAFT_ACTION_IDENTITY_CHANGED/);
  assert.match(background, /expectedTeamId: actionBinding\.teamId/);
  assert.match(background, /expectedSeason: actionBinding\.season/);
  assert.match(background, /chrome\.tabs\.get\(expectedTabId\)/);
  assert.match(background, /findUniqueDraftRoomContext/);
  assert.match(background, /matches\.length === 1/);
  assert.match(background, /createPollCoordinator/);
  assert.match(background, /runtimeDiagnostics/);
  assert.match(bridge, /commandCenterDocumentId: payload\.commandCenterDocumentId/);
  assert.match(page, /commandCenterDocumentId: COMMAND_CENTER_PUBLISHER\.documentId/);
  assert.match(background, /browserTabCount/);
  assert.match(background, /draftForgeTabCount/);
  assert.match(background, /espnTabCount/);
  assert.match(background, /managedCleanupReady: true/);
  const firstAuctionLease = background.indexOf("const serverLease = await verifyServerDispatchLease(action)");
  const durableAuctionWrite = background.indexOf("await writeAuctionUncertainties(records)", firstAuctionLease);
  const finalAuctionLease = background.indexOf("const finalServerLease = await verifyServerDispatchLease(action)", durableAuctionWrite);
  assert.ok(firstAuctionLease >= 0 && durableAuctionWrite > firstAuctionLease && finalAuctionLease > durableAuctionWrite,
    "durable auction ARM must verify the server lease both before persistence and after storage readback");
  assert.match(background, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(background, /keepLiveRoomVisible/);
  assert.match(background, /chrome\.windows\.create\(\{ tabId: roomTabId, focused: false, type: "normal" \}\)/);
  assert.match(background, /PRACTICE_CLOSE_VERIFICATION_FAILED/);
  assert.match(background, /PRACTICE_CLOSE_IDENTITY_MISMATCH/);
  assert.match(background, /PRACTICE_ROOM_CLOSED_AFTER_AUDIT/);
  assert.match(background, /if \(exactCompletedAudit\)/);
  assert.match(workspaceLifecycle, /Number\(proof\?\.tabId\) === Number\(roomTabId\)/);
  assert.match(workspaceLifecycle, /url\.href === "about:blank"/);
  assert.match(background, /CLEAN_LOCAL_WORKSPACE/);
  assert.match(workspaceLifecycle, /LOCAL_WORKSPACE_CLEAN/);
  assert.match(background, /selectManagedWorkspaceCleanup/);
  assert.match(background, /authorization\.senderKind === "app"\s*\? await reconcileWorkspaceHello\(sender\.tab\?\.id\)/);
  assert.match(background, /authorizeWorkspaceMessage/);
  assert.match(workspaceLifecycle, /WORKSPACE_OBSERVER_READ_ONLY/);
  assert.match(background, /completedAuditProvesPracticeRoom/);
  assert.match(background, /practiceWorkspaceCleanupTabIds/);
  assert.match(background, /recoverExactDraftRoomContext\(\{/);
  assert.match(background, /data\.workspaceRecovery/);
  assert.match(background, /startsWith\("Practice Draft for "\)/);
  assert.match(background, /ESPN_HEARTBEAT/);
  assert.match(background, /ESPN_ACTION_RESOLVED/);
  assert.match(background, /ESPN_ACTION_SUBMITTED/);
  assert.match(background, /resultMatchesActionBinding\(actionBinding, action, context, senderTabId\)/);
  assert.match(background, /DF_ACTION_RESOLVED/);
  assert.match(background, /DISABLE_ESPN_AUTOPICK/);
  assert.match(background, /DF_DISABLE_AUTOPICK/);
  assert.match(content, /MIN_ACTION_WINDOW_SECONDS = 5/);
  assert.match(content, /AUTOPICK_ACTIVE/);
  assert.doesNotMatch(content, /SOUND_NOT_MUTED/);
  assert.match(content, /const season = Number\(url\.searchParams\.get\("seasonId"\)/);
  assert.match(content, /autopickActive/);
  assert.match(content, /snakeClockOwnMarker/);
  assert.match(content, /snakeClockSource/);
  assert.match(content, /function disableEspnAutopick/);
  assert.match(content, /\.pick-queue__header \.autoPick-toggle/);
  assert.match(content, /SELECT_ACTION_BUDGET_MS = 4500/);
  assert.match(content, /NOMINATION_CONFIRMATION_WINDOW_MS = 4000/);
  assert.match(content, /MAX_MANDATORY_SEARCH_CANDIDATES = 18/);
  assert.match(content, /AUCTION_SETTLEMENT_DEADLINE_MS = 5000/);
  assert.match(content, /MANDATORY_CANDIDATE_SEARCH_WINDOW_MS = 120/);
  assert.match(content, /MANDATORY_POSITION_FILTER_WINDOW_MS = 1800/);
  assert.match(content, /function buildMandatoryPositionPlan\(candidates\)/);
  assert.match(content, /function availableSnakeCandidates\(candidates, context\)/);
  assert.match(content, /availableSnakeCandidates\(requestedCandidates, context\)/);
  assert.match(content, /setNativeSelectValue\(positionFilter, mandatoryPositionPlan\.slotId\)/);
  assert.match(content, /!visibleCandidate && !usedPositionFilter && playerSearch instanceof HTMLInputElement/);
  assert.match(content, /const rehydrateDeadline = Math\.min/);
  assert.match(content, /candidates\s*\.find\(\(candidate\) => visiblePlayerControl/);
  assert.match(content, /setNativeSelectValue\(usedPositionFilter, "-1"\)/);
  assert.match(content, /sendToCompanion\(\{ type: "ESPN_ACTION_RESOLVED", payload: resolvedAction \}\)/);
  assert.match(content, /sendToCompanion\(\{ type: "ESPN_ACTION_SUBMITTED"/);
  assert.match(content, /WRONG_LEAGUE/);
  assert.match(content, /NOMINEE_MISMATCH/);
  assert.match(content, /BID_CHANGED/);
  assert.match(content, /HOLD_LEADING_BID/);
  assert.match(content, /WALK_AWAY/);
  assert.match(content, /BID_ACK_UNCERTAIN/);
  assert.match(content, /ACTION_EXPIRED/);
  assert.match(content, /actionDeadlineFailure\(action\)/);
  assert.match(content, /NOMINATION_ACK_UNCERTAIN/);
  assert.match(content, /actionExecutionTail/);
  assert.match(content, /inFlightActionResults/);
  assert.match(content, /expectedTeamId/);
  assert.match(content, /expectedSeason/);
  assert.match(content, /BUDGET_RESERVE/);
  assert.match(content, /#icon__controls__volume_mute/);
  assert.doesNotMatch(content, /function enforceMutedDraftSound\(context\)/);
  assert.doesNotMatch(content, /enforceMutedDraftSound\(context\);/);
  assert.match(content, /new MutationObserver\(/);
  assert.match(content, /CONTEXT_WATCHDOG_MS = 2000/);
  assert.doesNotMatch(content, /ESPN_POLL/);
  assert.doesNotMatch(content, /}, 250\);/);
  assert.doesNotMatch(content, /return executeAction\(/);
  assert.match(bridge, /function announceReady\(\)/);
  assert.match(bridge, /event\.data\.type === "APP_HELLO"/);
  assert.match(bridge, /commandType: event\.data\.type/);
  assert.match(page, /sendToExtension\("APP_HELLO", \{ commandCenterSessionId: COMMAND_CENTER_PUBLISHER\.sessionId \}\)/);
  assert.match(page, /workspaceRoleRef\.current !== "writer"/);
  assert.match(page, /if \(workspaceRole !== "writer"\) return;/);
  assert.match(page, /Read-only observer: this tab cannot submit picks, nominations, or bids/);
  assert.match(page, /draftRuntimeWorkspaceReady\(runtimeDiagnostics\)/);
  assert.match(page, /Auto-Draft disarmed: the managed Chrome workspace is no longer exactly one DraftForge tab and one ESPN tab/);
  assert.match(page, /sendToExtension\("CLOSE_PRACTICE_ROOM"/);
  assert.match(page, /resolvePracticeRoomCleanupRequest/);
  assert.match(page, /sendToExtension\("ARM_LIVE_ROOM_WATCH"/);
  assert.match(page, /sourceTabId: context\.tabId/);
  assert.match(page, /autoArmRequested: true/);
  assert.match(page, /pendingLiveRoomAutoArmRef/);
  assert.match(background, /reusedAuthenticatedPlayerPool/);
  assert.match(background, /Broadcast the verified room first/);
  assert.match(background, /const exactSourceTabId = Number\.isInteger\(requestedSourceTabId\)/);
  assert.match(background, /Number\(espnContext\?\.tabId\)/);
  assert.match(background, /waitForEspnContext\(\s*requestedLeagueId,\s*exactSourceTabId/);
  assert.match(page, /LIVE_ROOM_WATCH_ARMED/);
  assert.match(page, /expectedCurrentBid: resolvedOperation === "BID"/);
  assert.match(page, /maxApprovedBid: resolvedOperation === "BID"/);
  assert.match(page, /notAfter/);
  assert.match(page, /fillsMandatoryStarter: player\.fillsMandatoryStarter/);
  assert.match(page, /ACTION_CANDIDATE_LIMIT = 64/);
  assert.match(page, /position: player\.pos/);
  assert.match(page, /const RETRIABLE_BID_CODES = new Set/);
  assert.match(page, /"AUCTION_SETTLEMENT_PENDING"/);
  assert.match(page, /RETRIABLE_NOMINATION_CODES = new Set\(\["NOT_ON_CLOCK", "CLOCK_TOO_SHORT", "NOMINATION_ACTIVE"\]\)/);
  assert.match(page, /nominated \|\| context\.nominatedPlayer \|\| Number\(context\.currentBid \|\| 0\) > 0/);
  assert.match(content, /code: "NOMINATION_ACTIVE"/);
  assert.match(page, /if \(!payload\.ok\) setAutoDraft\(false\)/);
  assert.match(page, /actionRequestId !== latestActionRequestRef\.current/);
  assert.match(page, /type === "DF_ACTION_RESOLVED"/);
  assert.match(page, /type === "DF_ACTION_SUBMITTED"/);
  assert.match(page, /pending\.playerId = Number\(payload\.playerId\)/);
  assert.match(page, /pendingTelemetry\.playerId = Number\(payload\.playerId\)/);
  assert.match(page, /Number\.isInteger\(Number\(payload\.playerId\)\)/);
  assert.match(page, /Number\(payload\.playerId\) !== 0/);
  assert.match(page, /Number\.isInteger\(resolvedPlayerId\)/);
  assert.match(page, /resolvedPlayerId !== 0/);
  assert.match(page, /payload\.code === "ROSTER_CONFIRMED"/);
  const rosterConfirmedHandler = page.match(/if \(payload\.code === "ROSTER_CONFIRMED"\) \{([\s\S]*?)\n\s*\}/)?.[1] || "";
  assert.match(rosterConfirmedHandler, /pendingSnakeActionRef\.current = null/);
  assert.doesNotMatch(rosterConfirmedHandler, /lastAutoAction\.current = ""/);
  assert.doesNotMatch(rosterConfirmedHandler, /setActionRetryNonce/);
  const importHandler = page.match(/if \(type === "DF_IMPORT_SUCCESS"[\s\S]*?if \(type === "DF_DRAFT_UPDATE"\)/)?.[0] || "";
  assert.match(importHandler, /setAutoDraft\(false\)/);
  assert.match(importHandler, /pendingActionTelemetryRef\.current\.clear\(\)/);
  assert.match(importHandler, /actionTelemetryRef\.current = \[\]/);
  assert.equal(page.match(/salaryCapDecisionObservationsRef\.current\.clear\(\)/g)?.length, 4);
  assert.equal(page.match(/sleeperEvidenceLedgerRef\.current = \{ leagueId: [^,]+, candidates: \[\] \}/g)?.length, 5);
  assert.match(page, /sendToExtension\("GET_RUNTIME_DIAGNOSTICS"\)/);
  assert.match(page, /authenticatedImportAt/);
  assert.match(page, /ESPN confirmed roster \$\{myPickCount\}\/\$\{league\.rosterSize\}/);
  assert.match(page, /contextMatchesActiveDraftTab/);
  assert.match(page, /expectedTabId/);
  assert.match(page, /REFRESH_ESPN_CONTEXT/);
  assert.match(page, /EXACT_TAB_WATCHDOG_MS = 5000/);
  const exactTabWatchdog = page.match(/useEffect\(\(\) => \{\n\s*\/\/ A league lobby import[\s\S]*?const refreshExactDraftTab[\s\S]*?EXACT_TAB_WATCHDOG_MS[\s\S]*?\}, \[context\.inDraftRoom, extension, league\.id, workspaceRole\]\);/)?.[0] || "";
  assert.match(exactTabWatchdog, /context\.inDraftRoom !== true\) return;/);
  assert.match(page, /contextCanRebindDraftTab/);
  assert.match(page, /ESPN_ROSTER_CONFIRMATION_GRACE_MS = 6000/);
  assert.match(page, /preflightChecks/);
  assert.match(page, /liveChecks/);
  assert.match(page, /onClick=\{confirmEnableAutoDraft\}/);
  assert.match(page, /sendToExtension\("REFRESH_ESPN_CONTEXT"[\s\S]*autoArmRequestId: requestId/);
  assert.match(page, /canArmAutoDraft/);
  assert.doesNotMatch(page, /className="danger-button" onClick=\{\(\) => \{ setAutoDraft\(true\)/);
  assert.match(background, /autoArmRequestId/);
  assert.match(page, /captureRequested.*capture.*sanitized/);
  assert.match(page, /draftforge-sanitized-capture/);
  assert.match(page, /\["localhost", "127\.0\.0\.1"\]/);
  assert.match(page, /sanitizeAuthenticatedEspnLeague\(league\)/);
  assert.match(page, /sanitizeAuthenticatedEspnPlayers\(espnPlayers\)/);
  assert.match(page, /buildAuthenticatedEspnCaptureAttestation/);
  assert.match(page, /capturedAt: authenticatedImportAt/);
  assert.match(page, /authenticatedEspnCapture/);
  assert.match(page, /ISSUE_ESPN_CAPTURE_RECEIPT/);
  assert.match(page, /captureIssueToken/);
  assert.match(page, /extension !== "connected"/);
  assert.match(page, /isCanonicalDraftAuditUtcTimestamp\(authenticatedImportAt\)/);
});
