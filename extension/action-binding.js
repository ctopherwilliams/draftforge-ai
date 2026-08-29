export function sanitizeActionBinding(binding) {
  if (!binding) return null;
  const sanitized = {
    leagueId: String(binding.leagueId || ""),
    teamId: Number(binding.teamId),
    season: Number(binding.season),
    tabId: Number(binding.tabId),
    appTabId: Number(binding.appTabId),
    producerSessionId: typeof binding.producerSessionId === "string"
      ? binding.producerSessionId
      : "",
    commandCenterSessionId: typeof binding.commandCenterSessionId === "string"
      ? binding.commandCenterSessionId
      : "",
    commandCenterDocumentId: typeof binding.commandCenterDocumentId === "string"
      ? binding.commandCenterDocumentId
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
    && validProducerSessionId(binding.producerSessionId)
    && validCommandCenterSessionId(binding.commandCenterSessionId)
    && validCommandCenterSessionId(binding.commandCenterDocumentId));
}

export function validProducerSessionId(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function validCommandCenterSessionId(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function actionDeadlineStatus(payload, now = Date.now(), maxFutureMs = 10_000) {
  const notAfter = Number(payload?.notAfter);
  if (!Number.isSafeInteger(notAfter) || notAfter <= 0) return "ACTION_DEADLINE_INVALID";
  if (!Number.isFinite(now) || now >= notAfter) return "ACTION_EXPIRED";
  if (notAfter - now > maxFutureMs) return "ACTION_DEADLINE_INVALID";
  return "ACTION_DEADLINE_VALID";
}

export function actionAvailabilityDeadlineStatus(payload, now = Date.now()) {
  const notAfter = Number(payload?.notAfter);
  const availabilityNotAfter = Number(payload?.availabilityNotAfter);
  if (!Number.isSafeInteger(availabilityNotAfter) || availabilityNotAfter <= 0) {
    return "AVAILABILITY_DEADLINE_INVALID";
  }
  if (!Number.isSafeInteger(notAfter) || notAfter <= 0 || notAfter > availabilityNotAfter) {
    return "ACTION_AFTER_AVAILABILITY";
  }
  if (!Number.isFinite(now) || now >= availabilityNotAfter) return "AVAILABILITY_EXPIRED";
  return "AVAILABILITY_DEADLINE_VALID";
}

export function contextMatchesActionBinding(binding, context, expectedTabId = binding?.tabId) {
  return validActionBinding(binding)
    && Number(expectedTabId) === binding.tabId
    && Number(context?.tabId) === binding.tabId
    && String(context?.leagueId || "") === binding.leagueId
    && Number(context?.teamId) === binding.teamId
    && Number(context?.season) === binding.season
    && String(context?.producerSessionId || "") === binding.producerSessionId
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
    && String(payload?.expectedProducerSessionId || "") === binding.producerSessionId
    && String(payload?.commandCenterSessionId || "") === binding.commandCenterSessionId
    && String(payload?.commandCenterDocumentId || "") === binding.commandCenterDocumentId;
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
    && validProducerSessionId(context?.producerSessionId)
    && context.producerSessionId !== binding.producerSessionId
    && context?.inDraftRoom === true;
}

export function tabRemovalInvalidatesActionBinding(binding, removedTabId) {
  const sanitized = sanitizeActionBinding(binding);
  const exactRemovedTabId = Number(removedTabId);
  return Boolean(sanitized
    && Number.isInteger(exactRemovedTabId)
    && (exactRemovedTabId === sanitized.appTabId || exactRemovedTabId === sanitized.tabId));
}
