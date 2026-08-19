const MIN_ACTION_WINDOW_SECONDS = 5;
const MIN_SNAKE_SELECTION_WINDOW_SECONDS = 10;
const MAX_SEARCH_CANDIDATES = 7;
const MAX_MANDATORY_SEARCH_CANDIDATES = 18;
const PLAYER_RESOLUTION_WINDOW_MS = 2200;
const PRIMARY_CANDIDATE_SEARCH_WINDOW_MS = 900;
const CANDIDATE_SEARCH_WINDOW_MS = 250;
const MANDATORY_CANDIDATE_SEARCH_WINDOW_MS = 120;
const MANDATORY_POSITION_FILTER_WINDOW_MS = 1800;
const SELECT_CONFIRMATION_WINDOW_MS = 700;
const NOMINATION_CONFIRMATION_WINDOW_MS = 4000;
const MAX_SELECT_RETRIES = 1;
const MAX_BID_CONTROL_RETRIES = 4;
const SELECT_ACTION_BUDGET_MS = 4500;
const SNAKE_PLAYER_POOL_STABILITY_MS = 180;
const auctionSales = [];
let trackedAuctionOffer = null;
let domRevision = 0;
let visibleRowsCache = { revision: -1, rows: [] };
let trackedSnakePoolPick = null;
let trackedSnakePoolChangedAt = 0;

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

function nominationTransition(context, action) {
  if (nominationHasStarted(context, action.playerName)) {
    return { ok: true, code: "NOMINATION_STARTED", message: "nomination submitted in ESPN.", action };
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

function getContext() {
  const url = new URL(window.location.href);
  const text = document.body?.innerText ?? "";
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
  const clockMatch = text.slice(0, 1000).match(/\b(\d{1,2}):(\d{2})\b/);
  const remainingSeconds = clockMatch ? Number(clockMatch[1]) * 60 + Number(clockMatch[2]) : null;
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
  const activeAuctionPlayer = document.querySelector("[data-testid='player-selected'] .playerinfo__playername");
  const activeAuctionContainer = activeAuctionPlayer?.closest?.("[data-testid='player-selected']") || null;
  const nominatedPlayerId = Number(
    activeAuctionContainer?.querySelector?.("[data-player-id], [data-playerid]")?.getAttribute?.("data-player-id")
    || activeAuctionContainer?.querySelector?.("[data-player-id], [data-playerid]")?.getAttribute?.("data-playerid")
    || activeAuctionContainer?.querySelector?.("img[src*='/players/full/']")?.getAttribute?.("src")?.match(/players\/full\/(-?\d+)/)?.[1]
    || 0
  ) || null;
  const nomineeNode = activeAuctionPlayer || document.querySelector("[data-testid*='nominee' i], [class*='nominee' i], [aria-label*='nominated player' i]");
  const currentBidMatch = text.match(/current (?:bid|offer)\s*:\s*\$?\s*(\d+)/i) || text.match(/high bid\s*\$?\s*(\d+)/i);
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
  const leagueMatch = window.location.href.match(/league(?:Id|\/)(?:=|\/)(\d+)/i);
  const teamMatch = window.location.href.match(/team(?:Id|\/)(?:=|\/)(\d+)/i);
  const waitingTeamLink = [...document.querySelectorAll("a[href*='teamId=']")].find((link) => /edit team settings/i.test(link.textContent || ""));
  const waitingTeamMatch = waitingTeamLink?.getAttribute("href")?.match(/[?&]teamId=(\d+)/i);
  const inDraftRoom = /\/football\/draft(?:\/|$)/i.test(url.pathname) || /on the clock:\s*pick|you(?:'|’)re on the clock(?!\s+in\b)|your turn to (?:pick|nominate)|nominate player|current (?:bid|offer)/i.test(text);
  // ESPN keeps every volume icon in a hidden SVG sprite, so the mere presence
  // of #icon__controls__volume_mute does not prove the audible control is off.
  // Read the <use> reference rendered inside the visible draft header instead.
  const activeVolumeUse = [...document.querySelectorAll(".draft-header .icon-wrapper use")]
    .find((node) => /icon__controls__volume_/i.test(node.getAttribute("href") || node.getAttribute("xlink:href") || ""));
  const activeVolumeIcon = activeVolumeUse?.getAttribute("href") || activeVolumeUse?.getAttribute("xlink:href") || "";
  const soundMuted = activeVolumeIcon === "#icon__controls__volume_mute";
  const autopickToggle = visibleAutopickToggle();
  const autopickActive = /you(?:'|’)re on autopick/i.test(text)
    || Boolean(autopickToggle?.input?.checked)
    || [...document.querySelectorAll("button, [role='button']")]
      .some((node) => isElementVisible(node) && /^disable autopick$/i.test((node.textContent || "").trim()));
  const snakePickNumber = Number(currentPickMatch?.[1] || 0);
  // The pre-draft room has a readable player grid but no active pick number.
  // Let the user complete the no-click checklist there; once the draft starts,
  // every actual action still requires the stricter per-pick stability window.
  const snakePoolStable = snakePickNumber > 0
    ? snakePlayerPoolIsStable(snakePickNumber)
    : availableControls.length > 0;
  const actionSurfaceReady = Boolean(
    inDraftRoom
    && !autopickActive
    && Number.isFinite(remainingSeconds)
    && availableControls.length
    && (ownAuctionTeam ? budgetMaxLegalBid > 0 : ((snakeClockOwnMarker || ownDraftTeam) && snakePoolStable)),
  );
  return {
    url: window.location.href,
    leagueId: url.searchParams.get("leagueId") || leagueMatch?.[1] || null,
    teamId: Number(url.searchParams.get("teamId") || teamMatch?.[1] || waitingTeamMatch?.[1] || 0) || null,
    inDraftRoom,
    // A generic ESPN banner can remain mounted while another team is picking.
    // Snake authorization therefore comes only from the exact active-clock
    // team matching ESPN's own-pick team. Salary-cap nomination turns use the
    // exact selecting/own pick component identity above.
    onClock: snakeOnClock || nominationSelectionActive,
    snakeClockSource,
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
    nominatedPlayer: nomineeNode?.textContent?.trim().replace(/\s+/g, " ") || null,
    nominatedPlayerId,
    currentBid: Number(currentBidMatch?.[1] || 0),
    maxLegalBid: Number(maxLegalBidMatch?.[1] || budgetMaxLegalBid || 0),
    leadingBid: /you(?:'|’)re (?:the )?(?:high bidder|winning)|your bid is winning/i.test(text),
    soundMuted,
    autopickActive,
    actionSurfaceReady,
    auctionBudgets,
  };
}

function visibleAutopickToggle() {
  const container = document.querySelector(".pick-queue__header .autoPick-toggle");
  if (!isElementVisible(container)) return null;
  const input = container.querySelector("input[type='checkbox']");
  const control = container.querySelector("label");
  return input && isElementVisible(control) ? { input, control } : null;
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
  if (!context.autopickActive) return { ok: true, code: "AUTOPICK_ALREADY_OFF", message: "ESPN Autopick is already off." };
  const control = visibleDisableAutopickControl();
  if (!control) return { ok: false, code: "AUTOPICK_CONTROL_NOT_FOUND", message: "ESPN Autopick is active, but its exact visible disable control is unavailable." };

  control.click();
  const deadline = Date.now() + 800;
  do {
    await new Promise((resolve) => setTimeout(resolve, 40));
    context = getContext();
    if (!context.autopickActive) return { ok: true, code: "AUTOPICK_DISABLED", message: "ESPN Autopick was disabled in the exact draft room." };
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
        sequence: auctionSales.length + 1,
      });
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
  return !context.autopickActive
    && Number.isFinite(context.remainingSeconds)
    && Number(context.remainingSeconds) >= minimumSeconds;
}

function retryBidAction(action, context) {
  const retryCount = Number(action.bidRetryCount || 0);
  if (action.operation !== "BID" || retryCount >= MAX_BID_CONTROL_RETRIES || !hasSafeActionWindow(context)) return null;
  return { ...action, bidRetryCount: retryCount + 1 };
}

function buildCandidateSearchPlan(candidates) {
  const mandatorySearch = candidates.some((candidate) => candidate.fillsMandatoryStarter === true);
  const limit = mandatorySearch ? MAX_MANDATORY_SEARCH_CANDIDATES : MAX_SEARCH_CANDIDATES;
  return candidates.slice(0, limit).map((candidate, index) => ({
    candidate,
    waitMs: mandatorySearch
      ? MANDATORY_CANDIDATE_SEARCH_WINDOW_MS
      : index === 0 ? PRIMARY_CANDIDATE_SEARCH_WINDOW_MS : CANDIDATE_SEARCH_WINDOW_MS,
  }));
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

function preflightAction(action, context) {
  if (!context.inDraftRoom) return { ok: false, code: "NOT_IN_DRAFT_ROOM", message: "Open the ESPN draft room first." };
  if (context.autopickActive) return { ok: false, code: "AUTOPICK_ACTIVE", message: "ESPN Autopick is active. DraftForge stopped without sending another action." };
  if (context.soundMuted !== true) return { ok: false, code: "SOUND_NOT_MUTED", message: "ESPN draft sound is still on. DraftForge stopped before sending the action." };
  if (action.expectedLeagueId && String(context.leagueId) !== String(action.expectedLeagueId)) {
    return { ok: false, code: "WRONG_LEAGUE", message: "The open ESPN draft room is for a different league." };
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
  if (action.operation === "BID" && Number.isFinite(Number(action.maxApprovedBid))) {
    const nextOffer = Number(context.currentBid || 0) + 1;
    if (nextOffer > Number(action.maxApprovedBid)) {
      return { ok: true, code: "WALK_AWAY", message: `Offer is above the approved $${Number(action.maxApprovedBid)} walk-away price.`, action };
    }
    action = { ...action, amount: nextOffer, expectedCurrentBid: Number(context.currentBid || 0) };
  }
  if (action.operation === "NOMINATE") {
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
    if (!context.nominatedPlayer.toLowerCase().includes(action.playerName.toLowerCase())) {
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

async function executeAction(action) {
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

async function executeActionAttempt(action) {
  const context = getContext();
  const preflight = preflightAction(action, context);
  if (!preflight.action) return preflight;
  action = preflight.action;

  let resolvedAction = action;
  let usedPlayerSearch = null;
  let usedPositionFilter = null;
  if (action.operation === "SELECT" || action.operation === "NOMINATE") {
    const candidates = Array.isArray(action.candidates) && action.candidates.length
      ? action.candidates
      : [{ playerId: action.playerId, playerName: action.playerName }];
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
    const playerGridWaitMs = mandatoryPositionFilter ? 0 : context.ownRoster.length ? 400 : 700;
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
      const resolutionDeadline = Math.min(Number(action.actionDeadlineAt || Infinity), Date.now() + PLAYER_RESOLUTION_WINDOW_MS);
      for (const { candidate, waitMs } of buildCandidateSearchPlan(candidates)) {
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
        Date.now() + 400,
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
  if (action.amount && !exactIncrementalBidControl()) {
    const bidInput = document.querySelector("#bid__input") || findByText("input", [/bid/i, /amount/i, /salary/i]) || document.querySelector("input[type='number']");
    if (bidInput instanceof HTMLInputElement) setNativeValue(bidInput, String(action.amount));
  }

  const patterns = action.operation === "NOMINATE"
    ? [/^nominate$/i, /nominate player/i, /nominate\s+\w+/i]
    : action.operation === "BID"
      ? [/^bid$/i, /place bid/i, /bid \$/i, /^offer(?:\s+\$\d+)?$/i]
      : [/^draft$/i, /^select$/i, /draft player/i, /make pick/i];
  const exactDraftControl = () => [...document.querySelectorAll(`button.Button--draft[data-player-id="${CSS.escape(String(resolvedPlayerId))}"], button.Button--draft[data-playerid="${CSS.escape(String(resolvedPlayerId))}"]`)]
    .find(isElementVisible) || null;
  let submit = directSelect || (action.operation === "SELECT"
    ? exactDraftControl()
    : action.operation === "BID"
      ? exactIncrementalBidControl() || document.querySelector(".bidding-form__custom button:not([disabled])")
      : findByText("button, [role='button']", patterns));
  const submitWindowMs = action.operation === "BID"
    ? 180
    : action.operation === "NOMINATE"
      ? NOMINATION_CONFIRMATION_WINDOW_MS
      : 1500;
  const submitDeadline = Math.min(Number(action.actionDeadlineAt || Infinity), Date.now() + submitWindowMs);
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
        ? exactIncrementalBidControl() || document.querySelector(".bidding-form__custom button:not([disabled])")
        : findByText("button, [role='button']", patterns);
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
  if (action.operation === "BID" && Number(preSubmitContext.currentBid) !== Number(action.expectedCurrentBid)) {
    const retryAction = retryBidAction(action, preSubmitContext);
    if (retryAction) return { retryAction };
    return { ok: false, code: "BID_CHANGED", message: "The ESPN offer changed before the exact incremental bid could be clicked." };
  }

  if (action.operation === "SELECT") {
    sendToCompanion({ type: "ESPN_ACTION_RESOLVED", payload: resolvedAction });
  }
  submit.click();
  let submittedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 75));
  if (usedPositionFilter && String(usedPositionFilter.value) !== "-1") {
    setNativeSelectValue(usedPositionFilter, "-1");
    visibleRowsCache.revision = -1;
  }
  const dialog = document.querySelector("[role='dialog'], [aria-modal='true'], [class*='modal' i]");
  const confirmation = dialog && [...dialog.querySelectorAll("button, [role='button']")].find((node) =>
    /^(confirm|submit|yes)|confirm (pick|bid|nomination)|yes,? (draft|bid|nominate)/i.test((node.textContent || "").trim())
  );
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
    if (Number(confirmedContext.currentPick) === Number(action.expectedPick)
      && hasSafeActionWindow(confirmedContext, MIN_SNAKE_SELECTION_WINDOW_SECONDS)
      && Number(action.selectRetryCount || 0) < MAX_SELECT_RETRIES) {
      if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
      const retryCandidates = [resolvedAction, ...(Array.isArray(action.candidates) ? action.candidates : [])]
        .filter((candidate, index, all) => all.findIndex((item) => Number(item.playerId) === Number(candidate.playerId)) === index);
      return { retryAction: { ...action, candidates: retryCandidates, selectRetryCount: Number(action.selectRetryCount || 0) + 1 } };
    }
    if (usedPlayerSearch instanceof HTMLInputElement) setNativeValue(usedPlayerSearch, "");
    return {
      ok: false,
      code: "ROSTER_NOT_CONFIRMED",
      message: `ESPN did not confirm ${resolvedAction.playerName} on the exact roster before the turn changed.`,
      action: resolvedAction,
    };
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
  if (context.onClock && !context.autopickActive && !context.actionSurfaceReady && !scheduledContextRefresh) {
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
