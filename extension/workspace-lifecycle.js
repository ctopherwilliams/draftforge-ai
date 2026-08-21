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
    .filter((tabId) => tabId !== expectedSenderTabId);
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
