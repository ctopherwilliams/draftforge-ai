import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const contentUrl = new URL("../extension/espn-content.js", import.meta.url);

async function loadDraftContext({ text, staleBidText = "", stalePriorPrice = "", clockTeam, clockDisplay = null, extraGlobalAuctionClock = null, extraGlobalSnakeClock = null, snakeClockDisplays = null, auctionClockDisplays = null, clockOwnMarker = false, ownTeam, ownAuctionTeam, ownAuctionSelecting = false, nominationTurnEndsAfterSelect = false, snakeTurnEndsBeforeSubmit = false, separateDraftConfirmation = false, draftConfirmationDelayMs = 0, nominationConfirmationDelayMs = null, nominationAcknowledged = true, nominationAcknowledgementDelayMs = 0, nominationAcknowledgedAmount = 1, mandatoryPositionFilterDelayMs = null, maximumOffer, nominatedPlayer, nominatedPlayerId = null, nominatedPlayerIds = null, waitingTeamId, availableIds = [], snakeHistory = [], selectPlayer, selectRosterConfirmed = true, rosterPlayerId = null, rosterRootTeamId = 5, opponentRosterContainsSelected = false, duplicateOwnRosterRoots = 0, bidAmount, bidControlVisible = true, bidControlDelayMs = 0, extraBidControls = 0, customBidForm = false, customBidAcceptsAmount = true, customBidActsAsNomination = false, customBidDriftsAfterReads = null, bidAcknowledged = true, bidAcknowledgementDelayMs = 0, leadingBid = false, leadingBidAfterMs = null, opponentLeadingProof = true, decoratedLeader = null, extraAuctionTransactions = 0, modalConfirmations = [], autopickActive = false, autopickControlVisible = true, autopickEnableControlVisible = false, soundMuted = true, authorizationVerifier = null, href = "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026" }) {
  const source = await readFile(contentUrl, "utf8");
  const runtimeStart = source.indexOf("chrome.runtime.onMessage.addListener");
  assert.ok(runtimeStart > 0, "content script should expose a Chrome message listener");

  let visibleClock = clockDisplay === null ? text.match(/\b\d{1,2}:\d{2}\b/)?.[0] || "" : String(clockDisplay);
  let simulatedNominatedPlayer = nominatedPlayer;
  let simulatedSnakeTurnEnded = false;
  let snakeActionStarted = false;
  let simulatedNominatedPlayerIds = Array.isArray(nominatedPlayerIds)
    ? [...nominatedPlayerIds]
    : nominatedPlayerId !== null ? [nominatedPlayerId] : null;
  const draftClockSelector = [
    "[data-testid='draft-timer']",
    "[data-testid*='draft-clock' i]",
    ".draft-timer",
    ".auction-clock",
    "[class*='draft-clock' i]",
    "[class*='countdown' i]",
  ].join(", ");
  const configuredSnakeClocks = Array.isArray(snakeClockDisplays)
    ? snakeClockDisplays.map((display) => ({
        textContent: String(display),
        getClientRects: () => [{ width: 1, height: 1 }],
      }))
    : [];
  const snakeClockContainer = clockTeam ? {
    get textContent() { return `On the Clock: Pick 47 ${configuredSnakeClocks.map((node) => node.textContent).join(" ")}`; },
    querySelector: (childSelector) => childSelector === ".team-name" ? { textContent: clockTeam } : null,
    querySelectorAll: (selector) => selector === draftClockSelector ? configuredSnakeClocks : [],
  } : null;
  const clockNode = clockTeam ? {
    textContent: `On the Clock: Pick 47 ${visibleClock}`,
    querySelectorAll: (selector) => snakeClockContainer?.querySelectorAll(selector) || [],
    closest: (selector) => {
      if (selector === ".current-pick-module-container") return snakeClockContainer;
      if (selector === ".own-pick") return clockOwnMarker ? {} : null;
      return null;
    },
  } : null;
  const ownAuctionParent = {};
  const ownAuctionNode = ownAuctionTeam ? { closest: (selector) => selector === ".auction-pick-component" ? ownAuctionParent : null } : null;
  const selectingAuctionNode = ownAuctionSelecting ? { closest: (selector) => selector === ".auction-pick-component" ? ownAuctionParent : null } : null;
  let currentHref = href;
  const actionState = { selected: false, selectedAt: 0, selectClicks: 0, draftSubmitClicks: 0, nominationClicks: 0, nominationClickedAt: 0, bidClicks: 0, bidClickedAt: 0, autopickDisableClicks: 0, modalClicks: 0, customSurfaceReads: 0 };
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
  const defaultNotAfter = roomLoadedAt + 9_000;
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
    textContent: separateDraftConfirmation || nominationTurnEndsAfterSelect || nominationConfirmationDelayMs !== null ? "Select" : "Draft",
    disabled: false,
    click() { actionState.selected = true; actionState.selectedAt = Date.now(); actionState.selectClicks += 1; },
    scrollIntoView() { if (snakeTurnEndsBeforeSubmit) simulatedSnakeTurnEnded = true; },
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: (name) => name === "data-player-id" ? String(selectPlayer.id) : null,
    closest: () => playerRow,
  } : null;
  const finalDraftControl = selectPlayer && separateDraftConfirmation ? {
    textContent: "Draft",
    disabled: false,
    click() { actionState.draftSubmitClicks += 1; },
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
      if (selector.includes("button")) {
        if (snakeTurnEndsBeforeSubmit && snakeActionStarted) simulatedSnakeTurnEnded = true;
        return [playerControl];
      }
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
      if (selector.includes("[data-player-id]")) return { getAttribute: (name) => name === "data-player-id" ? String(rosterPlayerId ?? selectPlayer.id) : null };
      if (/playername|player-name/i.test(selector)) return { textContent: selectPlayer.name };
      return null;
    },
    querySelectorAll: () => [],
  } : null;
  const rosterRootSelector = "[data-testid*='roster' i], [class*='roster' i]";
  const rosterTeamLabelSelector = ".team-name, [data-testid*='team-name' i], [class*='team-name' i]";
  const rosterTeamName = ownAuctionTeam || ownTeam || clockTeam || "Us";
  const makeRosterRoot = (teamId, includesSelected) => ({
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute(name) {
      if (name === "data-team-id") return String(teamId);
      if (name === "class") return "team-roster";
      return null;
    },
    contains: () => false,
    querySelectorAll(selector) {
      if (selector === "tr") return includesSelected() && rosterRow ? [rosterRow] : [];
      if (selector === "a[href*='teamId=']") return [];
      if (selector === rosterTeamLabelSelector) return [{ textContent: teamId === 5 ? rosterTeamName : "Opponent Team", getClientRects: () => [{ width: 1, height: 1 }] }];
      return [];
    },
  });
  const ownRosterRoot = makeRosterRoot(rosterRootTeamId, () => selectRosterConfirmed && actionState.selected);
  const duplicateRosterRoots = Array.from({ length: duplicateOwnRosterRoots }, () => (
    makeRosterRoot(rosterRootTeamId, () => selectRosterConfirmed && actionState.selected)
  ));
  const opponentRosterRoot = opponentRosterContainsSelected
    ? makeRosterRoot(6, () => actionState.selected)
    : null;
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
  const bidConfirmed = () => bidAcknowledged
    && actionState.bidClickedAt > 0
    && Date.now() - actionState.bidClickedAt >= bidAcknowledgementDelayMs;
  const nominationConfirmed = () => nominationAcknowledged
    && actionState.nominationClickedAt > 0
    && Date.now() - actionState.nominationClickedAt >= nominationAcknowledgementDelayMs;
  const liveNominee = () => simulatedNominatedPlayer || (nominationConfirmed() ? selectPlayer?.name : null);
  const currentDraftText = (includeStale) => {
    let currentText = nominationTurnEndsAfterSelect && actionState.selected ? "PK 12 OF 128\n00:20\nOther team is nominating" : text;
    if (bidConfirmed()) {
      currentText = currentText.replace(/current (?:bid|offer)\s*:\s*\$?\s*\d+/i, `Current Bid: $${bidAmount}`);
    }
    if (nominationConfirmed() && !/current (?:bid|offer)/i.test(currentText)) {
      currentText += `\nCurrent Bid: $${nominationAcknowledgedAmount}`;
    }
    const becameLeading = leadingBidAfterMs !== null && Date.now() - roomLoadedAt >= leadingBidAfterMs;
    if (leadingBid || becameLeading || bidConfirmed()) currentText += "\nYou're the high bidder";
    if (includeStale && staleBidText) currentText += `\n${staleBidText}`;
    if (includeStale && stalePriorPrice) currentText = `${stalePriorPrice}\n${currentText}`;
    return includeStale && simulatedAutopickActive
      ? `${currentText}\nYou're on Autopick`
      : currentText.replace(/you(?:'|’)re on autopick/ig, "");
  };
  const auctionClockSelector = [
    "[data-testid='draft-timer']",
    "[data-testid*='draft-clock' i]",
    ".draft-timer",
    ".auction-clock",
    "[class*='draft-clock' i]",
    "[class*='countdown' i]",
  ].join(", ");
  const leaderSelector = "[data-testid*='high-bidder' i], [class*='high-bidder' i], [aria-label*='high bidder' i]";
  const configuredAuctionClocks = Array.isArray(auctionClockDisplays) && auctionClockDisplays.length
    ? auctionClockDisplays
    : [null];
  const auctionClockNodes = configuredAuctionClocks.map((configuredClock) => ({
    get textContent() { return configuredClock === null ? visibleClock : configuredClock; },
    getClientRects() { return this.textContent ? [{ width: 1, height: 1 }] : []; },
  }));
  const leaderNode = {
    get textContent() {
      const becameLeading = leadingBidAfterMs !== null && Date.now() - roomLoadedAt >= leadingBidAfterMs;
      const leader = leadingBid || becameLeading || bidConfirmed()
        ? ownAuctionTeam
        : (opponentLeadingProof ? "Rival Team" : null);
      if (!leader) return "";
      return leadingBid || becameLeading || bidConfirmed()
        ? (decoratedLeader || `High bidder: ${leader}`)
        : `High bidder: ${leader}`;
    },
    getClientRects() { return this.textContent ? [{ width: 1, height: 1 }] : []; },
    getAttribute: () => null,
  };
  const duplicateBidControls = Array.from({ length: extraBidControls }, () => ({
    ...bidControl,
    click() { actionState.bidClicks += 1; actionState.bidClickedAt = Date.now(); },
  }));
  let auctionTransactionContainer = null;
  const liveNomineeIds = () => {
    if (simulatedNominatedPlayerIds) return simulatedNominatedPlayerIds;
    if (nominationConfirmed() && selectPlayer) return [selectPlayer.id];
    return liveNominee() ? [12345] : [];
  };
  const selectedIdentityNodes = () => liveNomineeIds().map((playerId) => ({
    getAttribute(name) {
      if (["data-player-id", "data-playerid"].includes(name)) return String(playerId);
      return null;
    },
    getClientRects: () => liveNominee() ? [{ width: 1, height: 1 }] : [],
  }));
  const selectedPlayerNode = {
    get textContent() { return liveNominee() || ""; },
    getClientRects() { return this.textContent ? [{ width: 1, height: 1 }] : []; },
  };
  const selectedPlayerContainer = {
    parentElement: null,
    get textContent() { return liveNominee() || ""; },
    getClientRects() { return this.textContent ? [{ width: 1, height: 1 }] : []; },
    querySelectorAll(selector) {
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") return this.textContent ? [selectedPlayerNode] : [];
      if (selector === "[data-player-id], [data-playerid]") return this.textContent ? selectedIdentityNodes() : [];
      if (selector === "img[src*='/players/full/']") return [];
      return [];
    },
  };
  auctionTransactionContainer = {
    parentElement: null,
    get textContent() { return currentDraftText(false); },
    getClientRects: () => [{ width: 1, height: 1 }],
    querySelectorAll(selector) {
      if (selector === auctionClockSelector) return auctionClockNodes;
      if (selector === "[data-testid='player-selected']") return liveNominee() ? [selectedPlayerContainer] : [];
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") return liveNominee() ? [selectedPlayerNode] : [];
      if (selector === leaderSelector) return leaderNode.textContent ? [leaderNode] : [];
      if (selector === ".auction-pick-component--selecting") {
        return selectingAuctionNode && !(nominationTurnEndsAfterSelect && actionState.selected) ? [selectingAuctionNode] : [];
      }
      if (selector === ".bidding-form__custom") return customBidContainer ? [customBidContainer] : [];
      if (selector === "button, [role='button']") {
        const controls = [];
        if (nominationControl && actionState.selected && Date.now() - actionState.selectedAt >= nominationConfirmationDelayMs) controls.push(nominationControl);
        if (bidControl && Date.now() >= bidControlAvailableAt) controls.push(bidControl, ...duplicateBidControls);
        if (customBidSubmit) controls.push(customBidSubmit);
        return controls;
      }
      return [];
    },
  };
  selectedPlayerContainer.parentElement = auctionTransactionContainer;
  selectedPlayerNode.parentElement = selectedPlayerContainer;
  Object.assign(ownAuctionParent, {
    parentElement: auctionTransactionContainer,
    getClientRects: () => [{ width: 1, height: 1 }],
    querySelectorAll: () => [],
  });
  if (ownAuctionNode) ownAuctionNode.parentElement = ownAuctionParent;
  if (selectingAuctionNode) selectingAuctionNode.parentElement = ownAuctionParent;
  const extraSelectedContainers = Array.from({ length: extraAuctionTransactions }, () => ({
    ...selectedPlayerContainer,
    parentElement: { ...auctionTransactionContainer },
  }));
  const document = {
    body: { get innerText() { return currentDraftText(true); } },
    querySelector(selector) {
      if (selector === ".on-the-clock") return simulatedSnakeTurnEnded ? null : clockNode;
      if (selector === ".draft-timer") {
        const globalClock = clockNode ? extraGlobalSnakeClock : extraGlobalAuctionClock || visibleClock;
        return globalClock ? { textContent: globalClock } : null;
      }
      if (selector === ".pick-queue__header .autoPick-toggle") return autopickContainer;
      if (selector === ".bidding-form__custom") return customBidContainer;
      if (selector === ".pick-component.own-pick .team-name") return ownTeam ? { textContent: ownTeam } : null;
      if (selector === ".auction-pick-component--own .team-name") return ownAuctionTeam ? { textContent: `5. ${ownAuctionTeam}` } : null;
      if (selector === ".auction-pick-component--own") return ownAuctionNode;
      if (selector === ".auction-pick-component--selecting") return nominationTurnEndsAfterSelect && actionState.selected ? null : selectingAuctionNode;
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") {
        return liveNominee() ? selectedPlayerNode : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".draft-header .icon-wrapper use") return [{
        getAttribute: (name) => name === "href" ? `#icon__controls__volume_${soundMuted ? "mute" : "up"}` : null,
      }];
      if (selector === "[data-testid='player-selected']") {
        return liveNominee() ? [selectedPlayerContainer, ...extraSelectedContainers] : [];
      }
      if (selector === ".auction-pick-component--selecting") {
        return selectingAuctionNode && !(nominationTurnEndsAfterSelect && actionState.selected) ? [selectingAuctionNode] : [];
      }
      if (selector === ".auction-pick-component--own") return ownAuctionNode ? [ownAuctionNode] : [];
      if (selector === ".auction-pick-component--own .team-name") return ownAuctionTeam ? [{
        textContent: `5. ${ownAuctionTeam}`,
        getClientRects: () => [{ width: 1, height: 1 }],
      }] : [];
      if (selector === ".bidding-form__custom") return customBidContainer ? [customBidContainer] : [];
      if (selector === leaderSelector) return leaderNode.textContent ? [leaderNode] : [];
      if (selector === "[role='dialog'], [aria-modal='true'], [class*='modal' i]") return confirmationDialogs;
      if (selector === "[role='grid'] [role='row']") return [
        ...(surfaceRow ? [surfaceRow] : []),
        ...(playerRow && mandatoryPositionPlayerVisible() ? [playerRow] : []),
      ];
      if (selector.startsWith("button.Button--draft")) {
        if (finalDraftControl) {
          return actionState.selected && Date.now() - actionState.selectedAt >= draftConfirmationDelayMs
            ? [finalDraftControl]
            : [];
        }
        return playerControl && mandatoryPositionPlayerVisible() ? [playerControl] : [];
      }
      if (selector === "select") return mandatoryPositionFilter ? [mandatoryPositionFilter] : [];
      if (selector === "button, [role='button']") {
        const controls = [];
        if (enableAutopickControl) controls.push(enableAutopickControl);
        if (nominationControl && actionState.selected && Date.now() - actionState.selectedAt >= nominationConfirmationDelayMs) controls.push(nominationControl);
        if (bidControl && Date.now() >= bidControlAvailableAt) controls.push(bidControl, ...duplicateBidControls);
        if (customBidSubmit) controls.push(customBidSubmit);
        return controls;
      }
      if (selector === rosterRootSelector) {
        return [ownRosterRoot, ...duplicateRosterRoots, ...(opponentRosterRoot ? [opponentRosterRoot] : [])];
      }
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
    chrome: {
      runtime: {
        id: "test-extension",
        async sendMessage(message) {
          if (message?.type === "VERIFY_ACTION_AUTHORIZATION") {
            return authorizationVerifier ? authorizationVerifier(message.payload) : { ok: true, code: "ACTION_AUTHORIZATION_VERIFIED" };
          }
          return { ok: true };
        },
      },
    },
  };
  vm.runInNewContext(`${source.slice(0, runtimeStart)}\nglobalThis.readDraftContext = getContext; globalThis.readObservedDraftContext = getObservedContext; globalThis.hasSafeWindow = hasSafeActionWindow; globalThis.snakePoolStable = snakePlayerPoolIsStable; globalThis.nominationStarted = nominationHasStarted; globalThis.updateSales = updateAuctionSales; globalThis.advanceTrackedSales = advanceAuctionTracking; globalThis.advanceRapidProducerSales = advanceRapidProducerAuctionTracking; globalThis.observeTrackedSales = observeAuctionTracking; globalThis.executeDraftAction = executeAction; globalThis.revokeDraftActions = rememberMinimumActionAuthorizationEpoch; globalThis.disableDraftAutopick = disableEspnAutopick; globalThis.planCandidateSearch = buildCandidateSearchPlan; globalThis.planPlayerResolution = playerResolutionTiming; globalThis.planMandatoryPosition = buildMandatoryPositionPlan; globalThis.pruneSnakeCandidates = availableSnakeCandidates; globalThis.contextScanPolicyForTest = contextScanPolicy; globalThis.nextContextScanDelayForTest = nextContextScanDelay;`, sandbox);
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
    advanceTrackedSales: sandbox.advanceTrackedSales,
    advanceRapidProducerSales: sandbox.advanceRapidProducerSales,
    observeTrackedSales: sandbox.observeTrackedSales,
    readObservedContext: sandbox.readObservedDraftContext,
    readContext: sandbox.readDraftContext,
    executeAction: (action) => {
      snakeActionStarted = true;
      return sandbox.executeDraftAction({
        commandCenterSessionId: "test-command-center",
        authorizationEpoch: 0,
        writerLeaseId: "test-writer-lease",
        notAfter: defaultNotAfter,
        availabilityNotAfter: defaultNotAfter,
        ...action,
      });
    },
    revokeActions: (minimumAuthorizationEpoch) => sandbox.revokeDraftActions("test-command-center", minimumAuthorizationEpoch),
    disableAutopick: sandbox.disableDraftAutopick,
    candidateSearchPlan: sandbox.planCandidateSearch,
    playerResolutionPlan: sandbox.planPlayerResolution,
    mandatoryPositionPlan: sandbox.planMandatoryPosition,
    availableSnakeCandidates: sandbox.pruneSnakeCandidates,
    contextScanPolicy: sandbox.contextScanPolicyForTest,
    nextContextScanDelay: sandbox.nextContextScanDelayForTest,
    actionState,
    setAuctionOffer({ playerName, playerId, clock }) {
      simulatedNominatedPlayer = playerName;
      if (playerId !== undefined) simulatedNominatedPlayerIds = [playerId];
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

test("an unparseable exact snake clock never falls back to a visible global timer", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\nON THE CLOCK: PICK 47\nUs",
    clockDisplay: "",
    extraGlobalSnakeClock: "00:20",
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

  assert.equal(room.context.onClock, true);
  assert.equal(room.context.remainingSeconds, null);
  assert.equal(room.context.actionSurfaceReady, false);
  assert.equal(result.code, "CLOCK_TOO_SHORT");
  assert.equal(room.actionState.selectClicks, 0);
});

test("multiple visible clocks inside the exact snake pick scope fail closed", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\nON THE CLOCK: PICK 47\nUs",
    clockDisplay: "",
    snakeClockDisplays: ["00:20", "00:03"],
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

  assert.equal(room.context.remainingSeconds, null);
  assert.equal(room.context.actionSurfaceReady, false);
  assert.equal(result.code, "CLOCK_TOO_SHORT");
  assert.equal(room.actionState.selectClicks, 0);
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
  room.setAuctionOffer({ playerName: "Second Nominee", playerId: 54321, clock: "00:10" });
  assert.equal(room.readContext().remainingSeconds, 10, "a consecutive $1 offer for a different nominee accepts its reset");
});

test("active auction and own-clock mutations schedule context publication within 100ms", async () => {
  const auction = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
  });
  const snake = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
  });
  const now = 10_000;
  const auctionDelay = auction.nextContextScanDelay({ now, lastScanAt: now, context: auction.context });
  const snakeDelay = snake.nextContextScanDelay({ now, lastScanAt: now, context: snake.context });

  assert.equal(auction.context.auctionTransactionReady, true);
  assert.equal(auction.contextScanPolicy(auction.context).active, true);
  assert.ok(auctionDelay <= 100, `active auction scheduling delay was ${auctionDelay}ms`);
  assert.ok(snakeDelay <= 100, `own-clock scheduling delay was ${snakeDelay}ms`);
});

test("idle context scans retain a bounded slower cadence", async () => {
  const idle = await loadDraftContext({ text: "Draft room waiting" });
  const now = 10_000;
  const immediatelyAfterScan = idle.nextContextScanDelay({ now, lastScanAt: now, context: idle.context });
  const afterLongIdle = idle.nextContextScanDelay({ now, lastScanAt: 1, context: idle.context });

  assert.equal(idle.contextScanPolicy(idle.context).active, false);
  assert.equal(immediatelyAfterScan, 500);
  assert.equal(afterLongIdle, 125);
  assert.ok(afterLongIdle <= immediatelyAfterScan);
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

test("salary-cap tracking keeps consecutive same-name players distinct by exact ESPN id", async () => {
  const { updateSales } = await loadDraftContext({ text: "PK 11 OF 128\n00:14" });
  const startingBudgets = [
    { teamName: "Us", remaining: 200, maxOffer: 185 },
    { teamName: "Rival", remaining: 200, maxOffer: 185 },
  ];
  updateSales({
    nominatedPlayer: "Shared Player Name",
    nominatedPlayerId: 111,
    currentBid: 10,
    auctionBudgets: startingBudgets,
    actionSurfaceReady: true,
  });

  const secondOffer = updateSales({
    nominatedPlayer: "Shared Player Name",
    nominatedPlayerId: 222,
    currentBid: 1,
    auctionBudgets: [
      { teamName: "Us", remaining: 190, maxOffer: 176 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
    actionSurfaceReady: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(secondOffer.auctionSales)), [{
    playerId: 111,
    playerName: "Shared Player Name",
    teamName: "Us",
    amount: 10,
    sequence: 1,
  }]);
  assert.equal(secondOffer.auctionSettlementPending, false);

  const settled = updateSales({
    nominatedPlayer: null,
    nominatedPlayerId: null,
    currentBid: 0,
    auctionBudgets: [
      { teamName: "Us", remaining: 190, maxOffer: 176 },
      { teamName: "Rival", remaining: 199, maxOffer: 184 },
    ],
    actionSurfaceReady: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(settled.auctionSales)), [
    {
      playerId: 111,
      playerName: "Shared Player Name",
      teamName: "Us",
      amount: 10,
      sequence: 1,
    },
    {
      playerId: 222,
      playerName: "Shared Player Name",
      teamName: "Rival",
      amount: 1,
      sequence: 2,
    },
  ]);
  assert.equal(settled.auctionSettlementPending, false);
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

test("rapid producer scans retain the final bid before ESPN advances to the next offer", async () => {
  const room = await loadDraftContext({ text: "PK 11 OF 128\n00:14" });
  const startingBudgets = [
    { teamName: "Us", remaining: 200, maxOffer: 185 },
    { teamName: "Rival", remaining: 200, maxOffer: 185 },
  ];

  room.advanceTrackedSales({
    nominatedPlayer: "Jahmyr Gibbs",
    nominatedPlayerId: 4360078,
    currentBid: 5,
    auctionBudgets: startingBudgets,
    actionSurfaceReady: true,
  }, 1);

  const rapid = room.advanceRapidProducerSales({
    nominatedPlayer: "Jahmyr Gibbs",
    nominatedPlayerId: 4360078,
    currentBid: 10,
    auctionBudgets: startingBudgets,
    actionSurfaceReady: true,
  }, 2);
  assert.equal(rapid.auctionSales.length, 0);
  assert.equal(rapid.auctionSettlementPending, false);

  const nextOffer = room.advanceTrackedSales({
    nominatedPlayer: "CeeDee Lamb",
    nominatedPlayerId: 4241389,
    currentBid: 1,
    auctionBudgets: [
      { teamName: "Us", remaining: 190, maxOffer: 176 },
      { teamName: "Rival", remaining: 200, maxOffer: 185 },
    ],
    actionSurfaceReady: true,
  }, 3);

  assert.deepEqual(JSON.parse(JSON.stringify(nextOffer.auctionSales)), [{
    playerId: 4360078,
    playerName: "Jahmyr Gibbs",
    teamName: "Us",
    amount: 10,
    sequence: 1,
  }]);
  assert.equal(nextOffer.auctionSettlementPending, false);
  assert.equal(nextOffer.actionSurfaceReady, true);
});

test("observer reads and same-revision producer scans cannot consume salary-cap settlement recovery", async () => {
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const offer = (playerName, playerId, currentBid, auctionBudgets) => ({
    playerName,
    nominatedPlayer: playerName,
    nominatedPlayerId: playerId,
    currentBid,
    auctionBudgets,
  });
  const startingBudgets = [
    { teamName: "Us", remaining: 200, maxOffer: 185 },
    { teamName: "Rival", remaining: 200, maxOffer: 185 },
  ];
  const firstSettlementBudgets = [
    { teamName: "Us", remaining: 155, maxOffer: 141 },
    { teamName: "Rival", remaining: 200, maxOffer: 185 },
  ];
  const secondSettlementBudgets = [
    { teamName: "Us", remaining: 155, maxOffer: 141 },
    { teamName: "Rival", remaining: 162, maxOffer: 148 },
  ];

  const runScenario = async (withObserverPressure) => {
    const room = await loadDraftContext({ text: "PK 11 OF 128\n00:14" });
    room.advanceTrackedSales(offer("Jahmyr Gibbs", 4360078, 45, startingBudgets), 1);
    const transitionalContext = offer("CeeDee Lamb", 4241389, 38, []);
    const pending = room.advanceTrackedSales(transitionalContext, 2);
    const pendingDigest = digest(pending);

    if (withObserverPressure) {
      const initialStatusDigest = digest(room.readObservedContext());
      for (let index = 0; index < 250; index += 1) {
        assert.equal(
          digest(room.readObservedContext()),
          initialStatusDigest,
          `DF_GET_CONTEXT-equivalent read ${index + 1} changed its status snapshot`,
        );
        const observed = room.observeTrackedSales(transitionalContext);
        assert.equal(digest(observed), pendingDigest, `observer read ${index + 1} changed tracked state`);
      }
      for (let index = 0; index < 25; index += 1) {
        const repeated = room.advanceTrackedSales(transitionalContext, 2);
        assert.equal(digest(repeated), pendingDigest);
      }
    }

    room.advanceTrackedSales(offer("CeeDee Lamb", 4241389, 38, firstSettlementBudgets), 3);
    return room.advanceTrackedSales({
      nominatedPlayer: null,
      nominatedPlayerId: null,
      currentBid: 0,
      auctionBudgets: secondSettlementBudgets,
    }, 4);
  };

  const baseline = await runScenario(false);
  const readHeavy = await runScenario(true);
  assert.equal(digest(readHeavy), digest(baseline));
  assert.deepEqual(JSON.parse(JSON.stringify(readHeavy.auctionSales)), [
    { playerId: 4360078, playerName: "Jahmyr Gibbs", teamName: "Us", amount: 45, sequence: 1 },
    { playerId: 4241389, playerName: "CeeDee Lamb", teamName: "Rival", amount: 38, sequence: 2 },
  ]);
});

test("auction settlement survives more than five unrelated revisions and next-offer churn", async () => {
  const room = await loadDraftContext({ text: "PK 11 OF 128\n00:14" });
  const startingBudgets = [
    { teamName: "Us", remaining: 200, maxOffer: 185 },
    { teamName: "Rival", remaining: 200, maxOffer: 185 },
  ];
  const settledBudgets = [
    { teamName: "Us", remaining: 155, maxOffer: 141 },
    { teamName: "Rival", remaining: 200, maxOffer: 185 },
  ];
  room.advanceTrackedSales({
    nominatedPlayer: "Jahmyr Gibbs",
    nominatedPlayerId: 4360078,
    currentBid: 45,
    auctionBudgets: startingBudgets,
    actionSurfaceReady: true,
  }, 1);
  const nextOffer = {
    nominatedPlayer: "CeeDee Lamb",
    nominatedPlayerId: 4241389,
    currentBid: 38,
    auctionBudgets: [],
    actionSurfaceReady: true,
  };
  for (let revision = 2; revision <= 30; revision += 1) {
    const pending = room.advanceTrackedSales(nextOffer, revision);
    assert.equal(pending.auctionSales.length, 0);
    assert.equal(pending.auctionSettlementPending, true);
    assert.equal(pending.actionSurfaceReady, false);
  }

  const recovered = room.advanceTrackedSales({ ...nextOffer, auctionBudgets: settledBudgets }, 31);
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.auctionSales)), [{
    playerId: 4360078,
    playerName: "Jahmyr Gibbs",
    teamName: "Us",
    amount: 45,
    sequence: 1,
  }]);
  assert.equal(recovered.auctionSettlementPending, false);
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

test("salary-cap bid identity requires the exact ESPN id and displayed name", async () => {
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

test("mixed player ids inside one salary-cap transaction fail closed", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    nominatedPlayerIds: [12345, 67890],
    bidAmount: 28,
  });
  const missingIdentity = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    nominatedPlayerIds: [],
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
  const missingResult = await missingIdentity.executeAction({
    operation: "BID",
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });

  assert.equal(room.context.nominatedPlayerId, null);
  assert.equal(room.context.auctionTransactionReady, false);
  assert.equal(result.code, "AUCTION_TRANSACTION_AMBIGUOUS");
  assert.equal(missingIdentity.context.auctionTransactionReady, false);
  assert.equal(missingResult.code, "AUCTION_TRANSACTION_AMBIGUOUS");
  assert.equal(room.actionState.bidClicks, 0);
  assert.equal(missingIdentity.actionState.bidClicks, 0);
});

test("a matching salary-cap id cannot override a conflicting displayed name", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Different Player",
    nominatedPlayerId: 12345,
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

test("snake selection remains executable when the operator leaves ESPN sound on", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    soundMuted: false,
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });

  assert.equal(room.context.soundMuted, false);
  assert.equal(result.code, "ROSTER_CONFIRMED");
  assert.equal(room.actionState.selectClicks, 1);
});

test("snake selection never falls back to a same-name row with a different ESPN player id", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 99999, name: "Shared Player Name" },
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Shared Player Name",
    candidates: [{ playerId: 12345, playerName: "Shared Player Name" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });

  assert.equal(result.code, "PLAYER_NOT_FOUND");
  assert.equal(room.actionState.selectClicks, 0);
  assert.equal(room.actionState.draftSubmitClicks, 0);
});

test("snake roster confirmation requires the exact ESPN player id instead of a matching name", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Shared Player Name" },
    rosterPlayerId: 99999,
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Shared Player Name",
    candidates: [{ playerId: 12345, playerName: "Shared Player Name" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });

  assert.equal(result.code, "ROSTER_NOT_CONFIRMED");
  assert.equal(result.clicked, true);
  assert.equal(room.actionState.selectClicks, 1);
});

test("snake selection stops when the own-clock identity disappears but the stale pick number remains", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    snakeTurnEndsBeforeSubmit: true,
  });
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

test("another visible ESPN roster cannot confirm our snake selection", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    selectRosterConfirmed: false,
    opponentRosterContainsSelected: true,
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });

  assert.equal(result.code, "ROSTER_NOT_CONFIRMED");
  assert.equal(result.clicked, true);
  assert.equal(room.actionState.selectClicks, 1);
});

test("multiple authenticated own-roster roots are ambiguous and cannot confirm", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    duplicateOwnRosterRoots: 1,
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });

  assert.equal(result.code, "ROSTER_NOT_CONFIRMED");
  assert.equal(result.clicked, true);
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
  const nameOnly = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    modalConfirmations: [{ visible: true, playerName: "Exact Player" }],
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
  assert.equal((await nameOnly.executeAction({ ...action, actionRequestId: 7604 })).code, "ROSTER_CONFIRMED");
  assert.equal(exact.actionState.modalClicks, 1);
  assert.equal(stale.actionState.modalClicks, 0);
  assert.equal(ambiguous.actionState.modalClicks, 0);
  assert.equal(nameOnly.actionState.modalClicks, 0);
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

test("salary-cap bidding remains executable when the operator leaves ESPN sound on", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    soundMuted: false,
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

  assert.equal(room.context.soundMuted, false);
  assert.equal(result.code, "BID_CONFIRMED");
  assert.equal(room.actionState.bidClicks, 1);
});

test("a stale prior price outside the live nominee transaction cannot retarget a bid", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    stalePriorPrice: "Current Bid: $99",
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

  assert.equal(room.context.currentBid, 27);
  assert.equal(result.code, "BID_CONFIRMED");
  assert.equal(room.actionState.bidClicks, 1);
});

test("an unrelated second auction clock cannot override the transaction clock", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    clockDisplay: "00:20",
    extraGlobalAuctionClock: "00:03",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
  });

  assert.equal(room.context.remainingSeconds, 20);
  assert.equal(room.context.draftClockSource, "ACTIVE_AUCTION_TRANSACTION");
});

test("two visible clocks inside the same auction transaction fail closed", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    auctionClockDisplays: ["00:20", "00:03"],
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

  assert.equal(room.context.remainingSeconds, null);
  assert.equal(result.ok, false);
  assert.equal(room.actionState.bidClicks, 0);
});

test("a decorated exact own-team leader label never triggers a self-raise", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    leadingBid: true,
    decoratedLeader: "High bidder: 5. Us • $27 (You)",
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

  assert.equal(room.context.leadingBid, true);
  assert.equal(result.code, "HOLD_LEADING_BID");
  assert.equal(room.actionState.bidClicks, 0);
});

test("multiple live bid controls or transaction containers fail closed", async () => {
  const duplicateControls = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    extraBidControls: 1,
  });
  const duplicateTransactions = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    extraAuctionTransactions: 1,
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

  const controlResult = await duplicateControls.executeAction(action);
  const transactionResult = await duplicateTransactions.executeAction(action);
  const now = 10_000;
  const ambiguousDelay = duplicateControls.nextContextScanDelay({
    now,
    lastScanAt: now,
    context: duplicateControls.context,
  });

  assert.equal(controlResult.code, "AUCTION_TRANSACTION_AMBIGUOUS");
  assert.equal(transactionResult.code, "AUCTION_TRANSACTION_UNKNOWN");
  assert.ok(ambiguousDelay <= 100, "an active ambiguous offer is published promptly while remaining fail-closed");
  assert.equal(duplicateControls.actionState.bidClicks, 0);
  assert.equal(duplicateTransactions.actionState.bidClicks, 0);
});

test("an expired salary-cap action cannot click after delayed MV3 delivery", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
  });
  const result = await room.executeAction({
    operation: "BID",
    actionRequestId: 9101,
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
    notAfter: Date.now() - 1,
  });
  assert.equal(result.code, "ACTION_EXPIRED");
  assert.equal(room.actionState.bidClicks, 0);
});

test("salary-cap actions cannot outlive their exact availability evidence", async () => {
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
  const now = Date.now();
  const missing = await room.executeAction({ ...base, actionRequestId: 9111, availabilityNotAfter: undefined });
  const unsafe = await room.executeAction({ ...base, actionRequestId: 9112, availabilityNotAfter: Number.MAX_SAFE_INTEGER + 1 });
  const expired = await room.executeAction({
    ...base,
    actionRequestId: 9113,
    notAfter: now - 2_000,
    availabilityNotAfter: now - 1_000,
  });
  const availabilityCutoff = Date.now() + 2_000;
  const outlivesEvidence = await room.executeAction({
    ...base,
    actionRequestId: 9114,
    notAfter: availabilityCutoff + 1_000,
    availabilityNotAfter: availabilityCutoff,
  });

  assert.equal(missing.code, "AVAILABILITY_DEADLINE_INVALID");
  assert.equal(unsafe.code, "AVAILABILITY_DEADLINE_INVALID");
  assert.equal(expired.code, "AVAILABILITY_EXPIRED");
  assert.equal(outlivesEvidence.code, "ACTION_AFTER_AVAILABILITY");
  assert.equal(room.actionState.bidClicks, 0);
});

test("availability deadline identity is part of action idempotency", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
  });
  const now = Date.now();
  const action = {
    operation: "BID",
    actionRequestId: 9115,
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "wrong-league",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
    notAfter: now + 4_000,
    availabilityNotAfter: now + 5_000,
  };

  const first = await room.executeAction(action);
  const changedEvidence = await room.executeAction({ ...action, availabilityNotAfter: now + 6_000 });

  assert.equal(first.code, "WRONG_LEAGUE");
  assert.equal(changedEvidence.code, "ACTION_REQUEST_CONFLICT");
  assert.equal(room.actionState.bidClicks, 0);
});

test("every safety-relevant action field participates in request idempotency", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
  });
  const now = Date.now();
  const base = {
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    position: "WR",
    fillsMandatoryStarter: false,
    candidates: [{ playerId: 12345, playerName: "Exact Player", position: "WR", fillsMandatoryStarter: false }],
    expectedLeagueId: "wrong-league",
    expectedTeamId: 5,
    expectedSeason: 2026,
    expectedTabId: 41,
    expectedPick: 47,
    requireOnClock: true,
    availabilityDigest: `sha256:${"a".repeat(64)}`,
    availabilityDecisionDigest: `sha256:${"b".repeat(64)}`,
    notAfter: now + 4_000,
    availabilityNotAfter: now + 5_000,
  };
  const mutations = [
    ["tab", (action) => ({ ...action, expectedTabId: 42 })],
    ["availability artifact", (action) => ({ ...action, availabilityDigest: `sha256:${"c".repeat(64)}` })],
    ["availability decision", (action) => ({ ...action, availabilityDecisionDigest: `sha256:${"d".repeat(64)}` })],
    ["candidate position", (action) => ({ ...action, candidates: [{ ...action.candidates[0], position: "RB" }] })],
    ["mandatory starter flag", (action) => ({ ...action, candidates: [{ ...action.candidates[0], fillsMandatoryStarter: true }] })],
  ];
  let requestId = 9200;
  for (const [label, mutate] of mutations) {
    requestId += 1;
    const original = await room.executeAction({ ...base, actionRequestId: requestId });
    const conflict = await room.executeAction({ ...mutate(base), actionRequestId: requestId });
    assert.equal(original.code, "WRONG_LEAGUE", label);
    assert.equal(conflict.code, "ACTION_REQUEST_CONFLICT", label);
  }
  assert.equal(room.actionState.selectClicks, 0);
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

test("one exact incremental bid remains authoritative when ESPN also renders one custom form", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    customBidForm: true,
  });
  assert.equal(room.context.auctionTransactionReady, true);
  assert.equal(room.context.auctionOfferReady, true);
  assert.equal(room.context.playerPoolReady, false, "a virtualized player grid is not bid authority");
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
  assert.equal(room.actionState.customSurfaceReads, 0, "the unique exact +$1 surface wins without touching the custom form");
});

test("command-center revocation during a handed-off custom bid prevents every ESPN click", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    bidControlVisible: false,
    customBidForm: true,
  });
  const pending = room.executeAction({
    operation: "BID",
    authorizationEpoch: 0,
    playerId: 12345,
    playerName: "Exact Player",
    expectedLeagueId: "701",
    expectedCurrentBid: 27,
    amount: 28,
    maxApprovedBid: 35,
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(room.revokeActions(1), true);
  const result = await pending;
  assert.equal(result.code, "ACTION_AUTHORIZATION_REVOKED");
  assert.equal(room.actionState.bidClicks, 0);
  assert.equal(room.actionState.modalClicks, 0);
});

test("every workspace transition revokes delayed select, bid, and nomination before any ESPN click", async () => {
  const transitions = ["activateProfile", "startAnotherLeague", "previewDraftFormat"];
  const operations = ["SELECT", "BID", "NOMINATE"];
  for (const transition of transitions) {
    for (const operation of operations) {
      let verifyStarted;
      let releaseVerification;
      const started = new Promise((resolve) => { verifyStarted = resolve; });
      const verification = new Promise((resolve) => { releaseVerification = resolve; });
      const common = {
        authorizationVerifier: () => {
          verifyStarted();
          return verification;
        },
      };
      const room = operation === "SELECT"
        ? await loadDraftContext({
            ...common,
            text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
            clockTeam: "Us",
            ownTeam: "Us",
            selectPlayer: { id: 12345, name: "Exact Player" },
          })
        : operation === "BID"
          ? await loadDraftContext({
              ...common,
              text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
              ownAuctionTeam: "Us",
              maximumOffer: 150,
              nominatedPlayer: "Exact Player",
              bidAmount: 28,
            })
          : await loadDraftContext({
              ...common,
              text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
              ownAuctionTeam: "Us",
              ownAuctionSelecting: true,
              maximumOffer: 150,
              selectPlayer: { id: 12345, name: "Exact Player" },
              nominationConfirmationDelayMs: 0,
            });
      const action = operation === "SELECT"
        ? {
            operation,
            playerId: 12345,
            playerName: "Exact Player",
            candidates: [{ playerId: 12345, playerName: "Exact Player" }],
            expectedLeagueId: "701",
            expectedPick: 47,
          }
        : operation === "BID"
          ? {
              operation,
              playerId: 12345,
              playerName: "Exact Player",
              expectedLeagueId: "701",
              expectedCurrentBid: 27,
              amount: 28,
              maxApprovedBid: 35,
            }
          : {
              operation,
              playerId: 12345,
              playerName: "Exact Player",
              candidates: [{ playerId: 12345, playerName: "Exact Player" }],
              expectedLeagueId: "701",
              amount: 1,
              maxApprovedBid: 1,
              nominationIntent: "TARGET",
            };
      const pending = room.executeAction(action);
      await started;
      assert.equal(room.revokeActions(1), true, `${transition}/${operation} raises the content epoch`);
      releaseVerification({ ok: false, code: "ACTION_AUTHORIZATION_REVOKED" });
      const result = await pending;
      assert.equal(result.code, "ACTION_AUTHORIZATION_REVOKED", `${transition}/${operation} fails closed`);
      assert.equal(room.actionState.selectClicks, 0, `${transition}/${operation} does not select a player row`);
      assert.equal(room.actionState.bidClicks, 0, `${transition}/${operation} does not place a bid`);
      assert.equal(room.actionState.nominationClicks, 0, `${transition}/${operation} does not nominate`);
      assert.equal(room.actionState.modalClicks, 0, `${transition}/${operation} does not confirm`);
    }
  }
});

test("an invalidated extension context fails the final writer-lease check before every operation", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
    ownAuctionTeam: "Us",
    maximumOffer: 150,
    nominatedPlayer: "Exact Player",
    bidAmount: 28,
    authorizationVerifier: async () => { throw new Error("Extension context invalidated"); },
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
  assert.equal(result.code, "WRITER_LEASE_UNVERIFIED");
  assert.equal(room.actionState.bidClicks, 0);
  assert.equal(room.actionState.modalClicks, 0);
});

test("a stale server-instance lease blocks select, bid, and nomination before their preliminary click", async () => {
  for (const operation of ["SELECT", "BID", "NOMINATE"]) {
    const common = {
      authorizationVerifier: async () => ({ ok: false, code: "DRAFT_ACTION_SERVER_LEASE_STALE" }),
    };
    const room = operation === "SELECT"
      ? await loadDraftContext({
          ...common,
          text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
          clockTeam: "Us",
          ownTeam: "Us",
          selectPlayer: { id: 12345, name: "Exact Player" },
        })
      : operation === "BID"
        ? await loadDraftContext({
            ...common,
            text: "PK 11 OF 128\n00:20\nCurrent Bid: $27",
            ownAuctionTeam: "Us",
            maximumOffer: 150,
            nominatedPlayer: "Exact Player",
            bidAmount: 28,
          })
        : await loadDraftContext({
            ...common,
            text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
            ownAuctionTeam: "Us",
            ownAuctionSelecting: true,
            maximumOffer: 150,
            selectPlayer: { id: 12345, name: "Exact Player" },
            nominationConfirmationDelayMs: 0,
          });
    const action = operation === "SELECT"
      ? { operation, playerId: 12345, playerName: "Exact Player", candidates: [{ playerId: 12345, playerName: "Exact Player" }], expectedLeagueId: "701", expectedPick: 47 }
      : operation === "BID"
        ? { operation, playerId: 12345, playerName: "Exact Player", expectedLeagueId: "701", expectedCurrentBid: 27, amount: 28, maxApprovedBid: 35 }
        : { operation, playerId: 12345, playerName: "Exact Player", candidates: [{ playerId: 12345, playerName: "Exact Player" }], expectedLeagueId: "701", amount: 1, maxApprovedBid: 1, nominationIntent: "TARGET" };
    const result = await room.executeAction(action);
    assert.equal(result.code, "DRAFT_ACTION_SERVER_LEASE_STALE", operation);
    assert.equal(room.actionState.selectClicks, 0, operation);
    assert.equal(room.actionState.bidClicks, 0, operation);
    assert.equal(room.actionState.nominationClicks, 0, operation);
    assert.equal(room.actionState.modalClicks, 0, operation);
  }
});

test("a server restart after the reversible snake row click blocks the final Draft click", async () => {
  let verificationCount = 0;
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    separateDraftConfirmation: true,
    authorizationVerifier: async () => (++verificationCount === 1
      ? { ok: true, code: "ACTION_AUTHORIZATION_VERIFIED" }
      : { ok: false, code: "DRAFT_ACTION_SERVER_LEASE_STALE" }),
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });
  assert.equal(result.code, "DRAFT_ACTION_SERVER_LEASE_STALE");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.draftSubmitClicks, 0);
  assert.equal(room.actionState.modalClicks, 0);
});

test("the server dispatch lease is rechecked immediately before modal confirmation", async () => {
  let verificationCount = 0;
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    modalConfirmations: [{ playerId: 12345, playerName: "Exact Player", buttonText: "Confirm" }],
    authorizationVerifier: async () => (++verificationCount < 2
      ? { ok: true, code: "ACTION_AUTHORIZATION_VERIFIED" }
      : { ok: false, code: "DRAFT_ACTION_SERVER_LEASE_STALE" }),
  });
  const result = await room.executeAction({
    operation: "SELECT",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });
  assert.equal(result.code, "DRAFT_ACTION_SERVER_LEASE_STALE");
  assert.equal(verificationCount, 2);
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.modalClicks, 0);
});

test("command-center revocation after ESPN player selection prevents the final snake submit", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    separateDraftConfirmation: true,
    draftConfirmationDelayMs: 100,
  });
  const pending = room.executeAction({
    operation: "SELECT",
    authorizationEpoch: 0,
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });
  for (let index = 0; index < 50 && room.actionState.selectClicks < 1; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(room.actionState.selectClicks, 1, "ESPN received only the reversible row-selection click");
  assert.equal(room.revokeActions(1), true);
  const result = await pending;
  assert.equal(result.code, "ACTION_AUTHORIZATION_REVOKED");
  assert.equal(result.clicked, true, "the result discloses that a preliminary click already occurred");
  assert.equal(result.retryable, false);
  assert.equal(room.actionState.draftSubmitClicks, 0, "the irreversible Draft button is never clicked");
});

test("command-center revocation after the first snake submit prevents modal confirmation", async () => {
  const room = await loadDraftContext({
    text: "RND 5 OF 16\n00:20\nON THE CLOCK: PICK 47",
    clockTeam: "Us",
    ownTeam: "Us",
    selectPlayer: { id: 12345, name: "Exact Player" },
    modalConfirmations: [{ playerId: 12345, playerName: "Exact Player", buttonText: "Confirm" }],
  });
  const pending = room.executeAction({
    operation: "SELECT",
    authorizationEpoch: 0,
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    expectedLeagueId: "701",
    expectedPick: 47,
  });
  for (let index = 0; index < 50 && room.actionState.selectClicks < 1; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.revokeActions(1), true);
  const result = await pending;
  assert.equal(result.code, "ACTION_AUTHORIZATION_REVOKED");
  assert.equal(result.clicked, true);
  assert.equal(result.retryable, false);
  assert.equal(room.actionState.modalClicks, 0, "no confirmation click follows revocation");
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

test("nomination actuator never uses a same-name row with a different ESPN player id", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 0,
    maximumOffer: 150,
    selectPlayer: { id: 99999, name: "Shared Player Name" },
  });
  const result = await room.executeAction({
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Shared Player Name",
    candidates: [{ playerId: 12345, playerName: "Shared Player Name" }],
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

test("salary-cap nomination remains executable when the operator leaves ESPN sound on", async () => {
  const room = await loadDraftContext({
    text: "PK 11 OF 128\n00:20\nYour turn to nominate a player!\nSelect a player below to nominate",
    ownAuctionTeam: "Us",
    ownAuctionSelecting: true,
    nominationConfirmationDelayMs: 0,
    maximumOffer: 150,
    selectPlayer: { id: 12345, name: "Exact Player" },
    soundMuted: false,
  });
  const result = await room.executeAction({
    operation: "NOMINATE",
    playerId: 12345,
    playerName: "Exact Player",
    candidates: [{ playerId: 12345, playerName: "Exact Player" }],
    amount: 1,
    nominationIntent: "TARGET",
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
  });

  assert.equal(room.context.soundMuted, false);
  assert.equal(result.code, "NOMINATION_CONFIRMED");
  assert.equal(room.actionState.selectClicks, 1);
  assert.equal(room.actionState.nominationClicks, 1);
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
