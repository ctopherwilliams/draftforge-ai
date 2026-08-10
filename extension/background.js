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

async function findEspnContext(expectedLeagueId) {
  const tabs = await chrome.tabs.query({ url: "https://fantasy.espn.com/*" });
  const contexts = (await Promise.all(tabs.filter((tab) => tab.id).map(async (tab) => {
    try {
      const context = await chrome.tabs.sendMessage(tab.id, { type: "DF_GET_CONTEXT" });
      return { ...context, tabId: tab.id, lastAccessed: Number(tab.lastAccessed || 0) };
    } catch { return null; }
  }))).filter(Boolean);
  const exact = expectedLeagueId && contexts.find((context) => String(context.leagueId) === String(expectedLeagueId));
  if (exact) return exact;
  return contexts.sort((a, b) => Number(b.inDraftRoom) - Number(a.inDraftRoom) || b.lastAccessed - a.lastAccessed)[0] || null;
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
  const draftType = Number(draft.type) === 2 ? "AUCTION" : "SNAKE";
  const scoringItems = scoring.scoringItems || [];
  const receptionRule = scoringItems.find((item) => Number(item.statId) === 53);
  const receptionPoints = Number(receptionRule?.points || 0);
  const scoringLabel = receptionPoints === 1 ? "PPR" : receptionPoints === 0.5 ? "Half PPR" : receptionPoints === 0 ? "Standard" : "Custom";
  const keeperCount = (raw.teams || []).reduce((sum, team) => sum + (team.roster?.entries || []).filter((entry) => entry.keeperValue || entry.acquisitionType === "KEEPER").length, 0);

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
    rosterSize: Number(draft.slotCount || Object.values(roster.lineupSlotCounts || {}).reduce((a, b) => a + Number(b), 0) || 16),
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

function normalizePicks(raw) {
  return (raw.draftDetail?.picks || []).map((pick, index) => ({
    playerId: Number(pick.playerId),
    teamId: Number(pick.teamId),
    overall: Number(pick.overallPickNumber || index + 1),
    round: Number(pick.roundId || 0),
    amount: Number(pick.bidAmount || 0),
    keeper: Boolean(pick.keeper),
  }));
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
    if (message.type === "CONNECT_ESPN") {
      if (sender.tab?.id) appTabs.add(sender.tab.id);
      const requestedLeagueId = message.payload?.leagueId;
      const detected = await findEspnContext(requestedLeagueId);
      const context = { ...(detected || espnContext || {}) };
      if (requestedLeagueId) context.leagueId = requestedLeagueId;
      if (message.payload?.season) context.season = message.payload.season;
      if (!context.leagueId) return { ok: false, code: "NO_LEAGUE", message: "Open your ESPN league in another tab first." };
      const data = await importLeague(context);
      espnContext = { ...context, season: data.league.season };
      await broadcast("DF_IMPORT_SUCCESS", data);
      return { ok: true, data };
    }
    if (message.type === "ESPN_POLL") {
      const now = Date.now();
      if (now - lastPollAt < 1800 || !message.payload?.leagueId) return { ok: true, skipped: true };
      lastPollAt = now;
      const data = await pollDraft(message.payload);
      await broadcast("DF_DRAFT_UPDATE", data);
      return { ok: true };
    }
    if (message.type === "SUBMIT_ACTION") {
      const context = await findEspnContext(message.payload?.expectedLeagueId);
      if (!context?.tabId) return { ok: false, code: "NO_ESPN_TAB", message: "Open the ESPN draft room first." };
      const result = await chrome.tabs.sendMessage(context.tabId, { type: "DF_EXECUTE_ACTION", payload: message.payload });
      await broadcast("DF_ACTION_RESULT", result);
      return result;
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
