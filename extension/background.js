import { normalizeImportPicks, normalizePicks } from "./draft-normalizers.js";
import { normalizeSettings } from "./league-import.js";
import { normalizePlayers } from "./player-normalizers.js";
import { createPollCoordinator } from "./poll-coordinator.js";
import { selectUniqueEspnContext } from "./context-selector.js";
import { DRAFTFORGE_APP_ORIGINS, authorizeRuntimeMessage, isLocalDraftForgeSenderUrl } from "./origin-policy.js";
import { selectRecoveryWorkspace } from "./recovery-targets.js";
import { recoverExactDraftRoomContext } from "./recovery-context.js";
import { contextCanTriggerLiveRoomWatch, createLiveRoomWatch, liveLeagueMatchesWatch } from "./live-room-watch.js";
import {
  actionPayloadMatchesBinding,
  reboundMatchesActionBinding,
  restoredBindingMatchesEvidence,
  resultMatchesActionBinding,
  sanitizeActionBinding,
  tabRemovalInvalidatesActionBinding,
  validCommandCenterSessionId,
} from "./action-binding.js";
import {
  completedAuditProvesPracticeRoom,
  practiceWorkspaceCleanupTabIds,
  selectManagedWorkspaceCleanup,
} from "./workspace-lifecycle.js";

const appTabs = new Set();
let espnContext = null;
let liveRoomWatch = null;
let actionBinding = null;
const draftPolls = createPollCoordinator({ minIntervalMs: 1800 });
const CONNECT_CONTEXT_TIMEOUT_MS = 4000;
const CONNECT_CONTEXT_RETRY_MS = 150;
const RECOVERY_CONTEXT_TIMEOUT_MS = 12000;
const LIVE_ROOM_WATCH_STORAGE_KEY = "draftForgeLiveRoomWatchV1";
const ACTION_BINDING_STORAGE_KEY = "draftForgeActionBindingV1";

function sanitizedWatchPlayer(player) {
  return {
    id: Number(player?.id || 0),
    name: String(player?.name || ""),
    team: String(player?.team || ""),
    pos: String(player?.pos || ""),
    rank: Number(player?.rank || 999),
    adp: Number(player?.adp || 999),
    auction: Number(player?.auction || 0),
    projected: Number(player?.projected || 0),
    availabilityStatus: String(player?.availabilityStatus || "ACTIVE"),
    injured: player?.injured === true,
    unavailable: player?.unavailable === true,
  };
}

function sanitizedLiveRoomWatch(watch) {
  if (!watch) return null;
  return {
    appTabId: Number(watch.appTabId),
    sourceTabId: Number(watch.sourceTabId),
    sourceLeagueId: String(watch.sourceLeagueId || ""),
    sourceLeagueName: String(watch.sourceLeagueName || ""),
    teamId: Number(watch.teamId),
    season: Number(watch.season),
    rules: String(watch.rules || ""),
    sourcePlayers: (Array.isArray(watch.sourcePlayers) ? watch.sourcePlayers : []).slice(0, 1000).map(sanitizedWatchPlayer),
    autoArmRequested: watch.autoArmRequested === true,
    armedAt: Number(watch.armedAt),
    expiresAt: Number(watch.expiresAt),
    processingTabId: Number.isInteger(Number(watch.processingTabId)) ? Number(watch.processingTabId) : null,
    commandCenterSessionId: String(watch.commandCenterSessionId || ""),
  };
}

function validStoredLiveRoomWatch(watch, now = Date.now()) {
  return Boolean(watch
    && Number.isInteger(watch.appTabId) && watch.appTabId > 0
    && Number.isInteger(watch.sourceTabId) && watch.sourceTabId > 0
    && watch.sourceLeagueId
    && Number.isInteger(watch.teamId) && watch.teamId > 0
    && Number.isInteger(watch.season) && watch.season > 0
    && typeof watch.rules === "string" && watch.rules.length > 0
    && Array.isArray(watch.sourcePlayers) && watch.sourcePlayers.length > 0
    && Number.isFinite(watch.armedAt) && Number.isFinite(watch.expiresAt)
    && validCommandCenterSessionId(watch.commandCenterSessionId)
    && now >= watch.armedAt && now <= watch.expiresAt);
}

async function persistLiveRoomWatch(watch) {
  if (!watch) {
    await chrome.storage.session.remove(LIVE_ROOM_WATCH_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [LIVE_ROOM_WATCH_STORAGE_KEY]: sanitizedLiveRoomWatch(watch) });
}

async function restoreLiveRoomWatch() {
  try {
    const stored = (await chrome.storage.session.get(LIVE_ROOM_WATCH_STORAGE_KEY))?.[LIVE_ROOM_WATCH_STORAGE_KEY];
    if (!validStoredLiveRoomWatch(stored)) {
      await persistLiveRoomWatch(null);
      return null;
    }
    const [appTab, sourceTab] = await Promise.all([
      chrome.tabs.get(stored.appTabId).catch(() => null),
      chrome.tabs.get(stored.sourceTabId).catch(() => null),
    ]);
    if (!appTab || !isLocalDraftForgeSenderUrl(appTab.url || "")
      || (!sourceTab && !Number.isInteger(stored.processingTabId))) {
      await persistLiveRoomWatch(null);
      return null;
    }
    liveRoomWatch = stored;
    appTabs.add(stored.appTabId);
    return stored;
  } catch {
    liveRoomWatch = null;
    return null;
  }
}

const liveRoomWatchRestore = restoreLiveRoomWatch();

function bindDraftActions(context, league, tabId = context?.tabId, appTabId, commandCenterSessionId) {
  const leagueId = String(league?.id || context?.leagueId || "");
  const teamId = Number(league?.teamId || context?.teamId || 0);
  const season = Number(league?.season || context?.season || 0);
  const exactTabId = Number(tabId);
  const exactAppTabId = Number(appTabId);
  const exactCommandCenterSessionId = String(commandCenterSessionId || "");
  actionBinding = leagueId
    && Number.isInteger(teamId) && teamId > 0
    && Number.isInteger(season) && season > 0
    && Number.isInteger(exactTabId) && exactTabId > 0
    && Number.isInteger(exactAppTabId) && exactAppTabId > 0
    && validCommandCenterSessionId(exactCommandCenterSessionId)
      ? { leagueId, teamId, season, tabId: exactTabId, appTabId: exactAppTabId, commandCenterSessionId: exactCommandCenterSessionId }
      : null;
  return actionBinding;
}

async function persistActionBinding(binding) {
  const sanitized = sanitizeActionBinding(binding);
  if (!sanitized) {
    await chrome.storage.session.remove(ACTION_BINDING_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [ACTION_BINDING_STORAGE_KEY]: sanitized });
}

async function clearActionBinding() {
  actionBinding = null;
  await persistActionBinding(null);
}

async function establishActionBinding(context, league, tabId, appTabId, commandCenterSessionId) {
  await actionBindingRestore;
  if (context?.inDraftRoom !== true) {
    await clearActionBinding();
    return null;
  }
  const binding = bindDraftActions(context, league, tabId, appTabId, commandCenterSessionId);
  if (!binding) {
    await clearActionBinding();
    return null;
  }
  await persistActionBinding(binding);
  appTabs.add(binding.appTabId);
  return binding;
}

async function restoreActionBinding() {
  try {
    const stored = sanitizeActionBinding(
      (await chrome.storage.session.get(ACTION_BINDING_STORAGE_KEY))?.[ACTION_BINDING_STORAGE_KEY],
    );
    if (!stored) {
      await clearActionBinding();
      return null;
    }
    const [appTab, espnTab] = await Promise.all([
      chrome.tabs.get(stored.appTabId).catch(() => null),
      chrome.tabs.get(stored.tabId).catch(() => null),
    ]);
    const context = await chrome.tabs.sendMessage(stored.tabId, { type: "DF_GET_CONTEXT" }).catch(() => null);
    const exactContext = { ...context, tabId: stored.tabId };
    if (!restoredBindingMatchesEvidence(stored, {
      appTabUrl: appTab?.url,
      espnTabUrl: espnTab?.url,
      context: exactContext,
    }, DRAFTFORGE_APP_ORIGINS)) {
      await clearActionBinding();
      return null;
    }
    actionBinding = stored;
    espnContext = exactContext;
    appTabs.add(stored.appTabId);
    return stored;
  } catch {
    actionBinding = null;
    try { await persistActionBinding(null); } catch { /* storage failure still leaves authority cleared in memory */ }
    return null;
  }
}

const actionBindingRestore = restoreActionBinding();

async function ensureActionBinding() {
  await actionBindingRestore;
  if (actionBinding) return actionBinding;
  return restoreActionBinding();
}

function commandCenterSessionMatchesBinding(payload) {
  return Boolean(actionBinding
    && validCommandCenterSessionId(payload?.commandCenterSessionId)
    && payload.commandCenterSessionId === actionBinding.commandCenterSessionId);
}

async function broadcastBoundActionResult(type, payload) {
  const appTabId = Number(actionBinding?.appTabId);
  if (!Number.isInteger(appTabId)) return false;
  try {
    await chrome.tabs.sendMessage(appTabId, { type, payload });
    return true;
  } catch {
    appTabs.delete(appTabId);
    await clearActionBinding();
    return false;
  }
}

function actionMatchesBinding(payload, context, expectedTabId) {
  return actionPayloadMatchesBinding(actionBinding, payload, context, expectedTabId);
}

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
    managedCleanupReady: true,
  };
}

async function cleanManagedLocalWorkspace(senderTabId, payload = {}) {
  const selection = selectManagedWorkspaceCleanup(await chrome.tabs.query({}), {
    senderTabId,
    appOrigins: DRAFTFORGE_APP_ORIGINS,
    ownedBlankTabIds: payload.ownedBlankTabIds,
    electNewest: payload.electNewest === true,
  });
  if (!selection.ok) return selection;
  if (selection.cleanupTabIds.length) await chrome.tabs.remove(selection.cleanupTabIds);
  return {
    ...selection,
    closedTabIds: selection.cleanupTabIds,
    runtime: await runtimeDiagnostics(),
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

async function waitForEspnContext(expectedLeagueId, expectedTabId) {
  if (!expectedLeagueId) return findEspnContext(undefined, expectedTabId);
  const deadline = Date.now() + CONNECT_CONTEXT_TIMEOUT_MS;
  do {
    const context = await findEspnContext(expectedLeagueId, expectedTabId);
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

async function waitForExactDraftRoomContext(expectedLeagueId, expectedTeamId, expectedTabId) {
  const deadline = Date.now() + RECOVERY_CONTEXT_TIMEOUT_MS;
  do {
    const context = await findEspnContext(expectedLeagueId, expectedTabId);
    if (context?.inDraftRoom === true && Number(context.teamId) === Number(expectedTeamId)) return context;
    await new Promise((resolve) => setTimeout(resolve, CONNECT_CONTEXT_RETRY_MS));
  } while (Date.now() < deadline);
  return null;
}

async function keepLiveRoomVisible(roomTabId, appTab) {
  const roomTab = await chrome.tabs.get(roomTabId);
  if (!Number.isInteger(roomTab?.windowId) || !Number.isInteger(appTab?.windowId)) {
    throw new Error("RECOVERY_WINDOW_IDENTITY_MISSING");
  }
  if (roomTab.windowId !== appTab.windowId) return { separated: false, roomWindowId: roomTab.windowId };
  const roomWindow = await chrome.windows.create({ tabId: roomTabId, focused: false, type: "normal" });
  if (!Number.isInteger(roomWindow?.id)) throw new Error("RECOVERY_ROOM_WINDOW_FAILED");
  return { separated: true, roomWindowId: roomWindow.id };
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

async function importLeagueMetadata(context) {
  const season = Number(context.season || new Date().getFullYear());
  const raw = await espnFetch(leagueUrl(context.leagueId, season, ["mSettings", "mTeam", "mRoster", "mDraftDetail"]));
  const league = normalizeSettings(raw, context);
  return { league, raw };
}

async function importLeague(context) {
  const { league, raw } = await importLeagueMetadata(context);
  const season = Number(context.season || new Date().getFullYear());
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

async function recoverWatchedLiveRoom(context, senderTab) {
  await liveRoomWatchRestore;
  const watch = liveRoomWatch;
  const roomTabId = Number(senderTab?.id);
  if (!contextCanTriggerLiveRoomWatch(watch, { ...context, tabId: roomTabId })) return null;
  watch.processingTabId = roomTabId;
  await persistLiveRoomWatch(watch);
  let completed = false;
  try {
    const exactContext = await findEspnContext(context.leagueId, roomTabId);
    if (!contextCanTriggerLiveRoomWatch(watch, exactContext)) return null;
    // The authenticated source league already supplied the full ESPN player
    // pool. Re-fetch only the generated room's settings/picks so the exact
    // rules and practice-room name are still verified without spending the
    // 30-second opening countdown downloading the same 500 players again.
    const { league, raw } = await importLeagueMetadata(exactContext);
    const data = {
      league,
      players: watch.sourcePlayers,
      picks: normalizeImportPicks(raw),
      context: exactContext,
    };
    if (!liveLeagueMatchesWatch(watch, data.league, exactContext)) {
      await broadcast("DF_EXTENSION_ERROR", {
        code: "LIVE_ROOM_WATCH_IDENTITY_MISMATCH",
        message: "DraftForge saw an ESPN room, but its authenticated league rules did not exactly match the armed draft.",
      });
      return null;
    }
    espnContext = { ...exactContext, season: data.league.season };
    await establishActionBinding(
      espnContext,
      data.league,
      roomTabId,
      watch.appTabId,
      watch.commandCenterSessionId,
    );
    data.runtime = await runtimeDiagnostics();
    data.roomWatch = {
      recovered: true,
      sourceLeagueId: watch.sourceLeagueId,
      roomLeagueId: String(data.league.id),
      appTabId: watch.appTabId,
      roomTabId,
      reloadedRoom: false,
      autoArmRequested: watch.autoArmRequested === true,
      reusedAuthenticatedPlayerPool: Array.isArray(watch.sourcePlayers) && watch.sourcePlayers.length > 0,
    };
    liveRoomWatch = null;
    await persistLiveRoomWatch(null);
    // Broadcast the verified room first. Window separation, source cleanup,
    // and focus are presentation work and must not consume the opening clock.
    await broadcast("DF_IMPORT_SUCCESS", data);
    const appTab = await chrome.tabs.get(watch.appTabId);
    data.roomWatch.visibility = await keepLiveRoomVisible(roomTabId, appTab);
    if (Number.isInteger(watch.sourceTabId) && watch.sourceTabId !== roomTabId) {
      try { await chrome.tabs.remove(watch.sourceTabId); } catch { /* the source tab may already have closed */ }
    }
    if (Number.isInteger(appTab.windowId)) {
      await chrome.tabs.update(appTab.id, { active: true });
      try { await chrome.windows.update(appTab.windowId, { focused: true }); } catch { /* focus is helpful, not an identity invariant */ }
    }
    completed = true;
    return data.roomWatch;
  } finally {
    if (!completed && liveRoomWatch === watch) {
      watch.processingTabId = null;
      await persistLiveRoomWatch(watch);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const authorization = authorizeRuntimeMessage(message?.type, sender.url || sender.tab?.url || "");
    if (!authorization.ok) return authorization;
    if (authorization.senderKind === "app" && sender.tab?.id) appTabs.add(sender.tab.id);
    if (message.type === "RELOAD_EXTENSION") {
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "")) {
        return { ok: false, code: "RELOAD_FORBIDDEN", message: "Companion self-reload is available only from the local DraftForge app." };
      }
      setTimeout(() => chrome.runtime.reload(), 100);
      return { ok: true, code: "RELOADING", message: "Reloading the local DraftForge companion." };
    }
    if (message.type === "APP_HELLO") {
      if (sender.tab?.id) appTabs.add(sender.tab.id);
      const workspace = isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "") && sender.tab?.id
        ? await cleanManagedLocalWorkspace(sender.tab.id, { electNewest: true })
        : null;
      const context = await findEspnContext();
      return { ready: true, espnOpen: Boolean(context), context, workspace, runtime: await runtimeDiagnostics() };
    }
    if (message.type === "GET_RUNTIME_DIAGNOSTICS") {
      return { ok: true, runtime: await runtimeDiagnostics() };
    }
    if (message.type === "ARM_LIVE_ROOM_WATCH") {
      await liveRoomWatchRestore;
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "") || !sender.tab?.id) {
        return { ok: false, code: "LIVE_ROOM_WATCH_FORBIDDEN", message: "Live-room watch is available only from the active local DraftForge tab." };
      }
      if (!validCommandCenterSessionId(message.payload?.commandCenterSessionId)) {
        return { ok: false, code: "COMMAND_CENTER_SESSION_INVALID", message: "Reconnect DraftForge before arming the live-room handoff." };
      }
      const requestedLeagueId = String(message.payload?.sourceLeagueId || "");
      const requestedSourceTabId = Number(message.payload?.sourceTabId);
      const importedSourceTabId = Number(espnContext?.tabId);
      const exactSourceTabId = Number.isInteger(requestedSourceTabId) && requestedSourceTabId > 0
        ? requestedSourceTabId
        : String(espnContext?.leagueId || "") === requestedLeagueId
          && Number(espnContext?.teamId) === Number(message.payload?.teamId)
          && Number(espnContext?.season) === Number(message.payload?.season)
          && Number.isInteger(importedSourceTabId)
          && importedSourceTabId > 0
          ? importedSourceTabId
          : undefined;
      const sourceContext = await waitForEspnContext(
        requestedLeagueId,
        exactSourceTabId,
      );
      if (!sourceContext
        || sourceContext.inDraftRoom === true
        || Number(sourceContext.teamId) !== Number(message.payload?.teamId)
        || Number(sourceContext.season) !== Number(message.payload?.season)) {
        return { ok: false, code: "LIVE_ROOM_WATCH_SOURCE_MISMATCH", message: "Open the exact authenticated ESPN league before arming the live-room handoff." };
      }
      const sourceData = await importLeague(sourceContext);
      if (String(sourceData.league?.draftType || "") !== String(message.payload?.draftType || "")) {
        return { ok: false, code: "LIVE_ROOM_WATCH_FORMAT_MISMATCH", message: "The authenticated ESPN draft format changed before the live-room handoff was armed." };
      }
      const watch = createLiveRoomWatch({
        appTabId: sender.tab.id,
        sourceContext,
        sourceLeague: sourceData.league,
        sourcePlayers: sourceData.players,
        autoArmRequested: message.payload?.autoArmRequested === true,
      });
      if (!watch) return { ok: false, code: "LIVE_ROOM_WATCH_INVALID", message: "DraftForge could not prove one exact pre-draft league and team." };
      watch.commandCenterSessionId = message.payload.commandCenterSessionId;
      appTabs.add(sender.tab.id);
      liveRoomWatch = watch;
      await persistLiveRoomWatch(watch);
      return {
        ok: true,
        code: "LIVE_ROOM_WATCH_ARMED",
        message: "Exact ESPN live-room handoff armed.",
        watch: { sourceLeagueId: watch.sourceLeagueId, teamId: watch.teamId, season: watch.season, expiresAt: watch.expiresAt },
        runtime: await runtimeDiagnostics(),
      };
    }
    if (message.type === "CLEAN_LOCAL_WORKSPACE") {
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "") || !sender.tab?.id) {
        return { ok: false, code: "WORKSPACE_CLEANUP_FORBIDDEN", message: "Workspace cleanup is available only from the active local DraftForge tab." };
      }
      return cleanManagedLocalWorkspace(sender.tab.id, message.payload);
    }
    if (message.type === "CLOSE_PRACTICE_ROOM") {
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "")) {
        return { ok: false, code: "PRACTICE_CLOSE_FORBIDDEN", message: "Practice-room cleanup is available only from the local DraftForge app." };
      }
      const recovery = selectRecoveryWorkspace(await chrome.tabs.query({}), {
        appTabId: sender.tab?.id,
        draftLeagueId: message.payload?.draftLeagueId,
        sourceLeagueId: message.payload?.sourceLeagueId,
        teamId: message.payload?.teamId,
        season: message.payload?.season,
        appOrigins: DRAFTFORGE_APP_ORIGINS,
      });
      if (!recovery.ok) return { ...recovery, message: "DraftForge could not identify one exact ESPN practice room without ambiguity." };
      const { context, reloadedRoom } = await recoverExactDraftRoomContext({
        draftLeagueId: message.payload?.draftLeagueId,
        teamId: Number(message.payload?.teamId),
        roomTabId: recovery.roomTabId,
        findContext: findEspnContext,
        reloadTab: (tabId) => chrome.tabs.reload(tabId),
        waitForContext: waitForExactDraftRoomContext,
      });
      const verificationContext = context || {
        leagueId: String(message.payload?.draftLeagueId || ""),
        teamId: Number(message.payload?.teamId),
        season: Number(message.payload?.season),
        inDraftRoom: true,
        tabId: recovery.roomTabId,
      };
      let data;
      try {
        data = await importLeague(verificationContext);
      } catch {
        const proof = message.payload?.completedAuditProof;
        const exactCompletedAudit = completedAuditProvesPracticeRoom({
          proof,
          draftLeagueId: message.payload?.draftLeagueId,
          sourceLeagueId: message.payload?.sourceLeagueId,
          teamId: message.payload?.teamId,
          roomTabId: recovery.roomTabId,
        });
        if (exactCompletedAudit) {
          const cleanupTabIds = practiceWorkspaceCleanupTabIds(recovery, sender.tab?.id);
          if (cleanupTabIds.length) await chrome.tabs.remove(cleanupTabIds);
          return {
            ok: true,
            code: "PRACTICE_ROOM_CLOSED_AFTER_AUDIT",
            closedTabId: recovery.roomTabId,
            closedTabIds: cleanupTabIds,
            verifiedFromCompletedAudit: true,
            reloadedRoom,
            runtime: await runtimeDiagnostics(),
          };
        }
        return { ok: false, code: "PRACTICE_CLOSE_VERIFICATION_FAILED", message: "The exact ESPN practice room could not be verified before cleanup." };
      }
      if (String(data.league?.id) !== String(message.payload?.draftLeagueId)
        || Number(data.context?.teamId) !== Number(message.payload?.teamId)
        || Number(data.league?.season) !== Number(message.payload?.season)) {
        return { ok: false, code: "PRACTICE_CLOSE_IDENTITY_MISMATCH", message: "DraftForge refused to close a room whose authenticated ESPN identity changed." };
      }
      if (!String(data.league?.name || "").startsWith("Practice Draft for ")) {
        return { ok: false, code: "PRACTICE_ROOM_REQUIRED", message: "DraftForge refused to close a room that ESPN did not identify as a practice draft." };
      }
      const cleanupTabIds = practiceWorkspaceCleanupTabIds(recovery, sender.tab?.id);
      if (cleanupTabIds.length) await chrome.tabs.remove(cleanupTabIds);
      return {
        ok: true,
        code: "PRACTICE_ROOM_CLOSED",
        closedTabId: recovery.roomTabId,
        closedTabIds: cleanupTabIds,
        verifiedFromLiveContext: Boolean(context),
        reloadedRoom,
        runtime: await runtimeDiagnostics(),
      };
    }
    if (message.type === "RECOVER_LIVE_WORKSPACE") {
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "")) {
        return { ok: false, code: "RECOVERY_FORBIDDEN", message: "Live workspace recovery is available only from the local DraftForge app." };
      }
      if (!sender.tab?.id) return { ok: false, code: "RECOVERY_APP_TAB_REQUIRED", message: "A local DraftForge tab is required for recovery." };
      if (!validCommandCenterSessionId(message.payload?.commandCenterSessionId)) {
        return { ok: false, code: "COMMAND_CENTER_SESSION_INVALID", message: "Reload DraftForge before recovering the live workspace." };
      }
      appTabs.add(sender.tab.id);
      const recovery = selectRecoveryWorkspace(await chrome.tabs.query({}), {
        appTabId: sender.tab.id,
        draftLeagueId: message.payload?.draftLeagueId,
        sourceLeagueId: message.payload?.sourceLeagueId,
        teamId: message.payload?.teamId,
        season: message.payload?.season,
        appOrigins: DRAFTFORGE_APP_ORIGINS,
      });
      if (!recovery.ok) return { ...recovery, message: "DraftForge could not identify one exact ESPN live room without ambiguity." };

      const { context, reloadedRoom } = await recoverExactDraftRoomContext({
        draftLeagueId: message.payload?.draftLeagueId,
        teamId: Number(message.payload?.teamId),
        roomTabId: recovery.roomTabId,
        findContext: findEspnContext,
        reloadTab: (tabId) => chrome.tabs.reload(tabId),
        waitForContext: waitForExactDraftRoomContext,
      });
      if (!context) return { ok: false, code: "RECOVERY_CONTEXT_TIMEOUT", message: "The exact ESPN room did not reconnect before the recovery deadline." };

      const data = await importLeague(context);
      espnContext = { ...context, season: data.league.season };
      await establishActionBinding(
        espnContext,
        data.league,
        recovery.roomTabId,
        sender.tab.id,
        message.payload.commandCenterSessionId,
      );
      data.workspaceRecovery = {
        recovered: true,
        sourceLeagueId: String(message.payload?.sourceLeagueId || ""),
        roomLeagueId: String(data.league.id),
        roomTabId: recovery.roomTabId,
      };
      const cleanupTabIds = [...new Set([...recovery.staleAppTabIds, ...recovery.sourceLeagueTabIds])]
        .filter((tabId) => tabId !== recovery.roomTabId && tabId !== sender.tab.id);
      if (cleanupTabIds.length) await chrome.tabs.remove(cleanupTabIds);
      const visibility = await keepLiveRoomVisible(recovery.roomTabId, sender.tab);
      data.runtime = await runtimeDiagnostics();
      await broadcast("DF_IMPORT_SUCCESS", data);
      return { ok: true, code: "LIVE_WORKSPACE_RECOVERED", data, closedTabCount: cleanupTabIds.length, visibility, reloadedRoom };
    }
    if (message.type === "ESPN_CONTEXT") {
      espnContext = { ...message.payload, tabId: sender.tab?.id };
      const roomWatch = await recoverWatchedLiveRoom(espnContext, sender.tab);
      await broadcast("DF_ESPN_CONTEXT", espnContext);
      const poll = espnContext.inDraftRoom && espnContext.leagueId
        ? await pollDraftIfDue(espnContext)
        : { skipped: true, reason: "NOT_IN_DRAFT_ROOM" };
      return { ok: true, poll, roomWatch };
    }
    if (message.type === "ESPN_HEARTBEAT") {
      const context = { ...message.payload, tabId: sender.tab?.id };
      if (!context.inDraftRoom || !context.leagueId) return { ok: true, skipped: true };
      return pollDraftIfDue(context);
    }
    if (message.type === "ESPN_ACTION_RESOLVED") {
      await ensureActionBinding();
      const action = message.payload || {};
      const senderTabId = Number(sender.tab?.id);
      const context = actionBinding
        ? await findEspnContext(actionBinding.leagueId, senderTabId)
        : null;
      if (!resultMatchesActionBinding(actionBinding, action, context, senderTabId)) {
        return { ok: false, code: "ACTION_RESOLUTION_REJECTED" };
      }
      await broadcastBoundActionResult("DF_ACTION_RESOLVED", { ...action, tabId: senderTabId });
      return { ok: true };
    }
    if (message.type === "ESPN_ACTION_SUBMITTED") {
      await ensureActionBinding();
      const action = message.payload || {};
      const senderTabId = Number(sender.tab?.id);
      const context = actionBinding
        ? await findEspnContext(actionBinding.leagueId, senderTabId)
        : null;
      if (!resultMatchesActionBinding(actionBinding, action, context, senderTabId)) {
        return { ok: false, code: "ACTION_SUBMISSION_REJECTED" };
      }
      await broadcastBoundActionResult("DF_ACTION_SUBMITTED", { ...action, tabId: senderTabId });
      return { ok: true };
    }
    if (message.type === "REFRESH_ESPN_CONTEXT") {
      await ensureActionBinding();
      const autoArmRequestId = Number(message.payload?.autoArmRequestId);
      const verification = Number.isInteger(autoArmRequestId) ? { autoArmRequestId } : {};
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!Number.isInteger(expectedTabId)) return { ok: false, ...verification, code: "DRAFT_TAB_REQUIRED", message: "Reconnect the exact ESPN draft tab before refreshing." };
      if (!actionBinding || Number(sender.tab?.id) !== actionBinding.appTabId) {
        return { ok: false, ...verification, code: "DRAFT_BINDING_REQUIRED", message: "Reconnect the exact ESPN draft room before refreshing its live binding." };
      }
      if (!commandCenterSessionMatchesBinding(message.payload)) {
        return { ok: false, ...verification, code: "COMMAND_CENTER_SESSION_CHANGED", message: "This DraftForge page is not the command center bound to the ESPN room. Reconnect before refreshing." };
      }
      let context = await findEspnContext(message.payload?.expectedLeagueId, expectedTabId);
      if (!context) {
        context = await findUniqueDraftRoomContext(message.payload?.expectedLeagueId, Number(message.payload?.expectedTeamId));
        if (context && reboundMatchesActionBinding(actionBinding, context, sender.tab?.id)) {
          const previousTabId = actionBinding.tabId;
          await establishActionBinding(
            context,
            actionBinding,
            context.tabId,
            sender.tab.id,
            message.payload.commandCenterSessionId,
          );
          return { ok: true, ...verification, context, rebound: true, previousTabId };
        }
        return { ok: false, ...verification, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed or is ambiguous. Reconnect before submitting." };
      }
      if (!actionMatchesBinding(message.payload, context, expectedTabId)) {
        return { ok: false, ...verification, code: "DRAFT_ACTION_IDENTITY_CHANGED", message: "The exact ESPN league, team, season, or bound tab changed. Reconnect before submitting." };
      }
      return { ok: true, ...verification, context };
    }
    if (message.type === "CONNECT_ESPN") {
      if (sender.tab?.id) appTabs.add(sender.tab.id);
      const requestedLeagueId = message.payload?.leagueId;
      if (!validCommandCenterSessionId(message.payload?.commandCenterSessionId)) {
        return { ok: false, code: "COMMAND_CENTER_SESSION_INVALID", message: "Reload DraftForge before connecting to ESPN." };
      }
      const detected = await waitForEspnContext(requestedLeagueId);
      const context = { ...(detected || (!requestedLeagueId ? espnContext : {}) || {}) };
      if (message.payload?.season) context.season = message.payload.season;
      if (!context.leagueId || !context.tabId) return { ok: false, code: "NO_LEAGUE", message: "Open the exact ESPN league or draft tab, then connect again." };
      const data = await importLeague(context);
      data.runtime = await runtimeDiagnostics();
      espnContext = { ...context, season: data.league.season };
      await establishActionBinding(
        espnContext,
        data.league,
        context.tabId,
        sender.tab?.id,
        message.payload.commandCenterSessionId,
      );
      await broadcast("DF_IMPORT_SUCCESS", data);
      return { ok: true, data };
    }
    if (message.type === "SUBMIT_ACTION") {
      await ensureActionBinding();
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!Number.isInteger(expectedTabId)) return { ok: false, code: "DRAFT_TAB_REQUIRED", message: "Reconnect the exact ESPN draft tab before submitting." };
      if (!actionBinding || Number(sender.tab?.id) !== actionBinding.appTabId) {
        return { ok: false, code: "DRAFT_BINDING_REQUIRED", message: "Reconnect the exact ESPN draft room before submitting." };
      }
      if (!commandCenterSessionMatchesBinding(message.payload)) {
        return { ok: false, code: "COMMAND_CENTER_SESSION_CHANGED", message: "This DraftForge page is not the command center bound to the ESPN room. Reconnect before submitting." };
      }
      const context = await findEspnContext(message.payload?.expectedLeagueId, expectedTabId);
      if (!context?.tabId) return { ok: false, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed. Reconnect before submitting." };
      if (!actionMatchesBinding(message.payload, context, expectedTabId)) {
        return { ok: false, code: "DRAFT_ACTION_IDENTITY_CHANGED", message: "The exact ESPN league, team, season, or bound tab changed. DraftForge sent no action." };
      }
      const exactAction = {
        ...message.payload,
        expectedTeamId: actionBinding.teamId,
        expectedSeason: actionBinding.season,
      };
      const result = await chrome.tabs.sendMessage(context.tabId, { type: "DF_EXECUTE_ACTION", payload: exactAction });
      const actionResult = { ...result, action: result?.action || exactAction };
      await broadcastBoundActionResult("DF_ACTION_RESULT", actionResult);
      return actionResult;
    }
    if (message.type === "DISABLE_ESPN_AUTOPICK") {
      await ensureActionBinding();
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!Number.isInteger(expectedTabId)) return { ok: false, code: "DRAFT_TAB_REQUIRED", message: "Reconnect the exact ESPN draft tab before changing Autopick." };
      if (!actionBinding || Number(sender.tab?.id) !== actionBinding.appTabId) {
        return { ok: false, code: "DRAFT_BINDING_REQUIRED", message: "Reconnect the exact ESPN draft room before changing Autopick." };
      }
      if (!commandCenterSessionMatchesBinding(message.payload)) {
        return { ok: false, code: "COMMAND_CENTER_SESSION_CHANGED", message: "This DraftForge page is not the command center bound to the ESPN room. Reconnect before changing Autopick." };
      }
      const context = await findEspnContext(message.payload?.expectedLeagueId, expectedTabId);
      if (!context?.tabId) return { ok: false, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed. Reconnect before changing Autopick." };
      if (!actionMatchesBinding(message.payload, context, expectedTabId)) {
        return { ok: false, code: "DRAFT_ACTION_IDENTITY_CHANGED", message: "The exact ESPN league, team, season, or bound tab changed. DraftForge left Autopick untouched." };
      }
      return chrome.tabs.sendMessage(context.tabId, {
        type: "DF_DISABLE_AUTOPICK",
        payload: { ...message.payload, expectedTeamId: actionBinding.teamId, expectedSeason: actionBinding.season },
      });
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

chrome.tabs.onRemoved.addListener((tabId) => {
  appTabs.delete(tabId);
  if (tabRemovalInvalidatesActionBinding(actionBinding, tabId)) {
    void clearActionBinding();
  }
});
