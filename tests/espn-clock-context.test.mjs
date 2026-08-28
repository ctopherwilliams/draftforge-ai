import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const contentUrl = new URL("../extension/espn-content.js", import.meta.url);

async function loadDraftContext({ text, staleBidText = "", clockTeam, clockDisplay = null, clockOwnMarker = false, ownTeam, ownAuctionTeam, ownAuctionSelecting = false, nominationTurnEndsAfterSelect = false, nominationConfirmationDelayMs = null, nominationAcknowledged = true, nominationAcknowledgementDelayMs = 0, nominationAcknowledgedAmount = 1, mandatoryPositionFilterDelayMs = null, maximumOffer, nominatedPlayer, nominatedPlayerId = null, waitingTeamId, availableIds = [], snakeHistory = [], selectPlayer, selectRosterConfirmed = true, bidAmount, bidControlVisible = true, bidControlDelayMs = 0, customBidForm = false, customBidAcceptsAmount = true, customBidActsAsNomination = false, customBidDriftsAfterReads = null, bidAcknowledged = true, bidAcknowledgementDelayMs = 0, leadingBid = false, leadingBidAfterMs = null, opponentLeadingProof = true, modalConfirmations = [], autopickActive = false, autopickControlVisible = true, autopickEnableControlVisible = false, soundMuted = true, href = "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026" }) {
  const source = await readFile(contentUrl, "utf8");
  const runtimeStart = source.indexOf("chrome.runtime.onMessage.addListener");
  assert.ok(runtimeStart > 0, "content script should expose a Chrome message listener");

  let visibleClock = clockDisplay || text.match(/\b\d{1,2}:\d{2}\b/)?.[0] || "";
  let simulatedNominatedPlayer = nominatedPlayer;
  const clockNode = clockTeam ? {
    textContent: `On the Clock: Pick 47 ${visibleClock}`,
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
  let currentHref = href;
  const actionState = { selected: false, selectedAt: 0, selectClicks: 0, nominationClicks: 0, nominationClickedAt: 0, bidClicks: 0, bidClickedAt: 0, autopickDisableClicks: 0, modalClicks: 0, customSurfaceReads: 0 };
  class TestInputElement {
    constructor() {
      this._value = "";
      this.disabled = false;
    }
    get value() { return this._value; }
    set value(value) { if (customBidAcceptsAmount) this._value = String(value); }
    dispatchEvent() {}
    getClientRects() { return [{ width: 1, height: 1 }]; }
  }
  let simulatedAutopickActive = autopickActive || /you(?:'|’)re on autopick/i.test(text);
  const roomLoadedAt = Date.now();
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
  const bidControl = bidAmount && bidControlVisible ? {
    textContent: `Offer $${bidAmount}`,
    disabled: false,
    click() { actionState.bidClicks += 1; actionState.bidClickedAt = Date.now(); },
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: () => null,
  } : null;
  const customBidInput = customBidForm ? new TestInputElement() : null;
  const customBidSubmit = customBidForm ? {
    textContent: "Place Bid",
    disabled: false,
    click() {
      if (customBidActsAsNomination) {
        actionState.nominationClicks += 1;
        actionState.nominationClickedAt = Date.now();
      } else {
        actionState.bidClicks += 1;
        actionState.bidClickedAt = Date.now();
      }
    },
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: () => null,
  } : null;
  const customBidContainer = customBidForm ? {
    getClientRects: () => [{ width: 1, height: 1 }],
    querySelector(selector) {
      return selector === "#bid__input, input[type='number']" ? customBidInput : null;
    },
    querySelectorAll(selector) {
      if (selector === "button, [role='button']") return [customBidSubmit];
      if (selector === "#bid__input, input[type='number']") {
        actionState.customSurfaceReads += 1;
        if (customBidDriftsAfterReads !== null && actionState.customSurfaceReads >= customBidDriftsAfterReads) customBidInput._value = "";
        return [customBidInput];
      }
      return [];
    },
  } : null;
  const confirmationDialogs = modalConfirmations.map((modal) => {
    const identityNode = {
      textContent: modal.playerName || "",
      getAttribute(name) {
        return ["data-player-id", "data-playerid"].includes(name) && modal.playerId ? String(modal.playerId) : null;
      },
    };
    const buttons = Array.from({ length: Number(modal.buttons ?? 1) }, () => ({
      textContent: modal.buttonText || "Confirm",
      disabled: false,
      click() { actionState.modalClicks += 1; },
      getClientRects: () => modal.visible === false ? [] : [{ width: 1, height: 1 }],
    }));
    return {
      textContent: `${modal.playerName || ""} ${modal.amount ? `$${modal.amount}` : ""}`,
      getClientRects: () => modal.visible === false ? [] : [{ width: 1, height: 1 }],
      querySelectorAll(selector) {
        if (selector === "button, [role='button']") return buttons;
        if (selector.includes("[data-player-id]")) return [identityNode];
        return [];
      },
    };
  });
  const nominationControl = nominationConfirmationDelayMs !== null ? {
    textContent: "Nominate Player",
    disabled: false,
    click() { actionState.nominationClicks += 1; actionState.nominationClickedAt = Date.now(); },
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
  const enableAutopickControl = autopickEnableControlVisible ? {
    textContent: "Enable Autopick",
    disabled: false,
    click() {},
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
      let currentText = nominationTurnEndsAfterSelect && actionState.selected ? "PK 12 OF 128\n00:20\nOther team is nominating" : text;
      const bidConfirmed = bidAcknowledged && actionState.bidClickedAt > 0 && Date.now() - actionState.bidClickedAt >= bidAcknowledgementDelayMs;
      const nominationConfirmed = nominationAcknowledged && actionState.nominationClickedAt > 0 && Date.now() - actionState.nominationClickedAt >= nominationAcknowledgementDelayMs;
      if (bidConfirmed) {
        currentText = currentText.replace(/current (?:bid|offer)\s*:\s*\$?\s*\d+/i, `Current Bid: $${bidAmount}`);
      }
      if (nominationConfirmed && !/current (?:bid|offer)/i.test(currentText)) {
        currentText += `\nCurrent Bid: $${nominationAcknowledgedAmount}`;
      }
      const becameLeading = leadingBidAfterMs !== null && Date.now() - roomLoadedAt >= leadingBidAfterMs;
      if (leadingBid || becameLeading || bidConfirmed) currentText += "\nYou're the high bidder";
      if (staleBidText) currentText += `\n${staleBidText}`;
      currentText = simulatedAutopickActive ? `${currentText}\nYou're on Autopick` : currentText.replace(/you(?:'|’)re on autopick/ig, "");
      return currentText;
    } },
    querySelector(selector) {
      if (selector === ".on-the-clock") return clockNode;
      if (selector === ".draft-timer") return !clockNode && visibleClock ? { textContent: visibleClock } : null;
      if (selector === ".pick-queue__header .autoPick-toggle") return autopickContainer;
      if (selector === ".bidding-form__custom") return customBidContainer;
      if (selector === ".pick-component.own-pick .team-name") return ownTeam ? { textContent: ownTeam } : null;
      if (selector === ".auction-pick-component--own .team-name") return ownAuctionTeam ? { textContent: `5. ${ownAuctionTeam}` } : null;
      if (selector === ".auction-pick-component--own") return ownAuctionNode;
      if (selector === ".auction-pick-component--selecting") return nominationTurnEndsAfterSelect && actionState.selected ? null : selectingAuctionNode;
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") {
        const nominationConfirmed = nominationAcknowledged && actionState.nominationClickedAt > 0 && Date.now() - actionState.nominationClickedAt >= nominationAcknowledgementDelayMs;
        const liveNominee = simulatedNominatedPlayer || (nominationConfirmed ? selectPlayer?.name : null);
        return liveNominee ? {
          textContent: liveNominee,
          closest: () => ({
            querySelector() {
              return nominatedPlayerId ? { getAttribute: (name) => ["data-player-id", "data-playerid"].includes(name) ? String(nominatedPlayerId) : null } : null;
            },
          }),
        } : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".draft-header .icon-wrapper use") return [{
        getAttribute: (name) => name === "href" ? `#icon__controls__volume_${soundMuted ? "mute" : "up"}` : null,
      }];
      if (selector === ".bidding-form__custom") return customBidContainer ? [customBidContainer] : [];
      if (selector === "[data-testid*='high-bidder' i], [class*='high-bidder' i], [aria-label*='high bidder' i]") {
        const bidConfirmed = bidAcknowledged && actionState.bidClickedAt > 0 && Date.now() - actionState.bidClickedAt >= bidAcknowledgementDelayMs;
        const becameLeading = leadingBidAfterMs !== null && Date.now() - roomLoadedAt >= leadingBidAfterMs;
        const leader = leadingBid || becameLeading || bidConfirmed
          ? ownAuctionTeam
          : (opponentLeadingProof ? "Rival Team" : null);
        return leader ? [{
          textContent: `High bidder: ${leader}`,
          getClientRects: () => [{ width: 1, height: 1 }],
          getAttribute: () => null,
        }] : [];
      }
      if (selector === "[role='dialog'], [aria-modal='true'], [class*='modal' i]") return confirmationDialogs;
      if (selector === "[role='grid'] [role='row']") return [
        ...(surfaceRow ? [surfaceRow] : []),
        ...(playerRow && mandatoryPositionPlayerVisible() ? [playerRow] : []),
      ];
      if (selector.startsWith("button.Button--draft")) return playerControl && mandatoryPositionPlayerVisible() ? [playerControl] : [];
      if (selector === "select") return mandatoryPositionFilter ? [mandatoryPositionFilter] : [];
      if (selector === "button, [role='button']") {
        const controls = [];
        if (enableAutopickControl) controls.push(enableAutopickControl);
        if (nominationControl && actionState.selected && Date.now() - actionState.selectedAt >= nominationConfirmationDelayMs) controls.push(nominationControl);
        if (bidControl && Date.now() >= bidControlAvailableAt) controls.push(bidControl);
        return controls;
      }
      if (selector === "[class*='roster' i] tr") return selectRosterConfirmed && actionState.selected && rosterRow ? [rosterRow] : [];
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
    window: { location: { get href() { return currentHref; } } },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 16),
    HTMLInputElement: TestInputElement,
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
    readContext: sandbox.readDraftContext,
    executeAction: (action) => sandbox.executeDraftAction({ commandCenterSessionId: "test-command-center", ...action }),
    disableAutopick: sandbox.disableDraftAutopick,
    candidateSearchPlan: sandbox.planCandidateSearch,
    playerResolutionPlan: sandbox.planPlayerResolution,
    mandatoryPositionPlan: sandbox.planMandatoryPosition,
    availableSnakeCandidates: sandbox.pruneSnakeCandidates,
    actionState,
    setAuctionOffer({ playerName, clock }) {
      simulatedNominatedPlayer = playerName;
      visibleClock = clock;
    },
    setRoomUrl(url) { currentHref = url; },
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

test("unrelated body timers cannot override the scoped ESPN draft clock", async () => {
  const room = await loadDraftContext({
    text: "ADVERTISEMENT 99:59\nRND 5 OF 16\n00:12\nON THE CLOCK: PICK 47\nUs",
    clockDisplay: "00:12",
    clockTeam: "Us",
    ownTeam: "Us",
  });
  assert.equal(room.context.remainingSeconds, 12);
  assert.notEqual(room.context.draftClockSource, null);
});

test("auction clock monotonicity binds to the exact nominee and offer identity", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:05\nCurrent Bid: $1",
    clockDisplay: "00:05",
    nominatedPlayer: "First Nominee",
  });

  assert.equal(room.context.remainingSeconds, 5);
  room.setAuctionOffer({ playerName: "First Nominee", clock: "00:10" });
  assert.equal(room.readContext().remainingSeconds, null, "the same offer cannot jump upward");
  room.setAuctionOffer({ playerName: "Second Nominee", clock: "00:10" });
  assert.equal(room.readContext().remainingSeconds, 10, "a consecutive $1 offer for a different nominee accepts its reset");
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

test("Autopick absence is unknown and locks every draft action", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    autopickControlVisible: false,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });

  assert.equal(room.context.autopickActive, null);
  assert.equal(room.context.actionSurfaceReady, false);
  assert.equal(room.hasSafeWindow(room.context), false);
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });
  assert.equal(result.code, "AUTOPICK_STATE_UNKNOWN");
  assert.equal(room.actionState.selectClicks, 0);
  assert.equal((await room.disableAutopick({ expectedLeagueId: "701" })).code, "AUTOPICK_STATE_UNKNOWN");
});

test("an exact visible unchecked ESPN toggle is authoritative Autopick-off proof", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    autopickControlVisible: true,
  });

  assert.equal(room.context.autopickActive, false);
  assert.equal(room.hasSafeWindow(room.context), true);
  assert.equal((await room.disableAutopick({ expectedLeagueId: "701" })).code, "AUTOPICK_ALREADY_OFF");
});

test("contradictory visible Autopick controls are unknown and fail closed", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47\nYou're on Autopick",
    clockTeam: "Us",
    ownTeam: "Us",
    autopickActive: true,
    autopickControlVisible: true,
    autopickEnableControlVisible: true,
  });

  assert.equal(room.context.autopickActive, null);
  assert.equal(room.hasSafeWindow(room.context), false);
  assert.equal((await room.disableAutopick({ expectedLeagueId: "701" })).code, "AUTOPICK_STATE_UNKNOWN");
  assert.equal(room.actionState.autopickDisableClicks, 0);
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
    autopickControlVisible: false,
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
    nominationIntent: "TARGET",
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
    nominationIntent: "TARGET",
    expectedLeagueId: "701",
  });

  assert.equal(result.code, "NOMINATION_CONFIRMED");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 1);
});

test("salary-cap nomination proves the exact custom opening price and acknowledgement", async () => {
  const exact = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
    nominationConfirmationDelayMs: 10_000,
    nominationAcknowledgedAmount: 2,
    customBidForm: true,
    customBidActsAsNomination: true,
  });
  const wrongAcknowledgement = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
    nominationConfirmationDelayMs: 10_000,
    nominationAcknowledgedAmount: 1,
    customBidForm: true,
    customBidActsAsNomination: true,
  });
  const action = {
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 2,
    nominationIntent: "TARGET",
    expectedLeagueId: "701",
  };

  const exactResult = await exact.executeAction({ ...action, actionRequestId: 7401 });
  const wrongResult = await wrongAcknowledgement.executeAction({ ...action, actionRequestId: 7402 });

  assert.equal(exactResult.code, "NOMINATION_CONFIRMED");
  assert.equal(exact.actionState.nominationClicks, 1);
  assert.equal(wrongResult.code, "NOMINATION_ACK_UNCERTAIN");
  assert.equal(wrongResult.clicked, true);
  assert.equal(wrongResult.retryable, false);
  assert.equal(wrongAcknowledgement.actionState.nominationClicks, 1);
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
    nominationIntent: "TARGET",
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

test("salary-cap tracking survives a transient blank budget surface between nominations", async () => {
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

  const transient = updateSales({
    nominatedPlayer: "CeeDee Lamb",
    nominatedPlayerId: 4241389,
    currentBid: 38,
    auctionBudgets: [],
  });
  assert.equal(transient.auctionSales.length, 0);

  const recovered = updateSales({
    nominatedPlayer: "CeeDee Lamb",
    nominatedPlayerId: 4241389,
    currentBid: 38,
    auctionBudgets: [
      { teamName: "Us", remaining: 155, maxOffer: 141 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
  });
  assert.equal(recovered.auctionSales.length, 1);
  assert.equal(recovered.auctionSales[0].playerName, "Jahmyr Gibbs");
  assert.equal(recovered.auctionSales[0].teamName, "Us");
  assert.equal(recovered.auctionSales[0].amount, 45);

  const secondSettlement = updateSales({
    nominatedPlayer: null,
    currentBid: 0,
    auctionBudgets: [
      { teamName: "Us", remaining: 155, maxOffer: 141 },
      { teamName: "Rival", remaining: 162, maxOffer: 148 },
    ],
  });
  assert.equal(secondSettlement.auctionSales.length, 2);
  assert.equal(secondSettlement.auctionSales[1].playerName, "CeeDee Lamb");
  assert.equal(secondSettlement.auctionSales[1].teamName, "Rival");
  assert.equal(secondSettlement.auctionSales[1].amount, 38);
  assert.equal(secondSettlement.auctionSales[1].sequence, 2);
});

test("SPA navigation resets auction sales and clock state for the exact new draft namespace", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:14\nCurrent Bid: $45",
    clockDisplay: "00:14",
    nominatedPlayer: "First Room Player",
    href: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026&draftId=room-one",
  });
  room.updateSales({
    nominatedPlayer: "First Room Player",
    nominatedPlayerId: 111,
    currentBid: 45,
    auctionBudgets: [
      { teamName: "Us", remaining: 200, maxOffer: 185 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
  });
  const settled = room.updateSales({
    nominatedPlayer: null,
    currentBid: 0,
    auctionBudgets: [
      { teamName: "Us", remaining: 155, maxOffer: 141 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
  });
  assert.equal(settled.auctionSales.length, 1);
  room.updateSales({
    nominatedPlayer: "Unsettled First Room Player",
    nominatedPlayerId: 112,
    currentBid: 12,
    auctionBudgets: [
      { teamName: "Us", remaining: 155, maxOffer: 141 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
  });

  room.setRoomUrl("https://fantasy.espn.com/football/draft?leagueId=702&teamId=6&seasonId=2026&draftId=room-two");
  room.setAuctionOffer({ playerName: "Second Room Player", clock: "00:20" });
  const secondRoom = room.readContext();
  assert.equal(secondRoom.leagueId, "702");
  assert.equal(secondRoom.teamId, 6);
  assert.equal(secondRoom.remainingSeconds, 20, "the new room accepts its own clock reset");
  const secondOffer = room.updateSales({
    nominatedPlayer: "Second Room Player",
    nominatedPlayerId: 222,
    currentBid: 45,
    auctionBudgets: [
      { teamName: "Us", remaining: 200, maxOffer: 185 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
  });
  assert.equal(secondOffer.auctionSales.length, 0, "the first room's completed sales never cross the namespace");
});

test("salary-cap sale history stays bounded within a long draft room", async () => {
  const room = await loadDraftContext({ text: "PK 1 OF 400\n00:20" });
  let result;
  for (let index = 1; index <= 270; index += 1) {
    room.updateSales({
      nominatedPlayer: `Player ${index}`,
      nominatedPlayerId: index,
      currentBid: 1,
      auctionBudgets: [
        { teamName: "Us", remaining: 500 - index, maxOffer: 400 - index },
        { teamName: "Rival", remaining: 500, maxOffer: 400 },
      ],
    });
    result = room.updateSales({
      nominatedPlayer: null,
      currentBid: 0,
      auctionBudgets: [
        { teamName: "Us", remaining: 499 - index, maxOffer: 399 - index },
        { teamName: "Rival", remaining: 500, maxOffer: 400 },
      ],
    });
  }
  assert.equal(result.auctionSales.length, 256);
  assert.equal(result.auctionSales.at(-1).sequence, 270);
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
    bidAmount: 28,
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

test("salary-cap bid identity is ID-first and rejects colliding player names without clicking", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Expected Player Jr.",
    nominatedPlayerId: 222,
    bidAmount: 28,
  });
  const result = await room.executeAction({
    operation: "BID",
    playerId: 111,
    playerName: "Expected Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(result.code, "NOMINEE_MISMATCH");
  assert.equal(room.actionState.bidClicks, 0);
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
    nominationIntent: "TARGET",
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

test("only one visible modal scoped to the exact player can receive confirmation", async () => {
  const exact = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    modalConfirmations: [{ visible: true, playerId: 12345, playerName: "Exact Player" }],
  });
  const stale = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    modalConfirmations: [
      { visible: false, playerId: 12345, playerName: "Exact Player" },
      { visible: true, playerId: 99999, playerName: "Stale Player" },
    ],
  });
  const ambiguous = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    modalConfirmations: [
      { visible: true, playerId: 12345, playerName: "Exact Player" },
      { visible: true, playerId: 12345, playerName: "Exact Player" },
    ],
  });
  const action = {
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  };

  assert.equal((await exact.executeAction({ ...action, actionRequestId: 7601 })).code, "ROSTER_CONFIRMED");
  assert.equal((await stale.executeAction({ ...action, actionRequestId: 7602 })).code, "ROSTER_CONFIRMED");
  assert.equal((await ambiguous.executeAction({ ...action, actionRequestId: 7603 })).code, "ROSTER_CONFIRMED");
  assert.equal(exact.actionState.modalClicks, 1);
  assert.equal(stale.actionState.modalClicks, 0);
  assert.equal(ambiguous.actionState.modalClicks, 0);
});

test("an unconfirmed clicked snake selection is uncertain and never retries another candidate", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    selectRosterConfirmed: false,
  });
  const action = {
    operation: "SELECT",
    actionRequestId: 7701,
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [
      { playerId: 12345, playerName: "Exact Player" },
      { playerId: 99999, playerName: "Different Candidate" },
    ],
    expectedLeagueId: "701",
    expectedPick: 47,
  };

  const first = await room.executeAction(action);
  const duplicate = await room.executeAction(action);

  assert.equal(first.code, "ROSTER_NOT_CONFIRMED");
  assert.equal(first.clicked, true);
  assert.equal(first.retryable, false);
  assert.equal(duplicate.code, "ROSTER_NOT_CONFIRMED");
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

  assert.equal(room.context.leadingBid, false);
  const result = await room.executeAction({
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(result.code, "BID_CONFIRMED");
  assert.equal(room.actionState.bidClicks, 1);
});

test("a visible next-offer control cannot prove we are not already leading", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    opponentLeadingProof: false,
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

  assert.equal(room.context.leadingBid, null);
  assert.equal(result.code, "LEADING_BID_UNKNOWN");
  assert.equal(room.actionState.bidClicks, 0);
});

test("stale global auction messages never override the dedicated current leader", async () => {
  const staleOutbidButLeading = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    staleBidText: "You've been outbid",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    leadingBid: true,
  });
  const staleWinningButOpponentLeads = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    staleBidText: "You're the high bidder",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
  });

  assert.equal(staleOutbidButLeading.context.leadingBid, true);
  assert.equal(staleWinningButOpponentLeads.context.leadingBid, false);
});

test("stale global auction leadership without dedicated evidence fails closed", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    staleBidText: "Another team remains the high bidder",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    opponentLeadingProof: false,
  });
  const result = await room.executeAction({
    operation: "BID",
    actionRequestId: 7901,
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(room.context.leadingBid, null);
  assert.equal(result.code, "LEADING_BID_UNKNOWN");
  assert.equal(room.actionState.bidClicks, 0);
});

test("custom salary-cap bidding proves the exact input and paired submit before clicking", async () => {
  const exact = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlVisible: false,
    customBidForm: true,
  });
  const rejectedInput = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlVisible: false,
    customBidForm: true,
    customBidAcceptsAmount: false,
  });
  const action = {
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  };

  const exactResult = await exact.executeAction({ ...action, actionRequestId: 7801 });
  const rejectedResult = await rejectedInput.executeAction({ ...action, actionRequestId: 7802 });

  assert.equal(exactResult.code, "BID_CONFIRMED");
  assert.equal(exact.actionState.bidClicks, 1);
  assert.ok(exact.actionState.customSurfaceReads >= 4, "the custom amount surface is re-resolved after a render and before click");
  assert.equal(rejectedResult.code, "BID_OUT_OF_SEQUENCE");
  assert.equal(rejectedInput.actionState.bidClicks, 0);
});

test("a settled custom bid that drifts before final preflight never clicks", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlVisible: false,
    customBidForm: true,
    customBidDriftsAfterReads: 3,
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

  assert.equal(result.code, "CUSTOM_AMOUNT_UNCONFIRMED");
  assert.equal(room.actionState.bidClicks, 0);
});

test("salary-cap bidding fails closed while authoritative non-leading proof is rerendering", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlDelayMs: 260,
    opponentLeadingProof: false,
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

  assert.equal(room.context.leadingBid, null);
  assert.equal(result.code, "LEADING_BID_UNKNOWN");
  assert.equal(room.actionState.bidClicks, 0);
});

test("salary-cap bidding still fails closed when the exact offer control never stabilizes", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlDelayMs: 10_000,
    opponentLeadingProof: false,
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

  assert.equal(result.code, "LEADING_BID_UNKNOWN");
  assert.equal(room.actionState.bidClicks, 0);
});

test("salary-cap bidding never retargets an immutable stale offer", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $28",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 29,
  });
  const result = await room.executeAction({
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(result.code, "BID_CHANGED");
  assert.equal(room.actionState.bidClicks, 0);
});

test("salary-cap walk-away is terminal before any ESPN click", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $35",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 36,
  });
  const result = await room.executeAction({
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
    expectedCurrentBid: 35,
    amount: 36,
    maxApprovedBid: 35,
  });

  assert.equal(result.code, "WALK_AWAY");
  assert.equal(result.ok, true);
  assert.equal(room.actionState.bidClicks, 0);
});

test("salary-cap lead detection and ambiguous rerenders both block self-raises", async () => {
  const action = {
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  };
  const alreadyLeading = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    leadingBid: true,
  });
  const leadDuringRender = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlDelayMs: 120,
    leadingBidAfterMs: 40,
    opponentLeadingProof: false,
  });

  const initialResult = await alreadyLeading.executeAction({ ...action, actionRequestId: 8101 });
  const raceResult = await leadDuringRender.executeAction({ ...action, actionRequestId: 8102 });

  assert.equal(initialResult.code, "HOLD_LEADING_BID");
  assert.equal(raceResult.code, "LEADING_BID_UNKNOWN");
  assert.equal(alreadyLeading.actionState.bidClicks, 0);
  assert.equal(leadDuringRender.actionState.bidClicks, 0);
});

test("draft actions validate exact team and season before any click", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
  });
  const base = {
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  };

  const wrongTeam = await room.executeAction({ ...base, expectedTeamId: 6, expectedSeason: 2026, actionRequestId: 8201 });
  const wrongSeason = await room.executeAction({ ...base, expectedTeamId: 5, expectedSeason: 2025, actionRequestId: 8202 });

  assert.equal(wrongTeam.code, "WRONG_TEAM");
  assert.equal(wrongSeason.code, "WRONG_SEASON");
  assert.equal(room.actionState.bidClicks, 0);
});

test("salary-cap actions require a ceiling and explicit nomination intent", async () => {
  const bidRoom = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
  });
  const nominationRoom = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 0,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });

  const missingCeiling = await bidRoom.executeAction({
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
    expectedCurrentBid: 27,
    amount: 28,
  });
  const missingIntent = await nominationRoom.executeAction({
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 1,
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
  });

  assert.equal(missingCeiling.code, "BID_CEILING_UNKNOWN");
  assert.equal(missingIntent.code, "NOMINATION_INTENT_UNKNOWN");
  assert.equal(bidRoom.actionState.bidClicks, 0);
  assert.equal(nominationRoom.actionState.selectClicks, 0);
  assert.equal(nominationRoom.actionState.nominationClicks, 0);
});

test("a clicked bid has bounded acknowledgement and is never blindly retried", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidAcknowledged: false,
  });
  const action = {
    operation: "BID",
    actionRequestId: 8301,
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  };

  const first = await room.executeAction(action);
  const duplicate = await room.executeAction(action);

  assert.equal(first.code, "BID_ACK_UNCERTAIN");
  assert.equal(first.clicked, true);
  assert.equal(first.retryable, false);
  assert.equal(duplicate.code, "BID_ACK_UNCERTAIN");
  assert.equal(room.actionState.bidClicks, 1);
});

test("concurrent identical bid commands are single-flight and idempotent", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidAcknowledgementDelayMs: 80,
  });
  const action = {
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  };

  const [first, second] = await Promise.all([
    room.executeAction({ ...action, actionRequestId: 8401 }),
    room.executeAction({ ...action, actionRequestId: 8402 }),
  ]);
  const requestIdConflict = await room.executeAction({
    ...action,
    actionRequestId: 8401,
    expectedCurrentBid: 28,
    amount: 29,
  });

  assert.equal(first.code, "BID_CONFIRMED");
  assert.equal(second.code, "BID_CONFIRMED");
  assert.equal(first.action.actionRequestId, 8401);
  assert.equal(second.action.actionRequestId, 8402);
  assert.equal(requestIdConflict.code, "ACTION_REQUEST_CONFLICT");
  assert.equal(room.actionState.bidClicks, 1);
});

test("action request ids are namespaced to a validated command-center session", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
  });
  const base = {
    operation: "SELECT",
    actionRequestId: 1,
    expectedLeagueId: "wrong-league",
    expectedPick: 47,
  };

  const oldSession = await room.executeAction({
    ...base,
    commandCenterSessionId: "old-session-2026",
    playerId: 111,
    playerName: "Old Player",
  });
  const newSession = await room.executeAction({
    ...base,
    commandCenterSessionId: "new-session-2026",
    playerId: 222,
    playerName: "New Player",
  });
  const sameSessionConflict = await room.executeAction({
    ...base,
    commandCenterSessionId: "old-session-2026",
    playerId: 333,
    playerName: "Conflicting Player",
  });
  const unsafeSession = await room.executeAction({
    ...base,
    commandCenterSessionId: "bad session",
    actionRequestId: 2,
    playerId: 444,
    playerName: "Unsafe Session Player",
  });

  assert.equal(oldSession.code, "WRONG_LEAGUE");
  assert.equal(newSession.code, "WRONG_LEAGUE");
  assert.equal(sameSessionConflict.code, "ACTION_REQUEST_CONFLICT");
  assert.equal(unsafeSession.code, "COMMAND_CENTER_SESSION_INVALID");
  assert.equal(room.actionState.selectClicks, 0);
});

test("nomination actuator resolves only the exact requested player", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 0,
    maximumOffer: 150,
    selectPlayer: { id: 99999, name: "Visible Fallback" },
  });
  const result = await room.executeAction({
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Exact Target",
    candidates: [
      { playerId: 12345, playerName: "Exact Target" },
      { playerId: 99999, playerName: "Visible Fallback" },
    ],
    amount: 1,
    nominationIntent: "TARGET",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
  });

  assert.equal(result.code, "PLAYER_NOT_FOUND");
  assert.equal(room.actionState.selectClicks, 0);
  assert.equal(room.actionState.nominationClicks, 0);
});

test("a clicked drain nomination is acknowledged once and exposes its intent", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 0,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const action = {
    operation: "NOMINATE",
    actionRequestId: 8501,
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 1,
    nominationIntent: "DRAIN",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
  };

  const first = await room.executeAction(action);
  const duplicate = await room.executeAction(action);
  const tracked = room.readContext();

  assert.equal(first.code, "NOMINATION_CONFIRMED");
  assert.equal(duplicate.code, "NOMINATION_CONFIRMED");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 1);
  assert.equal(tracked.ownNominationIntent, "DRAIN");
  assert.equal(tracked.ownNominationPlayerId, 12345);
  room.setRoomUrl("https://fantasy.espn.com/football/draft?leagueId=702&teamId=6&seasonId=2026&draftId=next-room");
  const nextRoom = room.readContext();
  assert.equal(nextRoom.ownNominationIntent, null);
  assert.equal(nextRoom.ownNominationPlayerId, null);
});

test("an unacknowledged clicked nomination is uncertain and never blindly retried", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 0,
    nominationAcknowledged: false,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const action = {
    operation: "NOMINATE",
    actionRequestId: 8601,
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 1,
    nominationIntent: "TARGET",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
  };

  const first = await room.executeAction(action);
  const duplicate = await room.executeAction(action);

  assert.equal(first.code, "NOMINATION_ACK_UNCERTAIN");
  assert.equal(first.clicked, true);
  assert.equal(first.retryable, false);
  assert.equal(duplicate.code, "NOMINATION_ACK_UNCERTAIN");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 1);
});

test("a late ESPN acknowledgement still preserves drain intent after an uncertain result", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 0,
    nominationAcknowledgementDelayMs: 850,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const result = await room.executeAction({
    operation: "NOMINATE",
    actionRequestId: 8701,
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 1,
    nominationIntent: "DRAIN",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const tracked = room.readContext();

  assert.equal(result.code, "NOMINATION_ACK_UNCERTAIN");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 1);
  assert.equal(tracked.nominatedPlayer, "Exact Player");
  assert.equal(tracked.ownNominationIntent, "DRAIN");
  assert.equal(tracked.ownNominationPlayerId, 12345);
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
    nominationIntent: "TARGET",
    expectedLeagueId: "701",
  });

  assert.equal(result.code, "NOMINATION_CONFIRMED");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 1);
  assert.ok(Date.now() - startedAt < 520, "mandatory filter path should not wait for the unfiltered grid first");
});
