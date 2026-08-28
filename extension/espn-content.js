const MIN_ACTION_WINDOW_SECONDS = 5;
const MIN_SNAKE_SELECTION_WINDOW_SECONDS = 10;
const MAX_SEARCH_CANDIDATES = 7;
const MAX_MANDATORY_SEARCH_CANDIDATES = 18;
const PLAYER_RESOLUTION_WINDOW_MS = 2200;
const PRIMARY_CANDIDATE_SEARCH_WINDOW_MS = 900;
const CANDIDATE_SEARCH_WINDOW_MS = 250;
const LATE_SNAKE_ROSTER_THRESHOLD = 10;
const LATE_SNAKE_PLAYER_GRID_WINDOW_MS = 120;
const LATE_SNAKE_RESOLUTION_WINDOW_MS = 1000;
const LATE_SNAKE_PRIMARY_SEARCH_WINDOW_MS = 500;
const LATE_SNAKE_CANDIDATE_SEARCH_WINDOW_MS = 80;
const LATE_SNAKE_REHYDRATE_WINDOW_MS = 120;
const MANDATORY_CANDIDATE_SEARCH_WINDOW_MS = 120;
const MANDATORY_POSITION_FILTER_WINDOW_MS = 1800;
const SELECT_CONFIRMATION_WINDOW_MS = 700;
const NOMINATION_CONFIRMATION_WINDOW_MS = 4000;
const BID_ACKNOWLEDGEMENT_WINDOW_MS = 650;
const NOMINATION_ACKNOWLEDGEMENT_WINDOW_MS = 650;
const OWN_NOMINATION_PENDING_WINDOW_MS = 10000;
const MAX_BID_CONTROL_RETRIES = 4;
const AUCTION_SETTLEMENT_DEADLINE_MS = 5000;
const MAX_AUCTION_SALES = 256;
const SELECT_ACTION_BUDGET_MS = 4500;
const MAX_ACTION_DEADLINE_WINDOW_MS = 10000;
const SNAKE_PLAYER_POOL_STABILITY_MS = 180;
const auctionSales = [];
let trackedAuctionOffer = null;
let pendingAuctionSettlement = null;
let auctionSettlementAmbiguous = false;
let trackedOwnNomination = null;
let trackedAuctionSaleSequence = 0;
let lastAcceptedAuctionTrackingRevision = -1;
let domRevision = 0;
let visibleRowsCache = { revision: -1, rows: [] };
let trackedSnakePoolPick = null;
let trackedSnakePoolChangedAt = 0;
let trackedDraftClock = { key: "", seconds: null, observedAt: 0 };
let trackedDraftNamespace = "";
let latestProducerContext = null;
let contextProducerRevision = 0;
const contextProducerSessionId = globalThis.crypto?.randomUUID?.()
  || `producer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let actionExecutionTail = Promise.resolve();
const inFlightActionResults = new Map();
const completedActionResults = new Map();
const actionRequestSignatures = new Map();
const minimumActionAuthorizationEpochs = new Map();
const MAX_COMPLETED_ACTION_RESULTS = 64;

function exactDraftNamespace(url, leagueId, teamId, season) {
  const draftInstance = url.searchParams.get("draftId")
    || url.searchParams.get("memberId")
    || url.searchParams.get("instanceId")
    || url.pathname;
  return `${String(leagueId || "unknown")}:${Number(teamId || 0)}:${Number(season || 0)}:${draftInstance}`;
}

function resetTrackedDraftState(namespace) {
  if (!namespace || trackedDraftNamespace === namespace) return;
  trackedDraftNamespace = namespace;
  auctionSales.length = 0;
  trackedAuctionOffer = null;
  pendingAuctionSettlement = null;
  auctionSettlementAmbiguous = false;
  trackedOwnNomination = null;
  trackedAuctionSaleSequence = 0;
  lastAcceptedAuctionTrackingRevision = -1;
  trackedSnakePoolPick = null;
  trackedSnakePoolChangedAt = 0;
  trackedDraftClock = { key: "", seconds: null, observedAt: 0 };
}

function currentAuctionSettlementStatus() {
  const pending = Boolean(pendingAuctionSettlement || auctionSettlementAmbiguous);
  const expired = auctionSettlementAmbiguous || Boolean(
    pendingAuctionSettlement && Date.now() > Number(pendingAuctionSettlement.settlementDeadlineAt),
  );
  return {
    pending,
    expired,
    code: auctionSettlementAmbiguous
      ? "AUCTION_SETTLEMENT_AMBIGUOUS"
      : pendingAuctionSettlement
        ? expired ? "AUCTION_SETTLEMENT_EXPIRED" : "AUCTION_SETTLEMENT_PENDING"
        : "AUCTION_SETTLEMENT_CURRENT",
  };
}

function isElementVisible(node) {
  if (!node || node.disabled) return false;
  if (typeof node.getClientRects !== "function") return true;
  if (!node.getClientRects().length) return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

function normalizePlayerName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function defenseNickname(value) {
  return String(value || "").replace(/d\/?st|defense/gi, "").trim().split(/\s+/).filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
}

function playerNamesMatch(left, right) {
  if (normalizePlayerName(left) === normalizePlayerName(right)) return true;
  const leftDefense = /d\/?st|defense/i.test(String(left || ""));
  const rightDefense = /d\/?st|defense/i.test(String(right || ""));
  if (!leftDefense && !rightDefense) return false;
  const leftNickname = defenseNickname(left);
  const rightNickname = defenseNickname(right);
  return Boolean(leftNickname && rightNickname && (leftNickname === rightNickname
    || normalizePlayerName(left).includes(rightNickname)
    || normalizePlayerName(right).includes(leftNickname)));
}

function actionDeadlineFailure(action, now = Date.now()) {
  const notAfter = Number(action?.notAfter);
  if (!Number.isSafeInteger(notAfter) || notAfter <= 0 || notAfter - now > MAX_ACTION_DEADLINE_WINDOW_MS) {
    return { ok: false, code: "ACTION_DEADLINE_INVALID", message: "The draft action is missing a valid absolute click deadline. No ESPN control was clicked.", action };
  }
  const availabilityNotAfter = Number(action?.availabilityNotAfter);
  if (!Number.isSafeInteger(availabilityNotAfter) || availabilityNotAfter <= 0) {
    return { ok: false, code: "AVAILABILITY_DEADLINE_INVALID", message: "The draft action is missing a valid availability-veto deadline. No ESPN control was clicked.", action };
  }
  if (now >= availabilityNotAfter) {
    return { ok: false, code: "AVAILABILITY_EXPIRED", message: "The availability-veto evidence expired before ESPN could execute the action. No ESPN control was clicked.", action };
  }
  if (notAfter > availabilityNotAfter) {
    return { ok: false, code: "ACTION_AFTER_AVAILABILITY", message: "The draft action can outlive its availability-veto evidence. No ESPN control was clicked.", action };
  }
  if (now >= notAfter) {
    return { ok: false, code: "ACTION_EXPIRED", message: "The draft action expired before ESPN could execute it. No ESPN control was clicked.", action };
  }
  return null;
}

function nominationHasStarted(context, playerName) {
  const expectedName = normalizePlayerName(playerName);
  return Boolean(expectedName
    && normalizePlayerName(context?.nominatedPlayer) === expectedName
    && Number(context?.currentBid) > 0);
}

function nominationMatchesAction(context, action) {
  const expectedPlayerId = Number(action?.playerId || 0);
  const livePlayerId = Number(context?.nominatedPlayerId || 0);
  return Boolean(
    Number.isInteger(expectedPlayerId)
    && expectedPlayerId !== 0
    && Number.isInteger(livePlayerId)
    && livePlayerId !== 0
    && expectedPlayerId === livePlayerId
    && nominationHasStarted(context, action?.playerName)
  );
}

function rememberOwnNomination(context, action) {
  if (!nominationMatchesAction(context, action) || !["TARGET", "DRAIN"].includes(action?.nominationIntent)) return;
  trackedOwnNomination = {
    leagueId: String(context.leagueId || ""),
    teamId: Number(context.teamId || 0),
    season: Number(context.season || 0),
    playerId: Number(action.playerId || context.nominatedPlayerId || 0),
    playerName: String(action.playerName || context.nominatedPlayer || ""),
    intent: action.nominationIntent,
    pendingUntil: null,
  };
}

function rememberPendingOwnNomination(context, action) {
  if (!["TARGET", "DRAIN"].includes(action?.nominationIntent)) return;
  trackedOwnNomination = {
    leagueId: String(context.leagueId || ""),
    teamId: Number(context.teamId || 0),
    season: Number(context.season || 0),
    playerId: Number(action.playerId || 0),
    playerName: String(action.playerName || ""),
    intent: action.nominationIntent,
    pendingUntil: Date.now() + OWN_NOMINATION_PENDING_WINDOW_MS,
  };
}

function nominationTransition(context, action) {
  const expectedOpeningBid = Number(action?.amount || 0);
  if (nominationMatchesAction(context, action)
    && Number.isInteger(expectedOpeningBid)
    && expectedOpeningBid > 0
    && Number(context?.currentBid) === expectedOpeningBid) {
    rememberOwnNomination(context, action);
    return { ok: true, code: "NOMINATION_CONFIRMED", message: `Exact $${expectedOpeningBid} nomination confirmed in ESPN.`, action };
  }
  if (nominationMatchesAction(context, action) && Number(context?.currentBid) > 0) {
    return { ok: false, code: "NOMINATION_OPENING_PRICE_UNCONFIRMED", message: `ESPN did not expose the exact $${expectedOpeningBid || "unknown"} opening offer for this nominee.` };
  }
  if (context.nominatedPlayer || Number(context.currentBid || 0) > 0) {
    return { ok: false, code: "NOMINATION_ACTIVE", message: "ESPN started another salary-cap nomination before this confirmation control appeared." };
  }
  if (!context.onClock) {
    return { ok: false, code: "NOT_ON_CLOCK", message: "ESPN advanced the nomination turn before the confirmation control appeared." };
  }
  return null;
}

function rosterHasPlayer(context, playerId) {
  const targetId = Number(playerId || 0);
  return Number.isInteger(targetId)
    && targetId !== 0
    && (context?.ownRoster || []).some((entry) => Number(entry.playerId) === targetId);
}

function playerRowFor(node) {
  return node?.closest?.("[role='row'], tr") || null;
}

function playerNameForRow(row) {
  if (!row) return "";
  const named = row.querySelector(".playerinfo__playername, [class*='playername' i], [data-testid*='player-name' i]")?.textContent?.trim();
  if (named) return named;
  return [...row.querySelectorAll("a[title], [title]")]
    .map((node) => node.getAttribute("title")?.trim() || "")
    .find((title) => title && !/^(position|bye week|player)$/i.test(title)) || "";
}

function playerControlForRow(row) {
  return [...(row?.querySelectorAll("button[data-player-id], button[data-playerid], button.Button--draft, button.Button--queue, button") || [])]
    .find((button) => isElementVisible(button) && /^(queue|draft|select)$/i.test((button.textContent || "").trim())) || null;
}

function playerIdForControl(control) {
  const row = playerRowFor(control);
  return Number(control?.getAttribute("data-player-id") || control?.getAttribute("data-playerid") || 0)
    || Number(row?.querySelector("img[src*='/players/full/']")?.getAttribute("src")?.match(/players\/full\/(-?\d+)/)?.[1] || 0)
    || 0;
}

function visiblePlayerRows() {
  if (visibleRowsCache.revision === domRevision) return visibleRowsCache.rows;
  visibleRowsCache = {
    revision: domRevision,
    rows: [...document.querySelectorAll("[role='grid'] [role='row']")].filter(isElementVisible),
  };
  return visibleRowsCache.rows;
}

function visiblePlayerControl(playerId, playerName) {
  const targetId = Number(playerId);
  if (!Number.isInteger(targetId) || targetId === 0) return null;
  const rows = visiblePlayerRows();
  const exactIdControl = rows.map(playerControlForRow)
    .find((control) => control && playerIdForControl(control) === targetId);
  if (exactIdControl) {
    const visibleName = playerNameForRow(playerRowFor(exactIdControl));
    if (!visibleName || playerNamesMatch(visibleName, playerName)) return exactIdControl;
  }
  return null;
}

function snakePlayerPoolIsStable(currentPick, advanceTracking = true) {
  const pick = Number(currentPick || 0) || null;
  if (!pick) return false;
  if (trackedSnakePoolPick !== pick) {
    if (advanceTracking) {
      trackedSnakePoolPick = pick;
      trackedSnakePoolChangedAt = Date.now();
    }
    return false;
  }
  return Date.now() - trackedSnakePoolChangedAt >= SNAKE_PLAYER_POOL_STABILITY_MS;
}

const DRAFT_CLOCK_SELECTOR = [
  "[data-testid='draft-timer']",
  "[data-testid*='draft-clock' i]",
  ".draft-timer",
  ".auction-clock",
  "[class*='draft-clock' i]",
  "[class*='countdown' i]",
].join(", ");
const AUCTION_LEADER_SELECTOR = "[data-testid*='high-bidder' i], [class*='high-bidder' i], [aria-label*='high bidder' i]";

function scopedDraftClock(snakeClock, snakeClockContainer) {
  const selectors = DRAFT_CLOCK_SELECTOR.split(", ");
  if (snakeClock) {
    const exactScope = snakeClockContainer || snakeClock;
    const exactClockNodes = [
      ...(snakeClock.matches?.(DRAFT_CLOCK_SELECTOR) ? [snakeClock] : []),
      ...visibleNodesWithin(exactScope, DRAFT_CLOCK_SELECTOR),
    ].filter((node, index, all) => all.indexOf(node) === index);
    // Once ESPN exposes the exact active-pick wrapper, a page-global timer is
    // never valid authority for this turn. Multiple visible clocks inside the
    // exact wrapper are equally ambiguous while React is rebuilding the room.
    if (exactClockNodes.length > 1) return { seconds: null, source: null };
    const exactCandidates = exactClockNodes.length
      ? exactClockNodes
      : [snakeClock, ...(snakeClockContainer && snakeClockContainer !== snakeClock ? [snakeClockContainer] : [])];
    for (const node of exactCandidates) {
      const matches = [...String(node?.textContent || "").matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
      if (matches.length > 1) return { seconds: null, source: null };
      if (matches.length !== 1) continue;
      const seconds = Number(matches[0][1]) * 60 + Number(matches[0][2]);
      return Number.isFinite(seconds)
        ? { seconds, source: "ACTIVE_PICK_CLOCK" }
        : { seconds: null, source: null };
    }
    return { seconds: null, source: null };
  }
  const candidates = [snakeClock, snakeClockContainer, ...selectors.map((selector) => document.querySelector(selector))]
    .filter((node, index, all) => node && all.indexOf(node) === index && isElementVisible(node));
  for (const node of candidates) {
    const match = String(node.textContent || "").match(/\b(\d{1,2}):(\d{2})\b/);
    if (!match) continue;
    const seconds = Number(match[1]) * 60 + Number(match[2]);
    if (Number.isFinite(seconds)) return { seconds, source: selectors.find((selector) => document.querySelector(selector) === node) || "ACTIVE_PICK_CLOCK" };
  }
  return { seconds: null, source: null };
}

function visibleNodesWithin(root, selector) {
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll(selector)]
    .filter((node, index, all) => all.indexOf(node) === index && isElementVisible(node));
}

function exactPlayerIdentityWithin(root) {
  const rootCarriesIdentity = root?.getAttribute?.("data-player-id") !== null
    && root?.getAttribute?.("data-player-id") !== undefined
    || root?.getAttribute?.("data-playerid") !== null
      && root?.getAttribute?.("data-playerid") !== undefined;
  const identityNodes = [
    ...(rootCarriesIdentity && isElementVisible(root) ? [root] : []),
    ...visibleNodesWithin(root, "[data-player-id], [data-playerid]"),
    ...visibleNodesWithin(root, "img[src*='/players/full/']"),
  ].filter((node, index, all) => all.indexOf(node) === index);
  const playerIds = [];
  let invalidEvidence = false;
  for (const node of identityNodes) {
    const raw = node?.getAttribute?.("data-player-id")
      || node?.getAttribute?.("data-playerid")
      || node?.getAttribute?.("src")?.match(/players\/full\/(-?\d+)/)?.[1]
      || "";
    const playerId = Number(raw);
    if (!Number.isInteger(playerId) || [0, -1].includes(playerId)) {
      invalidEvidence = true;
      continue;
    }
    playerIds.push(playerId);
  }
  const uniquePlayerIds = [...new Set(playerIds)];
  return {
    playerId: !invalidEvidence && identityNodes.length > 0 && uniquePlayerIds.length === 1
      ? uniquePlayerIds[0]
      : null,
    ready: !invalidEvidence && identityNodes.length > 0 && uniquePlayerIds.length === 1,
  };
}

function scopedAuctionClock(root) {
  const clocks = visibleNodesWithin(root, DRAFT_CLOCK_SELECTOR).flatMap((node) => {
    const matches = [...String(node.textContent || "").matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
    if (matches.length !== 1) return [];
    const seconds = Number(matches[0][1]) * 60 + Number(matches[0][2]);
    return Number.isFinite(seconds) ? [{ node, seconds }] : [];
  });
  if (clocks.length !== 1) return { seconds: null, source: null };
  return { seconds: clocks[0].seconds, source: "ACTIVE_AUCTION_TRANSACTION" };
}

function auctionOfferEvidence(root) {
  const matches = [...String(root?.textContent || "").matchAll(/(?:current (?:bid|offer)|high bid)\s*:?\s*\$?\s*(\d+)/gi)];
  if (matches.length !== 1) return { amount: null, count: matches.length };
  const amount = Number(matches[0][1]);
  return { amount: Number.isInteger(amount) && amount > 0 ? amount : null, count: matches.length };
}

function auctionBidSurfaces(root) {
  const forms = visibleNodesWithin(root, ".bidding-form__custom");
  const formButtons = new Set(forms.flatMap((form) => visibleNodesWithin(form, "button, [role='button']")));
  const incremental = visibleNodesWithin(root, "button, [role='button']").filter((node) => {
    if (formButtons.has(node)) return false;
    return /^(?:offer|bid)\s+\$\d+$/i.test(String(node.textContent || "").trim().replace(/\s+/g, " "));
  });
  return {
    forms,
    incremental,
    // ESPN can render its exact +$1 control alongside one custom amount form.
    // Prefer the unique incremental control, while duplicate controls within
    // either surface type remain ambiguous and fail closed.
    ready: incremental.length <= 1
      && forms.length <= 1
      && (incremental.length === 1 || forms.length === 1),
  };
}

function auctionNominationSurfaces(root) {
  return visibleNodesWithin(root, "button, [role='button']").filter((node) => (
    /^nominate(?:\s+player|\s+\w+)?$/i.test(String(node.textContent || "").trim().replace(/\s+/g, " "))
  ));
}

function closestAuctionTransaction(anchor, mode, ownSelectingPick) {
  let node = anchor;
  while (node && node !== document.body) {
    const selected = visibleNodesWithin(node, "[data-testid='player-selected']");
    const selecting = visibleNodesWithin(node, ".auction-pick-component--selecting");
    const clockNodes = visibleNodesWithin(node, DRAFT_CLOCK_SELECTOR);
    const offer = auctionOfferEvidence(node);
    const text = String(node.textContent || "");
    const offerCandidate = mode === "OFFER"
      && selected.length === 1
      && offer.count > 0
      && clockNodes.length > 0;
    const nominationCandidate = mode === "NOMINATION"
      && selecting.length === 1
      && selecting[0]?.closest?.(".auction-pick-component") === ownSelectingPick
      && /(?:your turn to nominate|nominate player)/i.test(text)
      && clockNodes.length > 0;
    if (offerCandidate || nominationCandidate) return node;
    node = node.parentElement || null;
  }
  return null;
}

function activeAuctionTransaction(ownAuctionTeam, selectingAuctionPick, ownAuctionPick) {
  const selected = [...document.querySelectorAll("[data-testid='player-selected']")].filter(isElementVisible);
  const selecting = [...document.querySelectorAll(".auction-pick-component--selecting")].filter(isElementVisible);
  if (selected.length > 1 || selecting.length > 1) return null;

  const roots = [];
  if (selected.length === 1) {
    const root = closestAuctionTransaction(selected[0], "OFFER", selectingAuctionPick);
    if (root) roots.push({ root, mode: "OFFER" });
  }
  if (!roots.some((entry) => entry.mode === "OFFER")
    && selecting.length === 1 && selectingAuctionPick && ownAuctionPick && selectingAuctionPick === ownAuctionPick) {
    const root = closestAuctionTransaction(selecting[0], "NOMINATION", selectingAuctionPick);
    if (root) roots.push({ root, mode: "NOMINATION" });
  }
  const uniqueRoots = roots.filter((entry, index, all) => (
    all.findIndex((candidate) => candidate.root === entry.root && candidate.mode === entry.mode) === index
  ));
  if (uniqueRoots.length !== 1) return null;

  const { root, mode } = uniqueRoots[0];
  const clock = scopedAuctionClock(root);
  const selectedPlayers = visibleNodesWithin(root, "[data-testid='player-selected'] .playerinfo__playername");
  const selectedContainers = visibleNodesWithin(root, "[data-testid='player-selected']");
  const selectedContainer = selectedContainers.length === 1 ? selectedContainers[0] : null;
  const playerNode = selectedPlayers.length === 1 ? selectedPlayers[0] : null;
  const identity = selectedContainer
    ? exactPlayerIdentityWithin(selectedContainer)
    : { playerId: null, ready: false };
  const playerId = identity.playerId;
  const playerName = playerNode?.textContent?.trim().replace(/\s+/g, " ") || null;
  const offer = auctionOfferEvidence(root);
  const leaderNodes = visibleNodesWithin(root, AUCTION_LEADER_SELECTOR);
  const leadingBid = authoritativeLeadingBidState(ownAuctionTeam, leaderNodes);
  const bidSurfaces = auctionBidSurfaces(root);
  const nominationSurfaces = auctionNominationSurfaces(root);
  const controlsReady = mode === "OFFER" ? bidSurfaces.ready : nominationSurfaces.length <= 1;
  const identityReady = mode === "OFFER"
    ? Boolean(identity.ready && playerName && offer.amount)
    : offer.count === 0;
  return {
    root,
    mode,
    playerId,
    playerName,
    currentBid: offer.amount,
    leadingBid,
    clock,
    controlsReady,
    ready: Boolean(identityReady && Number.isFinite(clock.seconds) && controlsReady),
  };
}

function monotonicDraftClock(seconds, key, advanceTracking = true) {
  if (!Number.isFinite(seconds) || !key) return null;
  const now = Date.now();
  if (trackedDraftClock.key !== key) {
    if (advanceTracking) trackedDraftClock = { key, seconds, observedAt: now };
    return seconds;
  }
  // The exact same pick/offer clock may hold or count down. A jump upward is
  // an ESPN surface reset or a different hidden timer and is never actionable.
  if (Number.isFinite(trackedDraftClock.seconds) && seconds > trackedDraftClock.seconds + 1) return null;
  if (advanceTracking) trackedDraftClock = { key, seconds, observedAt: now };
  return seconds;
}

const ROSTER_ROOT_SELECTOR = "[data-testid*='roster' i], [class*='roster' i]";

function fantasyTeamIdsWithin(root) {
  const ids = [];
  const direct = root?.getAttribute?.("data-fantasy-team-id")
    || root?.getAttribute?.("data-team-id")
    || root?.getAttribute?.("data-teamid")
    || "";
  if (/^\d+$/.test(direct)) ids.push(Number(direct));
  for (const link of visibleNodesWithin(root, "a[href*='teamId=']")) {
    const match = String(link.getAttribute?.("href") || "").match(/[?&]teamId=(\d+)/i);
    if (match) ids.push(Number(match[1]));
  }
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
}

function fantasyTeamLabelsWithin(root) {
  return [...new Set(visibleNodesWithin(
    root,
    ".team-name, [data-testid*='team-name' i], [class*='team-name' i]",
  ).map((node) => normalizePlayerName(canonicalAuctionTeamLabel(node.textContent || ""))).filter(Boolean))];
}

function authenticatedOwnRosterRoot(teamId, teamName) {
  const expectedTeamId = Number(teamId);
  const expectedTeamName = normalizePlayerName(canonicalAuctionTeamLabel(teamName || ""));
  if (!Number.isInteger(expectedTeamId) || expectedTeamId <= 0) return null;
  const candidates = visibleNodesWithin(document, ROSTER_ROOT_SELECTOR).filter((root) => (
    visibleNodesWithin(root, "tr").length > 0
  ));
  const authenticated = candidates.filter((root) => {
    const teamIds = fantasyTeamIdsWithin(root);
    const teamLabels = fantasyTeamLabelsWithin(root);
    if (teamIds.length > 1 || (teamIds.length === 1 && teamIds[0] !== expectedTeamId)) return false;
    if (teamLabels.length > 1 || (teamLabels.length === 1 && (!expectedTeamName || teamLabels[0] !== expectedTeamName))) return false;
    return teamIds[0] === expectedTeamId || Boolean(expectedTeamName && teamLabels[0] === expectedTeamName);
  });
  const innermost = authenticated.filter((root) => !authenticated.some((candidate) => (
    candidate !== root && typeof root.contains === "function" && root.contains(candidate)
  )));
  return innermost.length === 1 ? innermost[0] : null;
}

function ownRosterRows(teamId, teamName) {
  const root = authenticatedOwnRosterRoot(teamId, teamName);
  return root ? visibleNodesWithin(root, "tr") : [];
}

function getContext(advanceTracking = true) {
  const url = new URL(window.location.href);
  const text = document.body?.innerText ?? "";
  const leagueMatch = window.location.href.match(/league(?:Id|\/)(?:=|\/)(\d+)/i);
  const teamMatch = window.location.href.match(/team(?:Id|\/)(?:=|\/)(\d+)/i);
  const seasonMatch = window.location.href.match(/(?:seasonId=|\/seasons\/)(\d{4})/i);
  const waitingTeamLink = [...document.querySelectorAll("a[href*='teamId=']")].find((link) => /edit team settings/i.test(link.textContent || ""));
  const waitingTeamMatch = waitingTeamLink?.getAttribute("href")?.match(/[?&]teamId=(\d+)/i);
  const leagueId = url.searchParams.get("leagueId") || leagueMatch?.[1] || null;
  const teamId = Number(url.searchParams.get("teamId") || teamMatch?.[1] || waitingTeamMatch?.[1] || 0) || null;
  const season = Number(url.searchParams.get("seasonId") || seasonMatch?.[1] || 0) || null;
  if (advanceTracking) resetTrackedDraftState(exactDraftNamespace(url, leagueId, teamId, season));
  const snakeClock = document.querySelector(".on-the-clock");
  const snakeClockContainer = snakeClock?.closest?.(".current-pick-module-container") || null;
  // ESPN moves the active pick out of the pick train. On a team's final turn
  // there is therefore no future `.pick-component.own-pick` left to supply the
  // team label, but ESPN still marks the live clock wrapper itself `own-pick`.
  // Treat that exact structural marker as authoritative; the label comparison
  // remains a transition fallback and generic page text is never actionable.
  const snakeClockOwnMarker = Boolean(snakeClock?.closest?.(".own-pick"));
  const snakeClockTeam = snakeClockContainer
    ?.querySelector?.(".team-name")?.textContent?.trim() || "";
  const ownDraftTeam = document.querySelector(".pick-component.own-pick .team-name")
    ?.textContent?.trim() || "";
  const snakeTeamLabelsPresent = Boolean(snakeClockTeam && ownDraftTeam);
  const snakeTeamLabelsMatch = Boolean(snakeTeamLabelsPresent
    && normalizePlayerName(snakeClockTeam) === normalizePlayerName(ownDraftTeam));
  const snakeTeamLabelsConflict = snakeTeamLabelsPresent && !snakeTeamLabelsMatch;
  const snakeOnClock = !snakeTeamLabelsConflict && (snakeClockOwnMarker || snakeTeamLabelsMatch);
  const snakeClockSource = snakeOnClock
    ? (snakeClockOwnMarker ? "ACTIVE_OWN_PICK" : "TEAM_LABEL")
    : null;
  const currentPickMatch = snakeClock?.textContent?.match(/pick\s+(\d+)/i) || text.match(/on the clock:\s*pick\s+(\d+)/i);
  const selectingAuctionNodes = [...document.querySelectorAll(".auction-pick-component--selecting")].filter(isElementVisible);
  const ownAuctionNodes = [...document.querySelectorAll(".auction-pick-component--own")].filter(isElementVisible);
  const selectingAuctionPick = selectingAuctionNodes.length === 1
    ? selectingAuctionNodes[0]?.closest?.(".auction-pick-component") || null
    : null;
  const ownAuctionPick = ownAuctionNodes.length === 1
    ? ownAuctionNodes[0]?.closest?.(".auction-pick-component") || null
    : null;
  const ownAuctionTeamNodes = [...document.querySelectorAll(".auction-pick-component--own .team-name")].filter(isElementVisible);
  const ownAuctionTeam = ownAuctionTeamNodes.length === 1
    ? ownAuctionTeamNodes[0].textContent?.replace(/^\s*\d+\.\s*/, "").trim() || ""
    : "";
  const auctionTransaction = activeAuctionTransaction(ownAuctionTeam, selectingAuctionPick, ownAuctionPick);
  const nominatedPlayerId = auctionTransaction?.playerId || null;
  const nominatedPlayerName = auctionTransaction?.playerName || null;
  const currentBid = Number(auctionTransaction?.currentBid || 0);
  const auctionPickMatch = String(auctionTransaction?.root?.textContent || "").match(/\bPK\s+(\d+)\s+OF\s+\d+\b/i);
  const scopedClock = snakeClock
    ? scopedDraftClock(snakeClock, snakeClockContainer)
    : auctionTransaction?.clock || scopedDraftClock(null, null);
  const clockIdentity = Number(currentPickMatch?.[1] || 0) > 0
    ? `${url.pathname}:snake:${Number(currentPickMatch?.[1])}`
    : nominatedPlayerId
      ? `${url.pathname}:auction:offer:id:${nominatedPlayerId}:bid:${currentBid}`
      : nominatedPlayerName
        ? `${url.pathname}:auction:offer:name:${normalizePlayerName(nominatedPlayerName)}:bid:${currentBid}`
        : Number(auctionPickMatch?.[1] || 0) > 0
          ? `${url.pathname}:auction:nomination:${Number(auctionPickMatch?.[1])}`
          : scopedClock.source
            ? `${url.pathname}:waiting`
            : "";
  const remainingSeconds = monotonicDraftClock(scopedClock.seconds, clockIdentity, advanceTracking);
  const availableRows = visiblePlayerRows();
  const availableControls = availableRows.map(playerControlForRow).filter(Boolean);
  const availableNodes = availableControls.length
    ? availableControls
    : [...document.querySelectorAll("[role='grid'] [role='row'] img[src*='/players/full/']")];
  const availablePlayerIds = availableNodes
    .map((node) => playerIdForControl(node)
      || Number(node.getAttribute("src")?.match(/players\/full\/(-?\d+)/)?.[1] || 0))
    .filter((playerId) => Number.isInteger(playerId) && playerId !== 0 && playerId !== -1);
  const availablePlayerNames = availableControls.map((control) => playerNameForRow(playerRowFor(control))).filter(Boolean);
  const snakePicks = [...document.querySelectorAll(".pick-message__container")].flatMap((row) => {
    const playerName = row.querySelector(".playerinfo__playername")?.textContent?.trim() || "";
    const teamName = row.querySelector(".pick-info")?.textContent?.match(/-\s*(.+?)\s*$/)?.[1]?.trim() || "";
    const pickMatch = row.querySelector(".pick-info")?.textContent?.match(/R(\d+)\s*,\s*P(\d+)/i);
    const round = Number(pickMatch?.[1] || 0);
    const roundPick = Number(pickMatch?.[2] || 0);
    return playerName && teamName && round > 0 && roundPick > 0 ? [{ playerName, teamName, round, roundPick }] : [];
  });
  const exactRosterTeamName = ownAuctionTeam || ownDraftTeam || (snakeOnClock ? snakeClockTeam : "");
  const ownRoster = ownRosterRows(teamId, exactRosterTeamName).flatMap((row) => {
    const rowText = row.textContent?.trim() || "";
    if (!rowText || /^(pos|position)player/i.test(rowText) || /empty/i.test(rowText)) return [];
    const idNode = row.querySelector("[data-player-id], [data-playerid], img[src*='/players/full/'], a[href*='playerId='], a[href*='/players/']");
    const directPlayerId = Number(idNode?.getAttribute("data-player-id") || idNode?.getAttribute("data-playerid") || 0);
    const linkedIdentity = [idNode?.getAttribute("src"), idNode?.getAttribute("href")].filter(Boolean).join(" ");
    const linkedPlayerId = Number(linkedIdentity.match(/(?:playerId=|players\/full\/|players\/[^/]+\/)(-?\d+)/i)?.[1] || 0);
    const exactPlayerId = Number.isInteger(directPlayerId) && directPlayerId !== 0
      ? directPlayerId
      : Number.isInteger(linkedPlayerId) && linkedPlayerId !== 0 ? linkedPlayerId : 0;
    const playerId = exactPlayerId || null;
    const titled = [...row.querySelectorAll("[title]")]
      .map((node) => node.getAttribute("title")?.trim())
      .find((title) => title && !/^(position|bye week|player)$/i.test(title));
    const named = row.querySelector("[class*='playername' i], [data-testid*='player-name' i]")?.textContent?.trim();
    const salaryCell = [...row.querySelectorAll("td")]
      .map((cell) => cell.textContent?.trim() || "")
      .find((cellText) => /^\$\d+$/.test(cellText));
    const amount = Number(salaryCell?.match(/\$(\d+)/)?.[1] || 0);
    if (!playerId && !titled && !named) return [];
    return [{ playerId, name: titled || named || null, amount }];
  });
  const maxLegalBidMatch = String(auctionTransaction?.root?.textContent || "").match(/manual (?:bid|offer) \(max \$(\d+)\)/i);
  const auctionOnClock = Boolean(selectingAuctionPick && ownAuctionPick && selectingAuctionPick === ownAuctionPick);
  const ownBudgetRow = ownAuctionTeam
    ? [...document.querySelectorAll(".budgets-table [role='row']")].find((row) => {
        const cells = [...row.querySelectorAll("[role='gridcell']")];
        return cells.length >= 3
          && normalizePlayerName(cells[0].textContent || "") === normalizePlayerName(ownAuctionTeam);
      })
    : null;
  const ownBudgetCells = [...(ownBudgetRow?.querySelectorAll("[role='gridcell']") || [])];
  const budgetMaxLegalBid = Number((ownBudgetCells[2]?.textContent || "").match(/\$(\d+)/)?.[1] || 0);
  const auctionBudgets = [...document.querySelectorAll(".budgets-table [role='row']")].flatMap((row) => {
    const cells = [...row.querySelectorAll("[role='gridcell']")];
    const teamName = (cells[0]?.textContent || "").replace(/^\s*\d+\.\s*/, "").trim();
    const remaining = Number((cells[1]?.textContent || "").match(/\$(\d+)/)?.[1] || Number.NaN);
    const maxOffer = Number((cells[2]?.textContent || "").match(/\$(\d+)/)?.[1] || Number.NaN);
    return teamName && Number.isFinite(remaining) && Number.isFinite(maxOffer) ? [{ teamName, remaining, maxOffer }] : [];
  });
  const nominationSelectionActive = auctionOnClock
    && auctionTransaction?.mode === "NOMINATION"
    && auctionTransaction.ready === true
    && [...document.querySelectorAll("button[data-player-id], button[data-playerid], button")]
      .some((button) => isElementVisible(button) && /^select$/i.test((button.textContent || "").trim()));
  const inDraftRoom = /\/football\/draft(?:\/|$)/i.test(url.pathname) || /on the clock:\s*pick|you(?:'|’)re on the clock(?!\s+in\b)|your turn to (?:pick|nominate)|nominate player|current (?:bid|offer)/i.test(text);
  // ESPN keeps every volume icon in a hidden SVG sprite, so the mere presence
  // of #icon__controls__volume_mute does not prove the audible control is off.
  // Read the <use> reference rendered inside the visible draft header instead.
  const activeVolumeUse = [...document.querySelectorAll(".draft-header .icon-wrapper use")]
    .find((node) => /icon__controls__volume_/i.test(node.getAttribute("href") || node.getAttribute("xlink:href") || ""));
  const activeVolumeIcon = activeVolumeUse?.getAttribute("href") || activeVolumeUse?.getAttribute("xlink:href") || "";
  const soundMuted = activeVolumeIcon === "#icon__controls__volume_mute";
  const autopickActive = authoritativeAutopickState(text);
  const leadingBid = auctionTransaction?.leadingBid ?? null;
  const snakePickNumber = Number(currentPickMatch?.[1] || 0);
  // The pre-draft room has a readable player grid but no active pick number.
  // Let the user complete the no-click checklist there; once the draft starts,
  // every actual action still requires the stricter per-pick stability window.
  const snakePoolStable = snakePickNumber > 0
    ? snakePlayerPoolIsStable(snakePickNumber, advanceTracking)
    : availableControls.length > 0;
  const auctionSettlement = currentAuctionSettlementStatus();
  const playerPoolReady = Boolean(availableControls.length && snakePoolStable);
  const auctionOfferReady = Boolean(
    inDraftRoom
    && autopickActive === false
    && Number.isFinite(remainingSeconds)
    && budgetMaxLegalBid > 0
    && auctionTransaction?.mode === "OFFER"
    && auctionTransaction.ready === true
    && !auctionSettlement.pending
  );
  const auctionNominationReady = Boolean(
    inDraftRoom
    && autopickActive === false
    && Number.isFinite(remainingSeconds)
    && budgetMaxLegalBid > 0
    && auctionTransaction?.mode === "NOMINATION"
    && auctionTransaction.ready === true
    && availableControls.length > 0
    && !auctionSettlement.pending
  );
  const actionSurfaceReady = ownAuctionTeam
    ? (auctionTransaction?.mode === "OFFER" ? auctionOfferReady : auctionNominationReady)
    : Boolean(
        inDraftRoom
        && autopickActive === false
        && Number.isFinite(remainingSeconds)
        && playerPoolReady
        && (snakeClockOwnMarker || ownDraftTeam)
      );
  const trackedRoomMatches = trackedOwnNomination
    && String(trackedOwnNomination.leagueId) === String(leagueId || "")
    && Number(trackedOwnNomination.teamId) === Number(teamId || 0)
    && Number(trackedOwnNomination.season) === Number(season || 0);
  const trackedPlayerMatches = trackedRoomMatches && (
    (Number(trackedOwnNomination.playerId) !== 0
      && Number(nominatedPlayerId) !== 0
      && Number(trackedOwnNomination.playerId) === Number(nominatedPlayerId))
    || playerNamesMatch(trackedOwnNomination.playerName, nominatedPlayerName || "")
  );
  const trackedNominationPending = trackedRoomMatches
    && Number(trackedOwnNomination?.pendingUntil || 0) > Date.now();
  if (advanceTracking && trackedOwnNomination && (!trackedRoomMatches
    || (currentBid > 0 && !trackedPlayerMatches)
    || (!trackedNominationPending && !nominatedPlayerName && currentBid === 0))) {
    trackedOwnNomination = null;
  }
  return {
    url: window.location.href,
    leagueId,
    teamId,
    season,
    inDraftRoom,
    // A generic ESPN banner can remain mounted while another team is picking.
    // Snake authorization therefore comes only from the exact active-clock
    // team matching ESPN's own-pick team. Salary-cap nomination turns use the
    // exact selecting/own pick component identity above.
    onClock: snakeOnClock || nominationSelectionActive,
    snakeClockSource,
    draftClockSource: scopedClock.source,
    snakeClockOwnMarker,
    snakeClockTeam: snakeClockTeam || null,
    ownDraftTeam: ownDraftTeam || null,
    snakePicks,
    currentPick: Number(currentPickMatch?.[1] || 0) || null,
    remainingSeconds: Number.isFinite(remainingSeconds) ? remainingSeconds : null,
    availablePlayerIds,
    availablePlayerNames,
    ownRoster,
    auctionActive: Boolean(auctionTransaction) || /current (?:bid|offer)|your (?:bid|offer)|nominate player|salary cap/i.test(text),
    auctionTransactionMode: auctionTransaction?.mode || null,
    auctionTransactionReady: auctionTransaction?.ready === true,
    nominatedPlayer: nominatedPlayerName,
    nominatedPlayerId,
    currentBid,
    maxLegalBid: Number(maxLegalBidMatch?.[1] || budgetMaxLegalBid || 0),
    leadingBid,
    soundMuted,
    autopickActive,
    playerPoolReady,
    auctionOfferReady,
    auctionNominationReady,
    actionSurfaceReady,
    auctionSettlementPending: auctionSettlement.pending,
    auctionSettlementExpired: auctionSettlement.expired,
    auctionSettlementCode: auctionSettlement.code,
    auctionBudgets,
    ownNominationIntent: trackedPlayerMatches ? trackedOwnNomination?.intent || null : null,
    ownNominationPlayerId: trackedPlayerMatches ? Number(trackedOwnNomination?.playerId || 0) || null : null,
  };
}

function getRapidAuctionContext(baseContext, advanceTracking = true) {
  if (!baseContext?.auctionActive || baseContext.url !== window.location.href) return null;
  const url = new URL(window.location.href);
  const selectingNodes = [...document.querySelectorAll(".auction-pick-component--selecting")].filter(isElementVisible);
  const ownNodes = [...document.querySelectorAll(".auction-pick-component--own")].filter(isElementVisible);
  const selectingPick = selectingNodes.length === 1
    ? selectingNodes[0]?.closest?.(".auction-pick-component") || null
    : null;
  const ownPick = ownNodes.length === 1
    ? ownNodes[0]?.closest?.(".auction-pick-component") || null
    : null;
  const ownTeamNodes = [...document.querySelectorAll(".auction-pick-component--own .team-name")].filter(isElementVisible);
  const ownTeam = ownTeamNodes.length === 1
    ? ownTeamNodes[0].textContent?.replace(/^\s*\d+\.\s*/, "").trim() || ""
    : "";
  const transaction = activeAuctionTransaction(ownTeam, selectingPick, ownPick);
  // Nomination transitions, completed sales, and ambiguous containers require
  // the full producer. Only an exact active offer uses this bounded hot probe.
  if (!transaction || transaction.mode !== "OFFER") return null;
  const currentBid = Number(transaction.currentBid || 0);
  const playerId = Number(transaction.playerId || 0) || null;
  const playerName = transaction.playerName || null;
  const clockIdentity = playerId
    ? `${url.pathname}:auction:offer:id:${playerId}:bid:${currentBid}`
    : playerName
      ? `${url.pathname}:auction:offer:name:${normalizePlayerName(playerName)}:bid:${currentBid}`
      : "";
  const remainingSeconds = monotonicDraftClock(transaction.clock.seconds, clockIdentity, advanceTracking);
  const toggle = visibleAutopickToggle();
  const autopickActive = toggle && typeof toggle.input?.checked === "boolean"
    ? toggle.input.checked
    : null;
  const scopedMax = Number(String(transaction.root?.textContent || "").match(/manual (?:bid|offer) \(max \$(\d+)\)/i)?.[1] || 0);
  const exactMaxLegalBid = scopedMax || Number(baseContext.maxLegalBid || 0);
  const settlement = currentAuctionSettlementStatus();
  return {
    ...baseContext,
    url: window.location.href,
    inDraftRoom: /\/football\/draft(?:\/|$)/i.test(url.pathname),
    onClock: false,
    draftClockSource: transaction.clock.source,
    remainingSeconds: Number.isFinite(remainingSeconds) ? remainingSeconds : null,
    auctionActive: true,
    auctionTransactionMode: "OFFER",
    auctionTransactionReady: transaction.ready === true,
    nominatedPlayer: playerName,
    nominatedPlayerId: playerId,
    currentBid,
    maxLegalBid: exactMaxLegalBid,
    leadingBid: transaction.leadingBid,
    autopickActive,
    auctionOfferReady: Boolean(
      transaction.ready === true
      && autopickActive === false
      && Number.isFinite(remainingSeconds)
      && exactMaxLegalBid > 0
      && !settlement.pending
    ),
    actionSurfaceReady: Boolean(
      transaction.ready === true
      && autopickActive === false
      && Number.isFinite(remainingSeconds)
      && exactMaxLegalBid > 0
      && !settlement.pending
    ),
    auctionSettlementPending: settlement.pending,
    auctionSettlementExpired: settlement.expired,
    auctionSettlementCode: settlement.code,
  };
}

function visibleAutopickToggle() {
  const container = document.querySelector(".pick-queue__header .autoPick-toggle");
  if (!isElementVisible(container)) return null;
  const input = container.querySelector("input[type='checkbox']");
  const control = container.querySelector("label");
  return input && isElementVisible(control) ? { input, control } : null;
}

function authoritativeAutopickState(text) {
  const evidence = [];
  const toggle = visibleAutopickToggle();
  if (toggle && typeof toggle.input?.checked === "boolean") evidence.push(toggle.input.checked);
  const visibleButtons = [...document.querySelectorAll("button, [role='button']")].filter(isElementVisible);
  if (visibleButtons.some((node) => /^disable autopick$/i.test((node.textContent || "").trim()))) evidence.push(true);
  if (visibleButtons.some((node) => /^enable autopick$/i.test((node.textContent || "").trim()))) evidence.push(false);
  if (/you(?:'|’)re on autopick/i.test(text)) evidence.push(true);
  const uniqueEvidence = new Set(evidence);
  return uniqueEvidence.size === 1 ? [...uniqueEvidence][0] : null;
}

function canonicalAuctionTeamLabel(value) {
  let label = String(value || "").trim();
  for (let pass = 0; pass < 2; pass += 1) {
    label = label
      .replace(/\s*\((?:you|your team)\)\s*$/i, "")
      .replace(/\s*(?:[|•·—–-]\s*)?\$\s*\d+\s*$/i, "")
      .trim();
  }
  return normalizePlayerName(label.replace(/^\s*\d+\.\s*/, ""));
}

function authoritativeLeadingBidState(ownAuctionTeam, scopedLeaderNodes = null) {
  // Never infer current leadership from document.body text. ESPN can leave
  // stale toasts and activity-rail messages from a prior offer mounted while
  // the next nomination is already active. Only one visible, dedicated
  // current-leader element is authoritative; ambiguity fails closed.
  const leaderNodes = Array.isArray(scopedLeaderNodes)
    ? scopedLeaderNodes.filter(isElementVisible)
    : [...document.querySelectorAll(AUCTION_LEADER_SELECTOR)].filter(isElementVisible);
  if (leaderNodes.length !== 1) return null;
  const ownTeamKey = canonicalAuctionTeamLabel(ownAuctionTeam);
  const node = leaderNodes[0];
  const leaderText = String(node.textContent || node.getAttribute?.("aria-label") || "").trim();
  const match = leaderText.match(/(?:high bidder|leader)\s*:?\s*(.+)$/i)
    || leaderText.match(/^(.+?)\s+is\s+(?:the\s+)?(?:high bidder|leader)$/i);
  const leaderKey = canonicalAuctionTeamLabel(match?.[1]);
  if (leaderKey && ownTeamKey && leaderKey === ownTeamKey) return true;
  if (leaderKey && ownTeamKey && leaderKey !== ownTeamKey) return false;
  return null;
}

function visibleDisableAutopickControl() {
  const button = [...document.querySelectorAll("button, [role='button']")]
    .find((node) => isElementVisible(node) && /^disable autopick$/i.test((node.textContent || "").trim()));
  if (button) return button;
  const toggle = visibleAutopickToggle();
  return toggle?.input?.checked ? toggle.control : null;
}

async function disableEspnAutopick(action = {}) {
  let context = getContext();
  if (!context.inDraftRoom) return { ok: false, code: "NOT_IN_DRAFT_ROOM", message: "Open the ESPN draft room first." };
  if (action.expectedLeagueId && String(context.leagueId) !== String(action.expectedLeagueId)) {
    return { ok: false, code: "WRONG_LEAGUE", message: "The open ESPN draft room is for a different league." };
  }
  if (Number.isInteger(Number(action.expectedTeamId)) && Number(context.teamId) !== Number(action.expectedTeamId)) {
    return { ok: false, code: "WRONG_TEAM", message: "The open ESPN draft room is for a different team." };
  }
  if (Number.isInteger(Number(action.expectedSeason)) && Number(context.season) !== Number(action.expectedSeason)) {
    return { ok: false, code: "WRONG_SEASON", message: "The open ESPN draft room is for a different season." };
  }
  if (context.autopickActive === false) return { ok: true, code: "AUTOPICK_ALREADY_OFF", message: "ESPN Autopick is already off." };
  if (context.autopickActive !== true) return { ok: false, code: "AUTOPICK_STATE_UNKNOWN", message: "ESPN does not expose an exact visible Autopick state, so DraftForge cannot safely change it." };
  const control = visibleDisableAutopickControl();
  if (!control) return { ok: false, code: "AUTOPICK_CONTROL_NOT_FOUND", message: "ESPN Autopick is active, but its exact visible disable control is unavailable." };

  control.click();
  const deadline = Date.now() + 800;
  do {
    await new Promise((resolve) => setTimeout(resolve, 40));
    context = getContext();
    if (context.autopickActive === false) return { ok: true, code: "AUTOPICK_DISABLED", message: "ESPN Autopick was disabled in the exact draft room." };
  } while (Date.now() < deadline);
  return { ok: false, code: "AUTOPICK_DISABLE_UNCONFIRMED", message: "ESPN did not confirm that Autopick was disabled." };
}

function sameAuctionPlayerIdentity(leftPlayerId, leftPlayerName, rightPlayerId, rightPlayerName) {
  const leftId = Number(leftPlayerId || 0);
  const rightId = Number(rightPlayerId || 0);
  const leftHasExactId = Number.isInteger(leftId) && ![0, -1].includes(leftId);
  const rightHasExactId = Number.isInteger(rightId) && ![0, -1].includes(rightId);
  if (leftHasExactId && rightHasExactId) return leftId === rightId;
  const leftName = normalizePlayerName(leftPlayerName);
  const rightName = normalizePlayerName(rightPlayerName);
  return Boolean(leftName && rightName && leftName === rightName);
}

function updateAuctionSales(context) {
  const liveName = context.nominatedPlayer || "";
  const livePlayerId = Number(context.nominatedPlayerId || 0);
  const liveBid = Number(context.currentBid || 0);
  const currentBudgets = new Map((context.auctionBudgets || []).map((budget) => [normalizePlayerName(budget.teamName), budget.remaining]));
  const sameOffer = trackedAuctionOffer
    && liveName
    && sameAuctionPlayerIdentity(
      trackedAuctionOffer.playerId,
      trackedAuctionOffer.playerName,
      livePlayerId,
      liveName,
    );

  if (trackedAuctionOffer && !sameOffer) {
    if (!pendingAuctionSettlement) {
      pendingAuctionSettlement = {
        ...trackedAuctionOffer,
        settlementDeadlineAt: Date.now() + AUCTION_SETTLEMENT_DEADLINE_MS,
      };
    } else if (!sameAuctionPlayerIdentity(
      pendingAuctionSettlement.playerId,
      pendingAuctionSettlement.playerName,
      trackedAuctionOffer.playerId,
      trackedAuctionOffer.playerName,
    )) {
      // More than one unresolved budget delta cannot be attributed safely.
      // Keep the oldest exact evidence and lock actions until a fresh room bind.
      auctionSettlementAmbiguous = true;
    }
    trackedAuctionOffer = null;
  }

  let settlementResolved = false;
  if (pendingAuctionSettlement && !auctionSettlementAmbiguous) {
    const positiveDeltas = [...pendingAuctionSettlement.beforeBudgets.entries()].flatMap(([teamKey, previous]) => {
      if (!currentBudgets.has(teamKey)) return [];
      const delta = Number(previous) - Number(currentBudgets.get(teamKey));
      return delta > 0 ? [{ teamKey, delta }] : [];
    });
    const exactWinner = positiveDeltas.length === 1
      && positiveDeltas[0].delta === Number(pendingAuctionSettlement.amount)
      ? positiveDeltas[0]
      : null;
    const winnerBudget = exactWinner
      ? (context.auctionBudgets || []).find((budget) => normalizePlayerName(budget.teamName) === exactWinner.teamKey)
      : null;
    if (exactWinner && winnerBudget) {
      const alreadyRecorded = auctionSales.some((sale) => sameAuctionPlayerIdentity(
        sale.playerId,
        sale.playerName,
        pendingAuctionSettlement.playerId,
        pendingAuctionSettlement.playerName,
      ));
      if (!alreadyRecorded) {
        auctionSales.push({
          playerId: pendingAuctionSettlement.playerId,
          playerName: pendingAuctionSettlement.playerName,
          teamName: winnerBudget.teamName,
          amount: exactWinner.delta,
          sequence: ++trackedAuctionSaleSequence,
        });
        if (auctionSales.length > MAX_AUCTION_SALES) auctionSales.splice(0, auctionSales.length - MAX_AUCTION_SALES);
      }
      pendingAuctionSettlement = null;
      settlementResolved = true;
    }
  }

  if (liveName && liveBid > 0) {
    if (!trackedAuctionOffer) {
      trackedAuctionOffer = {
        playerId: context.nominatedPlayerId,
        playerName: liveName,
        amount: liveBid,
        beforeBudgets: currentBudgets,
      };
    } else {
      trackedAuctionOffer.playerId = context.nominatedPlayerId || trackedAuctionOffer.playerId;
      trackedAuctionOffer.amount = liveBid;
      // If the next offer appeared before the prior budget delta, rebase its
      // starting budgets only after that exact prior sale is proven.
      if (settlementResolved) trackedAuctionOffer.beforeBudgets = currentBudgets;
    }
  }
  const settlement = currentAuctionSettlementStatus();
  return {
    ...context,
    actionSurfaceReady: settlement.pending ? false : context.actionSurfaceReady,
    auctionSettlementPending: settlement.pending,
    auctionSettlementExpired: settlement.expired,
    auctionSettlementCode: settlement.code,
    auctionSales: [...auctionSales],
  };
}

function observeAuctionTracking(context) {
  const settlement = currentAuctionSettlementStatus();
  return {
    ...context,
    actionSurfaceReady: settlement.pending ? false : context.actionSurfaceReady,
    auctionSettlementPending: settlement.pending,
    auctionSettlementExpired: settlement.expired,
    auctionSettlementCode: settlement.code,
    auctionSales: [...auctionSales],
  };
}

function advanceAuctionTracking(context, revision = domRevision) {
  const acceptedRevision = Number(revision);
  if (!Number.isSafeInteger(acceptedRevision) || acceptedRevision < 0) {
    return observeAuctionTracking(context);
  }
  if (acceptedRevision <= lastAcceptedAuctionTrackingRevision) {
    return observeAuctionTracking(context);
  }
  const trackedContext = updateAuctionSales(context);
  lastAcceptedAuctionTrackingRevision = acceptedRevision;
  return trackedContext;
}

function advanceRapidProducerAuctionTracking(context, revision = domRevision) {
  // Rapid auction probes are part of the single producer pipeline, not
  // observational status reads. Accepting their newer DOM revision is what
  // preserves the final live offer when ESPN advances the bid between two
  // bounded full scans. DF_GET_CONTEXT continues to use
  // observeAuctionTracking() and therefore cannot mutate settlement state.
  return advanceAuctionTracking(context, revision);
}

function contextDraftNamespace(context) {
  try {
    const url = new URL(context?.url || window.location.href);
    return exactDraftNamespace(url, context?.leagueId, context?.teamId, context?.season);
  } catch {
    return "";
  }
}

function getObservedContext() {
  // Chat, dashboard, and recovery reads consume the latest producer snapshot.
  // They never trigger another full ESPN DOM traversal on the live-room main
  // thread. A navigation mismatch gets one observational rescan and remains
  // fail-closed until the producer publishes the new exact room.
  if (latestProducerContext?.url === window.location.href) {
    return observeAuctionTracking({ ...latestProducerContext });
  }
  const context = getContext(false);
  if (!trackedDraftNamespace || contextDraftNamespace(context) !== trackedDraftNamespace) {
    return { ...context, auctionSales: [] };
  }
  return observeAuctionTracking(context);
}

function getTrackedContext(revision = domRevision) {
  return advanceAuctionTracking(getContext(true), revision);
}

function hasSafeActionWindow(context, minimumSeconds = MIN_ACTION_WINDOW_SECONDS) {
  return context.autopickActive === false
    && Number.isFinite(context.remainingSeconds)
    && Number(context.remainingSeconds) >= minimumSeconds;
}

function retryBidAction(action, context) {
  const retryCount = Number(action.bidRetryCount || 0);
  if (action.operation !== "BID" || retryCount >= MAX_BID_CONTROL_RETRIES || !hasSafeActionWindow(context)) return null;
  return { ...action, bidRetryCount: retryCount + 1 };
}

function availableSnakeCandidates(candidates, context) {
  const roster = Array.isArray(context?.ownRoster) ? context.ownRoster : [];
  const draftedNames = (Array.isArray(context?.snakePicks) ? context.snakePicks : [])
    .map((pick) => String(pick?.playerName || "").trim())
    .filter(Boolean);
  return candidates.filter((candidate) => {
    const playerId = Number(candidate?.playerId || 0);
    const playerName = String(candidate?.playerName || "").trim();
    if (!playerName) return false;
    if (roster.some((entry) => (
      (playerId !== 0 && Number(entry?.playerId) === playerId)
      || playerNamesMatch(entry?.name, playerName)
    ))) return false;
    return !draftedNames.some((draftedName) => playerNamesMatch(draftedName, playerName));
  });
}

function isLateSnakeResolution(context, operation) {
  return operation === "SELECT"
    && Array.isArray(context?.ownRoster)
    && context.ownRoster.length >= LATE_SNAKE_ROSTER_THRESHOLD;
}

function buildCandidateSearchPlan(candidates, context, operation) {
  const mandatorySearch = candidates.some((candidate) => candidate.fillsMandatoryStarter === true);
  const lateSnakeSearch = !mandatorySearch && isLateSnakeResolution(context, operation);
  const limit = mandatorySearch ? MAX_MANDATORY_SEARCH_CANDIDATES : MAX_SEARCH_CANDIDATES;
  return candidates.slice(0, limit).map((candidate, index) => ({
    candidate,
    waitMs: mandatorySearch
      ? MANDATORY_CANDIDATE_SEARCH_WINDOW_MS
      : lateSnakeSearch
        ? index === 0 ? LATE_SNAKE_PRIMARY_SEARCH_WINDOW_MS : LATE_SNAKE_CANDIDATE_SEARCH_WINDOW_MS
        : index === 0 ? PRIMARY_CANDIDATE_SEARCH_WINDOW_MS : CANDIDATE_SEARCH_WINDOW_MS,
  }));
}

function playerResolutionTiming(context, operation, mandatoryPositionFilter) {
  const lateSnakeSearch = isLateSnakeResolution(context, operation);
  return {
    playerGridWaitMs: mandatoryPositionFilter
      ? 0
      : lateSnakeSearch
        ? LATE_SNAKE_PLAYER_GRID_WINDOW_MS
        : context.ownRoster.length ? 400 : 700,
    resolutionWindowMs: lateSnakeSearch ? LATE_SNAKE_RESOLUTION_WINDOW_MS : PLAYER_RESOLUTION_WINDOW_MS,
    rehydrateWindowMs: lateSnakeSearch ? LATE_SNAKE_REHYDRATE_WINDOW_MS : 400,
  };
}

function buildMandatoryPositionPlan(candidates) {
  const primary = candidates[0];
  const slotId = primary?.position === "DST" ? "16" : primary?.position === "K" ? "17" : null;
  if (!slotId || primary.fillsMandatoryStarter !== true) return null;
  return {
    slotId,
    candidates: candidates.filter((candidate) => candidate.position === primary.position),
  };
}

function findByText(selector, patterns, root = document) {
  const matches = [...root.querySelectorAll(selector)].filter((node) => {
    if (!isElementVisible(node)) return false;
    const label = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`.trim();
    return patterns.some((pattern) => pattern.test(label));
  });
  return matches.length === 1 ? matches[0] : null;
}

function currentAuctionTransaction() {
  const selectingNodes = [...document.querySelectorAll(".auction-pick-component--selecting")].filter(isElementVisible);
  const ownNodes = [...document.querySelectorAll(".auction-pick-component--own")].filter(isElementVisible);
  const teamNodes = [...document.querySelectorAll(".auction-pick-component--own .team-name")].filter(isElementVisible);
  const selectingPick = selectingNodes.length === 1
    ? selectingNodes[0]?.closest?.(".auction-pick-component") || null
    : null;
  const ownPick = ownNodes.length === 1
    ? ownNodes[0]?.closest?.(".auction-pick-component") || null
    : null;
  const ownTeam = teamNodes.length === 1
    ? teamNodes[0].textContent?.replace(/^\s*\d+\.\s*/, "").trim() || ""
    : "";
  return activeAuctionTransaction(ownTeam, selectingPick, ownPick);
}

function setNativeValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeSelectValue(select, value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function visiblePositionFilter(slotId) {
  return [...document.querySelectorAll("select")].find((select) => (
    isElementVisible(select)
    && [...select.options].some((option) => (
      String(option.value) === String(slotId)
      && (slotId === "16" ? /d\/st|defense/i : /^k$/i).test(String(option.textContent || "").trim())
    ))
  )) || null;
}

function visiblePlayerSearchInput() {
  return [...document.querySelectorAll("input")].find((input) => {
    if (!isElementVisible(input)) return false;
    const label = `${input.getAttribute("placeholder") || ""} ${input.getAttribute("aria-label") || ""}`;
    return /player name|search player/i.test(label);
  }) || null;
}

function customBidStructure() {
  const transaction = currentAuctionTransaction();
  if (!transaction?.ready) return null;
  const forms = visibleNodesWithin(transaction.root, ".bidding-form__custom");
  if (forms.length !== 1) return null;
  const form = forms[0];
  const inputs = [...form.querySelectorAll("#bid__input, input[type='number']")]
    .filter((input) => input instanceof HTMLInputElement && isElementVisible(input));
  const submits = [...form.querySelectorAll("button, [role='button']")].filter((node) => (
    isElementVisible(node)
    && /^(?:bid|offer|place bid)$/i.test((node.textContent || "").trim().replace(/\s+/g, " "))
  ));
  return inputs.length === 1 && submits.length === 1 ? { form, input: inputs[0], submit: submits[0] } : null;
}

function exactSettledCustomBidSurface(amount) {
  const expectedAmount = Number(amount);
  if (!Number.isInteger(expectedAmount) || expectedAmount < 1) return null;
  const structure = customBidStructure();
  return structure && Number(structure.input.value) === expectedAmount ? structure : null;
}

async function settleCustomBidSurface(amount, deadline) {
  const expectedAmount = Number(amount);
  if (!Number.isInteger(expectedAmount) || expectedAmount < 1) return null;
  while (Date.now() < deadline) {
    const initial = customBidStructure();
    if (initial) {
      setNativeValue(initial.input, String(expectedAmount));
      const crossedRenderBoundary = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };
        const timeout = setTimeout(() => finish(false), Math.max(1, Math.min(50, deadline - Date.now())));
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => finish(true));
      });
      if (!crossedRenderBoundary) continue;
      const settled = exactSettledCustomBidSurface(expectedAmount);
      if (settled) return settled;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

function exactVisibleModalConfirmation(action) {
  const expectedPlayerId = Number(action?.playerId || 0);
  if (!Number.isInteger(expectedPlayerId) || expectedPlayerId === 0) return null;
  const dialogs = [...document.querySelectorAll("[role='dialog'], [aria-modal='true'], [class*='modal' i]")]
    .filter(isElementVisible);
  const matches = dialogs.flatMap((dialog) => {
    const identityNodes = [...dialog.querySelectorAll("[data-player-id], [data-playerid], [data-testid*='player-name' i], [class*='playername' i]")];
    const identityIds = [...new Set(identityNodes
      .map((node) => Number(node.getAttribute?.("data-player-id") || node.getAttribute?.("data-playerid") || 0))
      .filter((playerId) => Number.isInteger(playerId) && playerId !== 0))];
    const exactIdentity = identityIds.length === 1 && identityIds[0] === expectedPlayerId;
    if (!exactIdentity) return [];
    if (["BID", "NOMINATE"].includes(action?.operation)) {
      const expectedAmount = Number(action?.amount);
      if (!Number.isInteger(expectedAmount) || !new RegExp(`\\$\\s*${expectedAmount}(?:\\D|$)`).test(String(dialog.textContent || ""))) return [];
    }
    return [...dialog.querySelectorAll("button, [role='button']")].filter((node) => (
      isElementVisible(node)
      && /^(?:confirm|submit|yes)(?:\s|$)|^confirm (?:pick|bid|nomination)$|^yes,? (?:draft|bid|nominate)$/i.test((node.textContent || "").trim())
    ));
  });
  return matches.length === 1 ? matches[0] : null;
}

function preflightAction(action, context) {
  const authorizationFailure = actionAuthorizationFailure(action);
  if (authorizationFailure) return authorizationFailure;
  const deadlineFailure = actionDeadlineFailure(action);
  if (deadlineFailure) return deadlineFailure;
  if (!context.inDraftRoom) return { ok: false, code: "NOT_IN_DRAFT_ROOM", message: "Open the ESPN draft room first." };
  if (context.autopickActive === true) return { ok: false, code: "AUTOPICK_ACTIVE", message: "ESPN Autopick is active. DraftForge stopped without sending another action." };
  if (context.autopickActive !== false) return { ok: false, code: "AUTOPICK_STATE_UNKNOWN", message: "ESPN does not expose an exact visible Autopick-off control. DraftForge stopped without sending an action." };
  if (action.expectedLeagueId && String(context.leagueId) !== String(action.expectedLeagueId)) {
    return { ok: false, code: "WRONG_LEAGUE", message: "The open ESPN draft room is for a different league." };
  }
  if (Number.isInteger(Number(action.expectedTeamId)) && Number(context.teamId) !== Number(action.expectedTeamId)) {
    return { ok: false, code: "WRONG_TEAM", message: "The open ESPN draft room is for a different team." };
  }
  if (Number.isInteger(Number(action.expectedSeason)) && Number(context.season) !== Number(action.expectedSeason)) {
    return { ok: false, code: "WRONG_SEASON", message: "The open ESPN draft room is for a different season." };
  }
  if (["BID", "NOMINATE"].includes(action.operation) && context.auctionSettlementPending === true) {
    return {
      ok: false,
      code: context.auctionSettlementExpired ? "AUCTION_SETTLEMENT_EXPIRED" : "AUCTION_SETTLEMENT_PENDING",
      message: "ESPN has not yet exposed one exact winner and salary for the prior sale. DraftForge stopped rather than act from stale budgets or roster state.",
    };
  }
  if (action.operation === "NOMINATE" && (context.nominatedPlayer || Number(context.currentBid || 0) > 0)) {
    return { ok: false, code: "NOMINATION_ACTIVE", message: "ESPN already has an active salary-cap nominee, so no nomination was sent." };
  }
  if (action.operation === "BID" && context.auctionTransactionMode !== "OFFER") {
    return { ok: false, code: "AUCTION_TRANSACTION_UNKNOWN", message: "ESPN does not expose one exact active offer container, so no bid was sent." };
  }
  if (action.operation === "NOMINATE" && context.auctionTransactionMode !== "NOMINATION") {
    return { ok: false, code: "AUCTION_TRANSACTION_UNKNOWN", message: "ESPN does not expose one exact nomination-turn container, so no nomination was sent." };
  }
  if (action.operation === "NOMINATE" && context.auctionTransactionReady !== true) {
    return { ok: false, code: "AUCTION_TRANSACTION_AMBIGUOUS", message: "The active ESPN auction container has ambiguous clock or action controls, so no action was sent." };
  }
  if (action.requireOnClock !== false && !context.onClock && action.operation !== "BID") {
    return { ok: false, code: "NOT_ON_CLOCK", message: "ESPN does not show that you are on the clock." };
  }
  const minimumActionWindow = action.operation === "SELECT" ? MIN_SNAKE_SELECTION_WINDOW_SECONDS : MIN_ACTION_WINDOW_SECONDS;
  if (!hasSafeActionWindow(context, minimumActionWindow)) {
    return { ok: false, code: "CLOCK_TOO_SHORT", message: `Only ${context.remainingSeconds ?? "unknown"} seconds remain. DraftForge stopped before an unsafe action.` };
  }
  if (action.operation === "SELECT" && Number(action.expectedPick) > 0 && context.currentPick && Number(action.expectedPick) !== Number(context.currentPick)) {
    return { ok: false, code: "PICK_CHANGED", message: "The active ESPN pick changed before the selection could be sent." };
  }
  if ((action.operation === "SELECT" || action.operation === "NOMINATE") && context.actionSurfaceReady !== true) {
    return { ok: false, code: "PLAYER_POOL_STALE", message: "ESPN's live player pool has not stabilized for this exact turn." };
  }
  if (action.operation === "BID" && context.leadingBid === true) {
    return { ok: true, code: "HOLD_LEADING_BID", message: "ESPN confirms that we already lead this offer; no bid was sent." };
  }
  if (action.operation === "BID" && context.leadingBid !== false) {
    return { ok: false, code: "LEADING_BID_UNKNOWN", message: "ESPN does not expose authoritative proof that another team leads, so no bid was sent." };
  }
  if (action.operation === "BID" && context.auctionTransactionReady !== true) {
    return { ok: false, code: "AUCTION_TRANSACTION_AMBIGUOUS", message: "The active ESPN offer container has ambiguous clock or bid controls, so no bid was sent." };
  }
  if (action.operation === "BID" && (!Number.isFinite(Number(action.maxApprovedBid)) || Number(action.maxApprovedBid) < 0)) {
    return { ok: false, code: "BID_CEILING_UNKNOWN", message: "The source-backed walk-away ceiling is missing, so no bid was sent." };
  }
  if (action.operation === "BID") {
    const expectedCurrentBid = Number(action.expectedCurrentBid);
    const expectedNextOffer = expectedCurrentBid + 1;
    if (!Number.isFinite(expectedCurrentBid) || expectedCurrentBid < 0) {
      return { ok: false, code: "BID_CONTEXT_INVALID", message: "The expected ESPN offer is missing, so no bid was sent." };
    }
    if (expectedNextOffer > Number(action.maxApprovedBid)) {
      return { ok: true, code: "WALK_AWAY", message: `Offer is above the approved $${Number(action.maxApprovedBid)} walk-away price.` };
    }
  }
  if (action.operation === "NOMINATE") {
    if (!["TARGET", "DRAIN"].includes(action.nominationIntent)) {
      return { ok: false, code: "NOMINATION_INTENT_UNKNOWN", message: "The nomination intent is missing, so no player was selected." };
    }
    const openingBid = Number(action.amount || 1);
    if (!Number.isInteger(openingBid) || openingBid < 1) {
      return { ok: false, code: "INVALID_OPENING_BID", message: "The ESPN opening offer must be a positive whole dollar." };
    }
    if (!Number.isFinite(context.maxLegalBid) || Number(context.maxLegalBid) < openingBid) {
      return { ok: false, code: "BUDGET_RESERVE", message: "The nomination would violate ESPN's one-dollar reserve for open roster spots." };
    }
  }
  if (action.operation === "BID") {
    if (!context.nominatedPlayer) return { ok: false, code: "NOMINEE_UNKNOWN", message: "ESPN does not expose an active nominee, so the bid was not sent." };
    if (!nominationMatchesAction(context, action)) {
      return { ok: false, code: "NOMINEE_MISMATCH", message: "The ESPN nominee no longer matches the recommended player." };
    }
    const expectedCurrentBid = Number(action.expectedCurrentBid);
    if (!Number.isFinite(expectedCurrentBid) || Number(context.currentBid) !== expectedCurrentBid) {
      return { ok: false, code: "BID_CHANGED", message: "The ESPN offer changed before the bid could be sent." };
    }
    if (Number(action.amount) !== Number(context.currentBid) + 1) {
      return { ok: false, code: "BID_OUT_OF_SEQUENCE", message: "The requested bid is no longer the next legal ESPN offer." };
    }
    if (!Number.isFinite(context.maxLegalBid) || Number(context.maxLegalBid) < 1) {
      return { ok: false, code: "BUDGET_UNKNOWN", message: "ESPN does not expose a legal maximum offer, so the bid was not sent." };
    }
    if (Number(action.amount) > Number(context.maxLegalBid)) {
      return { ok: false, code: "BUDGET_RESERVE", message: "The bid would violate ESPN's one-dollar reserve for open roster spots." };
    }
  }
  return { ok: true, action };
}

function actionExecutionSignature(action) {
  const candidateSignature = (Array.isArray(action?.candidates) ? action.candidates : [])
    .map((candidate) => [
      Number(candidate?.playerId || 0),
      normalizePlayerName(candidate?.playerName),
      String(candidate?.position || ""),
      candidate?.fillsMandatoryStarter === true ? "required" : "optional",
    ].join("-"))
    .join(",");
  return [
    action?.commandCenterSessionId || "",
    action?.dashboardLoadedAt || "",
    action?.actionId || "",
    action?.decisionId || "",
    action?.sourceSnapshotId || "",
    action?.operation || "",
    action?.expectedLeagueId || "",
    Number(action?.expectedTeamId || 0),
    Number(action?.expectedSeason || 0),
    Number(action?.expectedTabId || 0),
    Number(action?.authorizationEpoch ?? -1),
    Number(action?.expectedPick || 0),
    Number(action?.playerId || 0),
    normalizePlayerName(action?.playerName),
    String(action?.position || ""),
    action?.fillsMandatoryStarter === true ? "required" : "optional",
    Number(action?.expectedCurrentBid ?? -1),
    Number(action?.amount || 0),
    Number(action?.maxApprovedBid || 0),
    Number(action?.notAfter || 0),
    Number(action?.availabilityNotAfter || 0),
    String(action?.availabilityDigest || ""),
    String(action?.availabilityDecisionDigest || ""),
    action?.requireOnClock === true ? "on-clock" : "no-clock-requirement",
    action?.nominationIntent || "",
    candidateSignature,
  ].join(":");
}

function safeCommandCenterSessionId(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function actionAuthorizationFailure(action) {
  const sessionId = String(action?.commandCenterSessionId || "");
  const epoch = Number(action?.authorizationEpoch);
  if (!safeCommandCenterSessionId(sessionId) || !Number.isSafeInteger(epoch) || epoch < 0) {
    return { ok: false, code: "ACTION_AUTHORIZATION_INVALID", message: "The command-center authorization epoch is missing or invalid. No ESPN action was sent.", action };
  }
  const minimumEpoch = Number(minimumActionAuthorizationEpochs.get(sessionId) || 0);
  return epoch < minimumEpoch
    ? { ok: false, code: "ACTION_AUTHORIZATION_REVOKED", message: "The command center revoked this action before the ESPN click.", action }
    : null;
}

async function verifiedActionAuthorizationFailure(action) {
  const localFailure = actionAuthorizationFailure(action);
  if (localFailure) return localFailure;
  try {
    if (!chrome.runtime?.id) throw new Error("EXTENSION_CONTEXT_INVALID");
    const result = await chrome.runtime.sendMessage({
      type: "VERIFY_ACTION_AUTHORIZATION",
      payload: action,
    });
    if (result?.ok !== true) {
      return {
        ok: false,
        code: String(result?.code || "WRITER_LEASE_UNVERIFIED"),
        message: "The bound DraftForge writer or authorization lease changed before the ESPN click.",
        action,
      };
    }
  } catch {
    return {
      ok: false,
      code: "WRITER_LEASE_UNVERIFIED",
      message: "The DraftForge companion could not verify the live writer immediately before the ESPN click.",
      action,
    };
  }
  return actionAuthorizationFailure(action);
}

function rememberMinimumActionAuthorizationEpoch(sessionId, minimumEpoch) {
  if (!safeCommandCenterSessionId(sessionId) || !Number.isSafeInteger(minimumEpoch) || minimumEpoch < 0) return false;
  const current = Number(minimumActionAuthorizationEpochs.get(sessionId) || 0);
  minimumActionAuthorizationEpochs.set(sessionId, Math.max(current, minimumEpoch));
  while (minimumActionAuthorizationEpochs.size > 16) {
    const oldest = minimumActionAuthorizationEpochs.keys().next().value;
    if (oldest === undefined) break;
    minimumActionAuthorizationEpochs.delete(oldest);
  }
  return true;
}

function resultForAction(result, action) {
  return {
    ...result,
    action: {
      ...(result?.action || action),
      ...(action?.actionRequestId !== undefined ? { actionRequestId: action.actionRequestId } : {}),
    },
  };
}

function rememberCompletedAction(key, result) {
  completedActionResults.set(key, result);
  while (completedActionResults.size > MAX_COMPLETED_ACTION_RESULTS) {
    const oldest = completedActionResults.keys().next().value;
    if (oldest === undefined) break;
    completedActionResults.delete(oldest);
    if (String(oldest).startsWith("request:")) {
      actionRequestSignatures.delete(String(oldest).slice("request:".length));
    }
  }
}

async function executeAction(action) {
  const commandCenterSessionId = action?.commandCenterSessionId;
  if (!safeCommandCenterSessionId(commandCenterSessionId)) {
    return { ok: false, code: "COMMAND_CENTER_SESSION_INVALID", message: "The draft action is missing a safe command-center session identity.", action };
  }
  const authorizationFailure = actionAuthorizationFailure(action);
  if (authorizationFailure) return authorizationFailure;
  const deadlineFailure = actionDeadlineFailure(action);
  if (deadlineFailure) return deadlineFailure;
  const signature = actionExecutionSignature(action);
  const requestId = Number(action?.actionRequestId);
  const requestKey = Number.isInteger(requestId) ? `${commandCenterSessionId}:${requestId}` : null;
  if (requestKey) {
    const previousSignature = actionRequestSignatures.get(requestKey);
    if (previousSignature && previousSignature !== signature) {
      return { ok: false, code: "ACTION_REQUEST_CONFLICT", message: "The same action request id was reused for different ESPN state.", action };
    }
    actionRequestSignatures.set(requestKey, signature);
  }
  const requestResultKey = requestKey ? `request:${requestKey}` : null;
  if (requestResultKey && completedActionResults.has(requestResultKey)) {
    return resultForAction(completedActionResults.get(requestResultKey), action);
  }
  if (completedActionResults.has(signature)) {
    const cached = completedActionResults.get(signature);
    if (requestResultKey) rememberCompletedAction(requestResultKey, cached);
    return resultForAction(cached, action);
  }
  if (inFlightActionResults.has(signature)) {
    const shared = await inFlightActionResults.get(signature);
    if (requestResultKey) rememberCompletedAction(requestResultKey, shared);
    return resultForAction(shared, action);
  }

  const execution = actionExecutionTail
    .catch(() => {})
    .then(() => executeActionNow(action));
  actionExecutionTail = execution.catch(() => {});
  inFlightActionResults.set(signature, execution);
  try {
    const result = await execution;
    // Successful, deliberately terminal, or post-click-uncertain outcomes are
    // idempotent for this exact offer. Pre-click selector failures remain
    // eligible for a new request after ESPN rerenders.
    if (result?.ok === true || result?.clicked === true || ["WALK_AWAY", "HOLD_LEADING_BID"].includes(result?.code)) {
      rememberCompletedAction(signature, result);
    }
    if (requestResultKey) rememberCompletedAction(requestResultKey, result);
    return resultForAction(result, action);
  } finally {
    inFlightActionResults.delete(signature);
  }
}

async function executeActionNow(action) {
  const deadlineFailure = actionDeadlineFailure(action);
  if (deadlineFailure) return deadlineFailure;
  const actionDeadlineAt = Math.min(Number(action.notAfter), Date.now() + SELECT_ACTION_BUDGET_MS);
  let currentAction = { ...action, actionDeadlineAt };
  while (true) {
    const result = await executeActionAttempt(currentAction);
    if (!result?.retryAction) return result;
    if (Date.now() >= actionDeadlineAt) {
      return { ok: false, code: "ACTION_TIMEOUT", message: "ESPN did not confirm the exact player quickly enough. DraftForge stopped this candidate while time remained to re-rank." };
    }
    currentAction = result.retryAction;
  }
}

function getAuctionAcknowledgementContext() {
  const rapid = latestProducerContext
    ? getRapidAuctionContext(latestProducerContext, false)
    : null;
  return rapid || getContext();
}

async function acknowledgeBid(action) {
  const deadline = Math.min(
    Number(action.actionDeadlineAt || Infinity),
    Date.now() + BID_ACKNOWLEDGEMENT_WINDOW_MS,
  );
  let context = getAuctionAcknowledgementContext();
  while (Date.now() < deadline) {
    const livePlayerMatches = nominationMatchesAction(context, action);
    const liveBid = Number(context.currentBid || 0);
    if (livePlayerMatches && liveBid === Number(action.amount) && context.leadingBid === true) {
      return { ok: true, code: "BID_CONFIRMED", message: `ESPN confirmed the exact $${action.amount} bid and our lead.`, action };
    }
    if (livePlayerMatches && liveBid > Number(action.amount)) {
      return { ok: true, code: "BID_SUPERSEDED", message: `ESPN advanced the offer beyond $${action.amount}; re-evaluate from the new exact price.`, action };
    }
    if ((context.nominatedPlayer || liveBid > 0) && !livePlayerMatches) {
      return { ok: false, clicked: true, retryable: false, code: "BID_ACK_UNCERTAIN", message: "ESPN changed nominees before confirming the clicked bid. DraftForge will not retry it blindly.", action };
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    context = getAuctionAcknowledgementContext();
  }
  return { ok: false, clicked: true, retryable: false, code: "BID_ACK_UNCERTAIN", message: "ESPN did not acknowledge the clicked bid before the bounded deadline. DraftForge will not retry it blindly.", action };
}

async function acknowledgeNomination(action) {
  const deadline = Math.min(
    Number(action.actionDeadlineAt || Infinity),
    Date.now() + NOMINATION_ACKNOWLEDGEMENT_WINDOW_MS,
  );
  let context = getAuctionAcknowledgementContext();
  while (Date.now() < deadline) {
    const transition = nominationTransition(context, action);
    if (transition?.ok) return transition;
    if (transition && !transition.ok) {
      return { ...transition, clicked: true, retryable: false, code: "NOMINATION_ACK_UNCERTAIN", message: `${transition.message} DraftForge will not retry the clicked confirmation blindly.`, action };
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    context = getAuctionAcknowledgementContext();
  }
  return { ok: false, clicked: true, retryable: false, code: "NOMINATION_ACK_UNCERTAIN", message: "ESPN did not acknowledge the clicked nomination before the bounded deadline. DraftForge will not retry it blindly.", action };
}

async function executeActionAttempt(action) {
  const context = getContext();
  const preflight = preflightAction(action, context);
  if (!preflight.action) return preflight;
  action = preflight.action;

  let resolvedAction = action;
  let usedPlayerSearch = null;
  let usedPositionFilter = null;
  let preliminaryClickSent = false;
  if (action.operation === "SELECT" || action.operation === "NOMINATE") {
    const exactMetadata = (Array.isArray(action.candidates) ? action.candidates : []).find((candidate) => (
      Number(candidate?.playerId || 0) === Number(action.playerId || 0)
      && playerNamesMatch(candidate?.playerName, action.playerName)
    ));
    // The server has acknowledged this exact chosen player. Content-script
    // fallback to an alternative would bypass that publication fence, even if
    // the alternative appeared in an informational shortlist. Return
    // PLAYER_NOT_FOUND so the production engine can plan and publish the next
    // exact player as a new decision before any click.
    const requestedCandidates = [{
      playerId: action.playerId,
      playerName: action.playerName,
      position: action.position || exactMetadata?.position,
      fillsMandatoryStarter: action.fillsMandatoryStarter ?? exactMetadata?.fillsMandatoryStarter,
    }];
    // The pick message rail updates before the virtualized player pool. Remove
    // exact players ESPN already proves were drafted so late-round resolution
    // never spends sequential search windows on stale recommendations. This
    // only prunes authoritative history; model order among legal candidates is
    // unchanged and exact DOM identity is still required before every click.
    const candidates = action.operation === "SELECT"
      ? availableSnakeCandidates(requestedCandidates, context)
      : requestedCandidates;
    if (!candidates.length) {
      return { ok: false, code: "PLAYER_NOT_FOUND", message: "Every recommended player is already confirmed in ESPN's draft history." };
    }
    const primaryCandidate = candidates[0];
    let visibleCandidate = primaryCandidate && visiblePlayerControl(primaryCandidate.playerId, primaryCandidate.playerName)
      ? primaryCandidate
      : null;
    const mandatoryPositionPlan = buildMandatoryPositionPlan(candidates);
    const mandatoryPositionFilter = !visibleCandidate && mandatoryPositionPlan
      ? visiblePositionFilter(mandatoryPositionPlan.slotId)
      : null;
    // ESPN briefly tears down and rebuilds its virtualized player grid when a
    // snake turn begins. Hold the top deterministic candidate locally so a
    // lower-ranked rendered row cannot jump ahead during that rebuild.
    // ESPN's first turn performs a longer one-time grid hydration. Do not let
    // that startup race consume the front of the ordered shortlist.
    // A visible exact K/DST filter is the authoritative fast path for final
    // mandatory slots. Waiting for the unfiltered virtualized grid first adds
    // a second hydration delay without improving identity safety.
    // Once ten roster spots are confirmed, repeated authenticated drafts show
    // that ESPN's virtualized pool resolves normally inside 500 ms, while the
    // original sequential fallback can consume more than 2.4 seconds. Keep the
    // same deterministic order and exact identity checks, but bound only this
    // proven late-snake path so an unsuccessful search returns control while
    // the 10-second safety window is still intact.
    const resolutionTiming = playerResolutionTiming(context, action.operation, mandatoryPositionFilter);
    const playerGridWaitMs = resolutionTiming.playerGridWaitMs;
    const playerGridDeadline = Math.min(Number(action.actionDeadlineAt || Infinity), Date.now() + playerGridWaitMs);
    while (!visibleCandidate && Date.now() < playerGridDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (primaryCandidate && visiblePlayerControl(primaryCandidate.playerId, primaryCandidate.playerName)) {
        visibleCandidate = primaryCandidate;
      }
    }
    // ESPN virtualizes the late-round table, so required kickers and defenses
    // (and occasionally early elite players) may not exist in the DOM even
    // though they are available. Resolve the shortlist strictly in model order:
    // search each leading candidate before considering any lower visible row.
    if (!visibleCandidate && mandatoryPositionPlan) {
      const positionFilter = mandatoryPositionFilter || visiblePositionFilter(mandatoryPositionPlan.slotId);
      if (positionFilter) {
        usedPositionFilter = positionFilter;
        if (String(positionFilter.value) !== mandatoryPositionPlan.slotId) {
          setNativeSelectValue(positionFilter, mandatoryPositionPlan.slotId);
          visibleRowsCache.revision = -1;
        }
        const filterDeadline = Math.min(
          Number(action.actionDeadlineAt || Infinity),
          Date.now() + MANDATORY_POSITION_FILTER_WINDOW_MS,
        );
        while (!visibleCandidate && Date.now() < filterDeadline) {
          visibleCandidate = mandatoryPositionPlan.candidates
            .find((candidate) => visiblePlayerControl(candidate.playerId, candidate.playerName)) || null;
          if (!visibleCandidate) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            visibleRowsCache.revision = -1;
          }
        }
      }
    }
    const playerSearch = visiblePlayerSearchInput();
    if (!visibleCandidate && !usedPositionFilter && playerSearch instanceof HTMLInputElement) {
      const resolutionDeadline = Math.min(
        Number(action.actionDeadlineAt || Infinity),
        Date.now() + resolutionTiming.resolutionWindowMs,
      );
      for (const { candidate, waitMs } of buildCandidateSearchPlan(candidates, context, action.operation)) {
        if (Date.now() >= resolutionDeadline) break;
        if (visiblePlayerControl(candidate.playerId, candidate.playerName)) {
          visibleCandidate = candidate;
          break;
        }
        setNativeValue(playerSearch, candidate.playerName);
        const candidateDeadline = Math.min(
          Date.now() + waitMs,
          resolutionDeadline,
        );
        while (!visibleCandidate && Date.now() < candidateDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          const searchedControl = visiblePlayerControl(candidate.playerId, candidate.playerName);
          if (searchedControl) visibleCandidate = candidate;
        }
        if (visibleCandidate) {
          usedPlayerSearch = playerSearch;
          break;
        }
      }
      if (!visibleCandidate) setNativeValue(playerSearch, "");
    }
    // Clearing ESPN's search causes its virtualized grid to rehydrate. The
    // previous implementation stopped here, even when one of the ordered
    // candidates became visible again a moment later. Re-read that live grid
    // briefly and select the highest-ranked exact match; never select an
    // arbitrary rendered row.
    if (!visibleCandidate && !usedPositionFilter && playerSearch instanceof HTMLInputElement) {
      const rehydrateDeadline = Math.min(
        Number(action.actionDeadlineAt || Infinity),
        Date.now() + resolutionTiming.rehydrateWindowMs,
      );
      while (!visibleCandidate && Date.now() < rehydrateDeadline) {
        visibleRowsCache.revision = -1;
        visibleCandidate = candidates
          .find((candidate) => visiblePlayerControl(candidate.playerId, candidate.playerName)) || null;
        if (!visibleCandidate) await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    // If ESPN ever removes the search box, retain a fail-closed exact-identity
    // fallback while preserving the same model order among rendered rows.
    if (!visibleCandidate && !usedPositionFilter && !(playerSearch instanceof HTMLInputElement)) {
      visibleCandidate = candidates
        .find((candidate) => visiblePlayerControl(candidate.playerId, candidate.playerName)) || null;
    }
    if (visibleCandidate) resolvedAction = { ...action, ...visibleCandidate };
  }

  const selectControl = action.operation === "SELECT" || action.operation === "NOMINATE"
    ? visiblePlayerControl(resolvedAction.playerId, resolvedAction.playerName)
    : null;
  const resolvedPlayerId = playerIdForControl(selectControl);
  const requestedPlayerId = Number(resolvedAction.playerId || 0);
  let directSelect = selectControl && /draft/i.test(selectControl.textContent || "") ? selectControl : null;
  if (action.operation === "SELECT" && !selectControl) {
    const candidateNames = (Array.isArray(action.candidates) ? action.candidates : [action])
      .slice(0, 5).map((candidate) => candidate.playerName).filter(Boolean);
    const visibleNames = [...document.querySelectorAll("[role='grid'] [role='row']")]
      .filter(isElementVisible).map(playerNameForRow).filter(Boolean).slice(0, 5);
    return {
      ok: false,
      code: "PLAYER_NOT_FOUND",
      message: `No recommended player is visible in ESPN's available-player list (received ${candidateNames.length ? candidateNames.join(", ") : "no candidates"}; ESPN shows ${visibleNames.length ? visibleNames.join(", ") : "no visible player rows"}).`,
    };
  }
  if (action.operation === "NOMINATE" && !selectControl) {
    return { ok: false, code: "PLAYER_NOT_FOUND", message: `No recommended player is visible in ESPN's available-player list.` };
  }
  if (["SELECT", "NOMINATE"].includes(action.operation)
    && (!Number.isInteger(requestedPlayerId) || requestedPlayerId === 0 || resolvedPlayerId !== requestedPlayerId)) {
    return { ok: false, code: "PLAYER_CONTROL_DRIFT", message: "ESPN's player control does not expose the exact recommended player id." };
  }

  // Candidate resolution can consume most of a fast snake transition. Re-read
  // the exact ESPN clock immediately before touching the player row so a stale
  // dashboard message or a turn change can never cause even a selection click.
  if (action.operation === "SELECT" || action.operation === "NOMINATE") {
    const refreshedPreflight = preflightAction(action, getContext());
    if (!refreshedPreflight.action) {
      if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
      if (usedPositionFilter && String(usedPositionFilter.value) !== "-1") {
        setNativeSelectValue(usedPositionFilter, "-1");
        visibleRowsCache.revision = -1;
      }
      return refreshedPreflight;
    }
    action = refreshedPreflight.action;
    resolvedAction = {
      ...action,
      playerId: resolvedAction.playerId,
      playerName: resolvedAction.playerName,
      position: resolvedAction.position,
      fillsMandatoryStarter: resolvedAction.fillsMandatoryStarter,
    };
  }

  if (action.operation === "NOMINATE") {
    const deadlineFailure = actionDeadlineFailure(action);
    if (deadlineFailure) return deadlineFailure;
    const authorizationFailure = await verifiedActionAuthorizationFailure(action);
    if (authorizationFailure) return authorizationFailure;
    if (playerIdForControl(selectControl) !== requestedPlayerId) {
      return { ok: false, code: "PLAYER_CONTROL_DRIFT", message: "ESPN's nomination row changed player identity before selection." };
    }
    selectControl.scrollIntoView({ block: "center" });
    selectControl.click();
    preliminaryClickSent = true;
  }
  if (action.operation === "SELECT" && !directSelect) {
    const deadlineFailure = actionDeadlineFailure(action);
    if (deadlineFailure) return deadlineFailure;
    const authorizationFailure = await verifiedActionAuthorizationFailure(action);
    if (authorizationFailure) return authorizationFailure;
    if (playerIdForControl(selectControl) !== requestedPlayerId) {
      return { ok: false, code: "PLAYER_CONTROL_DRIFT", message: "ESPN's player row changed identity before selection." };
    }
    selectControl.scrollIntoView({ block: "center" });
    selectControl.click();
    preliminaryClickSent = true;
  }

  const exactIncrementalBidControl = () => {
    if (action.operation !== "BID") return null;
    const transaction = currentAuctionTransaction();
    if (transaction?.mode !== "OFFER" || transaction.ready !== true) return null;
    const matches = visibleNodesWithin(transaction.root, "button, [role='button']").filter((node) => {
      const label = (node.textContent || "").trim().replace(/\s+/g, " ");
      return new RegExp(`^(?:offer|bid) \\$${Number(action.amount)}$`, "i").test(label);
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const patterns = action.operation === "NOMINATE"
    ? [/^nominate$/i, /nominate player/i, /nominate\s+\w+/i]
    : action.operation === "BID"
      ? [/^bid$/i, /place bid/i, /bid \$/i, /^offer(?:\s+\$\d+)?$/i]
      : [/^draft$/i, /^select$/i, /draft player/i, /make pick/i];
  const exactNominationControl = () => {
    if (action.operation !== "NOMINATE" || Number(action.amount) !== 1) return null;
    const transaction = currentAuctionTransaction();
    return transaction?.mode === "NOMINATION" && transaction.ready === true
      ? findByText("button, [role='button']", patterns, transaction.root)
      : null;
  };
  const exactDraftControl = () => [...document.querySelectorAll(`button.Button--draft[data-player-id="${CSS.escape(String(resolvedPlayerId))}"], button.Button--draft[data-playerid="${CSS.escape(String(resolvedPlayerId))}"]`)]
    .find(isElementVisible) || null;
  const submitWindowMs = action.operation === "BID"
    ? 180
    : action.operation === "NOMINATE"
      ? NOMINATION_CONFIRMATION_WINDOW_MS
      : 1500;
  const submitDeadline = Math.min(Number(action.actionDeadlineAt || Infinity), Date.now() + submitWindowMs);
  let customAmountSurface = null;
  let submit = directSelect || (action.operation === "SELECT"
    ? exactDraftControl()
    : action.operation === "BID"
      ? exactIncrementalBidControl()
      : exactNominationControl());
  const needsCustomAmountSurface = (action.operation === "BID" && !submit)
    || (action.operation === "NOMINATE" && Number(action.amount) !== 1);
  if (needsCustomAmountSurface) {
    customAmountSurface = await settleCustomBidSurface(action.amount, submitDeadline);
    submit = customAmountSurface?.submit || null;
  }
  while (!submit && Date.now() < submitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (action.operation === "NOMINATE") {
      const transition = nominationTransition(getContext(), resolvedAction);
      if (transition) {
        if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
        return transition;
      }
    }
    submit = action.operation === "SELECT"
      ? exactDraftControl()
      : action.operation === "BID"
        ? exactIncrementalBidControl()
        : exactNominationControl();
  }
  if (!submit) {
    const latest = getContext();
    // ESPN can accept the selected nominee and immediately replace the
    // confirmation panel with live bidding. Exact nominee identity plus an
    // active offer is authoritative success; anything less still fails closed.
    const nominationResult = action.operation === "NOMINATE"
      ? nominationTransition(latest, resolvedAction)
      : null;
    if (nominationResult) {
      if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
      return nominationResult;
    }
    if (action.operation === "BID") {
      const retryAction = retryBidAction(action, latest);
      if (retryAction) return { retryAction };
      return Number(latest.currentBid) !== Number(action.expectedCurrentBid)
        ? { ok: false, code: "BID_CHANGED", message: "The ESPN offer changed before the bid control could be sent." }
        : { ok: false, code: "BID_OUT_OF_SEQUENCE", message: "ESPN no longer exposes the exact incremental offer control." };
    }
    return { ok: false, code: "ACTION_NOT_FOUND", message: "The ESPN confirmation control was not found. ESPN may have changed its draft-room layout." };
  }

  if (action.operation === "SELECT") {
    const submitPlayerId = playerIdForControl(submit);
    if (submitPlayerId !== requestedPlayerId) {
      return { ok: false, code: "PLAYER_CONTROL_DRIFT", message: "ESPN's Draft control does not match the recommended player." };
    }
  }

  if (customAmountSurface) {
    const settledAgain = exactSettledCustomBidSurface(action.amount);
    if (!settledAgain) {
      return { ok: false, code: "CUSTOM_AMOUNT_UNCONFIRMED", message: "ESPN did not preserve the exact custom dollar amount on one unique visible bid form." };
    }
    customAmountSurface = settledAgain;
    submit = settledAgain.submit;
  }

  const preSubmitContext = getContext();
  const minimumPreSubmitWindow = action.operation === "SELECT" ? MIN_SNAKE_SELECTION_WINDOW_SECONDS : MIN_ACTION_WINDOW_SECONDS;
  if (!hasSafeActionWindow(preSubmitContext, minimumPreSubmitWindow)) {
    return { ok: false, code: "CLOCK_TOO_SHORT", message: `Only ${preSubmitContext.remainingSeconds ?? "unknown"} seconds remain. DraftForge stopped before an unsafe action.` };
  }
  // The pick number can remain mounted while ESPN transitions the active team.
  // Never let the stale initial on-clock state override the final authoritative
  // own-clock marker/team identity immediately before the click.
  if (action.operation !== "BID" && preSubmitContext.onClock !== true) {
    return { ok: false, code: "NOT_ON_CLOCK", message: "ESPN changed turns before the action could be sent." };
  }
  if (action.operation === "SELECT" && Number(action.expectedPick) > 0 && Number(preSubmitContext.currentPick) !== Number(action.expectedPick)) {
    return { ok: false, code: "PICK_CHANGED", message: "The active ESPN pick changed before the selection could be sent." };
  }
  if (action.operation === "BID") {
    const bidPreflight = preflightAction(action, preSubmitContext);
    if (!bidPreflight.action) return bidPreflight;
    action = bidPreflight.action;
  }
  if (customAmountSurface) {
    const finalSurface = exactSettledCustomBidSurface(action.amount);
    if (!finalSurface) {
      return { ok: false, code: "CUSTOM_AMOUNT_DRIFT", message: "ESPN changed the exact custom dollar form immediately before submission." };
    }
    submit = finalSurface.submit;
  }

  if (action.operation === "SELECT") {
    sendToCompanion({ type: "ESPN_ACTION_RESOLVED", payload: resolvedAction });
  }
  const finalDeadlineFailure = actionDeadlineFailure(action);
  if (finalDeadlineFailure) return finalDeadlineFailure;
  const finalAuthorizationFailure = await verifiedActionAuthorizationFailure(action);
  if (finalAuthorizationFailure) return preliminaryClickSent
    ? { ...finalAuthorizationFailure, clicked: true, retryable: false }
    : finalAuthorizationFailure;
  submit.click();
  if (action.operation === "NOMINATE") rememberPendingOwnNomination(preSubmitContext, resolvedAction);
  let submittedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 75));
  if (usedPositionFilter && String(usedPositionFilter.value) !== "-1") {
    setNativeSelectValue(usedPositionFilter, "-1");
    visibleRowsCache.revision = -1;
  }
  const confirmation = exactVisibleModalConfirmation(resolvedAction);
  if (confirmation) {
    const confirmationDeadlineFailure = actionDeadlineFailure(action);
    if (confirmationDeadlineFailure) {
      return {
        ...confirmationDeadlineFailure,
        clicked: true,
        retryable: false,
        code: "ACTION_EXPIRED_AFTER_SUBMIT",
        message: "The action expired after ESPN received the first click. DraftForge did not click the confirmation or retry.",
        action: { ...resolvedAction, submittedAt },
      };
    }
    const confirmationAuthorizationFailure = await verifiedActionAuthorizationFailure(action);
    if (confirmationAuthorizationFailure) {
      return {
        ...confirmationAuthorizationFailure,
        clicked: true,
        retryable: false,
        message: "The command center revoked this action after ESPN received the first click. DraftForge did not click the confirmation.",
      };
    }
    confirmation.click();
  }
  if (confirmation) submittedAt = Date.now();
  resolvedAction = { ...resolvedAction, submittedAt };
  sendToCompanion({ type: "ESPN_ACTION_SUBMITTED", payload: { ...resolvedAction, submittedAt } });
  if (action.operation === "SELECT") {
    const confirmationDeadline = Math.min(Number(action.actionDeadlineAt || Infinity), Date.now() + SELECT_CONFIRMATION_WINDOW_MS);
    let confirmedContext = getContext();
    while (!rosterHasPlayer(confirmedContext, resolvedAction.playerId)
      && Number(confirmedContext.currentPick) === Number(action.expectedPick)
      && Date.now() < confirmationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      confirmedContext = getContext();
    }
    if (rosterHasPlayer(confirmedContext, resolvedAction.playerId)) {
      if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
      return { ok: true, code: "ROSTER_CONFIRMED", message: `${resolvedAction.playerName} confirmed on the ESPN roster.`, action: resolvedAction };
    }
    if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
    return {
      ok: false,
      clicked: true,
      retryable: false,
      code: "ROSTER_NOT_CONFIRMED",
      message: `ESPN did not confirm ${resolvedAction.playerName} on the exact roster. DraftForge will not click any candidate again until the room state is reconciled.`,
      action: resolvedAction,
    };
  }
  if (action.operation === "BID") {
    if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
    return acknowledgeBid(resolvedAction);
  }
  if (action.operation === "NOMINATE") {
    if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
    return acknowledgeNomination(resolvedAction);
  }
  if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
  return { ok: true, code: "SUBMITTED", message: `${action.operation.toLowerCase()} submitted in ESPN.`, action: resolvedAction };
}

const ACTIVE_CONTEXT_DEBOUNCE_MS = 25;
const ACTIVE_CONTEXT_SCAN_INTERVAL_MS = 75;
const ACTIVE_AUCTION_FULL_SCAN_INTERVAL_MS = 400;
const IDLE_CONTEXT_DEBOUNCE_MS = 125;
const IDLE_CONTEXT_SCAN_INTERVAL_MS = 500;
const CONTEXT_WATCHDOG_MS = 2000;

function contextNeedsPromptScan(context) {
  return ["OFFER", "NOMINATION"].includes(context?.auctionTransactionMode)
    || (context?.onClock === true && Number.isFinite(context?.remainingSeconds));
}

function contextScanPolicy(context, activeHint = false) {
  const active = Boolean(activeHint || contextNeedsPromptScan(context));
  return active
    ? { active: true, debounceMs: ACTIVE_CONTEXT_DEBOUNCE_MS, minIntervalMs: ACTIVE_CONTEXT_SCAN_INTERVAL_MS }
    : { active: false, debounceMs: IDLE_CONTEXT_DEBOUNCE_MS, minIntervalMs: IDLE_CONTEXT_SCAN_INTERVAL_MS };
}

function nextContextScanDelay({ now, lastScanAt, context, activeHint = false }) {
  const policy = contextScanPolicy(context, activeHint);
  const elapsed = Math.max(0, Number(now) - Number(lastScanAt || 0));
  return Math.max(policy.debounceMs, policy.minIntervalMs - elapsed);
}

function hasPromptContextMutationEvidence() {
  const selected = [...document.querySelectorAll("[data-testid='player-selected']")].filter(isElementVisible);
  const selecting = [...document.querySelectorAll(".auction-pick-component--selecting")].filter(isElementVisible);
  if (selected.length || selecting.length) return true;
  const snakeClock = document.querySelector(".on-the-clock");
  if (!isElementVisible(snakeClock)) return false;
  const clockContainer = snakeClock?.closest?.(".current-pick-module-container") || null;
  const ownMarker = Boolean(snakeClock?.closest?.(".own-pick"));
  const clockTeam = clockContainer?.querySelector?.(".team-name")?.textContent?.trim() || "";
  const ownTeam = document.querySelector(".pick-component.own-pick .team-name")?.textContent?.trim() || "";
  const teamMatch = Boolean(clockTeam && ownTeam && normalizePlayerName(clockTeam) === normalizePlayerName(ownTeam));
  return Boolean((ownMarker || teamMatch) && Number.isFinite(scopedDraftClock(snakeClock, clockContainer).seconds));
}

function sendToCompanion(message) {
  try {
    // Reloading an unpacked extension invalidates scripts already injected into
    // open ESPN tabs. Do nothing until that tab is reloaded into the new context.
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Extension-context invalidation is expected during a companion reload.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DF_GET_CONTEXT") {
    // Status reads are deliberately observational. Producer scans are the
    // only path allowed to advance settlement recovery or append auction
    // sales, so chat/UI queries cannot change a later draft decision.
    sendResponse(getObservedContext());
    return;
  }
  if (message?.type === "DF_CANCEL_PENDING_ACTIONS") {
    const accepted = rememberMinimumActionAuthorizationEpoch(
      String(message.payload?.commandCenterSessionId || ""),
      Number(message.payload?.minimumAuthorizationEpoch),
    );
    sendResponse(accepted
      ? { ok: true, code: "ACTION_AUTHORIZATION_REVOKED" }
      : { ok: false, code: "ACTION_AUTHORIZATION_INVALID" });
    return;
  }
  if (message?.type === "DF_EXECUTE_ACTION") {
    executeAction(message.payload).then(sendResponse);
    return true;
  }
  if (message?.type === "DF_DISABLE_AUTOPICK") {
    disableEspnAutopick(message.payload).then(sendResponse);
    return true;
  }
});

let previousState = "";
let lastContextScanAt = 0;
let lastFullContextScanAt = 0;
let scheduledContextRefresh = null;
let scheduledContextRefreshAt = 0;
let latestContextForScheduling = null;

function scanAndPublishContext(forceHeartbeat = false) {
  if (scheduledContextRefresh) {
    clearTimeout(scheduledContextRefresh);
    scheduledContextRefresh = null;
    scheduledContextRefreshAt = 0;
  }
  const scanStartedAt = Date.now();
  lastContextScanAt = scanStartedAt;
  const rapidAuction = latestProducerContext
    && scanStartedAt - lastFullContextScanAt < ACTIVE_AUCTION_FULL_SCAN_INTERVAL_MS
    ? getRapidAuctionContext(latestProducerContext, true)
    : null;
  const observedContext = rapidAuction
    ? advanceRapidProducerAuctionTracking(rapidAuction, domRevision)
    : getTrackedContext(domRevision);
  if (!rapidAuction) lastFullContextScanAt = scanStartedAt;
  const context = { ...observedContext };
  delete context.producerRevision;
  delete context.contextCapturedAt;
  latestContextForScheduling = context;
  const serialized = JSON.stringify(context);
  if (serialized !== previousState) {
    previousState = serialized;
    contextProducerRevision += 1;
    latestProducerContext = {
      ...context,
      producerSessionId: contextProducerSessionId,
      producerRevision: contextProducerRevision,
      contextCapturedAt: new Date(scanStartedAt).toISOString(),
    };
    sendToCompanion({ type: "ESPN_CONTEXT", payload: latestProducerContext });
  } else if (forceHeartbeat && context.inDraftRoom && context.leagueId) {
    sendToCompanion({ type: "ESPN_HEARTBEAT", payload: latestProducerContext || context });
  }
  if (rapidAuction && !scheduledContextRefresh) {
    const delay = Math.max(1, ACTIVE_AUCTION_FULL_SCAN_INTERVAL_MS - (Date.now() - lastFullContextScanAt));
    scheduledContextRefreshAt = Date.now() + delay;
    scheduledContextRefresh = setTimeout(() => scanAndPublishContext(false), delay);
  }
  if (context.onClock && context.autopickActive === false && !context.actionSurfaceReady && !scheduledContextRefresh) {
    const delay = SNAKE_PLAYER_POOL_STABILITY_MS + 25;
    scheduledContextRefreshAt = Date.now() + delay;
    scheduledContextRefresh = setTimeout(() => scanAndPublishContext(false), delay);
  }
}

function queueContextRefresh() {
  const now = Date.now();
  const delay = nextContextScanDelay({
    now,
    lastScanAt: lastContextScanAt,
    context: latestContextForScheduling,
    activeHint: hasPromptContextMutationEvidence(),
  });
  const requestedAt = now + delay;
  if (scheduledContextRefresh && scheduledContextRefreshAt <= requestedAt) return;
  if (scheduledContextRefresh) clearTimeout(scheduledContextRefresh);
  scheduledContextRefreshAt = requestedAt;
  scheduledContextRefresh = setTimeout(() => scanAndPublishContext(false), delay);
}

const contextObserver = new MutationObserver(() => {
  domRevision += 1;
  queueContextRefresh();
});
contextObserver.observe(document.documentElement || document.body, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ["class", "disabled", "aria-label", "href"],
});
const contextWatchdog = setInterval(() => scanAndPublishContext(true), CONTEXT_WATCHDOG_MS);
window.addEventListener("pagehide", () => {
  contextObserver.disconnect();
  clearInterval(contextWatchdog);
  if (scheduledContextRefresh) clearTimeout(scheduledContextRefresh);
  scheduledContextRefreshAt = 0;
}, { once: true });

scanAndPublishContext(false);
