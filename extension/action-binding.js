export function sanitizeActionBinding(binding) {
  if (!binding) return null;
  const sanitized = {
    leagueId: String(binding.leagueId || ""),
    teamId: Number(binding.teamId),
    season: Number(binding.season),
    tabId: Number(binding.tabId),
    appTabId: Number(binding.appTabId),
    commandCenterSessionId: typeof binding.commandCenterSessionId === "string"
      ? binding.commandCenterSessionId
      : "",
  };
  return validActionBinding(sanitized) ? sanitized : null;
}

export function validActionBinding(binding) {
  return Boolean(binding
    && typeof binding.leagueId === "string"
    && binding.leagueId.length > 0
    && Number.isInteger(binding.teamId) && binding.teamId > 0
    && Number.isInteger(binding.season) && binding.season > 0
    && Number.isInteger(binding.tabId) && binding.tabId > 0
    && Number.isInteger(binding.appTabId) && binding.appTabId > 0
    && validCommandCenterSessionId(binding.commandCenterSessionId));
}

export function validCommandCenterSessionId(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function contextMatchesActionBinding(binding, context, expectedTabId = binding?.tabId) {
  return validActionBinding(binding)
    && Number(expectedTabId) === binding.tabId
    && Number(context?.tabId) === binding.tabId
    && String(context?.leagueId || "") === binding.leagueId
    && Number(context?.teamId) === binding.teamId
    && Number(context?.season) === binding.season
    && context?.inDraftRoom === true;
}

export function actionPayloadMatchesBinding(binding, payload, context, expectedTabId) {
  if (!contextMatchesActionBinding(binding, context, expectedTabId)) return false;
  const requestedTeamId = payload?.expectedTeamId === undefined
    ? binding.teamId
    : Number(payload.expectedTeamId);
  const requestedSeason = payload?.expectedSeason === undefined
    ? binding.season
    : Number(payload.expectedSeason);
  return String(payload?.expectedLeagueId || "") === binding.leagueId
    && requestedTeamId === binding.teamId
    && requestedSeason === binding.season
    && String(payload?.commandCenterSessionId || "") === binding.commandCenterSessionId;
}

export function resultMatchesActionBinding(binding, payload, context, senderTabId) {
  const expectedTabId = Number(payload?.expectedTabId);
  return Number.isInteger(expectedTabId)
    && Number(senderTabId) === expectedTabId
    && actionPayloadMatchesBinding(binding, payload, context, expectedTabId);
}

export function restoredBindingMatchesEvidence(binding, evidence, authorizedAppOrigins) {
  const sanitized = sanitizeActionBinding(binding);
  if (!sanitized) return false;
  let appOrigin = "";
  let espnOrigin = "";
  try { appOrigin = new URL(evidence?.appTabUrl || "").origin; } catch { /* invalid URL */ }
  try { espnOrigin = new URL(evidence?.espnTabUrl || "").origin; } catch { /* invalid URL */ }
  return Array.isArray(authorizedAppOrigins)
    && authorizedAppOrigins.includes(appOrigin)
    && espnOrigin === "https://fantasy.espn.com"
    && contextMatchesActionBinding(sanitized, evidence?.context, sanitized.tabId);
}

export function reboundMatchesActionBinding(binding, context, appTabId) {
  return validActionBinding(binding)
    && Number(appTabId) === binding.appTabId
    && Number.isInteger(Number(context?.tabId))
    && Number(context.tabId) > 0
    && String(context?.leagueId || "") === binding.leagueId
    && Number(context?.teamId) === binding.teamId
    && Number(context?.season) === binding.season
    && context?.inDraftRoom === true;
}

export function tabRemovalInvalidatesActionBinding(binding, removedTabId) {
  const sanitized = sanitizeActionBinding(binding);
  const exactRemovedTabId = Number(removedTabId);
  return Boolean(sanitized
    && Number.isInteger(exactRemovedTabId)
    && (exactRemovedTabId === sanitized.appTabId || exactRemovedTabId === sanitized.tabId));
}
