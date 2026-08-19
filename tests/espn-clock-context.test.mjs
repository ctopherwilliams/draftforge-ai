import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const contentUrl = new URL("../extension/espn-content.js", import.meta.url);

async function loadDraftContext({ text, clockTeam, clockOwnMarker = false, ownTeam, ownAuctionTeam, ownAuctionSelecting = false, nominationTurnEndsAfterSelect = false, nominationConfirmationDelayMs = null, mandatoryPositionFilterDelayMs = null, maximumOffer, nominatedPlayer, waitingTeamId, availableIds = [], snakeHistory = [], selectPlayer, bidAmount, bidControlDelayMs = 0, autopickActive = false, autopickControlVisible = false, soundMuted = true, href = "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5" }) {
  const source = await readFile(contentUrl, "utf8");
  const runtimeStart = source.indexOf("chrome.runtime.onMessage.addListener");
  assert.ok(runtimeStart > 0, "content script should expose a Chrome message listener");

  const clockNode = clockTeam ? {
    textContent: "On the Clock: Pick 47",
    closest: (selector) => {
      if (selector === ".current-pick-module-container") {
        return { querySelector: (childSelector) => childSelector === ".team-name" ? { textContent: clockTeam } : null };
      }
      if (selector === ".own-pick") return clockOwnMarker ? {} : null;
      return null;
    },
  } : null;
  const ownAuctionParent = {};
  const ownAuctionNode = ownAuctionTeam ? { closest: (selector) => selector === ".auction-pick-component" ? ownAuctionParent : null } : null;
  const selectingAuctionNode = ownAuctionSelecting ? { closest: (selector) => selector === ".auction-pick-component" ? ownAuctionParent : null } : null;
  const actionState = { selected: false, selectedAt: 0, selectClicks: 0, nominationClicks: 0, bidClicks: 0, autopickDisableClicks: 0 };
  let simulatedAutopickActive = autopickActive || /you(?:'|’)re on autopick/i.test(text);
  const bidControlAvailableAt = Date.now() + bidControlDelayMs;
  let mandatoryPositionFilterActivatedAt = 0;
  let mandatoryPositionFilterValue = "-1";
  const mandatoryPositionFilterPrototype = {};
  Object.defineProperty(mandatoryPositionFilterPrototype, "value", {
    get: () => mandatoryPositionFilterValue,
    set: (value) => {
      mandatoryPositionFilterValue = String(value);
      if (mandatoryPositionFilterValue !== "-1" && !mandatoryPositionFilterActivatedAt) mandatoryPositionFilterActivatedAt = Date.now();
    },
  });
  const mandatoryPositionFilter = mandatoryPositionFilterDelayMs === null ? null : Object.assign(
    Object.create(mandatoryPositionFilterPrototype),
    {
      disabled: false,
      options: [{ value: "16", textContent: "D/ST" }, { value: "17", textContent: "K" }],
      dispatchEvent() {},
      getClientRects: () => [{ width: 1, height: 1 }],
    },
  );
  const mandatoryPositionPlayerVisible = () => mandatoryPositionFilterDelayMs === null
    || (mandatoryPositionFilterActivatedAt > 0 && Date.now() - mandatoryPositionFilterActivatedAt >= mandatoryPositionFilterDelayMs);
  let playerRow = null;
  const playerControl = selectPlayer ? {
    textContent: nominationTurnEndsAfterSelect || nominationConfirmationDelayMs !== null ? "Select" : "Draft",
    disabled: false,
    click() { actionState.selected = true; actionState.selectedAt = Date.now(); actionState.selectClicks += 1; },
    scrollIntoView() {},
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: (name) => name === "data-player-id" ? String(selectPlayer.id) : null,
    closest: () => playerRow,
  } : null;
  playerRow = selectPlayer ? {
    textContent: selectPlayer.name,
    querySelector(selector) {
      if (/playername|player-name/i.test(selector)) return { textContent: selectPlayer.name };
      if (selector.includes("img[src*='/players/full/']")) return { getAttribute: () => `https://a.espncdn.com/i/headshots/nfl/players/full/${selectPlayer.id}.png` };
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("button")) return [playerControl];
      return [];
    },
    getClientRects: () => [{ width: 1, height: 1 }],
  } : null;
  let surfaceRow = null;
  const surfaceControl = mandatoryPositionFilter ? {
    textContent: "Select",
    disabled: false,
    click() {},
    scrollIntoView() {},
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: (name) => name === "data-player-id" ? "99999" : null,
    closest: () => surfaceRow,
  } : null;
  surfaceRow = surfaceControl ? {
    textContent: "Visible Player",
    querySelector(selector) {
      if (/playername|player-name/i.test(selector)) return { textContent: "Visible Player" };
      if (selector.includes("img[src*='/players/full/']")) return { getAttribute: () => "https://a.espncdn.com/i/headshots/nfl/players/full/99999.png" };
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("button")) return [surfaceControl];
      return [];
    },
    getClientRects: () => [{ width: 1, height: 1 }],
  } : null;
  const rosterRow = selectPlayer ? {
    textContent: selectPlayer.name,
    querySelector(selector) {
      if (selector.includes("[data-player-id]")) return { getAttribute: (name) => name === "data-player-id" ? String(selectPlayer.id) : null };
      if (/playername|player-name/i.test(selector)) return { textContent: selectPlayer.name };
      return null;
    },
    querySelectorAll: () => [],
  } : null;
  const bidControl = bidAmount ? {
    textContent: `Offer $${bidAmount}`,
    disabled: false,
    click() { actionState.bidClicks += 1; },
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: () => null,
  } : null;
  const nominationControl = nominationConfirmationDelayMs !== null ? {
    textContent: "Nominate Player",
    disabled: false,
    click() { actionState.nominationClicks += 1; },
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: () => null,
  } : null;
  const disableAutopickControl = autopickControlVisible ? {
    textContent: "",
    disabled: false,
    click() { actionState.autopickDisableClicks += 1; simulatedAutopickActive = false; },
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: () => null,
  } : null;
  const autopickInput = autopickControlVisible ? {
    get checked() { return simulatedAutopickActive; },
    getClientRects: () => [{ width: 1, height: 1 }],
  } : null;
  const autopickContainer = autopickControlVisible ? {
    getClientRects: () => [{ width: 1, height: 1 }],
    querySelector(selector) {
      if (selector === "input[type='checkbox']") return autopickInput;
      if (selector === "label") return disableAutopickControl;
      return null;
    },
  } : null;
  const document = {
    body: { get innerText() {
      const currentText = nominationTurnEndsAfterSelect && actionState.selected ? "PK 12 OF 128\n00:20\nOther team is nominating" : text;
      return simulatedAutopickActive ? `${currentText}\nYou're on Autopick` : currentText.replace(/you(?:'|’)re on autopick/ig, "");
    } },
    querySelector(selector) {
      if (selector === ".on-the-clock") return clockNode;
      if (selector === ".pick-queue__header .autoPick-toggle") return autopickContainer;
      if (selector === ".pick-component.own-pick .team-name") return ownTeam ? { textContent: ownTeam } : null;
      if (selector === ".auction-pick-component--own .team-name") return ownAuctionTeam ? { textContent: `5. ${ownAuctionTeam}` } : null;
      if (selector === ".auction-pick-component--own") return ownAuctionNode;
      if (selector === ".auction-pick-component--selecting") return nominationTurnEndsAfterSelect && actionState.selected ? null : selectingAuctionNode;
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") {
        return nominatedPlayer ? { textContent: nominatedPlayer, closest: () => null } : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".draft-header .icon-wrapper use") return [{
        getAttribute: (name) => name === "href" ? `#icon__controls__volume_${soundMuted ? "mute" : "up"}` : null,
      }];
      if (selector === "[role='grid'] [role='row']") return [
        ...(surfaceRow ? [surfaceRow] : []),
        ...(playerRow && mandatoryPositionPlayerVisible() ? [playerRow] : []),
      ];
      if (selector.startsWith("button.Button--draft")) return playerControl && mandatoryPositionPlayerVisible() ? [playerControl] : [];
      if (selector === "select") return mandatoryPositionFilter ? [mandatoryPositionFilter] : [];
      if (selector === "button, [role='button']") {
        const controls = [];
        if (nominationControl && actionState.selected && Date.now() - actionState.selectedAt >= nominationConfirmationDelayMs) controls.push(nominationControl);
        if (bidControl && Date.now() >= bidControlAvailableAt) controls.push(bidControl);
        return controls;
      }
      if (selector === "[class*='roster' i] tr") return actionState.selected && rosterRow ? [rosterRow] : [];
      if (selector === "a[href*='teamId=']") {
        return waitingTeamId ? [{ textContent: "Edit Team Settings", getAttribute: () => `/football/team?leagueId=701&teamId=${waitingTeamId}` }] : [];
      }
      if (selector === "[role='grid'] [role='row'] img[src*='/players/full/']") {
        return availableIds.map((id) => ({ getAttribute: () => `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png` }));
      }
      if (selector === ".pick-message__container") {
        return snakeHistory.map((pick) => ({
          querySelector(childSelector) {
            if (childSelector === ".playerinfo__playername") return { textContent: pick.playerName };
            if (childSelector === ".pick-info") return { textContent: `R${pick.round}, P${pick.roundPick} - ${pick.teamName}` };
            return null;
          },
        }));
      }
      if (selector === ".budgets-table [role='row']") {
        return ownAuctionTeam && maximumOffer ? [{
          querySelectorAll: (cellSelector) => cellSelector === "[role='gridcell']"
            ? [{ textContent: ownAuctionTeam }, { textContent: "$200" }, { textContent: `$${maximumOffer}` }]
            : [],
        }] : [];
      }
      if (selector === "button[data-player-id], button[data-playerid], button") {
        return ownAuctionSelecting ? [{
          textContent: "Select",
          disabled: false,
          getClientRects: () => [{ width: 1, height: 1 }],
        }] : [];
      }
      return [];
    },
  };
  const sandbox = {
    URL,
    document,
    window: { location: { href } },
    setTimeout,
    clearTimeout,
    HTMLInputElement: class HTMLInputElement {},
    CSS: { escape: (value) => String(value) },
    Event: class Event {},
  };
  vm.runInNewContext(`${source.slice(0, runtimeStart)}\nglobalThis.readDraftContext = getContext; globalThis.hasSafeWindow = hasSafeActionWindow; globalThis.snakePoolStable = snakePlayerPoolIsStable; globalThis.nominationStarted = nominationHasStarted; globalThis.updateSales = updateAuctionSales; globalThis.executeDraftAction = executeAction; globalThis.disableDraftAutopick = disableEspnAutopick; globalThis.planCandidateSearch = buildCandidateSearchPlan; globalThis.planPlayerResolution = playerResolutionTiming; globalThis.planMandatoryPosition = buildMandatoryPositionPlan; globalThis.pruneSnakeCandidates = availableSnakeCandidates;`, sandbox);
  let context = sandbox.readDraftContext();
  if (context.onClock && !context.actionSurfaceReady) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    context = sandbox.readDraftContext();
  }
  return {
    context,
    hasSafeWindow: sandbox.hasSafeWindow,
    snakePoolStable: sandbox.snakePoolStable,
    nominationStarted: sandbox.nominationStarted,
    updateSales: sandbox.updateSales,
    executeAction: sandbox.executeDraftAction,
    disableAutopick: sandbox.disableDraftAutopick,
    candidateSearchPlan: sandbox.planCandidateSearch,
    playerResolutionPlan: sandbox.planPlayerResolution,
    mandatoryPositionPlan: sandbox.planMandatoryPosition,
    availableSnakeCandidates: sandbox.pruneSnakeCandidates,
    actionState,
  };
}

test("snake context binds the active clock to the signed-in ESPN team", async () => {
  const { context, hasSafeWindow } = await loadDraftContext({
    text: "RND 5 OF 16\n00:12\nON THE CLOCK: PICK 47\nChris's Cool Team",
    clockTeam: "Chris's Cool Team",
    ownTeam: "Chris's Cool Team",
    availableIds: [4360078, 4047650],
  });

  assert.equal(context.onClock, true);
  assert.equal(context.currentPick, 47);
  assert.equal(context.remainingSeconds, 12);
  assert.deepEqual(Array.from(context.availablePlayerIds), [4360078, 4047650]);
  assert.equal(hasSafeWindow(context), true);
});

test("snake context exposes ESPN's complete visible pick history", async () => {
  const { context } = await loadDraftContext({
    text: "RND 2 OF 16\n00:20\nON THE CLOCK: PICK 12\nOther Team",
    clockTeam: "Other Team",
    ownTeam: "Us",
    snakeHistory: [
      { playerName: "Lamar Jackson", teamName: "Alpha", round: 1, roundPick: 1 },
      { playerName: "Josh Allen", teamName: "Bravo", round: 1, roundPick: 2 },
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.snakePicks)), [
    { playerName: "Lamar Jackson", teamName: "Alpha", round: 1, roundPick: 1 },
    { playerName: "Josh Allen", teamName: "Bravo", round: 1, roundPick: 2 },
  ]);
});

test("the pre-draft snake grid can pass the no-click checklist without authorizing a selection", async () => {
  const room = await loadDraftContext({
    text: "Drafting in\n00:20",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
  });

  assert.equal(room.context.inDraftRoom, true);
  assert.equal(room.context.currentPick, null);
  assert.equal(room.context.actionSurfaceReady, true);
  assert.equal(room.context.onClock, false);
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
  });
  assert.equal(result.code, "NOT_ON_CLOCK");
  assert.equal(room.actionState.selectClicks, 0);
});

test("late-round player-grid churn cannot keep the same snake pick locked", async () => {
  const room = await loadDraftContext({
    text: "RND 14 OF 16\n00:20\nON THE CLOCK: PICK 135",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
  });

  assert.equal(room.snakePoolStable(47), true);
  // The virtualized rows may churn, but authorization is tied to the exact
  // ESPN pick number and elapsed stabilization window, not row identity.
  assert.equal(room.snakePoolStable(47), true);
  assert.equal(room.snakePoolStable(48), false);
});

test("a six-second snake clock fails closed before touching ESPN", async () => {
  const room = await loadDraftContext({
    text: "RND 14 OF 16\n00:06\nON THE CLOCK: PICK 135",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });

  assert.equal(result.code, "CLOCK_TOO_SHORT");
  assert.equal(room.actionState.selectClicks, 0);
});

test("waiting-room context derives the signed-in team from ESPN's settings link", async () => {
  const { context } = await loadDraftContext({
    text: "Draft Type: Salary Cap\nEdit Team Settings\n00:42",
    waitingTeamId: 8,
    href: "https://fantasy.espn.com/football/waitingroom?leagueId=701",
  });

  assert.equal(context.teamId, 8);
});

test("short, unknown, or another team's ESPN clock is not actionable", async () => {
  const short = await loadDraftContext({
    text: "RND 5 OF 16\n00:04\nON THE CLOCK: PICK 47\nChris's Cool Team",
    clockTeam: "Chris's Cool Team",
    ownTeam: "Chris's Cool Team",
  });
  const otherTeam = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47\nOther Team",
    clockTeam: "Other Team",
    ownTeam: "Chris's Cool Team",
  });
  const unknown = await loadDraftContext({
    text: "ON THE CLOCK: PICK 47\nChris's Cool Team",
    clockTeam: "Chris's Cool Team",
    ownTeam: "Chris's Cool Team",
  });

  assert.equal(short.context.onClock, true);
  assert.equal(short.hasSafeWindow(short.context), false);
  assert.equal(otherTeam.context.onClock, false);
  assert.equal(unknown.context.remainingSeconds, null);
  assert.equal(unknown.hasSafeWindow(unknown.context), false);
});

test("hidden generic clock copy cannot override the exact opponent clock", async () => {
  const room = await loadDraftContext({
    text: "RND 16 OF 16\n00:20\nYou're on the clock\nON THE CLOCK: PICK 153\nOther Team",
    clockTeam: "Other Team",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
  });

  assert.equal(room.context.onClock, false);
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 153,
  });
  assert.equal(result.code, "NOT_ON_CLOCK");
  assert.equal(room.actionState.selectClicks, 0);
});

test("the exact active own-pick marker authorizes the final snake turn without a future own-pick label", async () => {
  const room = await loadDraftContext({
    text: "RND 16 OF 16\n00:20\nON THE CLOCK: PICK 151",
    clockTeam: "Us",
    clockOwnMarker: true,
    ownTeam: null,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });

  assert.equal(room.context.onClock, true);
  assert.equal(room.context.snakeClockSource, "ACTIVE_OWN_PICK");
  assert.equal(room.context.snakeClockOwnMarker, true);
  assert.equal(room.context.actionSurfaceReady, true);
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });
  assert.equal(result.code, "ROSTER_CONFIRMED");
  assert.equal(room.actionState.selectClicks, 1);
});

test("a conflicting exact team label defeats an accidental active own-pick marker", async () => {
  const room = await loadDraftContext({
    text: "RND 16 OF 16\n00:20\nYou're on the clock\nON THE CLOCK: PICK 151",
    clockTeam: "Other Team",
    clockOwnMarker: true,
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
  });

  assert.equal(room.context.onClock, false);
  assert.equal(room.context.snakeClockSource, null);
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });
  assert.equal(result.code, "NOT_ON_CLOCK");
  assert.equal(room.actionState.selectClicks, 0);
});

test("active ESPN Autopick is authoritative and closes the action window", async () => {
  const autopick = await loadDraftContext({
    text: "RND 16 OF 16\n00:12\nON THE CLOCK: PICK 153\nYou're on Autopick",
    clockTeam: "Chris's Cool Team",
    ownTeam: "Chris's Cool Team",
  });

  assert.equal(autopick.context.autopickActive, true);
  assert.equal(autopick.hasSafeWindow(autopick.context), false);
});

test("Autopick recovery clicks only the exact visible disable control in the exact league", async () => {
  const room = await loadDraftContext({
    text: "RND 16 OF 16\n00:12\nON THE CLOCK: PICK 153",
    clockTeam: "Us",
    clockOwnMarker: true,
    autopickActive: true,
    autopickControlVisible: true,
  });

  const result = await room.disableAutopick({ expectedLeagueId: "701" });
  assert.equal(result.code, "AUTOPICK_DISABLED");
  assert.equal(room.actionState.autopickDisableClicks, 1);
});

test("the exact visible ESPN queue toggle detects Autopick between the user's turns", async () => {
  const room = await loadDraftContext({
    text: "RND 2 OF 16\n00:30\nON THE CLOCK: PICK 17\nOther Team",
    clockTeam: "Other Team",
    ownTeam: "Us",
    autopickActive: true,
    autopickControlVisible: true,
  });

  assert.equal(room.context.onClock, false);
  assert.equal(room.context.autopickActive, true);
  assert.equal(room.hasSafeWindow(room.context), false);
});

test("Autopick recovery fails closed for another league or a missing exact control", async () => {
  const wrongLeague = await loadDraftContext({
    text: "RND 16 OF 16\n00:12\nON THE CLOCK: PICK 153",
    clockTeam: "Us",
    clockOwnMarker: true,
    autopickActive: true,
    autopickControlVisible: true,
  });
  const missingControl = await loadDraftContext({
    text: "RND 16 OF 16\n00:12\nON THE CLOCK: PICK 153",
    clockTeam: "Us",
    clockOwnMarker: true,
    autopickActive: true,
  });

  assert.equal((await wrongLeague.disableAutopick({ expectedLeagueId: "702" })).code, "WRONG_LEAGUE");
  assert.equal(wrongLeague.actionState.autopickDisableClicks, 0);
  assert.equal((await missingControl.disableAutopick({ expectedLeagueId: "701" })).code, "AUTOPICK_CONTROL_NOT_FOUND");
  assert.equal(missingControl.actionState.autopickDisableClicks, 0);
});

test("salary-cap nomination remains on turn after ESPN opens its confirmation panel", async () => {
  const selectedNominee = await loadDraftContext({
    text: "PK 5 OF 128\n00:13\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Bienvenido a Miami",
    ownAuctionSelecting: true,
    maximumOffer: 187,
  });
  const genericControl = await loadDraftContext({
    text: "PK 4 OF 128\n00:13\nNOMINATE PLAYER",
  });

  assert.equal(selectedNominee.context.onClock, true);
  assert.equal(selectedNominee.hasSafeWindow(selectedNominee.context), true);
  assert.equal(selectedNominee.context.maxLegalBid, 187);
  assert.equal(genericControl.context.onClock, false);
});

test("an exact live nominee and active offer confirm ESPN accepted the nomination", async () => {
  const { nominationStarted } = await loadDraftContext({ text: "PK 11 OF 128\n00:14" });

  assert.equal(nominationStarted({ nominatedPlayer: "Jaxon Smith-Njigba", currentBid: 27 }, "Jaxon Smith-Njigba"), true);
  assert.equal(nominationStarted({ nominatedPlayer: "Jaxon Smith-Njigba", currentBid: 27 }, "Christian McCaffrey"), false);
  assert.equal(nominationStarted({ nominatedPlayer: "Jaxon Smith-Njigba", currentBid: 0 }, "Jaxon Smith-Njigba"), false);
});

test("a nomination turn that advances before confirmation is retriable", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationTurnEndsAfterSelect: true,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const result = await room.executeAction({
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 1,
    expectedLeagueId: "701",
  });

  assert.equal(result.code, "NOT_ON_CLOCK");
});

test("salary-cap nomination waits once for ESPN's late confirmation control", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 3500,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const result = await room.executeAction({
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 1,
    expectedLeagueId: "701",
  });

  assert.equal(result.code, "SUBMITTED");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 1);
});

test("salary-cap nomination still fails closed when confirmation never appears", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 10_000,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const result = await room.executeAction({
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 1,
    expectedLeagueId: "701",
  });

  assert.equal(result.code, "ACTION_NOT_FOUND");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 0);
});

test("salary-cap tracking records the exact winner, price, and sequence from budget deltas", async () => {
  const { updateSales } = await loadDraftContext({ text: "PK 11 OF 128\n00:14" });
  updateSales({
    nominatedPlayer: "Jahmyr Gibbs",
    nominatedPlayerId: 4360078,
    currentBid: 45,
    auctionBudgets: [
      { teamName: "Us", remaining: 200, maxOffer: 185 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
  });
  const settled = updateSales({
    nominatedPlayer: null,
    currentBid: 0,
    auctionBudgets: [
      { teamName: "Us", remaining: 155, maxOffer: 141 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
  });

  assert.equal(settled.auctionSales.length, 1);
  assert.equal(settled.auctionSales[0].playerId, 4360078);
  assert.equal(settled.auctionSales[0].teamName, "Us");
  assert.equal(settled.auctionSales[0].amount, 45);
  assert.equal(settled.auctionSales[0].sequence, 1);
});

test("draft actions fail closed before resolving or clicking a player control", async () => {
  const wrongLeague = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
  });
  const shortClock = await loadDraftContext({
    text: "RND 5 OF 16\n00:04\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
  });
  const changedPick = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 48",
    clockTeam: "Us",
    ownTeam: "Us",
  });

  const wrongLeagueResult = await wrongLeague.executeAction({
    operation: "SELECT", playerId: 1, playerName: "Player One", expectedLeagueId: "702", expectedPick: 47,
  });
  const shortClockResult = await shortClock.executeAction({
    operation: "SELECT", playerId: 1, playerName: "Player One", expectedLeagueId: "701", expectedPick: 47,
  });
  const changedPickResult = await changedPick.executeAction({
    operation: "SELECT", playerId: 1, playerName: "Player One", expectedLeagueId: "701", expectedPick: 46,
  });

  assert.equal(wrongLeagueResult.code, "WRONG_LEAGUE");
  assert.equal(shortClockResult.code, "CLOCK_TOO_SHORT");
  assert.equal(changedPickResult.code, "PICK_CHANGED");
});

test("salary-cap actions reject a mismatched nominee before searching for a bid control", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    maximumOffer: 150,
    nominatedPlayer: "Other Player",
  });
  const result = await room.executeAction({
    operation: "BID",
    playerId: 1,
    playerName: "Expected Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(result.code, "NOMINEE_MISMATCH");
});

test("salary-cap nomination cannot fire while ESPN already has an active offer", async () => {
  const room = await loadDraftContext({
    text: "PK 31 OF 168\n00:20\nNOMINATE PLAYER\nCurrent offer: $28",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    maximumOffer: 150,
    nominatedPlayer: "Existing Nominee",
    selectPlayer: { id: 12345, name: "Next Target" },
  });
  const result = await room.executeAction({
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Next Target",
    candidates: [{ playerId: 12345, playerName: "Next Target" }],
    amount: 1,
    expectedLeagueId: "701",
  });

  assert.equal(result.code, "NOMINATION_ACTIVE");
  assert.equal(room.actionState.selectClicks, 0);
});

test("an exact snake player control is clicked and confirmed from ESPN's roster", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });

  assert.equal(result.code, "ROSTER_CONFIRMED");
  assert.equal(room.actionState.selectClicks, 1);
});

test("salary-cap bidding clicks only the exact next incremental offer", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
  });
  const result = await room.executeAction({
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(result.code, "SUBMITTED");
  assert.equal(room.actionState.bidClicks, 1);
});

test("salary-cap bidding survives a transient ESPN offer-control rerender", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlDelayMs: 260,
  });
  const result = await room.executeAction({
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(result.code, "SUBMITTED");
  assert.equal(room.actionState.bidClicks, 1);
});

test("salary-cap bidding still fails closed when the exact offer control never stabilizes", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlDelayMs: 10_000,
  });
  const result = await room.executeAction({
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(result.code, "BID_OUT_OF_SEQUENCE");
  assert.equal(room.actionState.bidClicks, 0);
});

test("final mandatory slots search a wider exact shortlist inside the same action budget", async () => {
  const room = await loadDraftContext({ text: "RND 16 OF 16\n00:20\nON THE CLOCK: PICK 157", clockTeam: "Us", ownTeam: "Us" });
  const mandatoryCandidates = Array.from({ length: 25 }, (_, index) => ({
    playerId: index + 1,
    playerName: `Defense ${index + 1}`,
    fillsMandatoryStarter: true,
  }));
  const ordinaryCandidates = mandatoryCandidates.map((candidate) => ({ ...candidate, fillsMandatoryStarter: false }));
  const mandatoryPlan = room.candidateSearchPlan(mandatoryCandidates);
  const ordinaryPlan = room.candidateSearchPlan(ordinaryCandidates);

  assert.equal(mandatoryPlan.length, 18);
  assert.ok(mandatoryPlan.every((entry) => entry.waitMs === 120));
  assert.equal(ordinaryPlan.length, 7);
  assert.deepEqual(Array.from(ordinaryPlan, (entry) => entry.waitMs), [900, 250, 250, 250, 250, 250, 250]);
});

test("late snake resolution skips only players ESPN already confirms as drafted", async () => {
  const room = await loadDraftContext({
    text: "RND 12 OF 16\n00:20\nON THE CLOCK: PICK 115",
    clockTeam: "Us",
    ownTeam: "Us",
    snakeHistory: [
      { playerName: "Stale First Choice", teamName: "Other", round: 11, roundPick: 4 },
      { playerName: "Roster Player", teamName: "Us", round: 10, roundPick: 5 },
    ],
  });
  const candidates = [
    { playerId: 1, playerName: "Stale First Choice" },
    { playerId: 2, playerName: "Best Legal Choice" },
    { playerId: 3, playerName: "Next Legal Choice" },
  ];

  assert.deepEqual(
    Array.from(room.availableSnakeCandidates(candidates, room.context), (candidate) => candidate.playerName),
    ["Best Legal Choice", "Next Legal Choice"],
  );
});

test("late snake resolution preserves model order inside a bounded search budget", async () => {
  const room = await loadDraftContext({ text: "RND 12 OF 16\n00:20\nON THE CLOCK: PICK 115", clockTeam: "Us", ownTeam: "Us" });
  const candidates = Array.from({ length: 9 }, (_, index) => ({
    playerId: index + 1,
    playerName: `Candidate ${index + 1}`,
  }));
  const lateContext = { ownRoster: Array.from({ length: 10 }, (_, index) => ({ playerId: index + 100 })) };
  const plan = room.candidateSearchPlan(candidates, lateContext, "SELECT");
  const timing = room.playerResolutionPlan(lateContext, "SELECT", null);

  assert.deepEqual(Array.from(plan, (entry) => entry.candidate.playerName), candidates.slice(0, 7).map((candidate) => candidate.playerName));
  assert.deepEqual(Array.from(plan, (entry) => entry.waitMs), [500, 80, 80, 80, 80, 80, 80]);
  assert.deepEqual({ ...timing }, {
    playerGridWaitMs: 120,
    resolutionWindowMs: 1000,
    rehydrateWindowMs: 120,
  });
  assert.ok(timing.playerGridWaitMs + timing.resolutionWindowMs + timing.rehydrateWindowMs < 1500);
});

test("late snake timing does not change salary-cap or mandatory-slot resolution", async () => {
  const room = await loadDraftContext({ text: "RND 12 OF 16\n00:20\nON THE CLOCK: PICK 115", clockTeam: "Us", ownTeam: "Us" });
  const lateContext = { ownRoster: Array.from({ length: 12 }, (_, index) => ({ playerId: index + 100 })) };
  const ordinaryCandidates = [{ playerId: 1, playerName: "Candidate" }];
  const mandatoryCandidates = [{ playerId: 2, playerName: "Defense", position: "DST", fillsMandatoryStarter: true }];

  assert.deepEqual(Array.from(room.candidateSearchPlan(ordinaryCandidates, lateContext, "NOMINATE"), (entry) => entry.waitMs), [900]);
  assert.deepEqual(Array.from(room.candidateSearchPlan(mandatoryCandidates, lateContext, "SELECT"), (entry) => entry.waitMs), [120]);
  assert.deepEqual({ ...room.playerResolutionPlan(lateContext, "NOMINATE", null) }, {
    playerGridWaitMs: 400,
    resolutionWindowMs: 2200,
    rehydrateWindowMs: 400,
  });
});

test("final kicker and defense slots filter ESPN once before exact candidate resolution", async () => {
  const room = await loadDraftContext({ text: "RND 16 OF 16\n00:20\nON THE CLOCK: PICK 157", clockTeam: "Us", ownTeam: "Us" });
  const defenses = Array.from({ length: 32 }, (_, index) => ({
    playerId: index + 1,
    playerName: `Defense ${index + 1}`,
    position: "DST",
    fillsMandatoryStarter: true,
  }));
  const kickers = [{ playerId: 100, playerName: "Kicker", position: "K", fillsMandatoryStarter: true }];

  assert.equal(room.mandatoryPositionPlan(defenses).slotId, "16");
  assert.equal(room.mandatoryPositionPlan(defenses).candidates.length, 32);
  assert.equal(room.mandatoryPositionPlan(kickers).slotId, "17");
  assert.equal(room.mandatoryPositionPlan([{ ...defenses[0], fillsMandatoryStarter: false }]), null);
});

test("an available mandatory position filter skips the redundant unfiltered grid wait", async () => {
  const room = await loadDraftContext({
    text: "PK 126 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 0,
    mandatoryPositionFilterDelayMs: 120,
    maximumOffer: 4,
    selectPlayer: { id: -16023, name: "Steelers D/ST" },
  });
  const startedAt = Date.now();
  const result = await room.executeAction({
    operation: "NOMINATE",
    playerId: -16023,
    playerName: "Steelers D/ST",
    position: "DST",
    candidates: [{ playerId: -16023, playerName: "Steelers D/ST", position: "DST", fillsMandatoryStarter: true }],
    amount: 1,
    expectedLeagueId: "701",
  });

  assert.equal(result.code, "SUBMITTED");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 1);
  assert.ok(Date.now() - startedAt < 520, "mandatory filter path should not wait for the unfiltered grid first");
});
