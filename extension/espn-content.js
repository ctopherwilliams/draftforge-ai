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
const MAX_AUCTION_SETTLEMENT_RECOVERY_POLLS = 5;
const MAX_AUCTION_SALES = 256;
const SELECT_ACTION_BUDGET_MS = 4500;
const SNAKE_PLAYER_POOL_STABILITY_MS = 180;
const auctionSales = [];
let trackedAuctionOffer = null;
let trackedOwnNomination = null;
let trackedAuctionSaleSequence = 0;
let domRevision = 0;
let visibleRowsCache = { revision: -1, rows: [] };
let trackedSnakePoolPick = null;
let trackedSnakePoolChangedAt = 0;
let trackedDraftClock = { key: "", seconds: null, observedAt: 0 };
let trackedDraftNamespace = "";
let actionExecutionTail = Promise.resolve();
const inFlightActionResults = new Map();
const completedActionResults = new Map();
const actionRequestSignatures = new Map();
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
  trackedOwnNomination = null;
  trackedAuctionSaleSequence = 0;
  trackedSnakePoolPick = null;
  trackedSnakePoolChangedAt = 0;
  trackedDraftClock = { key: "", seconds: null, observedAt: 0 };
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

function nominationHasStarted(context, playerName) {
  const expectedName = normalizePlayerName(playerName);
  return Boolean(expectedName
    && normalizePlayerName(context?.nominatedPlayer) === expectedName
    && Number(context?.currentBid) > 0);
}

function nominationMatchesAction(context, action) {
  const expectedPlayerId = Number(action?.playerId || 0);
  const livePlayerId = Number(context?.nominatedPlayerId || 0);
  if (expectedPlayerId && livePlayerId) return expectedPlayerId === livePlayerId;
  return nominationHasStarted(context, action?.playerName);
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

function rosterHasPlayer(context, playerId, playerName) {
  const targetId = Number(playerId || 0);
  const targetName = normalizePlayerName(playerName);
  return (context?.ownRoster || []).some((entry) => (
    (targetId !== 0 && Number(entry.playerId) === targetId)
    || (targetName && playerNamesMatch(entry.name, playerName))
  ));
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
  const targetName = normalizePlayerName(playerName);
  const rows = visiblePlayerRows();
  const exactIdControl = rows.map(playerControlForRow)
    .find((control) => control && playerIdForControl(control) === Number(playerId));
  if (exactIdControl) {
    const visibleName = playerNameForRow(playerRowFor(exactIdControl));
    if (!visibleName || playerNamesMatch(visibleName, playerName)) return exactIdControl;
  }
  if (!targetName) return null;
  const exactNameRow = rows.find((row) => playerNamesMatch(playerNameForRow(row), playerName));
  return playerControlForRow(exactNameRow);
}

function snakePlayerPoolIsStable(currentPick) {
  const pick = Number(currentPick || 0) || null;
  if (!pick) return false;
  if (trackedSnakePoolPick !== pick) {
    trackedSnakePoolPick = pick;
    trackedSnakePoolChangedAt = Date.now();
    return false;
  }
  return Date.now() - trackedSnakePoolChangedAt >= SNAKE_PLAYER_POOL_STABILITY_MS;
}

function scopedDraftClock(snakeClock, snakeClockContainer) {
  const selectors = [
    "[data-testid='draft-timer']",
    "[data-testid*='draft-clock' i]",
    ".draft-timer",
    ".auction-clock",
    "[class*='draft-clock' i]",
    "[class*='countdown' i]",
  ];
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

function monotonicDraftClock(seconds, key) {
  if (!Number.isFinite(seconds) || !key) return null;
  const now = Date.now();
  if (trackedDraftClock.key !== key) {
    trackedDraftClock = { key, seconds, observedAt: now };
    return seconds;
  }
  // The exact same pick/offer clock may hold or count down. A jump upward is
  // an ESPN surface reset or a different hidden timer and is never actionable.
  if (Number.isFinite(trackedDraftClock.seconds) && seconds > trackedDraftClock.seconds + 1) return null;
  trackedDraftClock = { key, seconds, observedAt: now };
  return seconds;
}

function getContext() {
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
  resetTrackedDraftState(exactDraftNamespace(url, leagueId, teamId, season));
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
  const currentBidMatch = text.match(/current (?:bid|offer)\s*:\s*\$?\s*(\d+)/i) || text.match(/high bid\s*\$?\s*(\d+)/i);
  const activeAuctionPlayer = document.querySelector("[data-testid='player-selected'] .playerinfo__playername");
  const activeAuctionContainer = activeAuctionPlayer?.closest?.("[data-testid='player-selected']") || null;
  const nominatedPlayerId = Number(
    activeAuctionContainer?.querySelector?.("[data-player-id], [data-playerid]")?.getAttribute?.("data-player-id")
    || activeAuctionContainer?.querySelector?.("[data-player-id], [data-playerid]")?.getAttribute?.("data-playerid")
    || activeAuctionContainer?.querySelector?.("img[src*='/players/full/']")?.getAttribute?.("src")?.match(/players\/full\/(-?\d+)/)?.[1]
    || 0
  ) || null;
  const nomineeNode = activeAuctionPlayer || document.querySelector("[data-testid*='nominee' i], [class*='nominee' i], [aria-label*='nominated player' i]");
  const nominatedPlayerName = nomineeNode?.textContent?.trim().replace(/\s+/g, " ") || null;
  const auctionPickMatch = text.match(/\bPK\s+(\d+)\s+OF\s+\d+\b/i);
  const scopedClock = scopedDraftClock(snakeClock, snakeClockContainer);
  const clockIdentity = Number(currentPickMatch?.[1] || 0) > 0
    ? `${url.pathname}:snake:${Number(currentPickMatch?.[1])}`
    : nominatedPlayerId
      ? `${url.pathname}:auction:offer:id:${nominatedPlayerId}:bid:${Number(currentBidMatch?.[1] || 0)}`
      : nominatedPlayerName
        ? `${url.pathname}:auction:offer:name:${normalizePlayerName(nominatedPlayerName)}:bid:${Number(currentBidMatch?.[1] || 0)}`
        : Number(auctionPickMatch?.[1] || 0) > 0
          ? `${url.pathname}:auction:nomination:${Number(auctionPickMatch?.[1])}`
          : scopedClock.source
            ? `${url.pathname}:waiting`
            : "";
  const remainingSeconds = monotonicDraftClock(scopedClock.seconds, clockIdentity);
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
  const ownRoster = [...document.querySelectorAll("[class*='roster' i] tr")].flatMap((row) => {
    const rowText = row.textContent?.trim() || "";
    if (!rowText || /^(pos|position)player/i.test(rowText) || /empty/i.test(rowText)) return [];
    const idNode = row.querySelector("[data-player-id], [data-playerid], img[src*='/players/full/'], a[href*='playerId='], a[href*='/players/']");
    const idSource = [
      idNode?.getAttribute("data-player-id"),
      idNode?.getAttribute("data-playerid"),
      idNode?.getAttribute("src"),
      idNode?.getAttribute("href"),
    ].filter(Boolean).join(" ");
    const playerId = Number(idSource.match(/(?:playerId=|players\/full\/|players\/[^/]+\/)(-?\d+)/i)?.[1] || 0) || null;
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
  const maxLegalBidMatch = text.match(/manual (?:bid|offer) \(max \$(\d+)\)/i);
  const selectingAuctionPick = document.querySelector(".auction-pick-component--selecting")
    ?.closest?.(".auction-pick-component") || null;
  const ownAuctionPick = document.querySelector(".auction-pick-component--own")
    ?.closest?.(".auction-pick-component") || null;
  const auctionOnClock = Boolean(selectingAuctionPick && ownAuctionPick && selectingAuctionPick === ownAuctionPick);
  const ownAuctionTeam = document.querySelector(".auction-pick-component--own .team-name")
    ?.textContent?.replace(/^\s*\d+\.\s*/, "").trim() || "";
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
    && !currentBidMatch
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
  const leadingBid = authoritativeLeadingBidState(ownAuctionTeam);
  const snakePickNumber = Number(currentPickMatch?.[1] || 0);
  // The pre-draft room has a readable player grid but no active pick number.
  // Let the user complete the no-click checklist there; once the draft starts,
  // every actual action still requires the stricter per-pick stability window.
  const snakePoolStable = snakePickNumber > 0
    ? snakePlayerPoolIsStable(snakePickNumber)
    : availableControls.length > 0;
  const actionSurfaceReady = Boolean(
    inDraftRoom
    && autopickActive === false
    && Number.isFinite(remainingSeconds)
    && availableControls.length
    && (ownAuctionTeam ? budgetMaxLegalBid > 0 : ((snakeClockOwnMarker || ownDraftTeam) && snakePoolStable)),
  );
  const trackedRoomMatches = trackedOwnNomination
    && String(trackedOwnNomination.leagueId) === String(leagueId || "")
    && Number(trackedOwnNomination.teamId) === Number(teamId || 0)
    && Number(trackedOwnNomination.season) === Number(season || 0);
  const trackedPlayerMatches = trackedRoomMatches && (
    (Number(trackedOwnNomination.playerId) !== 0
      && Number(nominatedPlayerId) !== 0
      && Number(trackedOwnNomination.playerId) === Number(nominatedPlayerId))
    || playerNamesMatch(trackedOwnNomination.playerName, nomineeNode?.textContent || "")
  );
  const trackedNominationPending = trackedRoomMatches
    && Number(trackedOwnNomination?.pendingUntil || 0) > Date.now();
  if (trackedOwnNomination && (!trackedRoomMatches
    || (Number(currentBidMatch?.[1] || 0) > 0 && !trackedPlayerMatches)
    || (!trackedNominationPending && !nomineeNode && Number(currentBidMatch?.[1] || 0) === 0))) {
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
    auctionActive: /current (?:bid|offer)|your (?:bid|offer)|nominate player|salary cap/i.test(text),
    nominatedPlayer: nominatedPlayerName,
    nominatedPlayerId,
    currentBid: Number(currentBidMatch?.[1] || 0),
    maxLegalBid: Number(maxLegalBidMatch?.[1] || budgetMaxLegalBid || 0),
    leadingBid,
    soundMuted,
    autopickActive,
    actionSurfaceReady,
    auctionBudgets,
    ownNominationIntent: trackedPlayerMatches ? trackedOwnNomination?.intent || null : null,
    ownNominationPlayerId: trackedPlayerMatches ? Number(trackedOwnNomination?.playerId || 0) || null : null,
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

function authoritativeLeadingBidState(ownAuctionTeam) {
  // Never infer current leadership from document.body text. ESPN can leave
  // stale toasts and activity-rail messages from a prior offer mounted while
  // the next nomination is already active. Only one visible, dedicated
  // current-leader element is authoritative; ambiguity fails closed.
  const leaderNodes = [
    ...document.querySelectorAll("[data-testid*='high-bidder' i], [class*='high-bidder' i], [aria-label*='high bidder' i]"),
  ].filter(isElementVisible);
  if (leaderNodes.length !== 1) return null;
  const ownTeamKey = normalizePlayerName(ownAuctionTeam);
  const node = leaderNodes[0];
  const leaderText = String(node.textContent || node.getAttribute?.("aria-label") || "").trim();
  const match = leaderText.match(/(?:high bidder|leader)\s*:?\s*(.+)$/i)
    || leaderText.match(/^(.+?)\s+is\s+(?:the\s+)?(?:high bidder|leader)$/i);
  const leaderKey = normalizePlayerName(match?.[1]);
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

function updateAuctionSales(context) {
  const liveName = context.nominatedPlayer || "";
  const liveBid = Number(context.currentBid || 0);
  const currentBudgets = new Map((context.auctionBudgets || []).map((budget) => [normalizePlayerName(budget.teamName), budget.remaining]));
  const sameOffer = trackedAuctionOffer
    && liveName
    && normalizePlayerName(trackedAuctionOffer.playerName) === normalizePlayerName(liveName);

  if (trackedAuctionOffer && !sameOffer) {
    const winner = [...trackedAuctionOffer.beforeBudgets.entries()]
      .map(([teamKey, previous]) => ({
        teamKey,
        delta: Number(previous) - Number(currentBudgets.get(teamKey) ?? previous),
      }))
      .filter((entry) => entry.delta > 0)
      .sort((left, right) => right.delta - left.delta)[0];
    const winnerBudget = (context.auctionBudgets || []).find((budget) => normalizePlayerName(budget.teamName) === winner?.teamKey);
    if (winner && winnerBudget && !auctionSales.some((sale) => normalizePlayerName(sale.playerName) === normalizePlayerName(trackedAuctionOffer.playerName))) {
      auctionSales.push({
        playerId: trackedAuctionOffer.playerId,
        playerName: trackedAuctionOffer.playerName,
        teamName: winnerBudget.teamName,
        amount: winner.delta,
        sequence: ++trackedAuctionSaleSequence,
      });
      if (auctionSales.length > MAX_AUCTION_SALES) auctionSales.splice(0, auctionSales.length - MAX_AUCTION_SALES);
    }
    if (!winner || !winnerBudget) {
      trackedAuctionOffer.settlementRecoveryPolls = Number(trackedAuctionOffer.settlementRecoveryPolls || 0) + 1;
      if (trackedAuctionOffer.settlementRecoveryPolls <= MAX_AUCTION_SETTLEMENT_RECOVERY_POLLS) {
        return { ...context, auctionSales: [...auctionSales] };
      }
    }
    trackedAuctionOffer = null;
  }

  if (liveName && liveBid > 0) {
    if (!trackedAuctionOffer) {
      trackedAuctionOffer = {
        playerId: context.nominatedPlayerId,
        playerName: liveName,
        amount: liveBid,
        beforeBudgets: currentBudgets,
        settlementRecoveryPolls: 0,
      };
    } else {
      trackedAuctionOffer.playerId = context.nominatedPlayerId || trackedAuctionOffer.playerId;
      trackedAuctionOffer.amount = liveBid;
    }
  }
  return { ...context, auctionSales: [...auctionSales] };
}

function getTrackedContext() {
  return updateAuctionSales(getContext());
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

function findByText(selector, patterns) {
  return [...document.querySelectorAll(selector)].find((node) => {
    if (!isElementVisible(node)) return false;
    const label = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`.trim();
    return patterns.some((pattern) => pattern.test(label));
  });
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
  const forms = [...document.querySelectorAll(".bidding-form__custom")].filter(isElementVisible);
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
  const dialogs = [...document.querySelectorAll("[role='dialog'], [aria-modal='true'], [class*='modal' i]")]
    .filter(isElementVisible);
  const matches = dialogs.flatMap((dialog) => {
    const identityNodes = [...dialog.querySelectorAll("[data-player-id], [data-playerid], [data-testid*='player-name' i], [class*='playername' i]")];
    const identityIds = identityNodes
      .map((node) => Number(node.getAttribute?.("data-player-id") || node.getAttribute?.("data-playerid") || 0))
      .filter((playerId) => Number.isInteger(playerId) && playerId !== 0);
    const exactIdentity = Number(action?.playerId || 0) && identityIds.length
      ? identityIds.length === 1 && identityIds[0] === Number(action.playerId)
      : identityNodes.some((node) => playerNamesMatch(node.textContent || "", action?.playerName || ""));
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
  if (!context.inDraftRoom) return { ok: false, code: "NOT_IN_DRAFT_ROOM", message: "Open the ESPN draft room first." };
  if (context.autopickActive === true) return { ok: false, code: "AUTOPICK_ACTIVE", message: "ESPN Autopick is active. DraftForge stopped without sending another action." };
  if (context.autopickActive !== false) return { ok: false, code: "AUTOPICK_STATE_UNKNOWN", message: "ESPN does not expose an exact visible Autopick-off control. DraftForge stopped without sending an action." };
  if (context.soundMuted !== true) return { ok: false, code: "SOUND_NOT_MUTED", message: "ESPN draft sound is still on. DraftForge stopped before sending the action." };
  if (action.expectedLeagueId && String(context.leagueId) !== String(action.expectedLeagueId)) {
    return { ok: false, code: "WRONG_LEAGUE", message: "The open ESPN draft room is for a different league." };
  }
  if (Number.isInteger(Number(action.expectedTeamId)) && Number(context.teamId) !== Number(action.expectedTeamId)) {
    return { ok: false, code: "WRONG_TEAM", message: "The open ESPN draft room is for a different team." };
  }
  if (Number.isInteger(Number(action.expectedSeason)) && Number(context.season) !== Number(action.expectedSeason)) {
    return { ok: false, code: "WRONG_SEASON", message: "The open ESPN draft room is for a different season." };
  }
  if (action.operation === "NOMINATE" && (context.nominatedPlayer || Number(context.currentBid || 0) > 0)) {
    return { ok: false, code: "NOMINATION_ACTIVE", message: "ESPN already has an active salary-cap nominee, so no nomination was sent." };
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
    .map((candidate) => `${Number(candidate?.playerId || 0)}-${normalizePlayerName(candidate?.playerName)}`)
    .join(",");
  return [
    action?.commandCenterSessionId || "",
    action?.operation || "",
    action?.expectedLeagueId || "",
    Number(action?.expectedTeamId || 0),
    Number(action?.expectedSeason || 0),
    Number(action?.expectedPick || 0),
    Number(action?.playerId || 0),
    normalizePlayerName(action?.playerName),
    Number(action?.expectedCurrentBid ?? -1),
    Number(action?.amount || 0),
    Number(action?.maxApprovedBid || 0),
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
  const actionDeadlineAt = Date.now() + SELECT_ACTION_BUDGET_MS;
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

async function acknowledgeBid(action) {
  const deadline = Math.min(
    Number(action.actionDeadlineAt || Infinity),
    Date.now() + BID_ACKNOWLEDGEMENT_WINDOW_MS,
  );
  let context = getContext();
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
    context = getContext();
  }
  return { ok: false, clicked: true, retryable: false, code: "BID_ACK_UNCERTAIN", message: "ESPN did not acknowledge the clicked bid before the bounded deadline. DraftForge will not retry it blindly.", action };
}

async function acknowledgeNomination(action) {
  const deadline = Math.min(
    Number(action.actionDeadlineAt || Infinity),
    Date.now() + NOMINATION_ACKNOWLEDGEMENT_WINDOW_MS,
  );
  let context = getContext();
  while (Date.now() < deadline) {
    const transition = nominationTransition(context, action);
    if (transition?.ok) return transition;
    if (transition && !transition.ok) {
      return { ...transition, clicked: true, retryable: false, code: "NOMINATION_ACK_UNCERTAIN", message: `${transition.message} DraftForge will not retry the clicked confirmation blindly.`, action };
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    context = getContext();
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
  if (action.operation === "SELECT" || action.operation === "NOMINATE") {
    const exactNominationMetadata = action.operation === "NOMINATE"
      ? (Array.isArray(action.candidates) ? action.candidates : []).find((candidate) => (
          Number(candidate?.playerId || 0) === Number(action.playerId || 0)
          && playerNamesMatch(candidate?.playerName, action.playerName)
        ))
      : null;
    const requestedCandidates = action.operation === "NOMINATE"
      // TARGET/DRAIN is part of the nomination decision. A different player is
      // not a safe fallback because it can invert that intent. Return to the
      // production engine instead of silently resolving another candidate.
      ? [{
          playerId: action.playerId,
          playerName: action.playerName,
          position: action.position || exactNominationMetadata?.position,
          fillsMandatoryStarter: action.fillsMandatoryStarter ?? exactNominationMetadata?.fillsMandatoryStarter,
        }]
      : Array.isArray(action.candidates) && action.candidates.length
        ? action.candidates
        : [{ playerId: action.playerId, playerName: action.playerName }];
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
    selectControl?.scrollIntoView({ block: "center" });
    selectControl?.click();
  }
  if (action.operation === "SELECT" && !directSelect) {
    selectControl?.scrollIntoView({ block: "center" });
    selectControl?.click();
  }

  const exactIncrementalBidControl = () => action.operation === "BID"
    ? [...document.querySelectorAll("button, [role='button']")].find((node) => {
        if (!isElementVisible(node)) return false;
        const label = (node.textContent || "").trim().replace(/\s+/g, " ");
        return new RegExp(`^(?:offer|bid) \\$${Number(action.amount)}$`, "i").test(label);
      }) || null
    : null;
  const patterns = action.operation === "NOMINATE"
    ? [/^nominate$/i, /nominate player/i, /nominate\s+\w+/i]
    : action.operation === "BID"
      ? [/^bid$/i, /place bid/i, /bid \$/i, /^offer(?:\s+\$\d+)?$/i]
      : [/^draft$/i, /^select$/i, /draft player/i, /make pick/i];
  const exactNominationControl = () => action.operation === "NOMINATE"
    ? (Number(action.amount) === 1
        ? findByText("button, [role='button']", patterns)
        : null)
    : null;
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
    if (submitPlayerId !== resolvedPlayerId) {
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
  const sameSnakePick = action.operation === "SELECT"
    && context.onClock
    && Number(action.expectedPick) > 0
    && Number(preSubmitContext.currentPick) === Number(action.expectedPick);
  if (action.operation !== "BID" && !preSubmitContext.onClock && !sameSnakePick) {
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
  submit.click();
  if (action.operation === "NOMINATE") rememberPendingOwnNomination(preSubmitContext, resolvedAction);
  let submittedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 75));
  if (usedPositionFilter && String(usedPositionFilter.value) !== "-1") {
    setNativeSelectValue(usedPositionFilter, "-1");
    visibleRowsCache.revision = -1;
  }
  const confirmation = exactVisibleModalConfirmation(resolvedAction);
  confirmation?.click();
  if (confirmation) submittedAt = Date.now();
  resolvedAction = { ...resolvedAction, submittedAt };
  sendToCompanion({ type: "ESPN_ACTION_SUBMITTED", payload: { ...resolvedAction, submittedAt } });
  if (action.operation === "SELECT") {
    const confirmationDeadline = Math.min(Number(action.actionDeadlineAt || Infinity), Date.now() + SELECT_CONFIRMATION_WINDOW_MS);
    let confirmedContext = getContext();
    while (!rosterHasPlayer(confirmedContext, resolvedAction.playerId, resolvedAction.playerName)
      && Number(confirmedContext.currentPick) === Number(action.expectedPick)
      && Date.now() < confirmationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      confirmedContext = getContext();
    }
    if (rosterHasPlayer(confirmedContext, resolvedAction.playerId, resolvedAction.playerName)) {
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
    sendResponse(getTrackedContext());
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

const CONTEXT_DEBOUNCE_MS = 75;
const MIN_CONTEXT_SCAN_INTERVAL_MS = 400;
const CONTEXT_WATCHDOG_MS = 2000;
const SOUND_MUTE_RETRY_MS = 1000;
let previousState = "";
let lastContextScanAt = 0;
let lastSoundMuteAttemptAt = 0;
let scheduledContextRefresh = null;

function enforceMutedDraftSound(context) {
  if (!context.inDraftRoom || context.soundMuted || Date.now() - lastSoundMuteAttemptAt < SOUND_MUTE_RETRY_MS) return;
  const soundControl = [...document.querySelectorAll(".draft-header .icon-wrapper")]
    .find((node) => isElementVisible(node)
      && /sound/i.test(node.textContent || "")
      && /icon__controls__volume_(?!mute)/i.test(node.querySelector("use")?.getAttribute("href")
        || node.querySelector("use")?.getAttribute("xlink:href")
        || ""));
  if (!soundControl) return;
  lastSoundMuteAttemptAt = Date.now();
  soundControl.click();
}

function scanAndPublishContext(forceHeartbeat = false) {
  if (scheduledContextRefresh) {
    clearTimeout(scheduledContextRefresh);
    scheduledContextRefresh = null;
  }
  lastContextScanAt = Date.now();
  const context = getTrackedContext();
  enforceMutedDraftSound(context);
  const serialized = JSON.stringify(context);
  if (serialized !== previousState) {
    previousState = serialized;
    sendToCompanion({ type: "ESPN_CONTEXT", payload: context });
  } else if (forceHeartbeat && context.inDraftRoom && context.leagueId) {
    sendToCompanion({ type: "ESPN_HEARTBEAT", payload: context });
  }
  if (context.onClock && context.autopickActive === false && !context.actionSurfaceReady && !scheduledContextRefresh) {
    scheduledContextRefresh = setTimeout(() => scanAndPublishContext(false), SNAKE_PLAYER_POOL_STABILITY_MS + 25);
  }
}

function queueContextRefresh() {
  if (scheduledContextRefresh) return;
  const elapsed = Date.now() - lastContextScanAt;
  const delay = Math.max(CONTEXT_DEBOUNCE_MS, MIN_CONTEXT_SCAN_INTERVAL_MS - elapsed);
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
}, { once: true });

scanAndPublishContext(false);
