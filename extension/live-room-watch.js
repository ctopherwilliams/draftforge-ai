const DEFAULT_WATCH_WINDOW_MS = 15 * 60 * 1000;
export const AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT = 500;

function canonicalUtcTimestamp(value) {
  const timestamp = String(value || "");
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === timestamp
    ? timestamp
    : null;
}

function exactUniquePlayerIds(players) {
  if (!Array.isArray(players)) return null;
  const ids = players.map((player) => Number(player?.id));
  return ids.every((id) => Number.isSafeInteger(id) && id !== 0)
    && new Set(ids).size === ids.length
      ? ids
      : null;
}

export function createAuthenticatedEspnPlayerPoolEnvelope({
  players,
  fetchedAt,
  leagueId,
  teamId,
  season,
  requestedCount = AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT,
}) {
  const exactFetchedAt = canonicalUtcTimestamp(fetchedAt);
  const ids = exactUniquePlayerIds(players);
  const exactLeagueId = String(leagueId || "");
  const exactTeamId = Number(teamId);
  const exactSeason = Number(season);
  if (requestedCount !== AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT
    || !ids
    || ids.length !== AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT
    || !exactFetchedAt
    || !exactLeagueId
    || !Number.isSafeInteger(exactTeamId) || exactTeamId <= 0
    || !Number.isSafeInteger(exactSeason) || exactSeason <= 0) return null;
  return Object.freeze({
    schemaVersion: 1,
    requestedCount: AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT,
    playerCount: ids.length,
    uniquePlayerCount: ids.length,
    fetchedAt: exactFetchedAt,
    leagueId: exactLeagueId,
    teamId: exactTeamId,
    season: exactSeason,
  });
}

export function authenticatedEspnPlayerPoolEnvelopeMatches(envelope, input) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  const expected = createAuthenticatedEspnPlayerPoolEnvelope(input);
  if (!expected) return false;
  const expectedKeys = Object.keys(expected).sort();
  const envelopeKeys = Object.keys(envelope).sort();
  return expectedKeys.length === envelopeKeys.length
    && expectedKeys.every((key, index) => key === envelopeKeys[index]
      && Object.is(envelope[key], expected[key]));
}

function exactCanonicalValueMatches(value, expected) {
  if (Object.is(value, expected)) return true;
  if (Array.isArray(value) || Array.isArray(expected)) {
    if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length) return false;
    const valueKeys = Object.keys(value).sort();
    const expectedKeys = Object.keys(expected).sort();
    return valueKeys.length === expectedKeys.length
      && expectedKeys.every((key, index) => key === valueKeys[index]
        && exactCanonicalValueMatches(value[key], expected[key]));
  }
  if (!value || !expected || typeof value !== "object" || typeof expected !== "object") return false;
  const valueKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return valueKeys.length === expectedKeys.length
    && expectedKeys.every((key, index) => key === valueKeys[index]
      && exactCanonicalValueMatches(value[key], expected[key]));
}

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

export function sanitizeLiveRoomWatchForStorage(watch) {
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
      schemaVersion: Number(watch.sourcePlayerEnvelope?.schemaVersion || 0),
      requestedCount: Number(watch.sourcePlayerEnvelope?.requestedCount || 0),
      fetchedAt: String(watch.sourcePlayerEnvelope?.fetchedAt || ""),
      leagueId: String(watch.sourcePlayerEnvelope?.leagueId || ""),
      teamId: Number(watch.sourcePlayerEnvelope?.teamId || 0),
      season: Number(watch.sourcePlayerEnvelope?.season || 0),
      playerCount: Number(watch.sourcePlayerEnvelope?.playerCount || 0),
      uniquePlayerCount: Number(watch.sourcePlayerEnvelope?.uniquePlayerCount || 0),
    },
    autoArmRequested: watch.autoArmRequested === true,
    armedAt: Number(watch.armedAt),
    expiresAt: Number(watch.expiresAt),
    processingTabId: Number.isInteger(watch.processingTabId) && watch.processingTabId > 0
      ? watch.processingTabId
      : null,
    commandCenterSessionId: String(watch.commandCenterSessionId || ""),
    commandCenterDocumentId: String(watch.commandCenterDocumentId || ""),
  };
}

export function validStoredLiveRoomWatch(
  watch,
  {
    now = Date.now(),
    commandCenterSessionIdIsValid = () => false,
    commandCenterDocumentIdIsValid = () => false,
  } = {},
) {
  const playersFetchedAtMs = Date.parse(String(watch?.sourcePlayersFetchedAt || ""));
  return Boolean(watch
    && exactCanonicalValueMatches(watch, sanitizeLiveRoomWatchForStorage(watch))
    && Number.isInteger(watch.appTabId) && watch.appTabId > 0
    && Number.isInteger(watch.sourceTabId) && watch.sourceTabId > 0
    && watch.sourceLeagueId
    && Number.isInteger(watch.teamId) && watch.teamId > 0
    && Number.isInteger(watch.season) && watch.season > 0
    && typeof watch.rules === "string" && watch.rules.length > 0
    && Array.isArray(watch.sourcePlayers) && watch.sourcePlayers.length > 0
    && Number.isFinite(playersFetchedAtMs)
    && new Date(playersFetchedAtMs).toISOString() === watch.sourcePlayersFetchedAt
    && authenticatedEspnPlayerPoolEnvelopeMatches(watch.sourcePlayerEnvelope, {
      players: watch.sourcePlayers,
      fetchedAt: watch.sourcePlayersFetchedAt,
      leagueId: watch.sourceLeagueId,
      teamId: watch.teamId,
      season: watch.season,
      requestedCount: AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT,
    })
    && Number.isFinite(watch.armedAt) && Number.isFinite(watch.expiresAt)
    && watch.expiresAt > watch.armedAt
    && (watch.processingTabId === null
      || (Number.isInteger(watch.processingTabId) && watch.processingTabId > 0))
    && typeof commandCenterSessionIdIsValid === "function"
    && commandCenterSessionIdIsValid(watch.commandCenterSessionId)
    && typeof commandCenterDocumentIdIsValid === "function"
    && commandCenterDocumentIdIsValid(watch.commandCenterDocumentId)
    && now >= watch.armedAt && now <= watch.expiresAt);
}

export function createLiveRoomHandoffCoordinator() {
  let active = null;
  return {
    run(watch, operation) {
      if (!watch || typeof operation !== "function") return Promise.resolve(null);
      if (active) return active.watch === watch ? active.promise : Promise.resolve(null);
      let claimedPromise;
      claimedPromise = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (active?.promise === claimedPromise) active = null;
        });
      active = { watch, promise: claimedPromise };
      return claimedPromise;
    },
    active() {
      return active !== null;
    },
  };
}

function stableNumberMap(value) {
  return Object.fromEntries(Object.entries(value || {})
    .map(([key, amount]) => [String(key), Number(amount || 0)])
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })));
}

export function liveRoomRuleSignature(league) {
  return JSON.stringify({
    season: Number(league?.season || 0),
    size: Number(league?.size || 0),
    draftType: String(league?.draftType || ""),
    rosterSize: Number(league?.rosterSize || 0),
    auctionBudget: String(league?.draftType || "") === "AUCTION" ? Number(league?.auctionBudget || 0) : 0,
    lineupSlotCounts: stableNumberMap(league?.lineupSlotCounts),
    positionLimits: stableNumberMap(league?.positionLimits),
    scoringLabel: String(league?.scoringLabel || ""),
    scoringRules: Number(league?.scoringRules || 0),
    keeperCount: Number(league?.keeperCount || 0),
  });
}

export function createLiveRoomWatch({ appTabId, sourceContext, sourceLeague, sourcePlayers = [], sourcePlayersFetchedAt, sourcePlayerEnvelope, autoArmRequested = false, now = Date.now(), windowMs = DEFAULT_WATCH_WINDOW_MS }) {
  const sourceLeagueId = String(sourceLeague?.id || "");
  const teamId = Number(sourceContext?.teamId || sourceLeague?.teamId || 0);
  const season = Number(sourceLeague?.season || sourceContext?.season || 0);
  const exactPlayersFetchedAt = String(sourcePlayersFetchedAt || "");
  const playersFetchedAtMs = Date.parse(exactPlayersFetchedAt);
  if (!Number.isInteger(appTabId)
    || !Number.isInteger(Number(sourceContext?.tabId))
    || !sourceLeagueId
    || !Number.isInteger(teamId)
    || teamId <= 0
    || !Number.isInteger(season)
    || season <= 0
    || !authenticatedEspnPlayerPoolEnvelopeMatches(sourcePlayerEnvelope, {
      players: sourcePlayers,
      fetchedAt: exactPlayersFetchedAt,
      leagueId: sourceLeagueId,
      teamId,
      season,
      requestedCount: AUTHENTICATED_ESPN_PLAYER_POOL_REQUIRED_COUNT,
    })
    || !Number.isFinite(playersFetchedAtMs)
    || new Date(playersFetchedAtMs).toISOString() !== exactPlayersFetchedAt
    || sourceContext?.inDraftRoom === true
    || String(sourceContext?.leagueId || "") !== sourceLeagueId) return null;
  return {
    appTabId,
    sourceTabId: Number(sourceContext.tabId),
    sourceLeagueId,
    sourceLeagueName: String(sourceLeague?.name || ""),
    teamId,
    season,
    rules: liveRoomRuleSignature(sourceLeague),
    sourcePlayers: Array.isArray(sourcePlayers) ? sourcePlayers : [],
    sourcePlayersFetchedAt: exactPlayersFetchedAt,
    sourcePlayerEnvelope: Object.freeze({ ...sourcePlayerEnvelope }),
    autoArmRequested: autoArmRequested === true,
    armedAt: now,
    expiresAt: now + Math.max(1, Number(windowMs || DEFAULT_WATCH_WINDOW_MS)),
    processingTabId: null,
  };
}

export function contextCanTriggerLiveRoomWatch(watch, context, now = Date.now()) {
  const tabId = Number(context?.tabId);
  return Boolean(watch
    && now >= Number(watch.armedAt)
    && now <= Number(watch.expiresAt)
    && context?.inDraftRoom === true
    && String(context?.leagueId || "")
    && Number(context?.teamId) === Number(watch.teamId)
    && Number(context?.season) === Number(watch.season)
    && Number.isInteger(tabId)
    && (!Number.isInteger(watch.processingTabId) || Number(watch.processingTabId) === tabId));
}

export function liveLeagueMatchesWatch(watch, liveLeague, liveContext) {
  if (!contextCanTriggerLiveRoomWatch(watch, liveContext)) return false;
  if (String(liveLeague?.id || "") !== String(liveContext?.leagueId || "")
    || Number(liveLeague?.teamId) !== Number(watch.teamId)
    || Number(liveLeague?.season) !== Number(watch.season)
    || liveRoomRuleSignature(liveLeague) !== watch.rules) return false;
  if (String(liveLeague.id) === String(watch.sourceLeagueId)) return true;
  return Boolean(watch.sourceLeagueName
    && String(liveLeague?.name || "") === `Practice Draft for ${watch.sourceLeagueName}`);
}
