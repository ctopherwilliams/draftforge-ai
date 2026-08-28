function parsedTab(tab) {
  try {
    return { tab, url: new URL(tab?.url || "") };
  } catch {
    return null;
  }
}

function tabRecency(tab) {
  const value = Number(tab?.lastAccessed || 0);
  return Number.isFinite(value) ? value : 0;
}

const READ_ONLY_WORKSPACE_MESSAGES = new Set([
  "APP_HELLO",
  "GET_RUNTIME_DIAGNOSTICS",
]);

function exactPositiveTabId(value) {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
}

/**
 * Resolve the one DraftForge tab allowed to mutate live browser state. An
 * exact ESPN action binding always wins, followed by an armed live-room watch,
 * then the persisted pre-draft writer lease. Recency is deliberately absent:
 * merely opening another dashboard can never seize live authority.
 */
export function resolveWorkspaceWriterTabId({ actionBinding, liveRoomWatch, writerAppTabId } = {}) {
  return exactPositiveTabId(actionBinding?.appTabId)
    ?? exactPositiveTabId(liveRoomWatch?.appTabId)
    ?? exactPositiveTabId(writerAppTabId);
}

export function resolveWorkspaceRole(authority, senderTabId) {
  const writerTabId = resolveWorkspaceWriterTabId(authority);
  const exactSenderTabId = exactPositiveTabId(senderTabId);
  if (!exactSenderTabId) return { ok: false, code: "WORKSPACE_APP_TAB_REQUIRED", role: "invalid", writerTabId };
  if (!writerTabId) return { ok: true, code: "WORKSPACE_WRITER_UNCLAIMED", role: "unclaimed", writerTabId: null };
  return exactSenderTabId === writerTabId
    ? { ok: true, code: "WORKSPACE_WRITER", role: "writer", writerTabId }
    : { ok: true, code: "WORKSPACE_OBSERVER", role: "observer", writerTabId };
}

/**
 * Observer tabs may handshake and poll diagnostics only. Every browser-side
 * mutation remains bound to the writer tab, even when an observer has the
 * same origin and a newer command-center session id.
 */
export function authorizeWorkspaceMessage(authority, senderTabId, messageType) {
  const role = resolveWorkspaceRole(authority, senderTabId);
  if (!role.ok) return role;
  if (READ_ONLY_WORKSPACE_MESSAGES.has(String(messageType || ""))) return role;
  if (role.role === "writer") return role;
  return {
    ok: false,
    code: role.role === "observer" ? "WORKSPACE_OBSERVER_READ_ONLY" : "WORKSPACE_WRITER_HANDSHAKE_REQUIRED",
    role: role.role,
    writerTabId: role.writerTabId,
  };
}

/**
 * Elect one exact DraftForge dashboard and return only tabs DraftForge can
 * prove it owns. Arbitrary browser, ESPN, and unrequested blank tabs are never
 * cleanup targets.
 */
export function selectManagedWorkspaceCleanup(tabs, {
  senderTabId,
  appOrigins,
  ownedBlankTabIds = [],
  electNewest = false,
  protectedWriterTabId,
}) {
  const expectedSenderTabId = Number(senderTabId);
  if (!Number.isInteger(expectedSenderTabId) || !Array.isArray(appOrigins) || !appOrigins.length) {
    return { ok: false, code: "LOCAL_WORKSPACE_TARGET_INVALID" };
  }

  const parsed = (tabs || []).map(parsedTab).filter(Boolean);
  const appTabs = parsed
    .filter(({ tab, url }) => Number.isInteger(Number(tab?.id)) && appOrigins.includes(url.origin))
    .map(({ tab }) => tab);
  const senderIsDraftForge = appTabs.some((tab) => Number(tab.id) === expectedSenderTabId);
  if (!senderIsDraftForge) return { ok: false, code: "LOCAL_WORKSPACE_SENDER_MISMATCH" };

  const exactProtectedWriterTabId = exactPositiveTabId(protectedWriterTabId);
  if (exactProtectedWriterTabId && exactProtectedWriterTabId !== expectedSenderTabId) {
    return {
      ok: false,
      code: "WORKSPACE_OBSERVER_READ_ONLY",
      role: "observer",
      writerTabId: exactProtectedWriterTabId,
      cleanupTabIds: [],
    };
  }

  const leader = [...appTabs].sort((left, right) => (
    tabRecency(right) - tabRecency(left) || Number(right.id) - Number(left.id)
  ))[0];
  const leaderTabId = Number(leader?.id);
  if (electNewest && leaderTabId !== expectedSenderTabId) {
    return {
      ok: true,
      code: "LOCAL_WORKSPACE_STANDBY",
      leaderTabId,
      cleanupTabIds: [],
    };
  }

  const requestedBlankIds = new Set((Array.isArray(ownedBlankTabIds) ? ownedBlankTabIds : [])
    .map(Number)
    .filter(Number.isInteger));
  const staleAppTabIds = appTabs
    .map((tab) => Number(tab.id))
    .filter((tabId) => tabId !== expectedSenderTabId && tabId !== exactProtectedWriterTabId);
  const exactOwnedBlankTabIds = parsed
    .filter(({ tab, url }) => requestedBlankIds.has(Number(tab?.id)) && url.href === "about:blank")
    .map(({ tab }) => Number(tab.id));

  return {
    ok: true,
    code: "LOCAL_WORKSPACE_CLEAN",
    leaderTabId: expectedSenderTabId,
    cleanupTabIds: [...new Set([...staleAppTabIds, ...exactOwnedBlankTabIds])],
  };
}

export function completedAuditProvesPracticeRoom({
  proof,
  draftLeagueId,
  sourceLeagueId,
  teamId,
  roomTabId,
}) {
  return String(draftLeagueId || "") !== String(sourceLeagueId || "")
    && proof?.finalReady === true
    && proof?.parity === true
    && proof?.autoDraftOff === true
    && String(proof?.leagueId) === String(draftLeagueId)
    && Number(proof?.teamId) === Number(teamId)
    && Number(proof?.tabId) === Number(roomTabId);
}

export function practiceWorkspaceCleanupTabIds(recovery, senderTabId) {
  const exactSenderTabId = Number(senderTabId);
  return [...new Set([
    recovery?.roomTabId,
    ...(recovery?.staleAppTabIds || []),
    ...(recovery?.sourceLeagueTabIds || []),
  ].map(Number).filter(Number.isInteger))]
    .filter((tabId) => tabId !== exactSenderTabId);
}
