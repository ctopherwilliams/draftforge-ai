const DEFAULT_WATCH_WINDOW_MS = 15 * 60 * 1000;

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

export function createLiveRoomWatch({ appTabId, sourceContext, sourceLeague, sourcePlayers = [], sourcePlayersFetchedAt, autoArmRequested = false, now = Date.now(), windowMs = DEFAULT_WATCH_WINDOW_MS }) {
  const sourceLeagueId = String(sourceLeague?.id || "");
  const teamId = Number(sourceContext?.teamId || sourceLeague?.teamId || 0);
  const season = Number(sourceLeague?.season || sourceContext?.season || 0);
  const playerCount = Array.isArray(sourcePlayers) ? sourcePlayers.length : 0;
  const exactPlayersFetchedAt = String(sourcePlayersFetchedAt || (playerCount === 0 ? new Date(now).toISOString() : ""));
  const playersFetchedAtMs = Date.parse(exactPlayersFetchedAt);
  if (!Number.isInteger(appTabId)
    || !Number.isInteger(Number(sourceContext?.tabId))
    || !sourceLeagueId
    || !Number.isInteger(teamId)
    || teamId <= 0
    || !Number.isInteger(season)
    || season <= 0
    || (playerCount > 0 && !sourcePlayersFetchedAt)
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
    sourcePlayerEnvelope: Object.freeze({
      fetchedAt: exactPlayersFetchedAt,
      leagueId: sourceLeagueId,
      teamId,
      season,
      playerCount,
    }),
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
