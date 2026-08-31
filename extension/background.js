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
  AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT,
  contextCanTriggerLiveRoomWatch,
  createAuthenticatedEspnPlayerPoolEnvelope,
  createLiveRoomHandoffCoordinator,
  createLiveRoomWatch,
  liveLeagueMatchesWatch,
  sanitizeLiveRoomWatchForStorage,
  validStoredLiveRoomWatch,
} from "./live-room-watch.js";
import {
  actionAvailabilityDeadlineStatus,
  actionDeadlineStatus,
  actionPayloadMatchesBinding,
  contextMatchesActionBinding,
  reboundMatchesActionBinding,
  restoredBindingMatchesEvidence,
  resultMatchesActionBinding,
  sanitizeActionBinding,
  tabRemovalInvalidatesActionBinding,
  validCommandCenterSessionId,
  validProducerSessionId,
} from "./action-binding.js";
import {
  authorizeWorkspaceMessage,
  completedAuditProvesPracticeRoom,
  practiceWorkspaceCleanupTabIds,
  resolveWorkspaceRole,
  resolveWorkspaceWriterTabId,
  selectExactEspnReloadTab,
  selectManagedWorkspaceCleanup,
} from "./workspace-lifecycle.js";
import { renewExistingWriterLease, writerLeaseMatchesBinding } from "./writer-lease.js";

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
const FINAL_ROOM_CARDINALITY_TIMEOUT_MS = 350;
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
const ACTION_BINDING_STORAGE_KEY = "draftForgeActionBindingV2";
const WORKSPACE_WRITER_STORAGE_KEY = "draftForgeWorkspaceWriterV1";
const AUCTION_CLICK_UNCERTAINTY_STORAGE_KEY = "draftForgeAuctionClickUncertaintyV1";
const MAX_AUCTION_CLICK_UNCERTAINTIES = 1;
let auctionUncertaintyMutationTail = Promise.resolve();
try {
  const storageAccess = chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  storageAccess?.catch?.(() => {});
} catch {
  // Access-level hardening is best effort. Every authoritative read/write is
  // still checked and fails closed independently below.
}
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
  "writer-lease.js",
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

function exactAuctionPlayerId(value) {
  const playerId = Number(value || 0);
  return Number.isInteger(playerId) && ![0, -1].includes(playerId) ? playerId : null;
}

function auctionRoomIdentity(action, sender) {
  let url;
  try { url = new URL(sender?.url || sender?.tab?.url || ""); }
  catch { return null; }
  const tabId = Number(sender?.tab?.id);
  const leagueId = String(action?.expectedLeagueId || "");
  const teamId = Number(action?.expectedTeamId || 0);
  const season = Number(action?.expectedSeason || 0);
  if (url.origin !== "https://fantasy.espn.com") return null;
  return Number.isInteger(tabId) && tabId > 0 && leagueId
    && Number.isInteger(teamId) && teamId > 0
    && Number.isInteger(season) && season > 0
      ? { armedTabId: tabId, leagueId, teamId, season, key: `${leagueId}:${teamId}:${season}` }
      : null;
}

function sanitizedAuctionUncertainty(action, room, now = Date.now()) {
  const playerId = exactAuctionPlayerId(action?.playerId);
  const amount = Number(action?.amount || 0);
  const operation = String(action?.operation || "");
  return playerId && Number.isInteger(amount) && amount >= 1 && ["BID", "NOMINATE"].includes(operation)
    ? {
        ...room,
        operation,
        playerId,
        amount,
        armedAt: now,
        latestPermitAt: now,
        actionIdentity: {
          actionId: String(action?.actionId || ""),
          decisionId: String(action?.decisionId || ""),
          commandCenterSessionId: String(action?.commandCenterSessionId || ""),
          commandCenterDocumentId: String(action?.commandCenterDocumentId || ""),
          authorizationEpoch: Number(action?.authorizationEpoch),
          actionRequestId: Number.isInteger(Number(action?.actionRequestId)) ? Number(action.actionRequestId) : null,
        },
      }
    : null;
}

function sameAuctionActionIdentity(left, right) {
  return Boolean(left && right
    && left.actionId === right.actionId
    && left.decisionId === right.decisionId
    && left.commandCenterSessionId === right.commandCenterSessionId
    && left.commandCenterDocumentId === right.commandCenterDocumentId
    && left.authorizationEpoch === right.authorizationEpoch
    && left.actionRequestId === right.actionRequestId);
}

function validStoredAuctionUncertainty(record, key) {
  return Boolean(record && typeof record === "object"
    && record.key === key
    && Number.isInteger(record.armedTabId) && record.armedTabId > 0
    && typeof record.leagueId === "string" && record.leagueId
    && Number.isInteger(record.teamId) && record.teamId > 0
    && Number.isInteger(record.season) && record.season > 0
    && ["BID", "NOMINATE"].includes(record.operation)
    && exactAuctionPlayerId(record.playerId)
    && Number.isInteger(record.amount) && record.amount >= 1
    && Number.isFinite(record.armedAt)
    && typeof record.tokenHash === "string" && /^[a-f0-9]{64}$/.test(record.tokenHash)
    && ["PLAYER_ROW", "SUBMIT", "CONFIRMATION"].includes(record.stage)
    && Number.isFinite(record.latestPermitAt) && record.latestPermitAt >= record.armedAt
    && record.actionIdentity && typeof record.actionIdentity.actionId === "string" && record.actionIdentity.actionId.length >= 8
    && typeof record.actionIdentity.decisionId === "string" && record.actionIdentity.decisionId.length >= 8
    && validCommandCenterSessionId(record.actionIdentity.commandCenterSessionId)
    && validCommandCenterSessionId(record.actionIdentity.commandCenterDocumentId)
    && Number.isSafeInteger(record.actionIdentity.authorizationEpoch)
    && record.actionIdentity.authorizationEpoch >= 0);
}

async function readAuctionUncertainties() {
  const stored = (await chrome.storage.local.get(AUCTION_CLICK_UNCERTAINTY_STORAGE_KEY))?.[AUCTION_CLICK_UNCERTAINTY_STORAGE_KEY];
  if (stored === undefined) return {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("AUCTION_UNCERTAINTY_STORAGE_MALFORMED");
  const entries = Object.entries(stored);
  if (entries.length > MAX_AUCTION_CLICK_UNCERTAINTIES
    || entries.some(([key, record]) => !validStoredAuctionUncertainty(record, key))) {
    throw new Error("AUCTION_UNCERTAINTY_STORAGE_MALFORMED");
  }
  return stored;
}

async function writeAuctionUncertainties(records) {
  const entries = Object.entries(records);
  if (entries.length > MAX_AUCTION_CLICK_UNCERTAINTIES
    || entries.some(([key, record]) => !validStoredAuctionUncertainty(record, key))) {
    throw new Error("AUCTION_UNCERTAINTY_STORAGE_MALFORMED");
  }
  await chrome.storage.local.set({ [AUCTION_CLICK_UNCERTAINTY_STORAGE_KEY]: records });
  const verified = (await chrome.storage.local.get(AUCTION_CLICK_UNCERTAINTY_STORAGE_KEY))?.[AUCTION_CLICK_UNCERTAINTY_STORAGE_KEY];
  if (JSON.stringify(verified) !== JSON.stringify(records)) throw new Error("AUCTION_UNCERTAINTY_STORAGE_WRITE_UNVERIFIED");
}

function exactAuctionReconciliation(record, evidence) {
  const playerId = exactAuctionPlayerId(record?.playerId);
  if (!playerId) return false;
  const evidenceCapturedAt = Date.parse(String(evidence?.contextCapturedAt || ""));
  if (!Number.isFinite(evidenceCapturedAt) || evidenceCapturedAt <= Number(record.latestPermitAt)) return false;
  if ((evidence?.ownRosterPlayerIds || []).some((id) => exactAuctionPlayerId(id) === playerId)
    || (evidence?.auctionSalePlayerIds || []).some((id) => exactAuctionPlayerId(id) === playerId)) return true;
  const liveNomineeId = exactAuctionPlayerId(evidence?.nominatedPlayerId);
  if (liveNomineeId && liveNomineeId !== playerId
    && evidence?.auctionTransactionMode === "OFFER"
    && evidence?.auctionTransactionReady === true) return true;
  if (liveNomineeId !== playerId
    || evidence?.auctionTransactionMode !== "OFFER"
    || evidence?.auctionTransactionReady !== true
    || !Number.isInteger(Number(evidence?.currentBid))
    || Number(evidence.currentBid) < Number(record.amount)) return false;
  if (record.operation === "NOMINATE") return true;
  return record.operation === "BID"
    && (Number(evidence.currentBid) > Number(record.amount) || typeof evidence?.leadingBid === "boolean");
}

async function auctionTokenHash(token) {
  if (typeof token !== "string" || token.length < 16) return "";
  return integritySha256(new TextEncoder().encode(token));
}

function legalAuctionStage(record, operation, stage) {
  if (!record) return (operation === "BID" && stage === "SUBMIT")
    || (operation === "NOMINATE" && stage === "PLAYER_ROW");
  if (record.stage === stage) return false;
  if (operation === "NOMINATE" && record.stage === "PLAYER_ROW" && stage === "SUBMIT") return true;
  return ["BID", "NOMINATE"].includes(operation) && record.stage === "SUBMIT" && stage === "CONFIRMATION";
}

function publicAuctionUncertainty(record) {
  if (!record) return null;
  return {
    operation: record.operation,
    playerId: record.playerId,
    amount: record.amount,
    leagueId: record.leagueId,
    teamId: record.teamId,
    season: record.season,
    armedAt: record.armedAt,
  };
}

async function auctionUncertaintyMessageNow(message, sender) {
  const action = message?.payload?.action || {};
  const mode = String(message?.payload?.mode || "");
  const stage = String(message?.payload?.stage || "");
  const room = auctionRoomIdentity(action, sender);
  const proposed = room ? sanitizedAuctionUncertainty(action, room) : null;
  if (!proposed || !["CHECK", "ARM", "RECONCILE", "CANCEL_PRE_CLICK"].includes(mode)) {
    return { ok: false, code: "AUCTION_UNCERTAINTY_AUTHORITY_REJECTED" };
  }

  // A permit holder may retire only its own exact pre-click record. This path
  // intentionally does not require the still-current action binding: deadline,
  // authorization, or DOM drift is precisely why a proven no-submit path needs
  // to release the durable permit. The unguessable token, exact action identity,
  // exact room/tab, and exact cancellable stage remain mandatory. A submit or
  // confirmation click never enters this branch, and CONFIRMATION can never be
  // retired without authoritative ESPN reconciliation.
  if (mode === "CANCEL_PRE_CLICK") {
    if (!["PLAYER_ROW", "SUBMIT"].includes(stage)) {
      return { ok: false, code: "AUCTION_UNCERTAINTY_STAGE_INVALID" };
    }
    try {
      const records = await readAuctionUncertainties();
      const [pendingKey, pending] = Object.entries(records)[0] || [null, null];
      if (!pending) return { ok: true, code: "AUCTION_UNCERTAINTY_CLEAR" };
      const suppliedTokenHash = await auctionTokenHash(message.payload?.token);
      if (pendingKey !== room.key
        || pending.armedTabId !== room.armedTabId
        || pending.operation !== proposed.operation
        || pending.playerId !== proposed.playerId
        || pending.amount !== proposed.amount
        || pending.stage !== stage
        || suppliedTokenHash !== pending.tokenHash
        || !sameAuctionActionIdentity(pending.actionIdentity, proposed.actionIdentity)) {
        return { ok: false, code: "AUCTION_CLICK_UNCERTAIN", pending: publicAuctionUncertainty(pending) };
      }
      delete records[pendingKey];
      await writeAuctionUncertainties(records);
      return { ok: true, code: "AUCTION_UNCERTAINTY_PRE_CLICK_RETIRED" };
    } catch {
      return { ok: false, code: "AUCTION_UNCERTAINTY_STORAGE_UNVERIFIED" };
    }
  }

  await ensureActionBinding();
  const authorizedBinding = actionBinding;
  if (!proposed
    || actionAuthorizationStatus(action, authorizedBinding) !== "ACTION_AUTHORIZATION_VALID"
    || !writerLeaseAuthorizes(authorizedBinding, action, sender?.tab?.id)) {
    return { ok: false, code: "AUCTION_UNCERTAINTY_AUTHORITY_REJECTED" };
  }
  const authorizedBindingGeneration = actionBindingGeneration;
  try {
    const records = await readAuctionUncertainties();
    const [pendingKey, pending] = Object.entries(records)[0] || [null, null];
    if (mode === "CHECK") return { ok: true, pending: publicAuctionUncertainty(pending) };
    if (mode === "ARM") {
      const deadlineStatus = actionDeadlineStatus(action);
      if (deadlineStatus !== "ACTION_DEADLINE_VALID") return { ok: false, code: deadlineStatus };
      const availabilityStatus = actionAvailabilityDeadlineStatus(action);
      if (availabilityStatus !== "AVAILABILITY_DEADLINE_VALID") return { ok: false, code: availabilityStatus };
      const serverLease = await verifyServerDispatchLease(action);
      if (serverLease?.ok !== true) {
        return { ok: false, code: String(serverLease?.code || "SERVER_DISPATCH_LEASE_UNVERIFIED") };
      }
      if (actionBinding !== authorizedBinding
        || actionBindingGeneration !== authorizedBindingGeneration
        || actionAuthorizationStatus(action, authorizedBinding) !== "ACTION_AUTHORIZATION_VALID"
        || !writerLeaseAuthorizes(actionBinding, action, sender?.tab?.id)
        || actionDeadlineStatus(action) !== "ACTION_DEADLINE_VALID"
        || actionAvailabilityDeadlineStatus(action) !== "AVAILABILITY_DEADLINE_VALID") {
        return { ok: false, code: "AUCTION_UNCERTAINTY_AUTHORITY_REJECTED" };
      }
      const suppliedTokenHash = await auctionTokenHash(message.payload?.token);
      if (pending && (pendingKey !== room.key || pending.operation !== proposed.operation
        || pending.playerId !== proposed.playerId || pending.amount !== proposed.amount
        || !sameAuctionActionIdentity(pending.actionIdentity, proposed.actionIdentity)
        || suppliedTokenHash !== pending.tokenHash
        || !legalAuctionStage(pending, proposed.operation, stage))) {
        return { ok: false, code: "AUCTION_CLICK_UNCERTAIN", pending: publicAuctionUncertainty(pending) };
      }
      if (!pending && !legalAuctionStage(null, proposed.operation, stage)) {
        return { ok: false, code: "AUCTION_UNCERTAINTY_STAGE_INVALID" };
      }
      if (!pending && Object.keys(records).length >= MAX_AUCTION_CLICK_UNCERTAINTIES) {
        return { ok: false, code: "AUCTION_UNCERTAINTY_CAPACITY_REACHED" };
      }
      const token = pending ? message.payload.token
        : globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const tokenHash = pending?.tokenHash || await auctionTokenHash(token);
      if (actionBinding !== authorizedBinding
        || actionBindingGeneration !== authorizedBindingGeneration
        || actionAuthorizationStatus(action, authorizedBinding) !== "ACTION_AUTHORIZATION_VALID"
        || !writerLeaseAuthorizes(actionBinding, action, sender?.tab?.id)
        || actionDeadlineStatus(action) !== "ACTION_DEADLINE_VALID"
        || actionAvailabilityDeadlineStatus(action) !== "AVAILABILITY_DEADLINE_VALID") {
        return { ok: false, code: "AUCTION_UNCERTAINTY_AUTHORITY_REJECTED" };
      }
      records[room.key] = {
        ...(pending || proposed),
        stage,
        latestPermitAt: Date.now(),
        tokenHash,
      };
      await writeAuctionUncertainties(records);
      // The write is intentionally not rolled back when authority changes at
      // this boundary: the caller may have received or acted on the permit
      // even if this response is lost. Retaining the fence is the only safe
      // outcome once durable storage may have committed.
      const finalServerLease = await verifyServerDispatchLease(action);
      if (finalServerLease?.ok !== true
        || actionBinding !== authorizedBinding
        || actionBindingGeneration !== authorizedBindingGeneration
        || actionAuthorizationStatus(action, authorizedBinding) !== "ACTION_AUTHORIZATION_VALID"
        || !writerLeaseAuthorizes(actionBinding, action, sender?.tab?.id)
        || actionDeadlineStatus(action) !== "ACTION_DEADLINE_VALID"
        || actionAvailabilityDeadlineStatus(action) !== "AVAILABILITY_DEADLINE_VALID") {
        return {
          ok: false,
          code: finalServerLease?.ok !== true
            ? String(finalServerLease?.code || "SERVER_DISPATCH_LEASE_UNVERIFIED")
            : "AUCTION_UNCERTAINTY_AUTHORITY_REJECTED",
          pending: publicAuctionUncertainty(records[room.key]),
          token,
        };
      }
      return { ok: true, code: "AUCTION_UNCERTAINTY_ARMED", pending: publicAuctionUncertainty(records[room.key]), token };
    }
    if (!pending) return { ok: true, code: "AUCTION_UNCERTAINTY_CLEAR" };
    if (pendingKey !== room.key) return { ok: false, code: "AUCTION_CLICK_UNCERTAIN", pending: publicAuctionUncertainty(pending) };
    if (!exactAuctionReconciliation(pending, message.payload?.evidence || {})) {
      return { ok: false, code: "AUCTION_CLICK_UNCERTAIN", pending: publicAuctionUncertainty(pending) };
    }
    delete records[room.key];
    await writeAuctionUncertainties(records);
    return { ok: true, code: "AUCTION_UNCERTAINTY_RECONCILED" };
  } catch {
    return { ok: false, code: "AUCTION_UNCERTAINTY_STORAGE_UNVERIFIED" };
  }
}

function auctionUncertaintyMessage(message, sender) {
  const operation = auctionUncertaintyMutationTail
    .catch(() => {})
    .then(() => auctionUncertaintyMessageNow(message, sender));
  auctionUncertaintyMutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

function reconcileAuctionUncertaintyFromContext(context, sender) {
  const operation = auctionUncertaintyMutationTail
    .catch(() => {})
    .then(async () => {
      const room = auctionRoomIdentity({
        expectedLeagueId: context?.leagueId,
        expectedTeamId: context?.teamId,
        expectedSeason: context?.season,
      }, sender);
      if (!room) return { ok: false, code: "AUCTION_UNCERTAINTY_CONTEXT_INVALID" };
      try {
        const records = await readAuctionUncertainties();
        const pending = records[room.key];
        if (!pending) return { ok: true, code: "AUCTION_UNCERTAINTY_CLEAR" };
        const evidence = {
          nominatedPlayerId: context?.nominatedPlayerId,
          auctionTransactionMode: context?.auctionTransactionMode,
          auctionTransactionReady: context?.auctionTransactionReady,
          currentBid: context?.currentBid,
          leadingBid: context?.leadingBid,
          contextCapturedAt: context?.contextCapturedAt,
          ownRosterPlayerIds: (context?.ownRoster || []).map((entry) => entry?.playerId),
          auctionSalePlayerIds: (context?.auctionSales || []).map((sale) => sale?.playerId),
        };
        if (!exactAuctionReconciliation(pending, evidence)) {
          return { ok: true, code: "AUCTION_CLICK_UNCERTAIN" };
        }
        delete records[room.key];
        await writeAuctionUncertainties(records);
        return { ok: true, code: "AUCTION_UNCERTAINTY_RECONCILED" };
      } catch {
        return { ok: false, code: "AUCTION_UNCERTAINTY_STORAGE_UNVERIFIED" };
      }
    });
  auctionUncertaintyMutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

function durableAuctionGlobalFence(action) {
  if (!["BID", "NOMINATE"].includes(action?.operation)) return Promise.resolve(null);
  const operation = auctionUncertaintyMutationTail
    .catch(() => {})
    .then(async () => {
      try {
        const records = await readAuctionUncertainties();
        const pending = Object.values(records)[0];
        return pending
          ? { ok: false, code: "AUCTION_CLICK_UNCERTAIN", message: "A durable ESPN auction click fence must reconcile before another auction action can dispatch.", action }
          : null;
      } catch {
        return { ok: false, code: "AUCTION_UNCERTAINTY_STORAGE_UNVERIFIED", message: "DraftForge could not verify durable auction-click storage. No ESPN auction action was dispatched.", action };
      }
    });
  auctionUncertaintyMutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

function durableAuctionLifecycleFence() {
  const operation = auctionUncertaintyMutationTail
    .catch(() => {})
    .then(async () => {
      try {
        const pending = Object.values(await readAuctionUncertainties())[0];
        return pending ? { ok: false, code: "AUCTION_CLICK_UNCERTAIN", message: "An unresolved ESPN auction click must reconcile before reloading or cleaning the managed workspace." } : null;
      } catch {
        return { ok: false, code: "AUCTION_UNCERTAINTY_STORAGE_UNVERIFIED", message: "Durable auction-click storage is unverified, so DraftForge refused the lifecycle change." };
      }
    });
  auctionUncertaintyMutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function persistLiveRoomWatch(watch) {
  if (!watch) {
    await chrome.storage.session.remove(LIVE_ROOM_WATCH_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [LIVE_ROOM_WATCH_STORAGE_KEY]: sanitizeLiveRoomWatchForStorage(watch) });
}

async function restoreLiveRoomWatch() {
  try {
    const stored = (await chrome.storage.session.get(LIVE_ROOM_WATCH_STORAGE_KEY))?.[LIVE_ROOM_WATCH_STORAGE_KEY];
    if (!validStoredLiveRoomWatch(stored, {
      commandCenterSessionIdIsValid: validCommandCenterSessionId,
      commandCenterDocumentIdIsValid: validCommandCenterSessionId,
    })) {
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

function proposedDraftActionBinding(
  context,
  league,
  tabId = context?.tabId,
  appTabId,
  commandCenterSessionId,
  commandCenterDocumentId,
) {
  const leagueId = String(league?.id || context?.leagueId || "");
  const teamId = Number(league?.teamId || context?.teamId || 0);
  const season = Number(league?.season || context?.season || 0);
  const exactTabId = Number(tabId);
  const exactAppTabId = Number(appTabId);
  const exactCommandCenterSessionId = String(commandCenterSessionId || "");
  const exactCommandCenterDocumentId = String(commandCenterDocumentId || "");
  const producerSessionId = String(context?.producerSessionId || "");
  return leagueId
    && Number.isInteger(teamId) && teamId > 0
    && Number.isInteger(season) && season > 0
    && Number.isInteger(exactTabId) && exactTabId > 0
    && Number.isInteger(exactAppTabId) && exactAppTabId > 0
    && validCommandCenterSessionId(exactCommandCenterSessionId)
    && validCommandCenterSessionId(exactCommandCenterDocumentId)
    && validProducerSessionId(producerSessionId)
      ? {
          leagueId,
          teamId,
          season,
          tabId: exactTabId,
          appTabId: exactAppTabId,
          commandCenterSessionId: exactCommandCenterSessionId,
          commandCenterDocumentId: exactCommandCenterDocumentId,
          producerSessionId,
        }
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
    && left.commandCenterSessionId === right.commandCenterSessionId
    && left.commandCenterDocumentId === right.commandCenterDocumentId
    && left.producerSessionId === right.producerSessionId);
}

function actionBindingAuthoritySnapshot(binding = actionBinding) {
  return binding
    ? {
        ...binding,
        bindingGeneration: actionBindingGeneration,
      }
    : null;
}

function successorWatchPreservesEstablishedAuthority(
  previousWatch,
  successorWatch,
  establishedBinding,
  currentContext,
) {
  if (!previousWatch || !successorWatch || previousWatch === successorWatch) return false;
  const watchAuthorityFields = [
    "appTabId",
    "sourceTabId",
    "sourceLeagueId",
    "sourceLeagueName",
    "teamId",
    "season",
    "rules",
    "commandCenterSessionId",
    "commandCenterDocumentId",
  ];
  return watchAuthorityFields.every((field) => previousWatch[field] === successorWatch[field])
    && Number(successorWatch.appTabId) === Number(establishedBinding?.appTabId)
    && Number(successorWatch.teamId) === Number(establishedBinding?.teamId)
    && Number(successorWatch.season) === Number(establishedBinding?.season)
    && successorWatch.commandCenterSessionId === establishedBinding?.commandCenterSessionId
    && successorWatch.commandCenterDocumentId === establishedBinding?.commandCenterDocumentId
    && contextMatchesActionBinding(
      establishedBinding,
      currentContext,
      establishedBinding?.tabId,
    );
}

function newWriterLease(binding, now = Date.now()) {
  if (!binding) return null;
  const leaseId = globalThis.crypto?.randomUUID?.()
    || `${now}-${Math.random().toString(36).slice(2)}`;
  return {
    leaseId,
    appTabId: binding.appTabId,
    commandCenterSessionId: binding.commandCenterSessionId,
    commandCenterDocumentId: binding.commandCenterDocumentId,
    bindingGeneration: actionBindingGeneration,
    expiresAt: now + WRITER_LEASE_TTL_MS,
  };
}

function establishWriterLease(binding, now = Date.now()) {
  writerLease = newWriterLease(binding, now);
  return writerLease;
}

function renewWriterLease(binding, now = Date.now()) {
  writerLease = renewExistingWriterLease(
    writerLease,
    binding,
    actionBindingGeneration,
    now,
    WRITER_LEASE_TTL_MS,
  );
  return writerLease;
}

function currentWriterLease(binding, senderAppTabId, now = Date.now()) {
  return Number(senderAppTabId) === Number(binding?.appTabId)
    && writerLeaseMatchesBinding(writerLease, binding, actionBindingGeneration, now)
    ? writerLease
    : null;
}

function writerLeaseAuthorizes(binding, payload, senderTabId, now = Date.now()) {
  return Boolean(binding
    && writerLease
    && Number(senderTabId) === Number(binding.tabId)
    && writerLease.appTabId === binding.appTabId
    && writerLease.commandCenterSessionId === binding.commandCenterSessionId
    && writerLease.commandCenterDocumentId === binding.commandCenterDocumentId
    && writerLease.bindingGeneration === actionBindingGeneration
    && writerLease.expiresAt > now
    && String(payload?.writerLeaseId || "") === writerLease.leaseId
    && actionPayloadMatchesBinding(binding, payload, {
      leagueId: binding.leagueId,
      teamId: binding.teamId,
      season: binding.season,
      inDraftRoom: true,
      tabId: binding.tabId,
      producerSessionId: binding.producerSessionId,
    }, binding.tabId));
}

async function revokePriorActionBinding(binding, minimumAuthorizationEpoch = Number.MAX_SAFE_INTEGER) {
  if (!binding) return true;
  if (!Number.isSafeInteger(minimumAuthorizationEpoch) || minimumAuthorizationEpoch < 0) {
    throw new Error("ACTION_AUTHORIZATION_INVALID");
  }
  rememberMinimumActionAuthorizationEpoch(
    binding.commandCenterSessionId,
    minimumAuthorizationEpoch,
    binding,
  );
  try {
    const result = await withOperationDeadline(
      APP_BROADCAST_TIMEOUT_MS,
      "PRIOR_ACTION_BINDING_REVOCATION_TIMEOUT",
      () => chrome.tabs.sendMessage(binding.tabId, {
        type: "DF_CANCEL_PENDING_ACTIONS",
        payload: {
          commandCenterSessionId: binding.commandCenterSessionId,
          commandCenterDocumentId: binding.commandCenterDocumentId,
          expectedProducerSessionId: binding.producerSessionId,
          minimumAuthorizationEpoch,
          bindingRevocation: true,
        },
      }),
    );
    if (result?.code === "ACTION_AUTHORIZATION_PRODUCER_CHANGED") return true;
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

async function clearActionBindingNow({
  revoke = true,
  minimumAuthorizationEpoch = Number.MAX_SAFE_INTEGER,
} = {}) {
  const previous = actionBinding;
  if (revoke && previous) await revokePriorActionBinding(previous, minimumAuthorizationEpoch);
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

async function clearActionBinding(options = {}) {
  await actionBindingRestore;
  return enqueueActionBindingMutation(() => clearActionBindingNow(options));
}

async function clearActionBindingIfSame(establishedBinding, options = {}) {
  await actionBindingRestore;
  return enqueueActionBindingMutation(async () => {
    if (!sameActionBinding(actionBinding, establishedBinding)
      || actionBindingGeneration !== establishedBinding?.bindingGeneration) return false;
    await clearActionBindingNow(options);
    return true;
  });
}

async function establishActionBinding(
  context,
  league,
  tabId,
  appTabId,
  commandCenterSessionId,
  commandCenterDocumentId,
) {
  await actionBindingRestore;
  return enqueueActionBindingMutation(async () => {
    if (context?.inDraftRoom !== true) {
      await clearActionBindingNow();
      return null;
    }
    const binding = proposedDraftActionBinding(
      context,
      league,
      tabId,
      appTabId,
      commandCenterSessionId,
      commandCenterDocumentId,
    );
    if (!binding) {
      await clearActionBindingNow();
      return null;
    }
    if (!sameActionBinding(actionBinding, binding)) {
      await revokePriorActionBinding(actionBinding);
      actionBinding = binding;
    }
    // Every explicit, verified establish is a new authority generation even
    // when the bound tabs and identities are unchanged. This fences an older
    // handoff token and rotates its writer lease instead of letting stale
    // cleanup act on a later same-identity recovery.
    actionBindingGeneration += 1;
    writerLease = null;
    await persistActionBinding(actionBinding);
    workspaceWriterAppTabId = actionBinding.appTabId;
    await persistWorkspaceWriter(actionBinding.appTabId);
    appTabs.add(actionBinding.appTabId);
    establishWriterLease(actionBinding);
    return actionBindingAuthoritySnapshot(actionBinding);
  });
}

async function freshenEstablishedWriterLease(expectedBinding) {
  await actionBindingRestore;
  return enqueueActionBindingMutation(() => {
    if (!sameActionBinding(actionBinding, expectedBinding)
      || actionBindingGeneration !== expectedBinding?.bindingGeneration) return null;
    // Explicit authenticated handoff/recovery is allowed to mint. Keep this
    // as the final authority step after diagnostics, visibility, and cleanup
    // so a cold MV3 worker cannot publish an already-expired 1.5 s lease.
    return establishWriterLease(actionBinding);
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
  // Restoration is a one-shot MV3 startup operation. Once this worker clears
  // authority, no concurrent command may re-read a stale session-storage row
  // while its serialized removal is still pending and resurrect the revoked
  // binding. A new binding must come only from an explicit import/recovery.
  await actionBindingMutationTail;
  return actionBinding;
}

function commandCenterSessionMatchesBinding(payload) {
  return Boolean(actionBinding
    && validCommandCenterSessionId(payload?.commandCenterSessionId)
    && payload.commandCenterSessionId === actionBinding.commandCenterSessionId
    && validCommandCenterSessionId(payload?.commandCenterDocumentId)
    && payload.commandCenterDocumentId === actionBinding.commandCenterDocumentId);
}

function actionAuthorizationEpochKey(sessionId, binding) {
  if (!validCommandCenterSessionId(sessionId) || !sanitizeActionBinding(binding)) return "";
  return JSON.stringify([
    sessionId,
    binding.appTabId,
    binding.tabId,
    binding.leagueId,
    binding.teamId,
    binding.season,
    binding.producerSessionId,
    binding.commandCenterDocumentId,
  ]);
}

function actionAuthorizationStatus(payload, binding = actionBinding) {
  const sessionId = String(payload?.commandCenterSessionId || "");
  const epoch = Number(payload?.authorizationEpoch);
  const key = actionAuthorizationEpochKey(sessionId, binding);
  if (!key || !Number.isSafeInteger(epoch) || epoch < 0) {
    return "ACTION_AUTHORIZATION_INVALID";
  }
  const minimumEpoch = Number(minimumActionAuthorizationEpochs.get(key) || 0);
  return epoch < minimumEpoch ? "ACTION_AUTHORIZATION_REVOKED" : "ACTION_AUTHORIZATION_VALID";
}

function rememberMinimumActionAuthorizationEpoch(sessionId, minimumEpoch, binding = actionBinding) {
  const key = actionAuthorizationEpochKey(sessionId, binding);
  if (!key || !Number.isSafeInteger(minimumEpoch) || minimumEpoch < 0) return false;
  const current = Number(minimumActionAuthorizationEpochs.get(key) || 0);
  minimumActionAuthorizationEpochs.set(key, Math.max(current, minimumEpoch));
  while (minimumActionAuthorizationEpochs.size > 16) {
    const oldest = minimumActionAuthorizationEpochs.keys().next().value;
    if (oldest === undefined) break;
    minimumActionAuthorizationEpochs.delete(oldest);
  }
  return true;
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
    extensionRuntimeId: chrome.runtime.id,
    bridgeProtocolVersion: 2,
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

function tabUrlClaimsExactDraftRoom(tab, expectedLeagueId, expectedTeamId, expectedSeason) {
  let url;
  try { url = new URL(tab?.url || ""); }
  catch { return false; }
  return url.origin === "https://fantasy.espn.com"
    && /^\/football\/draft(?:\/|$)/.test(url.pathname)
    && url.searchParams.get("leagueId") === String(expectedLeagueId)
    && Number(url.searchParams.get("teamId")) === Number(expectedTeamId)
    && Number(url.searchParams.get("seasonId") || url.searchParams.get("season")) === Number(expectedSeason);
}

async function exactDraftRoomTabIds(expectedLeagueId, expectedTeamId, expectedSeason, candidateTabs) {
  const tabs = Array.isArray(candidateTabs)
    ? candidateTabs.filter((tab) => originForTab(tab) === "https://fantasy.espn.com")
    : await chrome.tabs.query({ url: "https://fantasy.espn.com/*" });
  const exact = new Set(tabs
    .filter((tab) => Number.isInteger(Number(tab?.id))
      && tabUrlClaimsExactDraftRoom(tab, expectedLeagueId, expectedTeamId, expectedSeason))
    .map((tab) => Number(tab.id)));
  await Promise.all(tabs.filter((tab) => Number.isInteger(Number(tab?.id))).map(async (tab) => {
    try {
      const context = await chrome.tabs.sendMessage(tab.id, { type: "DF_GET_CONTEXT" });
      if (context?.inDraftRoom === true
        && String(context?.leagueId || "") === String(expectedLeagueId)
        && Number(context?.teamId) === Number(expectedTeamId)
        && Number(context?.season) === Number(expectedSeason)) exact.add(Number(tab.id));
    } catch {
      // A loading exact draft URL was already counted above. Other tabs that
      // cannot prove exact live-room identity are never action authority.
    }
  }));
  return [...exact].sort((left, right) => left - right);
}

function sortedTabIdentity(tabs) {
  return tabs
    .map((tab) => ({ id: Number(tab?.id), url: String(tab?.url || "") }))
    .sort((left, right) => left.id - right.id || left.url.localeCompare(right.url));
}

async function finalDispatchWorkspaceSnapshot(expectedLeagueId, expectedTeamId, expectedSeason) {
  const beforeProbeTabs = await chrome.tabs.query({});
  const exactRoomTabIds = await exactDraftRoomTabIds(
    expectedLeagueId,
    expectedTeamId,
    expectedSeason,
    beforeProbeTabs,
  );
  // DF_GET_CONTEXT is asynchronous and can yield long enough for another tab
  // to appear. Re-read every tab after the probe; no later await occurs before
  // the caller's synchronous authorization checks and DF_EXECUTE_ACTION handoff.
  const tabs = await chrome.tabs.query({});
  const tabIds = tabs
    .map((tab) => Number(tab?.id))
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  const draftForgeTabIds = tabs
    .filter((tab) => DRAFTFORGE_APP_ORIGINS.includes(originForTab(tab)))
    .map((tab) => Number(tab?.id))
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  const espnTabIds = tabs
    .filter((tab) => originForTab(tab) === "https://fantasy.espn.com")
    .map((tab) => Number(tab?.id))
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  return {
    browserTabCount: tabs.length,
    tabIds,
    draftForgeTabIds,
    espnTabIds,
    exactRoomTabIds,
    stableTabIdentity: JSON.stringify(sortedTabIdentity(beforeProbeTabs))
      === JSON.stringify(sortedTabIdentity(tabs)),
  };
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
  const players = normalizePlayers(raw);
  const uniquePlayerCount = new Set(players.map((player) => Number(player.id))).size;
  if (!Array.isArray(raw?.players)
    || raw.players.length !== AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT
    || players.length !== AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT
    || uniquePlayerCount !== AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT) {
    throw new Error("ESPN_AUTHENTICATED_PLAYER_POOL_TRUNCATED");
  }
  return players;
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
  const authenticatedPlayerPoolEnvelope = createAuthenticatedEspnPlayerPoolEnvelope({
    players,
    fetchedAt: authenticatedImportAt,
    leagueId: league.id,
    teamId: Number(context.teamId || league.teamId),
    season: league.season,
    requestedCount: AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT,
  });
  if (!authenticatedPlayerPoolEnvelope) throw new Error("ESPN_AUTHENTICATED_PLAYER_POOL_UNVERIFIED");
  return {
    league,
    players,
    picks: normalizeImportPicks(raw),
    context,
    authenticatedImportAt,
    authenticatedPlayerPoolEnvelope,
  };
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
    if (liveRoomWatch !== watch) return null;
    const establishedBinding = await establishActionBinding(
      espnContext,
      data.league,
      roomTabId,
      watch.appTabId,
      watch.commandCenterSessionId,
      watch.commandCenterDocumentId,
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
    if (liveRoomWatch !== watch) {
      const sameAuthoritySuccessor = successorWatchPreservesEstablishedAuthority(
        watch,
        liveRoomWatch,
        establishedBinding,
        espnContext,
      );
      await clearActionBindingIfSame(establishedBinding, { revoke: !sameAuthoritySuccessor });
      return null;
    }
    liveRoomWatch = null;
    await persistLiveRoomWatch(null);
    if (!await freshenEstablishedWriterLease(establishedBinding)) {
      throw new Error("WRITER_BINDING_CHANGED_BEFORE_HANDOFF");
    }
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
      const helloDocumentId = String(message.payload?.commandCenterDocumentId || "");
      if (authorization.senderKind === "app"
        && liveRoomWatch
        && Number(sender.tab?.id) === Number(liveRoomWatch.appTabId)
        && validCommandCenterSessionId(helloDocumentId)
        && helloDocumentId !== liveRoomWatch.commandCenterDocumentId) {
        liveRoomWatch = null;
        await persistLiveRoomWatch(null);
      }
      let helloBinding = null;
      if (authorization.senderKind === "app"
        && actionBinding
        && Number(sender.tab?.id) === Number(actionBinding.appTabId)
        && validCommandCenterSessionId(helloSessionId)
        && validCommandCenterSessionId(helloDocumentId)) {
        if (helloSessionId === actionBinding.commandCenterSessionId
          && helloDocumentId === actionBinding.commandCenterDocumentId) {
          // APP_HELLO is the explicit exact-tab/session recovery handshake
          // after an MV3 restart. Heartbeats and actions may extend only this
          // freshly established lease; neither can resurrect an expired one.
          if (contextMatchesActionBinding(actionBinding, context, actionBinding.tabId)) {
            helloBinding = actionBindingAuthoritySnapshot(actionBinding);
          } else {
            await clearActionBinding();
          }
        } else {
          // A dashboard reload keeps the Chrome tab id but creates a new
          // command-center session. Revoke the old content-script actuator
          // before the replacement page can become the writer.
          await clearActionBinding();
        }
      }
      const runtime = await runtimeDiagnostics();
      // Runtime integrity can take longer than the deliberately short writer
      // lease on a cold MV3 worker. Mint only after every deferred hello check
      // and only if the exact session, tabs, league, team, season, and ESPN
      // producer document are still bound.
      if (helloBinding && !await freshenEstablishedWriterLease(helloBinding)) {
        helloBinding = null;
      }
      return {
        ready: true,
        espnOpen: Boolean(context),
        context,
        workspace: {
          ...workspace,
        },
        runtime,
        writerLeaseEstablished: Boolean(helloBinding),
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
      const lifecycleFence = await durableAuctionLifecycleFence();
      if (lifecycleFence) return lifecycleFence;
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "")) {
        return { ok: false, code: "RELOAD_FORBIDDEN", message: "Companion self-reload is available only from the local DraftForge app." };
      }
      await clearActionBinding();
      setTimeout(() => chrome.runtime.reload(), 100);
      return { ok: true, code: "RELOADING", message: "Reloading the local DraftForge companion." };
    }
    if (message.type === "RELOAD_EXACT_ESPN_TAB") {
      const lifecycleFence = await durableAuctionLifecycleFence();
      if (lifecycleFence) return lifecycleFence;
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "") || actionBinding) {
        return { ok: false, code: "ESPN_TAB_RELOAD_FORBIDDEN", message: "The ESPN tab can reload only from an idle local command center." };
      }
      const selection = selectExactEspnReloadTab(await chrome.tabs.query({}));
      if (!selection.ok) {
        return { ok: false, code: "ESPN_TAB_RELOAD_AMBIGUOUS", message: "Keep exactly one ESPN tab before reloading the companion workspace." };
      }
      const tabId = Number(selection.tabId);
      await chrome.tabs.reload(tabId);
      return { ok: true, code: "ESPN_TAB_RELOADED", tabId, runtime: await runtimeDiagnostics() };
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
      if (!validCommandCenterSessionId(message.payload?.commandCenterDocumentId)) {
        return { ok: false, code: "COMMAND_CENTER_DOCUMENT_INVALID", message: "Reload DraftForge before arming the live-room handoff." };
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
        sourcePlayerEnvelope: sourceData.authenticatedPlayerPoolEnvelope,
        autoArmRequested: message.payload?.autoArmRequested === true,
      });
      if (!watch) return { ok: false, code: "LIVE_ROOM_WATCH_INVALID", message: "DraftForge could not prove one exact pre-draft league and team." };
      watch.commandCenterSessionId = message.payload.commandCenterSessionId;
      watch.commandCenterDocumentId = message.payload.commandCenterDocumentId;
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
      const lifecycleFence = await durableAuctionLifecycleFence();
      if (lifecycleFence) return lifecycleFence;
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "") || !sender.tab?.id) {
        return { ok: false, code: "WORKSPACE_CLEANUP_FORBIDDEN", message: "Workspace cleanup is available only from the active local DraftForge tab." };
      }
      return cleanManagedLocalWorkspace(sender.tab.id, message.payload);
    }
    if (message.type === "CLOSE_PRACTICE_ROOM") {
      const lifecycleFence = await durableAuctionLifecycleFence();
      if (lifecycleFence) return lifecycleFence;
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
      const lifecycleFence = await durableAuctionLifecycleFence();
      if (lifecycleFence) return lifecycleFence;
      if (!isLocalDraftForgeSenderUrl(sender.url || sender.tab?.url || "")) {
        return { ok: false, code: "RECOVERY_FORBIDDEN", message: "Live workspace recovery is available only from the local DraftForge app." };
      }
      if (!sender.tab?.id) return { ok: false, code: "RECOVERY_APP_TAB_REQUIRED", message: "A local DraftForge tab is required for recovery." };
      if (!validCommandCenterSessionId(message.payload?.commandCenterSessionId)) {
        return { ok: false, code: "COMMAND_CENTER_SESSION_INVALID", message: "Reload DraftForge before recovering the live workspace." };
      }
      if (!validCommandCenterSessionId(message.payload?.commandCenterDocumentId)) {
        return { ok: false, code: "COMMAND_CENTER_DOCUMENT_INVALID", message: "Reload DraftForge before recovering the live workspace." };
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
      const establishedBinding = await establishActionBinding(
        espnContext,
        data.league,
        recovery.roomTabId,
        sender.tab.id,
        message.payload.commandCenterSessionId,
        message.payload.commandCenterDocumentId,
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
      if (!await freshenEstablishedWriterLease(establishedBinding)) {
        return { ok: false, code: "WRITER_BINDING_CHANGED_BEFORE_RECOVERY", message: "Live workspace authority changed before recovery could be published." };
      }
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
      const auctionUncertainty = await reconcileAuctionUncertaintyFromContext(espnContext, sender);
      const roomWatch = await recoverWatchedLiveRoom(espnContext, sender.tab);
      await broadcast("DF_ESPN_CONTEXT", espnContext);
      const poll = espnContext.inDraftRoom && espnContext.leagueId
        ? scheduleDraftPoll(espnContext)
        : { skipped: true, reason: "NOT_IN_DRAFT_ROOM" };
      return { ok: true, poll, roomWatch, auctionUncertainty };
    }
    if (message.type === "ESPN_HEARTBEAT") {
      const context = { ...message.payload, tabId: sender.tab?.id };
      if (!context.inDraftRoom || !context.leagueId) return { ok: true, skipped: true };
      // A replacement watch can be armed while the prior watched handoff is
      // settling without changing ESPN's serialized DOM context. In that
      // case the producer emits heartbeats, not another ESPN_CONTEXT event.
      // Let the exact, one-shot watch recover from that heartbeat so the
      // successor cannot remain inert until an unrelated room mutation.
      const roomWatch = liveRoomWatch
        ? await recoverWatchedLiveRoom(context, sender.tab)
        : null;
      return { ok: true, ...scheduleDraftPoll(context), roomWatch };
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
            message.payload.commandCenterDocumentId,
          );
          return { ok: true, ...verification, context, rebound: true, previousTabId };
        }
        return { ok: false, ...verification, code: "DRAFT_TAB_CHANGED", message: "The imported ESPN draft tab changed or is ambiguous. Reconnect before submitting." };
      }
      if (!actionMatchesBinding(message.payload, context, expectedTabId)) {
        if (reboundMatchesActionBinding(actionBinding, context, sender.tab?.id)) {
          const previousTabId = actionBinding.tabId;
          await establishActionBinding(
            context,
            actionBinding,
            context.tabId,
            sender.tab.id,
            message.payload.commandCenterSessionId,
            message.payload.commandCenterDocumentId,
          );
          return { ok: true, ...verification, context, rebound: true, previousTabId };
        }
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
      if (!validCommandCenterSessionId(message.payload?.commandCenterDocumentId)) {
        return { ok: false, code: "COMMAND_CENTER_DOCUMENT_INVALID", message: "Reload DraftForge before connecting to ESPN." };
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
        message.payload.commandCenterDocumentId,
      );
      await broadcast("DF_IMPORT_SUCCESS", data);
      return { ok: true, data };
    }
    if (message.type === "CANCEL_PENDING_ACTIONS") {
      await ensureActionBinding();
      const minimumEpoch = Number(message.payload?.minimumAuthorizationEpoch);
      const expectedTabId = Number(message.payload?.expectedTabId);
      const cancelledBinding = actionBinding;
      if (!cancelledBinding
        || !validCommandCenterSessionId(message.payload?.commandCenterSessionId)
        || message.payload.commandCenterSessionId !== cancelledBinding.commandCenterSessionId
        || !validCommandCenterSessionId(message.payload?.commandCenterDocumentId)
        || message.payload.commandCenterDocumentId !== cancelledBinding.commandCenterDocumentId
        || !Number.isSafeInteger(minimumEpoch) || minimumEpoch < 0
        || expectedTabId !== Number(cancelledBinding.tabId)
        || String(message.payload?.expectedLeagueId || "") !== String(cancelledBinding.leagueId)
        || Number(message.payload?.expectedTeamId) !== Number(cancelledBinding.teamId)) {
        return { ok: false, code: "ACTION_CANCELLATION_BINDING_MISMATCH" };
      }
      rememberMinimumActionAuthorizationEpoch(
        message.payload.commandCenterSessionId,
        minimumEpoch,
        cancelledBinding,
      );
      try {
        await withOperationDeadline(
          APP_BROADCAST_TIMEOUT_MS,
          "ACTION_CANCELLATION_DELIVERY_TIMEOUT",
          () => chrome.tabs.sendMessage(cancelledBinding.tabId, {
            type: "DF_CANCEL_PENDING_ACTIONS",
            payload: {
              commandCenterSessionId: message.payload.commandCenterSessionId,
              commandCenterDocumentId: cancelledBinding.commandCenterDocumentId,
              expectedProducerSessionId: cancelledBinding.producerSessionId,
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
      await actionBindingRestore;
      const pageHide = message.type === "REVOKE_WRITER_ON_PAGEHIDE";
      const requestedMinimumEpoch = pageHide
        ? Number.MAX_SAFE_INTEGER
        : Number(message.payload?.minimumAuthorizationEpoch);
      if (!Number.isSafeInteger(requestedMinimumEpoch) || requestedMinimumEpoch < 0) {
        return { ok: false, code: "ACTION_AUTHORIZATION_INVALID" };
      }
      return enqueueActionBindingMutation(async () => {
        const expectedTabId = Number(message.payload?.expectedTabId);
        const revoked = actionBinding;
        const exact = revoked
          && Number(sender.tab?.id) === Number(revoked.appTabId)
          && validCommandCenterSessionId(message.payload?.commandCenterSessionId)
          && message.payload.commandCenterSessionId === revoked.commandCenterSessionId
          && validCommandCenterSessionId(message.payload?.commandCenterDocumentId)
          && message.payload.commandCenterDocumentId === revoked.commandCenterDocumentId
          && expectedTabId === Number(revoked.tabId)
          && String(message.payload?.expectedLeagueId || "") === String(revoked.leagueId)
          && Number(message.payload?.expectedTeamId) === Number(revoked.teamId);
        if (!exact) {
          return {
            ok: false,
            code: "ACTION_BINDING_REVOCATION_MISMATCH",
            transitionRequestId: message.payload?.transitionRequestId,
          };
        }
        await clearActionBindingNow({ minimumAuthorizationEpoch: requestedMinimumEpoch });
        return {
          ok: true,
          code: "ACTION_BINDING_REVOKED",
          transitionRequestId: message.payload?.transitionRequestId,
          revokedTabId: revoked.tabId,
          revokedLeagueId: revoked.leagueId,
          revokedTeamId: revoked.teamId,
          minimumAuthorizationEpoch: requestedMinimumEpoch,
        };
      });
    }
    if (message.type === "WRITER_HEARTBEAT") {
      await ensureActionBinding();
      const transitionRequestId = message.payload?.transitionRequestId;
      const exact = actionBinding
        && Number(sender.tab?.id) === Number(actionBinding.appTabId)
        && commandCenterSessionMatchesBinding(message.payload)
        && Number(message.payload?.expectedTabId) === Number(actionBinding.tabId)
        && String(message.payload?.expectedLeagueId || "") === String(actionBinding.leagueId)
        && Number(message.payload?.expectedTeamId) === Number(actionBinding.teamId)
        && String(message.payload?.expectedProducerSessionId || "") === actionBinding.producerSessionId;
      if (!exact) return { ok: false, code: "WRITER_LEASE_BINDING_MISMATCH", transitionRequestId };
      const lease = renewWriterLease(actionBinding);
      if (!lease) return { ok: false, code: "WRITER_LEASE_EXPIRED", transitionRequestId };
      return { ok: true, code: "WRITER_LEASE_RENEWED", expiresAt: lease.expiresAt, transitionRequestId };
    }
    if (message.type === "AUCTION_CLICK_UNCERTAINTY") {
      return auctionUncertaintyMessage(message, sender);
    }
    if (message.type === "VERIFY_ACTION_AUTHORIZATION") {
      await ensureActionBinding();
      const verifiedBinding = actionBinding;
      const verifiedBindingGeneration = actionBindingGeneration;
      const authorizationStatus = actionAuthorizationStatus(message.payload, verifiedBinding);
      if (authorizationStatus !== "ACTION_AUTHORIZATION_VALID") {
        return { ok: false, code: authorizationStatus };
      }
      if (!writerLeaseAuthorizes(verifiedBinding, message.payload, sender.tab?.id)) {
        return { ok: false, code: "WRITER_LEASE_EXPIRED" };
      }
      const serverLease = await verifyServerDispatchLease(message.payload);
      if (!serverLease.ok) return serverLease;
      if (actionBinding !== verifiedBinding
        || actionBindingGeneration !== verifiedBindingGeneration
        || actionAuthorizationStatus(message.payload, verifiedBinding) !== "ACTION_AUTHORIZATION_VALID"
        || !writerLeaseAuthorizes(verifiedBinding, message.payload, sender.tab?.id)
        || actionDeadlineStatus(message.payload) !== "ACTION_DEADLINE_VALID"
        || actionAvailabilityDeadlineStatus(message.payload) !== "AVAILABILITY_DEADLINE_VALID") {
        return { ok: false, code: "ACTION_AUTHORIZATION_REVOKED" };
      }
      return { ok: true, code: "ACTION_AUTHORIZATION_VERIFIED" };
    }
    if (message.type === "SUBMIT_ACTION") {
      const initialAuctionFence = await durableAuctionGlobalFence(message.payload);
      if (initialAuctionFence) return initialAuctionFence;
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
      const submittedWriterLease = currentWriterLease(submittedBinding, sender.tab?.id);
      if (!submittedWriterLease) {
        return { ok: false, code: "WRITER_LEASE_EXPIRED", message: "The exact command-center writer lease expired. Rebind the live room before submitting.", action: message.payload };
      }
      const submittedBindingStillCurrent = () => (
        actionBinding === submittedBinding
        && actionBindingGeneration === submittedBindingGeneration
      );
      const initialAuthorizationStatus = actionAuthorizationStatus(message.payload, submittedBinding);
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
      const verifiedAuthorizationStatus = actionAuthorizationStatus(message.payload, submittedBinding);
      if (verifiedAuthorizationStatus !== "ACTION_AUTHORIZATION_VALID") {
        return { ok: false, code: verifiedAuthorizationStatus, message: "The command center revoked this action during exact-context verification. No action was sent.", action: message.payload };
      }
      const exactAction = {
        ...message.payload,
        expectedTeamId: submittedBinding.teamId,
        expectedSeason: submittedBinding.season,
        expectedProducerSessionId: submittedBinding.producerSessionId,
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
      const dispatchAuthorizationStatus = actionAuthorizationStatus(exactAction, submittedBinding);
      if (dispatchAuthorizationStatus !== "ACTION_AUTHORIZATION_VALID") {
        return { ok: false, code: dispatchAuthorizationStatus, message: "The command center revoked this action immediately before ESPN dispatch. No action was sent.", action: exactAction };
      }
      if (!submittedBindingStillCurrent()) {
        return { ok: false, code: "ACTION_BINDING_REVOKED", message: "The exact ESPN tab binding changed before dispatch. No action was sent.", action: exactAction };
      }
      const finalAuctionFence = await durableAuctionGlobalFence(exactAction);
      if (finalAuctionFence) return finalAuctionFence;
      let finalWorkspace;
      try {
        finalWorkspace = await withOperationDeadline(
          Math.max(1, Math.min(FINAL_ROOM_CARDINALITY_TIMEOUT_MS, Number(exactAction.notAfter) - Date.now())),
          "ESPN_EXACT_ROOM_CARDINALITY_TIMEOUT",
          () => finalDispatchWorkspaceSnapshot(
            exactAction.expectedLeagueId,
            exactAction.expectedTeamId,
            exactAction.expectedSeason,
          ),
        );
      } catch (error) {
        return {
          ok: false,
          code: error?.message || "ESPN_EXACT_ROOM_CARDINALITY_TIMEOUT",
          message: "DraftForge could not prove one sole exact ESPN live room immediately before dispatch. No action was sent.",
          action: exactAction,
        };
      }
      if (finalWorkspace.exactRoomTabIds.length !== 1
        || finalWorkspace.exactRoomTabIds[0] !== Number(submittedBinding.tabId)) {
        return {
          ok: false,
          code: "ESPN_EXACT_ROOM_CARDINALITY_CHANGED",
          message: "The exact ESPN live room became missing or duplicated immediately before dispatch. No action was sent.",
          action: exactAction,
        };
      }
      if (finalWorkspace.browserTabCount !== 2
        || finalWorkspace.tabIds.length !== 2
        || finalWorkspace.stableTabIdentity !== true
        || finalWorkspace.draftForgeTabIds.length !== 1
        || finalWorkspace.draftForgeTabIds[0] !== Number(submittedBinding.appTabId)
        || finalWorkspace.espnTabIds.length !== 1
        || finalWorkspace.espnTabIds[0] !== Number(submittedBinding.tabId)) {
        return {
          ok: false,
          code: "DRAFT_WORKSPACE_CARDINALITY_CHANGED",
          message: "The live browser workspace no longer contains exactly one bound DraftForge tab and one bound ESPN draft room. No action was sent.",
          action: exactAction,
        };
      }
      if (actionDeadlineStatus(exactAction) !== "ACTION_DEADLINE_VALID"
        || actionAvailabilityDeadlineStatus(exactAction) !== "AVAILABILITY_DEADLINE_VALID"
        || actionAuthorizationStatus(exactAction, submittedBinding) !== "ACTION_AUTHORIZATION_VALID"
        || !submittedBindingStillCurrent()) {
        return { ok: false, code: "ACTION_AUTHORIZATION_REVOKED", message: "Draft-room authority changed during the final sole-room check. No action was sent.", action: exactAction };
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
  if (Number(tabId) === Number(liveRoomWatch?.appTabId)) {
    liveRoomWatch = null;
    void persistLiveRoomWatch(null).catch(() => {});
  }
  if (Number(tabId) === Number(actionBinding?.appTabId)) {
    void clearActionBinding().catch(() => {});
  }
});
