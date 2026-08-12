import { normalizePicks } from "./draft-normalizers.js";
import { draftableRosterSizeFor, draftTypeFor, keeperCountFor } from "./league-normalizers.js";

const appTabs = new Set();
let espnContext = null;
let lastPollAt = 0;

const POSITION_MAP = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
const TEAM_MAP = {
  1:"ATL",2:"BUF",3:"CHI",4:"CIN",5:"CLE",6:"DAL",7:"DEN",8:"DET",9:"GB",10:"TEN",11:"IND",12:"KC",13:"LV",14:"LAR",15:"MIA",16:"MIN",17:"NE",18:"NO",19:"NYG",20:"NYJ",21:"PHI",22:"ARI",23:"PIT",24:"LAC",25:"SF",26:"SEA",27:"TB",28:"WAS",29:"CAR",30:"JAX",33:"BAL",34:"HOU"
};

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
  const requiresExactContext = Boolean(expectedLeagueId) || Number.isInteger(expectedTabId);
  const exact = contexts.find((context) =>
    (!expectedLeagueId || String(context.leagueId) === String(expectedLeagueId))
    && (!Number.isInteger(expectedTabId) || Number(context.tabId) === Number(expectedTabId))
  );
  if (exact) return exact;
  // Import and submission must never fall back to a similarly shaped ESPN
  // tab. A stale duplicate draft page is indistinguishable otherwise.
  if (requiresExactContext) return null;
  return contexts.sort((a, b) => Number(b.inDraftRoom) - Number(a.inDraftRoom) || b.lastAccessed - a.lastAccessed)[0] || null;
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

function normalizeSettings(raw, context) {
  const settings = raw.settings || {};
  const draft = settings.draftSettings || {};
  const roster = settings.rosterSettings || {};
  const scoring = settings.scoringSettings || {};
  const picks = raw.draftDetail?.picks || [];
  const draftType = draftTypeFor(draft.type);
  const scoringItems = scoring.scoringItems || [];
  const receptionRule = scoringItems.find((item) => Number(item.statId) === 53);
  const receptionPoints = Number(receptionRule?.points || 0);
  const scoringLabel = receptionPoints === 1 ? "PPR" : receptionPoints === 0.5 ? "Half PPR" : receptionPoints === 0 ? "Standard" : "Custom";
  const keeperCount = keeperCountFor(draft, raw.teams || []);

  return {
    id: String(raw.id || context.leagueId),
    name: settings.name || raw.name || "ESPN League",
    season: Number(raw.seasonId || 2026),
    size: Number(settings.size || raw.teams?.length || 12),
    isPublic: Boolean(raw.isPublic),
    teamId: Number(context.teamId || 0) || null,
    draftType,
    draftDate: draft.date || null,
    secondsPerPick: Number(draft.timePerSelection || 90),
    rosterSize: draftableRosterSizeFor(draft, roster),
    auctionBudget: Number(draft.auctionBudget || draft.budget || 200),
    pickOrder: draft.pickOrder || [],
    lineupSlotCounts: roster.lineupSlotCounts || {},
    positionLimits: roster.positionLimits || {},
    scoringLabel,
    scoringRules: scoringItems.length,
    keeperCount,
    draftStatus: {
      inProgress: Boolean(raw.draftDetail?.inProgress),
      complete: Boolean(raw.draftDetail?.drafted),
      picks: picks.length,
    },
    teams: (raw.teams || []).map((team) => ({ id: Number(team.id), name: team.name || `${team.location || ""} ${team.nickname || ""}`.trim(), abbrev: team.abbrev || "" })),
    rawSettings: settings,
  };
}

function normalizePlayers(raw) {
  return (raw.players || []).map((entry) => {
    const player = entry.player || entry;
    const ownership = player.ownership || {};
    const ranks = player.draftRanksByRankType || {};
    const bestRank = ranks.PPR || ranks.STANDARD || Object.values(ranks)[0] || {};
    const projection = (player.stats || []).find((stat) => Number(stat.statSourceId) === 1 && Number(stat.scoringPeriodId) === 0)
      || (player.stats || []).find((stat) => Number(stat.statSourceId) === 1);
    return {
      id: Number(player.id || entry.id),
      name: player.fullName || player.name || "Unknown player",
      team: TEAM_MAP[player.proTeamId] || "FA",
      pos: POSITION_MAP[player.defaultPositionId] || "FLEX",
      rank: Number(bestRank.rank || bestRank.eligibleSlotId || 999),
      adp: Number(ownership.averageDraftPosition || 999),
      auction: Number(ownership.auctionValueAverage || 1),
      projected: Number(projection?.appliedTotal || 0),
      injured: Boolean(player.injuryStatus && player.injuryStatus !== "ACTIVE"),
    };
  }).filter((player) => player.id && ["QB", "RB", "WR", "TE", "K", "DST"].includes(player.pos));
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
  return { league, players, picks: normalizePicks(raw), context };
}

async function pollDraft(context) {
  const raw = await espnFetch(leagueUrl(context.leagueId, Number(context.season || new Date().getFullYear()), ["mDraftDetail", "mTeam"]));
  return { picks: normalizePicks(raw), draftDetail: raw.draftDetail || {}, context };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "RELOAD_EXTENSION") {
      let senderHost = "";
      try { senderHost = new URL(sender.tab?.url || "").hostname; } catch { /* invalid sender URL */ }
      if (!["localhost", "127.0.0.1"].includes(senderHost)) {
        return { ok: false, code: "RELOAD_FORBIDDEN", message: "Companion self-reload is available only from the local DraftForge app." };
      }
      setTimeout(() => chrome.runtime.reload(), 100);
      return { ok: true, code: "RELOADING", message: "Reloading the local DraftForge companion." };
    }
    if (message.type === "APP_HELLO") {
      if (sender.tab?.id) appTabs.add(sender.tab.id);
      const context = await findEspnContext();
      return { ready: true, espnOpen: Boolean(context), context };
    }
    if (message.type === "ESPN_CONTEXT") {
      espnContext = { ...message.payload, tabId: sender.tab?.id };
      await broadcast("DF_ESPN_CONTEXT", espnContext);
      return { ok: true };
    }
    if (message.type === "REFRESH_ESPN_CONTEXT") {
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!Number.isInteger(expectedTabId)) return { ok: false, code: "DRAFT_TAB_REQUIRED", message: "Reconnect the exact ESPN draft tab before refreshing." };
      let context = await findEspnContext(message.payload?.expectedLeagueId, expectedTabId);
      if (!context) {
        context = await findUniqueDraftRoomContext(message.payload?.expectedLeagueId, Number(message.payload?.expectedTeamId));
        if (context) return { ok: true, context, rebound: true, previousTabId: expectedTabId };
        return { ok: false, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed or is ambiguous. Reconnect before submitting." };
      }
      return { ok: true, context };
    }
    if (message.type === "CONNECT_ESPN") {
      if (sender.tab?.id) appTabs.add(sender.tab.id);
      const requestedLeagueId = message.payload?.leagueId;
      const detected = await findEspnContext(requestedLeagueId);
      const context = { ...(detected || (!requestedLeagueId ? espnContext : {}) || {}) };
      if (message.payload?.season) context.season = message.payload.season;
      if (!context.leagueId || !context.tabId) return { ok: false, code: "NO_LEAGUE", message: "Open the exact ESPN league or draft tab, then connect again." };
      const data = await importLeague(context);
      espnContext = { ...context, season: data.league.season };
      await broadcast("DF_IMPORT_SUCCESS", data);
      return { ok: true, data };
    }
    if (message.type === "ESPN_POLL") {
      const now = Date.now();
      if (now - lastPollAt < 1800 || !message.payload?.leagueId) return { ok: true, skipped: true };
      lastPollAt = now;
      const pollContext = { ...message.payload, tabId: sender.tab?.id };
      const data = await pollDraft(pollContext);
      await broadcast("DF_DRAFT_UPDATE", data);
      return { ok: true };
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
    return { ok: false, code: "UNKNOWN_MESSAGE" };
  })().then(sendResponse).catch(async (error) => {
    const code = error?.message || "EXTENSION_ERROR";
    const messageText = code === "ESPN_LOGIN_REQUIRED" ? "Sign in to ESPN in another tab, then try again." : `ESPN connection failed: ${code}`;
    // Live mock rooms can disappear from ESPN's league API as soon as they
    // finish. A stale room's background poll must not poison every connected
    // DraftForge dashboard; explicit imports and actions still fail closed.
    if (message.type === "ESPN_POLL") {
      sendResponse({ ok: false, code, message: messageText });
      return;
    }
    await broadcast("DF_EXTENSION_ERROR", { code, message: messageText });
    sendResponse({ ok: false, code, message: messageText });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => appTabs.delete(tabId));
