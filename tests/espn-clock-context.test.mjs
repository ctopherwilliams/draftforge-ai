import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const contentUrl = new URL("../extension/espn-content.js", import.meta.url);

async function loadDraftContext({ text, clockTeam, ownTeam, ownAuctionTeam, ownAuctionSelecting = false, maximumOffer, waitingTeamId, availableIds = [], href = "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5" }) {
  const source = await readFile(contentUrl, "utf8");
  const runtimeStart = source.indexOf("chrome.runtime.onMessage.addListener");
  assert.ok(runtimeStart > 0, "content script should expose a Chrome message listener");

  const clockNode = clockTeam ? {
    textContent: "On the Clock: Pick 47",
    closest: (selector) => selector === ".current-pick-module-container"
      ? { querySelector: (childSelector) => childSelector === ".team-name" ? { textContent: clockTeam } : null }
      : null,
  } : null;
  const ownAuctionParent = {};
  const ownAuctionNode = ownAuctionTeam ? { closest: (selector) => selector === ".auction-pick-component" ? ownAuctionParent : null } : null;
  const selectingAuctionNode = ownAuctionSelecting ? { closest: (selector) => selector === ".auction-pick-component" ? ownAuctionParent : null } : null;
  const document = {
    body: { innerText: text },
    querySelector(selector) {
      if (selector === ".on-the-clock") return clockNode;
      if (selector === ".pick-component.own-pick .team-name") return ownTeam ? { textContent: ownTeam } : null;
      if (selector === ".auction-pick-component--own .team-name") return ownAuctionTeam ? { textContent: `5. ${ownAuctionTeam}` } : null;
      if (selector === ".auction-pick-component--own") return ownAuctionNode;
      if (selector === ".auction-pick-component--selecting") return selectingAuctionNode;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "a[href*='teamId=']") {
        return waitingTeamId ? [{ textContent: "Edit Team Settings", getAttribute: () => `/football/team?leagueId=701&teamId=${waitingTeamId}` }] : [];
      }
      if (selector === "[role='grid'] [role='row'] img[src*='/players/full/']") {
        return availableIds.map((id) => ({ getAttribute: () => `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png` }));
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
  const sandbox = { URL, document, window: { location: { href } } };
  vm.runInNewContext(`${source.slice(0, runtimeStart)}\nglobalThis.readDraftContext = getContext; globalThis.hasSafeWindow = hasSafeActionWindow; globalThis.nominationStarted = nominationHasStarted; globalThis.updateSales = updateAuctionSales;`, sandbox);
  return { context: sandbox.readDraftContext(), hasSafeWindow: sandbox.hasSafeWindow, nominationStarted: sandbox.nominationStarted, updateSales: sandbox.updateSales };
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
