import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authorizeRuntimeMessage } from "../extension/origin-policy.js";

const root = new URL("../extension/", import.meta.url);

test("extension is a narrowly scoped Manifest V3 ESPN companion", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.host_permissions.every((host) => /espn\.com/.test(host)));
  assert.ok(manifest.content_scripts.some((script) => script.matches.includes("https://fantasy.espn.com/*")));
  const appMatches = manifest.content_scripts.find((script) => script.js.includes("app-bridge.js")).matches;
  assert.deepEqual(appMatches, [
    "http://localhost:3000/*",
    "http://127.0.0.1:3000/*",
    "https://draftforge-ai.workspace-231977.chatgpt.site/*",
  ]);
});

test("privileged runtime messages require the exact DraftForge or ESPN sender origin", () => {
  const production = "https://draftforge-ai.workspace-231977.chatgpt.site/draft";
  const localhost = "http://localhost:3000/?reloadCompanion=1";
  const espn = "https://fantasy.espn.com/football/draft?leagueId=44050";
  assert.equal(authorizeRuntimeMessage("APP_HELLO", production).ok, true);
  assert.equal(authorizeRuntimeMessage("RELOAD_EXTENSION", localhost).ok, true);
  assert.equal(authorizeRuntimeMessage("SUBMIT_ACTION", espn).ok, false);
  assert.equal(authorizeRuntimeMessage("ESPN_CONTEXT", espn).ok, true);
  assert.equal(authorizeRuntimeMessage("ESPN_CONTEXT", production).ok, false);
  assert.equal(authorizeRuntimeMessage("CONNECT_ESPN", "https://attacker.chatgpt.site/").ok, false);
  assert.equal(authorizeRuntimeMessage("SUBMIT_ACTION", "https://attacker.openai.site/").ok, false);
  assert.equal(authorizeRuntimeMessage("DISABLE_ESPN_AUTOPICK", "https://attacker.sites.openai.com/").ok, false);
  assert.equal(authorizeRuntimeMessage("SUBMIT_ACTION", "http://localhost:3000.attacker.example/").ok, false);
  assert.equal(authorizeRuntimeMessage("SUBMIT_ACTION", "not a URL").ok, false);
  assert.equal(authorizeRuntimeMessage("FUTURE_UNCLASSIFIED_ACTION", production).code, "UNKNOWN_MESSAGE");
});

test("draft actions fail closed and private ESPN credentials are not persisted", async () => {
  const [background, content, bridge, page] = await Promise.all([
    readFile(new URL("background.js", root), "utf8"),
    readFile(new URL("espn-content.js", root), "utf8"),
    readFile(new URL("app-bridge.js", root), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(background, /chrome\.storage|espn_s2|SWID/);
  assert.match(background, /authorizeRuntimeMessage\(message\?\.type, sender\.url \|\| sender\.tab\?\.url \|\| ""\)/);
  assert.doesNotMatch(content, /espn_s2|SWID/);
  assert.match(background, /findEspnContext\(expectedLeagueId, expectedTabId\)/);
  assert.match(background, /selectUniqueEspnContext\(contexts, expectedLeagueId\)/);
  assert.match(background, /CONNECT_CONTEXT_TIMEOUT_MS = 4000/);
  assert.match(background, /waitForEspnContext\(requestedLeagueId\)/);
  assert.match(background, /DRAFT_TAB_REQUIRED/);
  assert.match(background, /DRAFT_TAB_CHANGED/);
  assert.match(background, /chrome\.tabs\.get\(expectedTabId\)/);
  assert.match(background, /findUniqueDraftRoomContext/);
  assert.match(background, /matches\.length === 1/);
  assert.match(background, /createPollCoordinator/);
  assert.match(background, /ESPN_HEARTBEAT/);
  assert.match(background, /ESPN_ACTION_RESOLVED/);
  assert.match(background, /senderTabId !== expectedTabId/);
  assert.match(background, /DF_ACTION_RESOLVED/);
  assert.match(background, /DISABLE_ESPN_AUTOPICK/);
  assert.match(background, /DF_DISABLE_AUTOPICK/);
  assert.match(content, /MIN_ACTION_WINDOW_SECONDS = 5/);
  assert.match(content, /AUTOPICK_ACTIVE/);
  assert.match(content, /autopickActive/);
  assert.match(content, /snakeClockOwnMarker/);
  assert.match(content, /snakeClockSource/);
  assert.match(content, /function disableEspnAutopick/);
  assert.match(content, /\.pick-queue__header \.autoPick-toggle/);
  assert.match(content, /SELECT_ACTION_BUDGET_MS = 4500/);
  assert.match(content, /NOMINATION_CONFIRMATION_WINDOW_MS = 4000/);
  assert.match(content, /MAX_MANDATORY_SEARCH_CANDIDATES = 18/);
  assert.match(content, /MANDATORY_CANDIDATE_SEARCH_WINDOW_MS = 120/);
  assert.match(content, /MANDATORY_POSITION_FILTER_WINDOW_MS = 1800/);
  assert.match(content, /function buildMandatoryPositionPlan\(candidates\)/);
  assert.match(content, /setNativeSelectValue\(positionFilter, mandatoryPositionPlan\.slotId\)/);
  assert.match(content, /!visibleCandidate && !usedPositionFilter && playerSearch instanceof HTMLInputElement/);
  assert.match(content, /setNativeSelectValue\(usedPositionFilter, "-1"\)/);
  assert.match(content, /sendToCompanion\(\{ type: "ESPN_ACTION_RESOLVED", payload: resolvedAction \}\)/);
  assert.match(content, /WRONG_LEAGUE/);
  assert.match(content, /NOMINEE_MISMATCH/);
  assert.match(content, /BID_CHANGED/);
  assert.match(content, /BUDGET_RESERVE/);
  assert.match(content, /#icon__controls__volume_mute/);
  assert.match(content, /function enforceMutedDraftSound\(context\)/);
  assert.match(content, /enforceMutedDraftSound\(context\);/);
  assert.match(content, /new MutationObserver\(/);
  assert.match(content, /CONTEXT_WATCHDOG_MS = 2000/);
  assert.doesNotMatch(content, /ESPN_POLL/);
  assert.doesNotMatch(content, /}, 250\);/);
  assert.doesNotMatch(content, /return executeAction\(/);
  assert.match(bridge, /function announceReady\(\)/);
  assert.match(bridge, /event\.data\.type === "APP_HELLO"/);
  assert.match(page, /sendToExtension\("APP_HELLO"\)/);
  assert.match(page, /expectedCurrentBid: resolvedOperation === "BID"/);
  assert.match(page, /maxApprovedBid: resolvedOperation === "BID"/);
  assert.match(page, /fillsMandatoryStarter: candidate\.fillsMandatoryStarter/);
  assert.match(page, /ACTION_CANDIDATE_LIMIT = 64/);
  assert.match(page, /position: candidate\.pos/);
  assert.match(page, /RETRIABLE_BID_CODES = new Set\(\[\.\.\.RETRIABLE_TURN_CODES, "ACTION_TIMEOUT", "NOMINEE_MISMATCH", "NOMINEE_UNKNOWN"\]\)/);
  assert.match(page, /RETRIABLE_NOMINATION_CODES = new Set\(\["NOT_ON_CLOCK", "CLOCK_TOO_SHORT", "NOMINATION_ACTIVE"\]\)/);
  assert.match(page, /nominated \|\| context\.nominatedPlayer \|\| Number\(context\.currentBid \|\| 0\) > 0/);
  assert.match(content, /code: "NOMINATION_ACTIVE"/);
  assert.match(page, /if \(!payload\.ok\) setAutoDraft\(false\)/);
  assert.match(page, /actionRequestId !== latestActionRequestRef\.current/);
  assert.match(page, /type === "DF_ACTION_RESOLVED"/);
  assert.match(page, /pending\.playerId = Number\(payload\.playerId\)/);
  assert.match(page, /payload\.code === "ROSTER_CONFIRMED"/);
  const rosterConfirmedHandler = page.match(/if \(payload\.code === "ROSTER_CONFIRMED"\) \{([\s\S]*?)\n\s*\}/)?.[1] || "";
  assert.match(rosterConfirmedHandler, /pendingSnakeActionRef\.current = null/);
  assert.match(rosterConfirmedHandler, /lastAutoAction\.current = ""/);
  assert.doesNotMatch(rosterConfirmedHandler, /setActionRetryNonce/);
  assert.match(page, /contextMatchesActiveDraftTab/);
  assert.match(page, /expectedTabId/);
  assert.match(page, /REFRESH_ESPN_CONTEXT/);
  assert.match(page, /EXACT_TAB_WATCHDOG_MS = 5000/);
  assert.match(page, /contextCanRebindDraftTab/);
  assert.match(page, /ESPN_ROSTER_CONFIRMATION_GRACE_MS = 6000/);
  assert.match(page, /preflightChecks/);
  assert.match(page, /liveChecks/);
  assert.match(page, /captureRequested.*capture.*sanitized/);
  assert.match(page, /draftforge-sanitized-capture/);
  assert.match(page, /\["localhost", "127\.0\.0\.1"\]/);
  assert.match(page, /delete safeLeague\.rawSettings/);
});
