export const SERVER_DISPATCH_LEASE_TIMEOUT_MS = 350;

export async function verifyServerDispatchLease(payload, {
  fetchImpl = fetch,
  now = Date.now,
  origin = "http://127.0.0.1:3000",
} = {}) {
  const remainingMs = Number(payload?.notAfter) - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { ok: false, code: "ACTION_DEADLINE_EXPIRED" };
  }
  const query = new URLSearchParams({
    view: "dispatch-lease",
    leagueId: String(payload?.expectedLeagueId ?? ""),
    teamId: String(payload?.expectedTeamId ?? ""),
    tabId: String(payload?.expectedTabId ?? ""),
    commandCenterSessionId: String(payload?.commandCenterSessionId ?? ""),
    dashboardLoadedAt: String(payload?.dashboardLoadedAt ?? ""),
    actionId: String(payload?.actionId ?? ""),
    decisionId: String(payload?.decisionId ?? ""),
    sourceSnapshotId: String(payload?.sourceSnapshotId ?? ""),
    availabilityDigest: String(payload?.availabilityDigest ?? ""),
    availabilityDecisionDigest: String(payload?.availabilityDecisionDigest ?? ""),
    operation: String(payload?.operation ?? ""),
    playerId: String(payload?.playerId ?? ""),
    notAfter: String(payload?.notAfter ?? ""),
  });
  if (payload?.operation === "SELECT") {
    query.set("expectedPick", String(payload?.expectedPick ?? ""));
  } else if (payload?.operation === "BID") {
    query.set("expectedCurrentBid", String(payload?.expectedCurrentBid ?? ""));
    query.set("amount", String(payload?.amount ?? ""));
    query.set("maxApprovedBid", String(payload?.maxApprovedBid ?? ""));
  } else if (payload?.operation === "NOMINATE") {
    query.set("amount", String(payload?.amount ?? ""));
    query.set("nominationIntent", String(payload?.nominationIntent ?? ""));
  }
  try {
    const response = await fetchImpl(`${origin}/api/draft-day?${query}`, {
      cache: "no-store",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(Math.max(1, Math.min(SERVER_DISPATCH_LEASE_TIMEOUT_MS, remainingMs))),
    });
    const result = await response.json().catch(() => null);
    if (Number(payload?.notAfter) - now() <= 0) {
      return { ok: false, code: "ACTION_DEADLINE_EXPIRED" };
    }
    return response.ok && result?.ok === true && result?.code === "DRAFT_ACTION_SERVER_LEASE_CURRENT"
      ? { ok: true, code: result.code }
      : { ok: false, code: String(result?.code || "SERVER_DISPATCH_LEASE_UNVERIFIED") };
  } catch {
    return { ok: false, code: "SERVER_DISPATCH_LEASE_UNVERIFIED" };
  }
}
