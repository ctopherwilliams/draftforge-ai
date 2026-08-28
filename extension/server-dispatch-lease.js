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
    leagueId: String(payload?.expectedLeagueId || ""),
    teamId: String(payload?.expectedTeamId || ""),
    tabId: String(payload?.expectedTabId || ""),
    commandCenterSessionId: String(payload?.commandCenterSessionId || ""),
    dashboardLoadedAt: String(payload?.dashboardLoadedAt || ""),
    decisionId: String(payload?.decisionId || ""),
    operation: String(payload?.operation || ""),
    playerId: String(payload?.playerId || ""),
  });
  try {
    const response = await fetchImpl(`${origin}/api/draft-day?${query}`, {
      cache: "no-store",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(Math.max(1, Math.min(SERVER_DISPATCH_LEASE_TIMEOUT_MS, remainingMs))),
    });
    const result = await response.json().catch(() => null);
    return response.ok && result?.ok === true && result?.code === "DRAFT_ACTION_SERVER_LEASE_CURRENT"
      ? { ok: true, code: result.code }
      : { ok: false, code: String(result?.code || "SERVER_DISPATCH_LEASE_UNVERIFIED") };
  } catch {
    return { ok: false, code: "SERVER_DISPATCH_LEASE_UNVERIFIED" };
  }
}
