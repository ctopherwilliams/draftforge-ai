import { normalizeImportPicks, normalizePicks } from "./draft-normalizers.js";
import { normalizeSettings } from "./league-import.js";
import { normalizePlayers } from "./player-normalizers.js";
import { createPollCoordinator } from "./poll-coordinator.js";
import { selectUniqueEspnContext } from "./context-selector.js";
import { DRAFTFORGE_APP_ORIGINS, authorizeRuntimeMessage, isLocalDraftForgeSenderUrl } from "./origin-policy.js";

const appTabs = new Set();
let espnContext = null;
const draftPolls = createPollCoordinator({ minIntervalMs: 1800 });
const CONNECT_CONTEXT_TIMEOUT_MS = 4000;
const CONNECT_CONTEXT_RETRY_MS = 150;

function originForTab(tab) {
  try { return new URL(tab?.url || "").origin; }
  catch { return ""; }
}

async function runtimeDiagnostics() {
  const tabs = await chrome.tabs.query({});
  return {
    capturedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    browserTabCount: tabs.length,
    draftForgeTabCount: tabs.filter((tab) => DRAFTFORGE_APP_ORIGINS.includes(originForTab(tab))).length,
    espnTabCount: tabs.filter((tab) => originForTab(tab) === "https://fantasy.espn.com").length,
  };
}

async function broadcast(type, payload) {
  for (const tabId of [...appTabs]) {
    try { await chrome.tabs.sendMessage(tabId, { type, payload }); }
    catch { appTabs.delete(tabId); }
  }
}

async function findEspnContext(expectedLeagueId, expectedTabId) {
  if (Number.isInteger(expectedTabId)) {
    try {
      const tab = await chrome.tabs.get(expectedTabId);
      if (!tab.url?.startsWith("https://fantasy.espn.com/")) return null;
      const context = await chrome.tabs.sendMessage(expectedTabId, { type: "DF_GET_CONTEXT" });
      if (expectedLeagueId && String(context?.leagueId) !== String(expectedLeagueId)) return null;
      return { ...context, tabId: expectedTabId, lastAccessed: Number(tab.lastAccessed || 0) };
    } catch {
      return null;
    }
  }
  const tabs = await chrome.tabs.query({ url: "https://fantasy.espn.com/*" });
  const contexts = (await Promise.all(tabs.filter((tab) => tab.id).map(async (tab) => {
    try {
      const context = await chrome.tabs.sendMessage(tab.id, { type: "DF_GET_CONTEXT" });
      return { ...context, tabId: tab.id, lastAccessed: Number(tab.lastAccessed || 0) };
    } catch { return null; }
  }))).filter(Boolean);
  // An exact league import may coexist with one ordinary league page, but two
  // live rooms for the same league are ambiguous and must fail closed.
  return selectUniqueEspnContext(contexts, expectedLeagueId);
}

async function waitForEspnContext(expectedLeagueId) {
  if (!expectedLeagueId) return findEspnContext();
  const deadline = Date.now() + CONNECT_CONTEXT_TIMEOUT_MS;
  do {
    const context = await findEspnContext(expectedLeagueId);
    if (context) return context;
    await new Promise((resolve) => setTimeout(resolve, CONNECT_CONTEXT_RETRY_MS));
  } while (Date.now() < deadline);
  return null;
}

async function findUniqueDraftRoomContext(expectedLeagueId, expectedTeamId) {
  if (!expectedLeagueId || !Number.isInteger(expectedTeamId)) return null;
  const tabs = await chrome.tabs.query({ url: "https://fantasy.espn.com/*" });
  const matches = (await Promise.all(tabs.filter((tab) => tab.id).map(async (tab) => {
    try {
      const context = await chrome.tabs.sendMessage(tab.id, { type: "DF_GET_CONTEXT" });
      if (String(context?.leagueId) !== String(expectedLeagueId)
        || Number(context?.teamId) !== Number(expectedTeamId)
        || context?.inDraftRoom !== true) return null;
      return { ...context, tabId: tab.id, lastAccessed: Number(tab.lastAccessed || 0) };
    } catch {
      return null;
    }
  }))).filter(Boolean);
  return matches.length === 1 ? matches[0] : null;
}

function leagueUrl(leagueId, season, views) {
  const url = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`);
  views.forEach((view) => url.searchParams.append("view", view));
  return url;
}

async function espnFetch(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: "include", headers: { Accept: "application/json", ...(options.headers || {}) } });
  if (response.status === 401 || response.status === 403) throw new Error("ESPN_LOGIN_REQUIRED");
  if (!response.ok) throw new Error(`ESPN_${response.status}`);
  return response.json();
}

async function fetchPlayers(leagueId, season, scoringLabel) {
  const filter = {
    players: {
      limit: 500,
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: scoringLabel === "PPR" ? "PPR" : "STANDARD" },
      filterRanksForRankTypes: { value: [scoringLabel === "PPR" ? "PPR" : "STANDARD"] },
      filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 20, 21, 23] }
    }
  };
  const raw = await espnFetch(leagueUrl(leagueId, season, ["kona_player_info"]), { headers: { "X-Fantasy-Filter": JSON.stringify(filter) } });
  return normalizePlayers(raw);
}

async function importLeague(context) {
  const season = Number(context.season || new Date().getFullYear());
  const raw = await espnFetch(leagueUrl(context.leagueId, season, ["mSettings", "mTeam", "mRoster", "mDraftDetail"]));
  const league = normalizeSettings(raw, context);
  const players = await fetchPlayers(context.leagueId, season, league.scoringLabel);
  return { league, players, picks: normalizeImportPicks(raw), context };
}

async function pollDraft(context) {
  const raw = await espnFetch(leagueUrl(context.leagueId, Number(context.season || new Date().getFullYear()), ["mDraftDetail", "mTeam"]));
  return { picks: normalizePicks(raw), draftDetail: raw.draftDetail || {}, context };
}

async function pollDraftIfDue(context) {
  try {
    return await draftPolls.run(context, async () => {
      const data = await pollDraft(context);
      await broadcast("DF_DRAFT_UPDATE", data);
      return { ok: true };
    });
  } catch (error) {
    // A completed or transient mock room may disappear from ESPN's API. Live
    // DOM context remains usable, and explicit imports/actions still fail closed.
    return { ok: false, code: error?.message || "ESPN_POLL_FAILED" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const authorization = authorizeRuntimeMessage(message?.type, sender.url || sender.tab?.url || "");
    if (!authorization.ok) return authorization;
    if (message.type === "RELOAD_EXTENSION") {
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "")) {
        return { ok: false, code: "RELOAD_FORBIDDEN", message: "Companion self-reload is available only from the local DraftForge app." };
      }
      setTimeout(() => chrome.runtime.reload(), 100);
      return { ok: true, code: "RELOADING", message: "Reloading the local DraftForge companion." };
    }
    if (message.type === "APP_HELLO") {
      if (sender.tab?.id) appTabs.add(sender.tab.id);
      const context = await findEspnContext();
      return { ready: true, espnOpen: Boolean(context), context, runtime: await runtimeDiagnostics() };
    }
    if (message.type === "GET_RUNTIME_DIAGNOSTICS") {
      return { ok: true, runtime: await runtimeDiagnostics() };
    }
    if (message.type === "ESPN_CONTEXT") {
      espnContext = { ...message.payload, tabId: sender.tab?.id };
      await broadcast("DF_ESPN_CONTEXT", espnContext);
      const poll = espnContext.inDraftRoom && espnContext.leagueId
        ? await pollDraftIfDue(espnContext)
        : { skipped: true, reason: "NOT_IN_DRAFT_ROOM" };
      return { ok: true, poll };
    }
    if (message.type === "ESPN_HEARTBEAT") {
      const context = { ...message.payload, tabId: sender.tab?.id };
      if (!context.inDraftRoom || !context.leagueId) return { ok: true, skipped: true };
      return pollDraftIfDue(context);
    }
    if (message.type === "ESPN_ACTION_RESOLVED") {
      const action = message.payload || {};
      const expectedTabId = Number(action.expectedTabId);
      const senderTabId = Number(sender.tab?.id);
      let senderLeagueId = "";
      try { senderLeagueId = new URL(sender.tab?.url || "").searchParams.get("leagueId") || ""; } catch { /* invalid sender URL */ }
      if (!Number.isInteger(expectedTabId) || senderTabId !== expectedTabId || String(action.expectedLeagueId || "") !== senderLeagueId) {
        return { ok: false, code: "ACTION_RESOLUTION_REJECTED" };
      }
      await broadcast("DF_ACTION_RESOLVED", { ...action, tabId: senderTabId });
      return { ok: true };
    }
    if (message.type === "ESPN_ACTION_SUBMITTED") {
      const action = message.payload || {};
      const expectedTabId = Number(action.expectedTabId);
      const senderTabId = Number(sender.tab?.id);
      let senderLeagueId = "";
      try { senderLeagueId = new URL(sender.tab?.url || "").searchParams.get("leagueId") || ""; } catch { /* invalid sender URL */ }
      if (!Number.isInteger(expectedTabId) || senderTabId !== expectedTabId || String(action.expectedLeagueId || "") !== senderLeagueId) {
        return { ok: false, code: "ACTION_SUBMISSION_REJECTED" };
      }
      await broadcast("DF_ACTION_SUBMITTED", { ...action, tabId: senderTabId });
      return { ok: true };
    }
    if (message.type === "REFRESH_ESPN_CONTEXT") {
      const autoArmRequestId = Number(message.payload?.autoArmRequestId);
      const verification = Number.isInteger(autoArmRequestId) ? { autoArmRequestId } : {};
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!Number.isInteger(expectedTabId)) return { ok: false, ...verification, code: "DRAFT_TAB_REQUIRED", message: "Reconnect the exact ESPN draft tab before refreshing." };
      let context = await findEspnContext(message.payload?.expectedLeagueId, expectedTabId);
      if (!context) {
        context = await findUniqueDraftRoomContext(message.payload?.expectedLeagueId, Number(message.payload?.expectedTeamId));
        if (context) return { ok: true, ...verification, context, rebound: true, previousTabId: expectedTabId };
        return { ok: false, ...verification, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed or is ambiguous. Reconnect before submitting." };
      }
      return { ok: true, ...verification, context };
    }
    if (message.type === "CONNECT_ESPN") {
      if (sender.tab?.id) appTabs.add(sender.tab.id);
      const requestedLeagueId = message.payload?.leagueId;
      const detected = await waitForEspnContext(requestedLeagueId);
      const context = { ...(detected || (!requestedLeagueId ? espnContext : {}) || {}) };
      if (message.payload?.season) context.season = message.payload.season;
      if (!context.leagueId || !context.tabId) return { ok: false, code: "NO_LEAGUE", message: "Open the exact ESPN league or draft tab, then connect again." };
      const data = await importLeague(context);
      data.runtime = await runtimeDiagnostics();
      espnContext = { ...context, season: data.league.season };
      await broadcast("DF_IMPORT_SUCCESS", data);
      return { ok: true, data };
    }
    if (message.type === "SUBMIT_ACTION") {
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!Number.isInteger(expectedTabId)) return { ok: false, code: "DRAFT_TAB_REQUIRED", message: "Reconnect the exact ESPN draft tab before submitting." };
      const context = await findEspnContext(message.payload?.expectedLeagueId, expectedTabId);
      if (!context?.tabId) return { ok: false, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed. Reconnect before submitting." };
      const result = await chrome.tabs.sendMessage(context.tabId, { type: "DF_EXECUTE_ACTION", payload: message.payload });
      const actionResult = { ...result, action: result?.action || message.payload };
      await broadcast("DF_ACTION_RESULT", actionResult);
      return actionResult;
    }
    if (message.type === "DISABLE_ESPN_AUTOPICK") {
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!Number.isInteger(expectedTabId)) return { ok: false, code: "DRAFT_TAB_REQUIRED", message: "Reconnect the exact ESPN draft tab before changing Autopick." };
      const context = await findEspnContext(message.payload?.expectedLeagueId, expectedTabId);
      if (!context?.tabId) return { ok: false, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed. Reconnect before changing Autopick." };
      return chrome.tabs.sendMessage(context.tabId, { type: "DF_DISABLE_AUTOPICK", payload: message.payload });
    }
    return { ok: false, code: "UNKNOWN_MESSAGE" };
  })().then(sendResponse).catch(async (error) => {
    const code = error?.message || "EXTENSION_ERROR";
    const messageText = code === "ESPN_LOGIN_REQUIRED" ? "Sign in to ESPN in another tab, then try again." : `ESPN connection failed: ${code}`;
    await broadcast("DF_EXTENSION_ERROR", { code, message: messageText });
    sendResponse({ ok: false, code, message: messageText });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => appTabs.delete(tabId));
