import { normalizeImportPicks, normalizePicks } from "./draft-normalizers.js";
import { normalizeSettings } from "./league-import.js";
import { normalizePlayers } from "./player-normalizers.js";
import { createPollCoordinator } from "./poll-coordinator.js";
import { verifyServerDispatchLease } from "./server-dispatch-lease.js";
import { selectUniqueEspnContext } from "./context-selector.js";
import {
  DRAFTFORGE_APP_ORIGINS,
  DRAFTFORGE_LOCAL_APP_ORIGINS,
  authorizeRuntimeMessage,
  isLocalDraftForgeSenderUrl,
} from "./origin-policy.js";
import { selectRecoveryWorkspace } from "./recovery-targets.js";
import { recoverExactDraftRoomContext } from "./recovery-context.js";
import {
  contextCanTriggerLiveRoomWatch,
  createLiveRoomHandoffCoordinator,
  createLiveRoomWatch,
  liveLeagueMatchesWatch,
} from "./live-room-watch.js";
import {
  actionAvailabilityDeadlineStatus,
  actionDeadlineStatus,
  actionPayloadMatchesBinding,
  reboundMatchesActionBinding,
  restoredBindingMatchesEvidence,
  resultMatchesActionBinding,
  sanitizeActionBinding,
  tabRemovalInvalidatesActionBinding,
  validCommandCenterSessionId,
} from "./action-binding.js";
import {
  authorizeWorkspaceMessage,
  completedAuditProvesPracticeRoom,
  practiceWorkspaceCleanupTabIds,
  resolveWorkspaceRole,
  resolveWorkspaceWriterTabId,
  selectManagedWorkspaceCleanup,
} from "./workspace-lifecycle.js";

const appTabs = new Set();
let espnContext = null;
let liveRoomWatch = null;
let actionBinding = null;
let actionBindingGeneration = 0;
let actionBindingMutationTail = Promise.resolve();
let writerLease = null;
let workspaceWriterAppTabId = null;
let workspaceWriterMutationTail = Promise.resolve();
const liveRoomHandoffs = createLiveRoomHandoffCoordinator();
const minimumActionAuthorizationEpochs = new Map();
const espnContextProducerStates = new Map();
const LIVE_DRAFT_POLL_FETCH_TIMEOUT_MS = 1100;
const LIVE_DRAFT_POLL_COORDINATOR_TIMEOUT_MS = 1200;
const PRE_ROOM_IMPORT_TIMEOUT_MS = 12000;
const LIVE_ROOM_HANDOFF_TIMEOUT_MS = 1500;
const LIVE_WORKSPACE_RECOVERY_TIMEOUT_MS = 4000;
const draftPolls = createPollCoordinator({
  minIntervalMs: 1800,
  taskTimeoutMs: LIVE_DRAFT_POLL_COORDINATOR_TIMEOUT_MS,
});
const CONNECT_CONTEXT_TIMEOUT_MS = 4000;
const CONNECT_CONTEXT_RETRY_MS = 150;
const RECOVERY_CONTEXT_TIMEOUT_MS = 12000;
const APP_BROADCAST_TIMEOUT_MS = 250;
const WRITER_LEASE_TTL_MS = 1500;
const LIVE_ROOM_WATCH_STORAGE_KEY = "draftForgeLiveRoomWatchV1";
const ACTION_BINDING_STORAGE_KEY = "draftForgeActionBindingV1";
const WORKSPACE_WRITER_STORAGE_KEY = "draftForgeWorkspaceWriterV1";
const EXTENSION_INTEGRITY_DOMAIN = "draftforge-extension-tree-v1";
const EXTENSION_SOURCE_FILES = Object.freeze([
  "README.md",
  "action-binding.js",
  "app-bridge.js",
  "background.js",
  "context-selector.js",
  "draft-normalizers.js",
  "espn-content.js",
  "league-import.js",
  "league-normalizers.js",
  "live-room-watch.js",
  "manifest.json",
  "origin-policy.js",
  "player-normalizers.js",
  "poll-coordinator.js",
  "recovery-context.js",
  "recovery-targets.js",
  "server-dispatch-lease.js",
  "workspace-lifecycle.js",
]);

function integrityHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function integritySha256(bytes) {
  return integrityHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function computeInstalledExtensionIntegrity() {
  const files = [];
  for (const path of EXTENSION_SOURCE_FILES) {
    const response = await fetch(chrome.runtime.getURL(path), { cache: "no-store" });
    if (!response.ok || response.redirected) throw new Error("EXTENSION_SOURCE_READ_FAILED");
    const bytes = await response.arrayBuffer();
    files.push({ path, bytes: bytes.byteLength, sha256: await integritySha256(bytes) });
  }
  const canonical = `${EXTENSION_INTEGRITY_DOMAIN}\n${files
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((file) => `${new TextEncoder().encode(file.path).byteLength}:${file.path}\0${file.bytes}:${file.sha256}\n`)
    .join("")}`;
  return {
    sha256: await integritySha256(new TextEncoder().encode(canonical)),
    fileCount: files.length,
  };
}

const installedExtensionIntegrityPromise = computeInstalledExtensionIntegrity()
  .catch(() => ({ sha256: "", fileCount: 0 }));

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
    sourcePlayersFetchedAt: String(watch.sourcePlayersFetchedAt || ""),
    sourcePlayerEnvelope: {
      fetchedAt: String(watch.sourcePlayerEnvelope?.fetchedAt || ""),
      leagueId: String(watch.sourcePlayerEnvelope?.leagueId || ""),
      teamId: Number(watch.sourcePlayerEnvelope?.teamId || 0),
      season: Number(watch.sourcePlayerEnvelope?.season || 0),
      playerCount: Number(watch.sourcePlayerEnvelope?.playerCount || 0),
    },
    autoArmRequested: watch.autoArmRequested === true,
    armedAt: Number(watch.armedAt),
    expiresAt: Number(watch.expiresAt),
    processingTabId: Number.isInteger(Number(watch.processingTabId)) ? Number(watch.processingTabId) : null,
    commandCenterSessionId: String(watch.commandCenterSessionId || ""),
  };
}

function validStoredLiveRoomWatch(watch, now = Date.now()) {
  const playersFetchedAtMs = Date.parse(String(watch?.sourcePlayersFetchedAt || ""));
  return Boolean(watch
    && Number.isInteger(watch.appTabId) && watch.appTabId > 0
    && Number.isInteger(watch.sourceTabId) && watch.sourceTabId > 0
    && watch.sourceLeagueId
    && Number.isInteger(watch.teamId) && watch.teamId > 0
    && Number.isInteger(watch.season) && watch.season > 0
    && typeof watch.rules === "string" && watch.rules.length > 0
    && Array.isArray(watch.sourcePlayers) && watch.sourcePlayers.length > 0
    && Number.isFinite(playersFetchedAtMs)
    && new Date(playersFetchedAtMs).toISOString() === watch.sourcePlayersFetchedAt
    && watch.sourcePlayerEnvelope?.fetchedAt === watch.sourcePlayersFetchedAt
    && watch.sourcePlayerEnvelope?.leagueId === watch.sourceLeagueId
    && Number(watch.sourcePlayerEnvelope?.teamId) === Number(watch.teamId)
    && Number(watch.sourcePlayerEnvelope?.season) === Number(watch.season)
    && Number(watch.sourcePlayerEnvelope?.playerCount) === watch.sourcePlayers.length
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

function proposedDraftActionBinding(context, league, tabId = context?.tabId, appTabId, commandCenterSessionId) {
  const leagueId = String(league?.id || context?.leagueId || "");
  const teamId = Number(league?.teamId || context?.teamId || 0);
  const season = Number(league?.season || context?.season || 0);
  const exactTabId = Number(tabId);
  const exactAppTabId = Number(appTabId);
  const exactCommandCenterSessionId = String(commandCenterSessionId || "");
  return leagueId
    && Number.isInteger(teamId) && teamId > 0
    && Number.isInteger(season) && season > 0
    && Number.isInteger(exactTabId) && exactTabId > 0
    && Number.isInteger(exactAppTabId) && exactAppTabId > 0
    && validCommandCenterSessionId(exactCommandCenterSessionId)
      ? { leagueId, teamId, season, tabId: exactTabId, appTabId: exactAppTabId, commandCenterSessionId: exactCommandCenterSessionId }
      : null;
}

async function persistActionBinding(binding) {
  const sanitized = sanitizeActionBinding(binding);
  if (!sanitized) {
    await chrome.storage.session.remove(ACTION_BINDING_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [ACTION_BINDING_STORAGE_KEY]: sanitized });
}

function sameActionBinding(left, right) {
  return Boolean(left && right
    && left.leagueId === right.leagueId
    && left.teamId === right.teamId
    && left.season === right.season
    && left.tabId === right.tabId
    && left.appTabId === right.appTabId
    && left.commandCenterSessionId === right.commandCenterSessionId);
}

function newWriterLease(binding, now = Date.now()) {
  if (!binding) return null;
  const leaseId = globalThis.crypto?.randomUUID?.()
    || `${now}-${Math.random().toString(36).slice(2)}`;
  return {
    leaseId,
    appTabId: binding.appTabId,
    commandCenterSessionId: binding.commandCenterSessionId,
    bindingGeneration: actionBindingGeneration,
    expiresAt: now + WRITER_LEASE_TTL_MS,
  };
}

function renewWriterLease(binding, now = Date.now()) {
  if (!binding) {
    writerLease = null;
    return null;
  }
  const sameLease = writerLease
    && writerLease.appTabId === binding.appTabId
    && writerLease.commandCenterSessionId === binding.commandCenterSessionId
    && writerLease.bindingGeneration === actionBindingGeneration;
  writerLease = sameLease
    ? { ...writerLease, expiresAt: now + WRITER_LEASE_TTL_MS }
    : newWriterLease(binding, now);
  return writerLease;
}

function writerLeaseAuthorizes(binding, payload, senderTabId, now = Date.now()) {
  return Boolean(binding
    && writerLease
    && Number(senderTabId) === Number(binding.tabId)
    && writerLease.appTabId === binding.appTabId
    && writerLease.commandCenterSessionId === binding.commandCenterSessionId
    && writerLease.bindingGeneration === actionBindingGeneration
    && writerLease.expiresAt > now
    && String(payload?.writerLeaseId || "") === writerLease.leaseId
    && actionPayloadMatchesBinding(binding, payload, {
      leagueId: binding.leagueId,
      teamId: binding.teamId,
      season: binding.season,
      inDraftRoom: true,
      tabId: binding.tabId,
    }, binding.tabId));
}

async function revokePriorActionBinding(binding) {
  if (!binding) return true;
  rememberMinimumActionAuthorizationEpoch(binding.commandCenterSessionId, Number.MAX_SAFE_INTEGER);
  try {
    const result = await withOperationDeadline(
      APP_BROADCAST_TIMEOUT_MS,
      "PRIOR_ACTION_BINDING_REVOCATION_TIMEOUT",
      () => chrome.tabs.sendMessage(binding.tabId, {
        type: "DF_CANCEL_PENDING_ACTIONS",
        payload: {
          commandCenterSessionId: binding.commandCenterSessionId,
          minimumAuthorizationEpoch: Number.MAX_SAFE_INTEGER,
          bindingRevocation: true,
        },
      }),
    );
    if (result?.ok !== true) throw new Error("PRIOR_ACTION_BINDING_REVOCATION_REJECTED");
    return true;
  } catch (error) {
    const oldTab = await chrome.tabs.get(binding.tabId).catch(() => null);
    if (!oldTab) return true;
    // A living tab whose prior content script cannot acknowledge revocation
    // is reloaded before authority can move. Navigation destroys any old
    // in-flight closure that might otherwise reach its final click.
    try {
      await chrome.tabs.reload(binding.tabId);
      return true;
    } catch {
      const failure = new Error("PRIOR_ACTION_BINDING_REVOCATION_FAILED");
      failure.cause = error;
      throw failure;
    }
  }
}

async function clearActionBindingNow({ revoke = true } = {}) {
  const previous = actionBinding;
  if (revoke && previous) await revokePriorActionBinding(previous);
  if (actionBinding !== null) actionBindingGeneration += 1;
  actionBinding = null;
  writerLease = null;
  await persistActionBinding(null);
}

function enqueueActionBindingMutation(operation) {
  const queued = actionBindingMutationTail.then(operation);
  actionBindingMutationTail = queued.then(() => undefined, () => undefined);
  return queued;
}

async function clearActionBinding() {
  await actionBindingRestore;
  return enqueueActionBindingMutation(() => clearActionBindingNow());
}

async function establishActionBinding(context, league, tabId, appTabId, commandCenterSessionId) {
  await actionBindingRestore;
  return enqueueActionBindingMutation(async () => {
    if (context?.inDraftRoom !== true) {
      await clearActionBindingNow();
      return null;
    }
    const binding = proposedDraftActionBinding(context, league, tabId, appTabId, commandCenterSessionId);
    if (!binding) {
      await clearActionBindingNow();
      return null;
    }
    if (!sameActionBinding(actionBinding, binding)) {
      await revokePriorActionBinding(actionBinding);
      actionBinding = binding;
      actionBindingGeneration += 1;
      writerLease = null;
    }
    await persistActionBinding(actionBinding);
    workspaceWriterAppTabId = actionBinding.appTabId;
    await persistWorkspaceWriter(actionBinding.appTabId);
    appTabs.add(actionBinding.appTabId);
    renewWriterLease(actionBinding);
    return actionBinding;
  });
}

async function restoreActionBinding() {
  try {
    const stored = sanitizeActionBinding(
      (await chrome.storage.session.get(ACTION_BINDING_STORAGE_KEY))?.[ACTION_BINDING_STORAGE_KEY],
    );
    if (!stored) {
      await clearActionBindingNow({ revoke: false });
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
    }, DRAFTFORGE_LOCAL_APP_ORIGINS)) {
      await clearActionBindingNow({ revoke: false });
      return null;
    }
    actionBinding = stored;
    actionBindingGeneration += 1;
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

async function persistWorkspaceWriter(appTabId) {
  const exactAppTabId = Number(appTabId);
  if (!Number.isInteger(exactAppTabId) || exactAppTabId <= 0) {
    await chrome.storage.session.remove(WORKSPACE_WRITER_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [WORKSPACE_WRITER_STORAGE_KEY]: exactAppTabId });
}

async function restoreWorkspaceWriter() {
  await Promise.all([actionBindingRestore, liveRoomWatchRestore]);
  try {
    const stored = Number((await chrome.storage.session.get(WORKSPACE_WRITER_STORAGE_KEY))?.[WORKSPACE_WRITER_STORAGE_KEY]);
    const authorityTabId = resolveWorkspaceWriterTabId({
      actionBinding,
      liveRoomWatch,
      writerAppTabId: stored,
    });
    if (!authorityTabId) {
      workspaceWriterAppTabId = null;
      await persistWorkspaceWriter(null);
      return null;
    }
    const tab = await chrome.tabs.get(authorityTabId).catch(() => null);
    const authorization = authorizeRuntimeMessage("APP_HELLO", tab?.url || "");
    if (!tab || !authorization.ok || authorization.senderKind !== "app") {
      // Never discard a still-valid exact action binding merely because the
      // writer's app bridge is temporarily unavailable. The binding restore
      // path already validates both tabs and remains authoritative.
      if (Number(actionBinding?.appTabId) === authorityTabId) {
        workspaceWriterAppTabId = authorityTabId;
        return authorityTabId;
      }
      workspaceWriterAppTabId = null;
      await persistWorkspaceWriter(null);
      return null;
    }
    workspaceWriterAppTabId = authorityTabId;
    appTabs.add(authorityTabId);
    await persistWorkspaceWriter(authorityTabId);
    return authorityTabId;
  } catch {
    workspaceWriterAppTabId = Number(actionBinding?.appTabId) || Number(liveRoomWatch?.appTabId) || null;
    return workspaceWriterAppTabId;
  }
}

const workspaceWriterRestore = restoreWorkspaceWriter();

function workspaceAuthority() {
  return { actionBinding, liveRoomWatch, writerAppTabId: workspaceWriterAppTabId };
}

async function reconcileWorkspaceHello(senderTabId) {
  const exactSenderTabId = Number(senderTabId);
  const operation = workspaceWriterMutationTail.then(async () => {
    await Promise.all([actionBindingRestore, liveRoomWatchRestore, workspaceWriterRestore]);
    const tabs = await chrome.tabs.query({});
    const protectedWriterTabId = resolveWorkspaceWriterTabId({
      actionBinding,
      liveRoomWatch,
      writerAppTabId: null,
    });
    const electionSenderTabId = Number.isInteger(protectedWriterTabId)
      ? protectedWriterTabId
      : exactSenderTabId;
    const selection = selectManagedWorkspaceCleanup(tabs, {
      senderTabId: electionSenderTabId,
      appOrigins: DRAFTFORGE_LOCAL_APP_ORIGINS,
      electNewest: !Number.isInteger(protectedWriterTabId),
      protectedWriterTabId,
    });
    if (!selection.ok) return { ...selection, cleanupTabIds: [] };

    const electedWriterTabId = Number(selection.leaderTabId);
    if (selection.code === "LOCAL_WORKSPACE_STANDBY") {
      workspaceWriterAppTabId = electedWriterTabId;
      await persistWorkspaceWriter(electedWriterTabId);
      const leaderSelection = selectManagedWorkspaceCleanup(tabs, {
        senderTabId: electedWriterTabId,
        appOrigins: DRAFTFORGE_LOCAL_APP_ORIGINS,
        protectedWriterTabId,
      });
      if (!leaderSelection.ok) return { ...leaderSelection, cleanupTabIds: [] };
      selection.cleanupTabIds = leaderSelection.cleanupTabIds;
      selection.leaderTabId = electedWriterTabId;
    } else {
      workspaceWriterAppTabId = electedWriterTabId;
      await persistWorkspaceWriter(electedWriterTabId);
    }

    const cleanupTabIds = selection.cleanupTabIds
      .map(Number)
      .filter((tabId) => Number.isInteger(tabId) && tabId !== electedWriterTabId);
    const immediateCleanup = cleanupTabIds.filter((tabId) => tabId !== exactSenderTabId);
    if (immediateCleanup.length) await chrome.tabs.remove(immediateCleanup);
    for (const tabId of cleanupTabIds) appTabs.delete(tabId);
    if (cleanupTabIds.includes(exactSenderTabId)) {
      // Let the observer receive its deterministic role/leader response before
      // closing only that duplicate local DraftForge document.
      setTimeout(() => chrome.tabs.remove(exactSenderTabId).catch(() => {}), 0);
    }
    return {
      ...resolveWorkspaceRole(workspaceAuthority(), exactSenderTabId),
      leaderTabId: electedWriterTabId,
      cleanupTabIds,
    };
  });
  workspaceWriterMutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function workspaceMessageAuthorization(senderTabId, messageType) {
  await workspaceWriterRestore;
  return authorizeWorkspaceMessage(workspaceAuthority(), senderTabId, messageType);
}

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

function actionAuthorizationStatus(payload) {
  const sessionId = String(payload?.commandCenterSessionId || "");
  const epoch = Number(payload?.authorizationEpoch);
  if (!validCommandCenterSessionId(sessionId) || !Number.isSafeInteger(epoch) || epoch < 0) {
    return "ACTION_AUTHORIZATION_INVALID";
  }
  const minimumEpoch = Number(minimumActionAuthorizationEpochs.get(sessionId) || 0);
  return epoch < minimumEpoch ? "ACTION_AUTHORIZATION_REVOKED" : "ACTION_AUTHORIZATION_VALID";
}

function rememberMinimumActionAuthorizationEpoch(sessionId, minimumEpoch) {
  const current = Number(minimumActionAuthorizationEpochs.get(sessionId) || 0);
  minimumActionAuthorizationEpochs.set(sessionId, Math.max(current, minimumEpoch));
  while (minimumActionAuthorizationEpochs.size > 16) {
    const oldest = minimumActionAuthorizationEpochs.keys().next().value;
    if (oldest === undefined) break;
    minimumActionAuthorizationEpochs.delete(oldest);
  }
}

function acceptEspnProducerContext(payload, tabId) {
  const producerSessionId = String(payload?.producerSessionId || "");
  const producerRevision = Number(payload?.producerRevision);
  const capturedAtMs = Date.parse(String(payload?.contextCapturedAt || ""));
  if (!producerSessionId || producerSessionId.length > 128
    || !Number.isSafeInteger(producerRevision) || producerRevision <= 0
    || !Number.isFinite(capturedAtMs)) return false;
  const namespace = [tabId, payload?.leagueId || "", payload?.teamId || 0, payload?.season || 0].join(":");
  const previous = espnContextProducerStates.get(namespace);
  if (previous) {
    if (previous.producerSessionId === producerSessionId) {
      if (producerRevision <= previous.producerRevision) return false;
    } else if (capturedAtMs <= previous.capturedAtMs) {
      return false;
    }
  }
  espnContextProducerStates.set(namespace, { producerSessionId, producerRevision, capturedAtMs });
  while (espnContextProducerStates.size > 32) {
    const oldest = espnContextProducerStates.keys().next().value;
    if (oldest === undefined) break;
    espnContextProducerStates.delete(oldest);
  }
  return true;
}

async function broadcastBoundActionResult(type, payload, binding = actionBinding) {
  const appTabId = Number(binding?.appTabId);
  if (!Number.isInteger(appTabId)) return false;
  // Action results always go to the exact writer first. A renderer that is
  // momentarily busy cannot hold the service worker or any later ESPN event
  // hostage; the command center independently fails closed on a missing ack.
  return sendBoundedAppMessage(appTabId, type, payload);
}

function actionMatchesBinding(payload, context, expectedTabId) {
  return actionPayloadMatchesBinding(actionBinding, payload, context, expectedTabId);
}

function originForTab(tab) {
  try { return new URL(tab?.url || "").origin; }
  catch { return ""; }
}

async function runtimeDiagnostics() {
  const [tabs, extensionIntegrity] = await Promise.all([
    chrome.tabs.query({}),
    installedExtensionIntegrityPromise,
  ]);
  return {
    capturedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    extensionSourceSha256: extensionIntegrity.sha256,
    extensionSourceFileCount: extensionIntegrity.fileCount,
    browserTabCount: tabs.length,
    draftForgeTabCount: tabs.filter((tab) => DRAFTFORGE_APP_ORIGINS.includes(originForTab(tab))).length,
    espnTabCount: tabs.filter((tab) => originForTab(tab) === "https://fantasy.espn.com").length,
    workspaceWriterTabId: resolveWorkspaceWriterTabId(workspaceAuthority()),
    managedCleanupReady: true,
  };
}

async function cleanManagedLocalWorkspace(senderTabId, payload = {}) {
  const selection = selectManagedWorkspaceCleanup(await chrome.tabs.query({}), {
    senderTabId,
    appOrigins: DRAFTFORGE_LOCAL_APP_ORIGINS,
    ownedBlankTabIds: payload.ownedBlankTabIds,
    electNewest: payload.electNewest === true,
    protectedWriterTabId: resolveWorkspaceWriterTabId(workspaceAuthority()),
  });
  if (!selection.ok) return selection;
  if (selection.cleanupTabIds.length) await chrome.tabs.remove(selection.cleanupTabIds);
  return {
    ...selection,
    closedTabIds: selection.cleanupTabIds,
    runtime: await runtimeDiagnostics(),
  };
}

async function sendBoundedAppMessage(tabId, type, payload) {
  let timeoutId;
  const delivery = chrome.tabs.sendMessage(tabId, { type, payload }).then(
    () => true,
    () => {
      appTabs.delete(tabId);
      return false;
    },
  );
  try {
    return await Promise.race([
      delivery,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), APP_BROADCAST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function broadcast(type, payload) {
  const writerTabId = resolveWorkspaceWriterTabId(workspaceAuthority());
  const recipients = [...new Set([...appTabs].map(Number).filter(Number.isInteger))];
  if (Number.isInteger(writerTabId)) {
    await sendBoundedAppMessage(writerTabId, type, payload);
  }
  const observers = recipients.filter((tabId) => tabId !== writerTabId);
  // Observer delivery is best-effort and concurrent. It can never delay ESPN
  // polling, action acknowledgements, or the writer's next decision cycle.
  void Promise.allSettled(observers.map((tabId) => sendBoundedAppMessage(tabId, type, payload)));
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

async function waitForExactDraftRoomContext(expectedLeagueId, expectedTeamId, expectedTabId, signal) {
  const deadline = Date.now() + RECOVERY_CONTEXT_TIMEOUT_MS;
  do {
    if (signal?.aborted) return null;
    const context = await findEspnContext(expectedLeagueId, expectedTabId);
    if (context?.inDraftRoom === true && Number(context.teamId) === Number(expectedTeamId)) return context;
    if (signal?.aborted) return null;
    await new Promise((resolve) => setTimeout(resolve, CONNECT_CONTEXT_RETRY_MS));
  } while (Date.now() < deadline && !signal?.aborted);
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
  const {
    timeoutMs: requestedTimeoutMs,
    timeoutCode: requestedTimeoutCode,
    ...fetchOptions
  } = options;
  const timeoutMs = Number.isFinite(Number(requestedTimeoutMs)) && Number(requestedTimeoutMs) > 0
    ? Math.floor(Number(requestedTimeoutMs))
    : 0;
  const timeoutCode = typeof requestedTimeoutCode === "string" && requestedTimeoutCode
    ? requestedTimeoutCode
    : "ESPN_REQUEST_TIMEOUT";
  const timeoutController = timeoutMs > 0 ? new AbortController() : null;
  const upstreamSignal = fetchOptions.signal;
  let timeoutId;
  let timedOut = false;
  let upstreamAbortHandler;

  if (timeoutController && upstreamSignal) {
    upstreamAbortHandler = () => timeoutController.abort(upstreamSignal.reason);
    if (upstreamSignal.aborted) upstreamAbortHandler();
    else upstreamSignal.addEventListener("abort", upstreamAbortHandler, { once: true });
  }

  try {
    if (timeoutController) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, timeoutMs);
    }
    const response = await fetch(url, {
      ...fetchOptions,
      credentials: "include",
      headers: { Accept: "application/json", ...(fetchOptions.headers || {}) },
      ...(timeoutController
        ? { signal: timeoutController.signal }
        : upstreamSignal
          ? { signal: upstreamSignal }
          : {}),
    });
    if (response.status === 401 || response.status === 403) throw new Error("ESPN_LOGIN_REQUIRED");
    if (!response.ok) throw new Error(`ESPN_${response.status}`);
    return await response.json();
  } catch (error) {
    if (timedOut) throw new Error(timeoutCode);
    if (upstreamSignal?.aborted) {
      const reason = upstreamSignal.reason;
      const code = typeof reason === "string"
        ? reason
        : typeof reason?.message === "string" && reason.message
          ? reason.message
          : "ESPN_REQUEST_ABORTED";
      throw new Error(code);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (upstreamSignal && upstreamAbortHandler) {
      upstreamSignal.removeEventListener("abort", upstreamAbortHandler);
    }
  }
}

async function withOperationDeadline(timeoutMs, timeoutCode, operation) {
  const controller = new AbortController();
  let timeoutId;
  let expired = false;
  const work = Promise.resolve().then(() => operation(controller.signal));
  // Promise.race bounds the caller even if a browser or mocked transport
  // ignores AbortSignal. Read helpers may finish late, but none of them own
  // action-binding mutation; authority is established only after this returns.
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      expired = true;
      controller.abort(new Error(timeoutCode));
      reject(new Error(timeoutCode));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (expired || controller.signal.aborted) throw new Error(timeoutCode);
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function fetchPlayers(leagueId, season, scoringLabel, options = {}) {
  const filter = {
    players: {
      limit: 500,
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: scoringLabel === "PPR" ? "PPR" : "STANDARD" },
      filterRanksForRankTypes: { value: [scoringLabel === "PPR" ? "PPR" : "STANDARD"] },
      filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 20, 21, 23] }
    }
  };
  const raw = await espnFetch(leagueUrl(leagueId, season, ["kona_player_info"]), {
    ...options,
    headers: { ...(options.headers || {}), "X-Fantasy-Filter": JSON.stringify(filter) },
  });
  return normalizePlayers(raw);
}

async function importLeagueMetadata(context, options = {}) {
  const season = Number(context.season || new Date().getFullYear());
  const raw = await espnFetch(
    leagueUrl(context.leagueId, season, ["mSettings", "mTeam", "mRoster", "mDraftDetail"]),
    options,
  );
  const league = normalizeSettings(raw, context);
  return { league, raw };
}

async function importLeague(context, options = {}) {
  const { league, raw } = await importLeagueMetadata(context, options);
  const season = Number(context.season || new Date().getFullYear());
  const players = await fetchPlayers(context.leagueId, season, league.scoringLabel, options);
  const authenticatedImportAt = new Date().toISOString();
  return { league, players, picks: normalizeImportPicks(raw), context, authenticatedImportAt };
}

function importPreRoomLeague(context) {
  return withOperationDeadline(
    PRE_ROOM_IMPORT_TIMEOUT_MS,
    "ESPN_PRE_ROOM_IMPORT_TIMEOUT",
    (signal) => importLeague(context, { signal }),
  );
}

function importLiveRoomMetadata(context) {
  return withOperationDeadline(
    LIVE_ROOM_HANDOFF_TIMEOUT_MS,
    "ESPN_LIVE_HANDOFF_TIMEOUT",
    (signal) => importLeagueMetadata(context, { signal }),
  );
}

async function readLiveWorkspaceRecovery({ draftLeagueId, teamId, roomTabId }) {
  return withOperationDeadline(
    LIVE_WORKSPACE_RECOVERY_TIMEOUT_MS,
    "ESPN_LIVE_RECOVERY_TIMEOUT",
    async (signal) => {
      const recovery = await recoverExactDraftRoomContext({
        draftLeagueId,
        teamId: Number(teamId),
        roomTabId,
        findContext: findEspnContext,
        reloadTab: (tabId) => chrome.tabs.reload(tabId),
        waitForContext: (leagueId, exactTeamId, exactTabId) => (
          waitForExactDraftRoomContext(leagueId, exactTeamId, exactTabId, signal)
        ),
      });
      if (signal.aborted) throw new Error("ESPN_LIVE_RECOVERY_TIMEOUT");
      if (!recovery.context) return { ...recovery, data: null };
      const data = await importLeague(recovery.context, { signal });
      if (signal.aborted) throw new Error("ESPN_LIVE_RECOVERY_TIMEOUT");
      return { ...recovery, data };
    },
  );
}

async function pollDraft(context, signal) {
  const raw = await espnFetch(
    leagueUrl(context.leagueId, Number(context.season || new Date().getFullYear()), ["mDraftDetail", "mTeam"]),
    {
      signal,
      timeoutMs: LIVE_DRAFT_POLL_FETCH_TIMEOUT_MS,
      timeoutCode: "ESPN_POLL_TIMEOUT",
    },
  );
  // The DOM producer owns volatile clock/nominee/bid state. A network poll can
  // finish after several newer DOM revisions, so it publishes only immutable
  // room identity plus authoritative picks—never its stale captured context.
  return {
    picks: normalizePicks(raw),
    draftDetail: raw.draftDetail || {},
    identity: {
      leagueId: String(context.leagueId || ""),
      teamId: Number(context.teamId || 0),
      season: Number(context.season || 0),
      tabId: Number(context.tabId || 0),
    },
  };
}

async function pollDraftIfDue(context) {
  try {
    return await draftPolls.run(context, async (signal, token) => {
      const data = await pollDraft(context, signal);
      if (signal.aborted || !draftPolls.isCurrent(context, token)) {
        return { skipped: true, reason: "ABORTED" };
      }
      await broadcast("DF_DRAFT_UPDATE", data);
      return { ok: true };
    });
  } catch (error) {
    // A completed or transient mock room may disappear from ESPN's API. Live
    // DOM context remains usable, and explicit imports/actions still fail closed.
    return { ok: false, code: error?.message || "ESPN_POLL_FAILED" };
  }
}

function scheduleDraftPoll(context) {
  // The ESPN content heartbeat must never wait on network I/O. The keyed poll
  // coordinator coalesces repeated triggers while espnFetch supplies the hard
  // transport deadline, so even a burst of heartbeats leaves one bounded poll.
  void pollDraftIfDue(context);
  return { scheduled: true };
}

async function performWatchedLiveRoomRecovery(watch, context, senderTab) {
  const roomTabId = Number(senderTab?.id);
  if (liveRoomWatch !== watch
    || !contextCanTriggerLiveRoomWatch(watch, { ...context, tabId: roomTabId })) return null;
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
    const { league, raw } = await importLiveRoomMetadata(exactContext);
    const data = {
      league,
      players: watch.sourcePlayers,
      picks: normalizeImportPicks(raw),
      context: exactContext,
      authenticatedImportAt: watch.sourcePlayersFetchedAt,
      authenticatedPlayerPoolEnvelope: { ...watch.sourcePlayerEnvelope },
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

async function recoverWatchedLiveRoom(context, senderTab) {
  await liveRoomWatchRestore;
  const watch = liveRoomWatch;
  const roomTabId = Number(senderTab?.id);
  if (!contextCanTriggerLiveRoomWatch(watch, { ...context, tabId: roomTabId })) return null;
  // ESPN can emit several monotonic DOM contexts before the first bounded
  // metadata import settles. Join an existing claim for this exact armed
  // watch; never import, bind, broadcast, focus, or clean up twice.
  return liveRoomHandoffs.run(
    watch,
    () => performWatchedLiveRoomRecovery(watch, context, senderTab),
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const authorization = authorizeRuntimeMessage(message?.type, sender.url || sender.tab?.url || "");
    if (!authorization.ok) return authorization;
    if (["app", "app-observer"].includes(authorization.senderKind) && sender.tab?.id) appTabs.add(sender.tab.id);
    if (message.type === "APP_HELLO") {
      const workspace = authorization.senderKind === "app"
        ? await reconcileWorkspaceHello(sender.tab?.id)
        : {
            ok: true,
            code: "WORKSPACE_REMOTE_OBSERVER",
            role: "observer",
            writerTabId: resolveWorkspaceWriterTabId(workspaceAuthority()),
          };
      const context = await findEspnContext();
      const helloSessionId = String(message.payload?.commandCenterSessionId || "");
      if (authorization.senderKind === "app"
        && actionBinding
        && Number(sender.tab?.id) === Number(actionBinding.appTabId)
        && validCommandCenterSessionId(helloSessionId)) {
        if (helloSessionId === actionBinding.commandCenterSessionId) {
          renewWriterLease(actionBinding);
        } else {
          // A dashboard reload keeps the Chrome tab id but creates a new
          // command-center session. Revoke the old content-script actuator
          // before the replacement page can become the writer.
          await clearActionBinding();
        }
      }
      return {
        ready: true,
        espnOpen: Boolean(context),
        context,
        workspace: {
          ...workspace,
        },
        runtime: await runtimeDiagnostics(),
      };
    }
    if (authorization.senderKind === "app") {
      const workspaceAuthorization = await workspaceMessageAuthorization(sender.tab?.id, message.type);
      if (!workspaceAuthorization.ok) {
        return {
          ...workspaceAuthorization,
          message: "This DraftForge tab is a read-only observer. Browser control remains bound to the original command center.",
        };
      }
    }
    if (message.type === "RELOAD_EXTENSION") {
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "")) {
        return { ok: false, code: "RELOAD_FORBIDDEN", message: "Companion self-reload is available only from the local DraftForge app." };
      }
      await clearActionBinding();
      setTimeout(() => chrome.runtime.reload(), 100);
      return { ok: true, code: "RELOADING", message: "Reloading the local DraftForge companion." };
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
      const sourceData = await importPreRoomLeague(sourceContext);
      if (String(sourceData.league?.draftType || "") !== String(message.payload?.draftType || "")) {
        return { ok: false, code: "LIVE_ROOM_WATCH_FORMAT_MISMATCH", message: "The authenticated ESPN draft format changed before the live-room handoff was armed." };
      }
      const watch = createLiveRoomWatch({
        appTabId: sender.tab.id,
        sourceContext,
        sourceLeague: sourceData.league,
        sourcePlayers: sourceData.players,
        sourcePlayersFetchedAt: sourceData.authenticatedImportAt,
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
        appOrigins: DRAFTFORGE_LOCAL_APP_ORIGINS,
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
        data = await importPreRoomLeague(verificationContext);
      } catch (error) {
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
        const code = error?.message === "ESPN_PRE_ROOM_IMPORT_TIMEOUT"
          ? "ESPN_PRE_ROOM_IMPORT_TIMEOUT"
          : "PRACTICE_CLOSE_VERIFICATION_FAILED";
        return { ok: false, code, message: "The exact ESPN practice room could not be verified before cleanup." };
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
        appOrigins: DRAFTFORGE_LOCAL_APP_ORIGINS,
      });
      if (!recovery.ok) return { ...recovery, message: "DraftForge could not identify one exact ESPN live room without ambiguity." };

      const { context, reloadedRoom, data } = await readLiveWorkspaceRecovery({
        draftLeagueId: message.payload?.draftLeagueId,
        teamId: Number(message.payload?.teamId),
        roomTabId: recovery.roomTabId,
      });
      if (!context) return { ok: false, code: "RECOVERY_CONTEXT_TIMEOUT", message: "The exact ESPN room did not reconnect before the recovery deadline." };

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
      if (Number(espnContext?.tabId) === Number(sender.tab?.id)
        && String(espnContext?.leagueId || "") !== String(message.payload?.leagueId || "")) {
        draftPolls.retireTab(Number(sender.tab?.id), "NAVIGATION");
      }
      if (!acceptEspnProducerContext(message.payload, Number(sender.tab?.id))) {
        return { ok: true, skipped: true, code: "ESPN_CONTEXT_STALE_OR_UNSEQUENCED" };
      }
      espnContext = { ...message.payload, tabId: sender.tab?.id };
      const roomWatch = await recoverWatchedLiveRoom(espnContext, sender.tab);
      await broadcast("DF_ESPN_CONTEXT", espnContext);
      const poll = espnContext.inDraftRoom && espnContext.leagueId
        ? scheduleDraftPoll(espnContext)
        : { skipped: true, reason: "NOT_IN_DRAFT_ROOM" };
      return { ok: true, poll, roomWatch };
    }
    if (message.type === "ESPN_HEARTBEAT") {
      const context = { ...message.payload, tabId: sender.tab?.id };
      if (!context.inDraftRoom || !context.leagueId) return { ok: true, skipped: true };
      return { ok: true, ...scheduleDraftPoll(context) };
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
      const data = await importPreRoomLeague(context);
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
    if (message.type === "CANCEL_PENDING_ACTIONS") {
      await ensureActionBinding();
      const minimumEpoch = Number(message.payload?.minimumAuthorizationEpoch);
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!actionBinding
        || !commandCenterSessionMatchesBinding(message.payload)
        || !Number.isSafeInteger(minimumEpoch) || minimumEpoch < 0
        || expectedTabId !== Number(actionBinding.tabId)
        || String(message.payload?.expectedLeagueId || "") !== String(actionBinding.leagueId)
        || Number(message.payload?.expectedTeamId) !== Number(actionBinding.teamId)) {
        return { ok: false, code: "ACTION_CANCELLATION_BINDING_MISMATCH" };
      }
      rememberMinimumActionAuthorizationEpoch(message.payload.commandCenterSessionId, minimumEpoch);
      try {
        await withOperationDeadline(
          APP_BROADCAST_TIMEOUT_MS,
          "ACTION_CANCELLATION_DELIVERY_TIMEOUT",
          () => chrome.tabs.sendMessage(actionBinding.tabId, {
            type: "DF_CANCEL_PENDING_ACTIONS",
            payload: {
              commandCenterSessionId: message.payload.commandCenterSessionId,
              minimumAuthorizationEpoch: minimumEpoch,
            },
          }),
        );
      } catch {
        // The background floor is already authoritative. Any action still in
        // background verification will fail before dispatch; a disconnected
        // ESPN tab cannot safely receive a new click in either case.
      }
      return { ok: true, code: "ACTION_AUTHORIZATION_REVOKED", minimumAuthorizationEpoch: minimumEpoch };
    }
    if (message.type === "REVOKE_ACTION_BINDING" || message.type === "REVOKE_WRITER_ON_PAGEHIDE") {
      await ensureActionBinding();
      const expectedTabId = Number(message.payload?.expectedTabId);
      const exact = actionBinding
        && Number(sender.tab?.id) === Number(actionBinding.appTabId)
        && commandCenterSessionMatchesBinding(message.payload)
        && expectedTabId === Number(actionBinding.tabId)
        && String(message.payload?.expectedLeagueId || "") === String(actionBinding.leagueId)
        && Number(message.payload?.expectedTeamId) === Number(actionBinding.teamId);
      if (!exact) {
        return {
          ok: false,
          code: "ACTION_BINDING_REVOCATION_MISMATCH",
          transitionRequestId: message.payload?.transitionRequestId,
        };
      }
      const revoked = { ...actionBinding };
      await clearActionBinding();
      return {
        ok: true,
        code: "ACTION_BINDING_REVOKED",
        transitionRequestId: message.payload?.transitionRequestId,
        revokedTabId: revoked.tabId,
        revokedLeagueId: revoked.leagueId,
        revokedTeamId: revoked.teamId,
        minimumAuthorizationEpoch: Number.MAX_SAFE_INTEGER,
      };
    }
    if (message.type === "WRITER_HEARTBEAT") {
      await ensureActionBinding();
      const exact = actionBinding
        && Number(sender.tab?.id) === Number(actionBinding.appTabId)
        && commandCenterSessionMatchesBinding(message.payload)
        && Number(message.payload?.expectedTabId) === Number(actionBinding.tabId)
        && String(message.payload?.expectedLeagueId || "") === String(actionBinding.leagueId)
        && Number(message.payload?.expectedTeamId) === Number(actionBinding.teamId);
      if (!exact) return { ok: false, code: "WRITER_LEASE_BINDING_MISMATCH" };
      const lease = renewWriterLease(actionBinding);
      return { ok: true, code: "WRITER_LEASE_RENEWED", expiresAt: lease.expiresAt };
    }
    if (message.type === "VERIFY_ACTION_AUTHORIZATION") {
      await ensureActionBinding();
      const authorizationStatus = actionAuthorizationStatus(message.payload);
      if (authorizationStatus !== "ACTION_AUTHORIZATION_VALID") {
        return { ok: false, code: authorizationStatus };
      }
      if (!writerLeaseAuthorizes(actionBinding, message.payload, sender.tab?.id)) {
        return { ok: false, code: "WRITER_LEASE_EXPIRED" };
      }
      const serverLease = await verifyServerDispatchLease(message.payload);
      if (!serverLease.ok) return serverLease;
      return { ok: true, code: "ACTION_AUTHORIZATION_VERIFIED" };
    }
    if (message.type === "SUBMIT_ACTION") {
      const initialDeadlineStatus = actionDeadlineStatus(message.payload);
      if (initialDeadlineStatus !== "ACTION_DEADLINE_VALID") {
        return { ok: false, code: initialDeadlineStatus, message: "The draft action's absolute click deadline is missing or expired. No ESPN action was sent.", action: message.payload };
      }
      const initialAvailabilityDeadlineStatus = actionAvailabilityDeadlineStatus(message.payload);
      if (initialAvailabilityDeadlineStatus !== "AVAILABILITY_DEADLINE_VALID") {
        return { ok: false, code: initialAvailabilityDeadlineStatus, message: "The draft action is not covered by current availability-veto evidence. No ESPN action was sent.", action: message.payload };
      }
      const remainingActionMs = () => Math.max(0, Number(message.payload?.notAfter) - Date.now());
      try {
        await withOperationDeadline(
          Math.max(1, remainingActionMs()),
          "DRAFT_ACTION_BINDING_TIMEOUT",
          () => ensureActionBinding(),
        );
      } catch (error) {
        return {
          ok: false,
          code: error?.message || "DRAFT_ACTION_BINDING_TIMEOUT",
          message: "The action binding could not be verified inside the exact click deadline. No ESPN action was sent.",
          action: message.payload,
        };
      }
      const expectedTabId = Number(message.payload?.expectedTabId);
      if (!Number.isInteger(expectedTabId)) return { ok: false, code: "DRAFT_TAB_REQUIRED", message: "Reconnect the exact ESPN draft tab before submitting." };
      if (!actionBinding || Number(sender.tab?.id) !== actionBinding.appTabId) {
        return { ok: false, code: "DRAFT_BINDING_REQUIRED", message: "Reconnect the exact ESPN draft room before submitting." };
      }
      if (!commandCenterSessionMatchesBinding(message.payload)) {
        return { ok: false, code: "COMMAND_CENTER_SESSION_CHANGED", message: "This DraftForge page is not the command center bound to the ESPN room. Reconnect before submitting." };
      }
      const submittedBinding = actionBinding;
      const submittedBindingGeneration = actionBindingGeneration;
      const submittedWriterLease = renewWriterLease(submittedBinding);
      const submittedBindingStillCurrent = () => (
        actionBinding === submittedBinding
        && actionBindingGeneration === submittedBindingGeneration
      );
      const initialAuthorizationStatus = actionAuthorizationStatus(message.payload);
      if (initialAuthorizationStatus !== "ACTION_AUTHORIZATION_VALID") {
        return { ok: false, code: initialAuthorizationStatus, message: "The command center revoked this action before ESPN dispatch. No action was sent.", action: message.payload };
      }
      let context;
      try {
        context = await withOperationDeadline(
          Math.max(1, remainingActionMs()),
          "ESPN_ACTION_CONTEXT_TIMEOUT",
          () => findEspnContext(message.payload?.expectedLeagueId, expectedTabId),
        );
      } catch (error) {
        return {
          ok: false,
          code: error?.message || "ESPN_ACTION_CONTEXT_TIMEOUT",
          message: "The exact ESPN action context could not be verified inside the click deadline. No ESPN action was sent.",
          action: message.payload,
        };
      }
      if (!context?.tabId) return { ok: false, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed. Reconnect before submitting." };
      if (!actionPayloadMatchesBinding(submittedBinding, message.payload, context, expectedTabId)) {
        return { ok: false, code: "DRAFT_ACTION_IDENTITY_CHANGED", message: "The exact ESPN league, team, season, or bound tab changed. DraftForge sent no action." };
      }
      const verifiedAuthorizationStatus = actionAuthorizationStatus(message.payload);
      if (verifiedAuthorizationStatus !== "ACTION_AUTHORIZATION_VALID") {
        return { ok: false, code: verifiedAuthorizationStatus, message: "The command center revoked this action during exact-context verification. No action was sent.", action: message.payload };
      }
      const exactAction = {
        ...message.payload,
        expectedTeamId: submittedBinding.teamId,
        expectedSeason: submittedBinding.season,
        writerLeaseId: submittedWriterLease.leaseId,
      };
      const dispatchDeadlineStatus = actionDeadlineStatus(exactAction);
      if (dispatchDeadlineStatus !== "ACTION_DEADLINE_VALID") {
        return { ok: false, code: dispatchDeadlineStatus, message: "The draft action expired while the exact ESPN tab was being verified. No ESPN action was sent.", action: exactAction };
      }
      const dispatchAvailabilityDeadlineStatus = actionAvailabilityDeadlineStatus(exactAction);
      if (dispatchAvailabilityDeadlineStatus !== "AVAILABILITY_DEADLINE_VALID") {
        return { ok: false, code: dispatchAvailabilityDeadlineStatus, message: "The availability-veto evidence expired while the exact ESPN tab was being verified. No ESPN action was sent.", action: exactAction };
      }
      const dispatchAuthorizationStatus = actionAuthorizationStatus(exactAction);
      if (dispatchAuthorizationStatus !== "ACTION_AUTHORIZATION_VALID") {
        return { ok: false, code: dispatchAuthorizationStatus, message: "The command center revoked this action immediately before ESPN dispatch. No action was sent.", action: exactAction };
      }
      if (!submittedBindingStillCurrent()) {
        return { ok: false, code: "ACTION_BINDING_REVOKED", message: "The exact ESPN tab binding changed before dispatch. No action was sent.", action: exactAction };
      }
      let result;
      try {
        result = await withOperationDeadline(
          Math.max(1, Number(exactAction.notAfter) - Date.now()),
          "ESPN_ACTION_DISPATCH_TIMEOUT",
          () => chrome.tabs.sendMessage(context.tabId, { type: "DF_EXECUTE_ACTION", payload: exactAction }),
        );
      } catch (error) {
        const timedOutResult = {
          ok: false,
          code: error?.message || "ESPN_ACTION_DISPATCH_TIMEOUT",
          clicked: null,
          message: "ESPN did not acknowledge the exact action before its absolute deadline. DraftForge will not retry it automatically.",
          action: exactAction,
        };
        await broadcastBoundActionResult("DF_ACTION_RESULT", timedOutResult, submittedBinding);
        return timedOutResult;
      }
      const actionResult = { ...result, action: result?.action || exactAction };
      await broadcastBoundActionResult("DF_ACTION_RESULT", actionResult, submittedBinding);
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
  draftPolls.retireTab(tabId, "TAB_REMOVED");
  appTabs.delete(tabId);
  // Serialize removal with APP_HELLO claims. Otherwise a replacement tab can
  // observe the just-closed writer for one race window and remain read-only.
  const operation = workspaceWriterMutationTail.then(async () => {
    await Promise.all([actionBindingRestore, liveRoomWatchRestore, workspaceWriterRestore]);
    if (tabRemovalInvalidatesActionBinding(actionBinding, tabId)) {
      await clearActionBinding();
    }
    if ([liveRoomWatch?.appTabId, liveRoomWatch?.sourceTabId, liveRoomWatch?.processingTabId]
      .some((candidate) => Number(candidate) === Number(tabId))) {
      liveRoomWatch = null;
      await persistLiveRoomWatch(null);
    }
    if (Number(tabId) === Number(workspaceWriterAppTabId)) {
      const survivingWriter = resolveWorkspaceWriterTabId(workspaceAuthority());
      workspaceWriterAppTabId = Number(survivingWriter) === Number(tabId) ? null : survivingWriter;
      await persistWorkspaceWriter(workspaceWriterAppTabId);
    }
  });
  workspaceWriterMutationTail = operation.then(() => undefined, () => undefined);
});

chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (changeInfo?.status !== "loading") return;
  draftPolls.retireTab(tabId, "TAB_NAVIGATED");
  // A same-tab dashboard reload/navigation retains its numeric tab id. Treat
  // document replacement exactly like writer removal so an action already
  // handed to ESPN cannot outlive its originating command-center document.
  if (Number(tabId) !== Number(actionBinding?.appTabId)) return;
  void clearActionBinding().catch(() => {});
});
