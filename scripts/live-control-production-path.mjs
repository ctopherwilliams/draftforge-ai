#!/usr/bin/env node

import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

import { buildDraftDayBridgeResult, prepareDraftDayBridge } from "../app/lib/draft-day-bridge.ts";
import {
  createDraftAuditPublisher,
  draftAuditPublicationDigest,
} from "../app/lib/draft-audit-publisher.ts";
import {
  appendLiveControlEvent,
  createLiveControlState,
} from "../app/lib/live-control.ts";
import * as draftDayRoute from "../app/api/draft-day/route.ts";
import {
  draftAuditCheckpointDigest,
  loadPersistedDraftAuditCheckpoint,
  persistDraftAuditCheckpoint,
} from "../app/lib/draft-audit-checkpoint-store.ts";
import { isDraftAuditSnapshot } from "../app/lib/draft-audit.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ORIGIN = "http://127.0.0.1:3000";
const APP_TAB_ID = 9101;
const ESPN_TAB_ID = 9102;
const LEAGUE_ID = "qa-auction-production-path";
const SNAKE_LEAGUE_ID = "qa-snake-observer-production-path";
const TEAM_ID = 7;
const SEASON = 2026;
const COMMAND_CENTER_SESSION_ID = "qa-command-center-20260828";
const LIVE_CONTROL_SESSION_ID = "qa-live-control-20260828";
const AVAILABILITY_DIGEST = `sha256:${"a".repeat(64)}`;
const AVAILABILITY_DECISION_DIGEST = `sha256:${"b".repeat(64)}`;
const SOURCE_SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const REQUEST_TIMEOUT_MS = 500;
const ACTION_SAMPLES_PER_OPERATION = 20;
const MIB = 1024 * 1024;
export const PRODUCTION_PATH_MEMORY_BUDGETS = Object.freeze({
  peakRssMb: 300,
});
const CHECKPOINT_PRESEED_MIN_BYTES = Math.ceil(1.8 * 1024 * 1024);
const CHECKPOINT_MAX_BYTES = 2 * 1024 * 1024;
const CHECKPOINT_ENTRY_TARGET_BYTES = 500 * 1024;
const CHECKPOINT_ENTRY_MAX_BYTES = 508 * 1024;
const CRITICAL_AUDIT_CHURN_INTERVAL_MS = 75;
const CRITICAL_AUDIT_CHURN_WRITES = 12;
let backgroundImportSequence = 0;

export function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return Number.POSITIVE_INFINITY;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * quantile) - 1))];
}

export function evaluateProductionPathMemory({ baselineRss, peakRss }) {
  const validMeasurements = Number.isFinite(baselineRss)
    && Number.isFinite(peakRss)
    && baselineRss > 0
    && peakRss >= baselineRss;
  const baselineRssMb = Number(baselineRss || 0) / MIB;
  const peakRssMb = Number(peakRss || 0) / MIB;
  return {
    passed: validMeasurements && peakRssMb <= PRODUCTION_PATH_MEMORY_BUDGETS.peakRssMb,
    checks: {
      measurements: validMeasurements,
      peakRss: peakRssMb <= PRODUCTION_PATH_MEMORY_BUDGETS.peakRssMb,
    },
    baselineRssMb,
    peakRssMb,
    rssGrowthMb: Math.max(0, peakRssMb - baselineRssMb),
  };
}

function summarize(values) {
  return {
    count: values.length,
    p50: percentile(values, .5),
    p95: percentile(values, .95),
    p99: percentile(values, .99),
    max: values.length ? Math.max(...values) : null,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function playersFixture() {
  const positions = ["WR", "RB", "QB", "TE", "WR", "RB", "K", "DST"];
  return Array.from({ length: 180 }, (_, index) => ({
    id: 10_001 + index,
    name: index === 0 ? "Production Path Receiver" : `Production Player ${String(index + 1).padStart(3, "0")}`,
    team: `T${String((index % 32) + 1).padStart(2, "0")}`,
    pos: positions[index % positions.length],
    rank: index + 1,
    adp: index + 1 + (index % 3) * .1,
    auction: Math.max(1, 62 - Math.floor(index / 3)),
    projected: Math.max(40, 380 - index),
  }));
}

function leagueFixture(draftType = "AUCTION", leagueId = LEAGUE_ID) {
  return {
    id: leagueId,
    name: draftType === "SNAKE" ? "Production Path Snake QA" : "Production Path Salary Cap QA",
    season: SEASON,
    size: 10,
    teamId: TEAM_ID,
    draftType,
    secondsPerPick: 30,
    rosterSize: 16,
    auctionBudget: 200,
    lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "23": 1 },
    positionLimits: { "1": 4, "2": 8, "3": 8, "4": 3, "16": 1, "17": 1 },
    scoringLabel: "PPR",
    scoringRules: 45,
    keeperCount: 0,
    pickOrder: Array.from({ length: 10 }, (_, index) => index + 1),
    teams: Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      name: index + 1 === TEAM_ID ? "QA Team" : `Opponent ${index + 1}`,
      abbrev: index + 1 === TEAM_ID ? "QA" : `O${index + 1}`,
    })),
  };
}

function sourcesFixture(players, updatedAt) {
  return [
    ["ffc", "market", .15],
    ["mfl", "market", .15],
    ["tradyr", "composite", .20],
    ["gng", "model", .20],
  ].map(([id, kind, weight], sourceIndex) => ({
    id,
    name: String(id).toUpperCase(),
    kind,
    weight,
    status: "ok",
    updatedAt,
    attribution: String(id),
    coverage: { players: players.length, corePositions: ["QB", "RB", "TE", "WR"] },
    players: players.map((player, index) => ({
      name: player.name,
      team: player.team,
      pos: player.pos,
      rank: index + 1 + ((sourceIndex + index) % 5 === 0 ? 1 : 0),
      adp: index + 1 + sourceIndex * .1,
      auction: Math.max(1, player.auction - (sourceIndex % 2)),
      projectedPpg: Math.max(1, player.projected / 17),
    })),
  }));
}

function visibleNode(extra = {}) {
  const node = {
    disabled: false,
    getClientRects: () => [{ width: 1, height: 1 }],
    getAttribute: () => null,
  };
  Object.defineProperties(node, Object.getOwnPropertyDescriptors(extra));
  return node;
}

async function createFakeAuctionContent() {
  const source = await readFile(path.join(projectRoot, "extension", "espn-content.js"), "utf8");
  const runtimeStart = source.indexOf("chrome.runtime.onMessage.addListener");
  if (runtimeStart <= 0) throw new Error("CONTENT_RUNTIME_BOUNDARY_MISSING");

  const state = {
    currentBid: 8,
    leading: false,
    bidClicks: 0,
    clickedAmounts: [],
    contentMessages: [],
  };
  const target = { id: 10_001, name: "Production Path Receiver" };
  const clock = visibleNode({ textContent: "00:18" });
  const identity = visibleNode({
    getAttribute(name) {
      return ["data-player-id", "data-playerid"].includes(name) ? String(target.id) : null;
    },
  });
  const playerName = visibleNode({ textContent: target.name });
  const leader = visibleNode({
    get textContent() {
      return `High bidder: ${state.leading ? "QA Team" : "Opponent 3"}`;
    },
  });
  const bidControl = visibleNode({
    get textContent() { return `Offer $${state.currentBid + 1}`; },
    click() {
      const amount = state.currentBid + 1;
      state.bidClicks += 1;
      state.clickedAmounts.push(amount);
      state.currentBid = amount;
      state.leading = true;
    },
  });
  const selected = visibleNode({
    parentElement: null,
    get textContent() { return target.name; },
    querySelectorAll(selector) {
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") return [playerName];
      if (selector === "[data-player-id], [data-playerid]") return [identity];
      if (selector === "img[src*='/players/full/']") return [];
      return [];
    },
  });
  const draftClockSelector = [
    "[data-testid='draft-timer']",
    "[data-testid*='draft-clock' i]",
    ".draft-timer",
    ".auction-clock",
    "[class*='draft-clock' i]",
    "[class*='countdown' i]",
  ].join(", ");
  const leaderSelector = "[data-testid*='high-bidder' i], [class*='high-bidder' i], [aria-label*='high bidder' i]";
  const transaction = visibleNode({
    parentElement: null,
    get textContent() {
      return `Salary Cap\nPK 5 OF 160\n00:18\nCurrent Bid: $${state.currentBid}\nManual Bid (max $185)`;
    },
    querySelectorAll(selector) {
      if (selector === "[data-testid='player-selected']") return [selected];
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") return [playerName];
      if (selector === draftClockSelector) return [clock];
      if (selector === leaderSelector) return [leader];
      if (selector === ".auction-pick-component--selecting") return [];
      if (selector === ".bidding-form__custom") return [];
      if (selector === "button, [role='button']") return [bidControl];
      return [];
    },
  });
  selected.parentElement = transaction;
  playerName.parentElement = selected;

  const ownAuctionParent = visibleNode({ parentElement: transaction, querySelectorAll: () => [] });
  const ownAuctionNode = visibleNode({
    parentElement: ownAuctionParent,
    closest(selector) { return selector === ".auction-pick-component" ? ownAuctionParent : null; },
  });
  const autopickInput = visibleNode({ checked: false });
  const autopickControl = visibleNode({});
  const autopickContainer = visibleNode({
    querySelector(selector) {
      if (selector === "input[type='checkbox']") return autopickInput;
      if (selector === "label") return autopickControl;
      return null;
    },
  });
  const volumeUse = {
    getAttribute(name) { return ["href", "xlink:href"].includes(name) ? "#icon__controls__volume_mute" : null; },
  };
  const budgetRows = Array.from({ length: 10 }, (_, index) => ({
    querySelectorAll(selector) {
      if (selector !== "[role='gridcell']") return [];
      const name = index + 1 === TEAM_ID ? "QA Team" : `Opponent ${index + 1}`;
      return [{ textContent: name }, { textContent: "$200" }, { textContent: "$185" }];
    },
  }));
  const body = {
    get innerText() { return transaction.textContent; },
  };
  transaction.parentElement = body;

  const document = {
    body,
    querySelector(selector) {
      if (selector === ".pick-queue__header .autoPick-toggle") return autopickContainer;
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") return playerName;
      if (selector === ".auction-pick-component--own") return ownAuctionNode;
      if (selector === ".auction-pick-component--selecting") return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-testid='player-selected']") return [selected];
      if (selector === ".auction-pick-component--selecting") return [];
      if (selector === ".auction-pick-component--own") return [ownAuctionNode];
      if (selector === ".auction-pick-component--own .team-name") return [visibleNode({ textContent: "7. QA Team" })];
      if (selector === leaderSelector) return [leader];
      if (selector === ".bidding-form__custom") return [];
      if (selector === ".draft-header .icon-wrapper use") return [volumeUse];
      if (selector === ".budgets-table [role='row']") return budgetRows;
      if (selector === "button, [role='button']") return [bidControl];
      if (selector === "[role='grid'] [role='row']") return [];
      if (selector === "[role='grid'] [role='row'] img[src*='/players/full/']") return [];
      if (selector === "[role='dialog'], [aria-modal='true'], [class*='modal' i]") return [];
      if (selector === "a[href*='teamId=']") return [];
      if (selector === ".pick-message__container") return [];
      if (selector === "[data-testid*='roster' i], [class*='roster' i]") return [];
      if (selector === "select" || selector === "input") return [];
      if (selector.startsWith("button.Button--draft")) return [];
      if (selector === "button[data-player-id], button[data-playerid], button") return [bidControl];
      return [];
    },
  };

  class TestInputElement {}
  const sandbox = {
    URL,
    crypto: globalThis.crypto,
    document,
    window: { location: { href: `https://fantasy.espn.com/football/draft?leagueId=${LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON}` } },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 1),
    HTMLInputElement: TestInputElement,
    CSS: { escape: (value) => String(value) },
    Event: class Event {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    chrome: {
      runtime: {
        id: "qa-extension",
        sendMessage(message) {
          state.contentMessages.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
  vm.runInNewContext(`${source.slice(0, runtimeStart)}
globalThis.produceContextForQa = () => {
  domRevision += 1;
  const context = getTrackedContext(domRevision);
  contextProducerRevision += 1;
  latestProducerContext = {
    ...context,
    producerSessionId: contextProducerSessionId,
    producerRevision: contextProducerRevision,
    contextCapturedAt: new Date().toISOString(),
  };
  return context;
};
globalThis.observeContextForQa = () => getObservedContext();
globalThis.hasCachedProducerContextForQa = () => latestProducerContext?.url === window.location.href;
globalThis.executeActionForQa = (action) => executeAction(action);
globalThis.trackingFingerprintForQa = () => JSON.stringify({
  auctionSales,
  trackedAuctionOffer,
  pendingAuctionSettlement,
  auctionSettlementAmbiguous,
  trackedOwnNomination,
  trackedAuctionSaleSequence,
  lastAcceptedAuctionTrackingRevision,
  trackedDraftClock,
});
globalThis.executionMetricsForQa = () => ({
  inFlight: inFlightActionResults.size,
  completed: completedActionResults.size,
  requestSignatures: actionRequestSignatures.size,
});`, sandbox, { filename: "extension/espn-content.js#production-path-qa" });

  return {
    state,
    target,
    setBid(amount) {
      state.currentBid = amount;
      state.leading = false;
    },
    produce: () => sandbox.produceContextForQa(),
    observe: () => sandbox.observeContextForQa(),
    hasCachedProducerContext: () => sandbox.hasCachedProducerContextForQa(),
    execute: (action) => sandbox.executeActionForQa(action),
    trackingFingerprint: () => sandbox.trackingFingerprintForQa(),
    executionMetrics: () => sandbox.executionMetricsForQa(),
  };
}

async function createFakeActionContent({ mode, players, leagueId = LEAGUE_ID, selectionAcknowledgementDelayMs = 25 }) {
  const source = await readFile(path.join(projectRoot, "extension", "espn-content.js"), "utf8");
  const runtimeStart = source.indexOf("chrome.runtime.onMessage.addListener");
  if (runtimeStart <= 0) throw new Error("CONTENT_RUNTIME_BOUNDARY_MISSING");
  if (!["SELECT", "NOMINATE", "BID_INCREMENTAL", "BID_CUSTOM"].includes(mode)) {
    throw new Error(`UNSUPPORTED_ACTION_MODE_${mode}`);
  }

  const pendingTimers = new Set();
  const schedule = (callback, delayMs) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      callback();
    }, delayMs);
    pendingTimers.add(timer);
    return timer;
  };
  const cancelPendingTimers = () => {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
  };
  const state = {
    mode,
    target: players[0],
    currentPick: 1,
    currentBid: 8,
    openingBid: 1,
    leading: false,
    selected: false,
    nominated: mode.startsWith("BID_"),
    roster: [],
    ownRemaining: 200,
    ownMaxOffer: 185,
    bidOutcome: "BID_CONFIRMED",
    preliminaryClicks: 0,
    finalClicks: 0,
    clickedAmounts: [],
    acknowledgementTransitions: 0,
    contentMessages: [],
  };

  class TestInputElement {
    constructor() {
      this._value = "";
      this.disabled = false;
    }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    dispatchEvent() {}
    getClientRects() { return [{ width: 1, height: 1 }]; }
  }

  const autopickInput = visibleNode({ checked: false });
  const autopickControl = visibleNode({});
  const autopickContainer = visibleNode({
    querySelector(selector) {
      if (selector === "input[type='checkbox']") return autopickInput;
      if (selector === "label") return autopickControl;
      return null;
    },
  });
  const volumeUse = {
    getAttribute(name) { return ["href", "xlink:href"].includes(name) ? "#icon__controls__volume_mute" : null; },
  };
  const clockNode = visibleNode({
    get textContent() { return "00:18"; },
  });
  const teamNameNode = visibleNode({ textContent: "QA Team" });
  const snakeClock = visibleNode({
    get textContent() { return `On the Clock: Pick ${state.currentPick} 00:18`; },
    closest(selector) {
      if (selector === ".current-pick-module-container") {
        return { querySelector: (childSelector) => childSelector === ".team-name" ? teamNameNode : null };
      }
      if (selector === ".own-pick") return {};
      return null;
    },
  });

  const playerRows = players.map((player) => {
    let row;
    const control = visibleNode({
      get textContent() { return mode === "SELECT" ? "Draft" : "Select"; },
      getAttribute(name) { return name === "data-player-id" ? String(player.id) : null; },
      closest() { return row; },
      scrollIntoView() {},
      click() {
        if (mode === "SELECT") {
          state.finalClicks += 1;
          schedule(() => {
            state.roster = [{ playerId: player.id, playerName: player.name, amount: 0 }];
            state.acknowledgementTransitions += 1;
          }, selectionAcknowledgementDelayMs);
        } else {
          state.preliminaryClicks += 1;
          state.selected = true;
          state.target = player;
        }
      },
    });
    const identity = visibleNode({
      getAttribute(name) {
        if (name === "src") return `https://a.espncdn.com/i/headshots/nfl/players/full/${player.id}.png`;
        return name === "data-player-id" ? String(player.id) : null;
      },
    });
    row = visibleNode({
      textContent: player.name,
      querySelector(selector) {
        if (/playername|player-name/i.test(selector)) return visibleNode({ textContent: player.name });
        if (selector.includes("img[src*='/players/full/']")) return identity;
        return null;
      },
      querySelectorAll(selector) {
        if (selector.includes("button")) return [control];
        return [];
      },
    });
    return { player, row, control, identity };
  });

  const selectedIdentity = visibleNode({
    getAttribute(name) {
      return ["data-player-id", "data-playerid"].includes(name) ? String(state.target.id) : null;
    },
  });
  const selectedPlayerName = visibleNode({
    get textContent() { return state.target.name; },
  });
  const selectedPlayer = visibleNode({
    parentElement: null,
    get textContent() { return state.target.name; },
    querySelectorAll(selector) {
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") return [selectedPlayerName];
      if (selector === "[data-player-id], [data-playerid]") return [selectedIdentity];
      if (selector === "img[src*='/players/full/']") return [];
      return [];
    },
  });
  const leaderNode = visibleNode({
    get textContent() { return `High bidder: ${state.leading ? "QA Team" : "Opponent 3"}`; },
  });

  const applyBidClick = (amount) => {
    state.finalClicks += 1;
    state.clickedAmounts.push(amount);
    schedule(() => {
      state.currentBid = amount;
      state.leading = true;
      state.acknowledgementTransitions += 1;
    }, 20);
    if (state.bidOutcome === "BID_SUPERSEDED") {
      // This exact 75ms competitor update overlaps the content script's first
      // post-click acknowledgement read and must never cause a blind retry.
      schedule(() => {
        state.currentBid = amount + 1;
        state.leading = false;
        state.acknowledgementTransitions += 1;
      }, 75);
    }
  };
  const incrementalBidControl = visibleNode({
    get textContent() { return `Offer $${state.currentBid + 1}`; },
    click() { applyBidClick(state.currentBid + 1); },
  });
  const customBidInput = new TestInputElement();
  const customBidSubmit = visibleNode({
    textContent: "Place Bid",
    click() { applyBidClick(Number(customBidInput.value)); },
  });
  const customBidForm = visibleNode({
    querySelector(selector) {
      return selector === "#bid__input, input[type='number']" ? customBidInput : null;
    },
    querySelectorAll(selector) {
      if (selector === "button, [role='button']") return [customBidSubmit];
      if (selector === "#bid__input, input[type='number']") return [customBidInput];
      return [];
    },
  });
  const nominationControl = visibleNode({
    textContent: "Nominate Player",
    click() {
      state.finalClicks += 1;
      schedule(() => {
        state.nominated = true;
        state.currentBid = state.openingBid;
        state.leading = false;
        state.acknowledgementTransitions += 1;
      }, 25);
    },
  });

  const auctionClockSelector = [
    "[data-testid='draft-timer']",
    "[data-testid*='draft-clock' i]",
    ".draft-timer",
    ".auction-clock",
    "[class*='draft-clock' i]",
    "[class*='countdown' i]",
  ].join(", ");
  const leaderSelector = "[data-testid*='high-bidder' i], [class*='high-bidder' i], [aria-label*='high bidder' i]";
  const transaction = visibleNode({
    parentElement: null,
    get textContent() {
      const header = `Salary Cap\nPK ${state.currentPick} OF 160\n00:18\nManual Bid (max $${state.ownMaxOffer})`;
      if (state.nominated) return `${header}\nCurrent Bid: $${state.currentBid}`;
      return `${header}\nYour turn to nominate a player!\nSelect a player below to nominate`;
    },
    querySelectorAll(selector) {
      if (selector === auctionClockSelector) return [clockNode];
      if (selector === "[data-testid='player-selected']") return state.nominated ? [selectedPlayer] : [];
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") return state.nominated ? [selectedPlayerName] : [];
      if (selector === leaderSelector) return state.nominated ? [leaderNode] : [];
      if (selector === ".auction-pick-component--selecting") return !state.nominated && mode === "NOMINATE" ? [selectingAuctionNode] : [];
      if (selector === ".bidding-form__custom") return state.nominated && mode === "BID_CUSTOM" ? [customBidForm] : [];
      if (selector === "button, [role='button']") {
        if (!state.nominated) return state.selected ? [nominationControl] : [];
        if (mode === "BID_CUSTOM") return [customBidSubmit];
        return [incrementalBidControl];
      }
      return [];
    },
  });
  selectedPlayer.parentElement = transaction;
  selectedPlayerName.parentElement = selectedPlayer;
  const ownAuctionNode = visibleNode({
    parentElement: transaction,
    closest(selector) { return selector === ".auction-pick-component" ? transaction : null; },
  });
  const selectingAuctionNode = visibleNode({
    parentElement: transaction,
    closest(selector) { return selector === ".auction-pick-component" ? transaction : null; },
  });

  const placeholderRosterRow = {
    textContent: "Empty",
    querySelector: () => null,
    querySelectorAll: () => [],
    getClientRects: () => [{ width: 1, height: 1 }],
  };
  const rosterRow = (entry) => ({
    textContent: entry.playerName,
    getClientRects: () => [{ width: 1, height: 1 }],
    querySelector(selector) {
      if (selector.includes("[data-player-id]")) {
        return {
          getAttribute(name) {
            if (name === "data-player-id") return String(entry.playerId);
            if (name === "src") return `https://a.espncdn.com/i/headshots/nfl/players/full/${entry.playerId}.png`;
            return null;
          },
        };
      }
      if (/playername|player-name/i.test(selector)) return { textContent: entry.playerName };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[title]") return [];
      if (selector === "td") return [{ textContent: entry.amount > 0 ? `$${entry.amount}` : "" }];
      return [];
    },
  });
  const rosterRoot = visibleNode({
    contains: () => false,
    getAttribute(name) {
      if (["data-team-id", "data-fantasy-team-id"].includes(name)) return String(TEAM_ID);
      if (name === "class") return "team-roster";
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "tr") return [placeholderRosterRow, ...state.roster.map(rosterRow)];
      if (selector === "a[href*='teamId=']") return [];
      if (selector === ".team-name, [data-testid*='team-name' i], [class*='team-name' i]") return [teamNameNode];
      return [];
    },
  });

  const budgetRows = Array.from({ length: 10 }, (_, index) => ({
    querySelectorAll(selector) {
      if (selector !== "[role='gridcell']") return [];
      const own = index + 1 === TEAM_ID;
      return [
        { textContent: own ? "QA Team" : `Opponent ${index + 1}` },
        { textContent: `$${own ? state.ownRemaining : 200}` },
        { textContent: `$${own ? state.ownMaxOffer : 185}` },
      ];
    },
  }));
  const body = {
    get innerText() {
      if (mode === "SELECT") return `RND 1 OF 16\n00:18\nON THE CLOCK: PICK ${state.currentPick}`;
      return transaction.textContent;
    },
  };
  transaction.parentElement = body;
  const allPlayerControls = playerRows.map((entry) => entry.control);
  const document = {
    body,
    querySelector(selector) {
      if (selector === ".pick-queue__header .autoPick-toggle") return autopickContainer;
      if (selector === ".on-the-clock") return mode === "SELECT" ? snakeClock : null;
      if (selector === ".pick-component.own-pick .team-name") return mode === "SELECT" ? teamNameNode : null;
      if (selector === ".auction-pick-component--own") return mode === "SELECT" ? null : ownAuctionNode;
      if (selector === ".auction-pick-component--selecting") return mode === "NOMINATE" && !state.nominated ? selectingAuctionNode : null;
      if (selector === "[data-testid='player-selected'] .playerinfo__playername") return state.nominated ? selectedPlayerName : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[role='grid'] [role='row']") return playerRows.map((entry) => entry.row);
      if (selector === "[role='grid'] [role='row'] img[src*='/players/full/']") return playerRows.map((entry) => entry.identity);
      if (selector === "[data-testid='player-selected']") return state.nominated ? [selectedPlayer] : [];
      if (selector === ".auction-pick-component--selecting") return mode === "NOMINATE" && !state.nominated ? [selectingAuctionNode] : [];
      if (selector === ".auction-pick-component--own") return mode === "SELECT" ? [] : [ownAuctionNode];
      if (selector === ".auction-pick-component--own .team-name") return mode === "SELECT" ? [] : [visibleNode({ textContent: "7. QA Team" })];
      if (selector === leaderSelector) return state.nominated ? [leaderNode] : [];
      if (selector === ".bidding-form__custom") return state.nominated && mode === "BID_CUSTOM" ? [customBidForm] : [];
      if (selector === ".draft-header .icon-wrapper use") return [volumeUse];
      if (selector === ".budgets-table [role='row']") return mode === "SELECT" ? [] : budgetRows;
      if (selector === "[data-testid*='roster' i], [class*='roster' i]") return [rosterRoot];
      if (selector === "button, [role='button']") {
        const auctionControls = mode === "SELECT"
          ? []
          : !state.nominated
            ? state.selected ? [nominationControl] : []
            : mode === "BID_CUSTOM" ? [customBidSubmit] : [incrementalBidControl];
        return [...allPlayerControls, ...auctionControls];
      }
      if (selector === "button[data-player-id], button[data-playerid], button") return allPlayerControls;
      if (selector === "[role='dialog'], [aria-modal='true'], [class*='modal' i]") return [];
      if (selector === "a[href*='teamId=']" || selector === ".pick-message__container") return [];
      if (selector === "select" || selector === "input") return [];
      if (selector.startsWith("button.Button--draft")) return [];
      return [];
    },
  };

  const sandbox = {
    URL,
    crypto: globalThis.crypto,
    document,
    window: { location: { href: `https://fantasy.espn.com/football/draft?leagueId=${leagueId}&teamId=${TEAM_ID}&seasonId=${SEASON}&mode=${mode}` } },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 1),
    HTMLInputElement: TestInputElement,
    CSS: { escape: (value) => String(value) },
    Event: class Event {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    chrome: {
      runtime: {
        id: "qa-extension",
        sendMessage(message) {
          state.contentMessages.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
  vm.runInNewContext(`${source.slice(0, runtimeStart)}
globalThis.produceContextForQa = () => {
  domRevision += 1;
  const context = getTrackedContext(domRevision);
  contextProducerRevision += 1;
  latestProducerContext = {
    ...context,
    producerSessionId: contextProducerSessionId,
    producerRevision: contextProducerRevision,
    contextCapturedAt: new Date().toISOString(),
  };
  return context;
};
globalThis.observeContextForQa = () => getObservedContext();
globalThis.hasCachedProducerContextForQa = () => latestProducerContext?.url === window.location.href;
globalThis.executeActionForQa = (action) => executeAction(action);
globalThis.trackingFingerprintForQa = () => JSON.stringify({
  auctionSales,
  trackedAuctionOffer,
  pendingAuctionSettlement,
  auctionSettlementAmbiguous,
  trackedOwnNomination,
  trackedAuctionSaleSequence,
  lastAcceptedAuctionTrackingRevision,
  trackedDraftClock,
});
globalThis.executionMetricsForQa = () => ({
  inFlight: inFlightActionResults.size,
  completed: completedActionResults.size,
  requestSignatures: actionRequestSignatures.size,
});`, sandbox, { filename: `extension/espn-content.js#production-path-${mode}` });

  return {
    mode,
    state,
    beginSample({ action = null, target = null, currentBid = 8, currentPick = 1, bidOutcome = "BID_CONFIRMED" } = {}) {
      cancelPendingTimers();
      state.target = target || (action ? players.find((player) => Number(player.id) === Number(action.playerId)) : null) || players[0];
      state.currentPick = currentPick;
      state.currentBid = currentBid;
      state.openingBid = Number(action?.amount || 1);
      state.leading = false;
      state.selected = false;
      state.nominated = mode.startsWith("BID_");
      state.bidOutcome = bidOutcome;
      if (mode === "SELECT") state.roster = [];
      customBidInput.value = "";
    },
    settleWonSale({ player, amount, nextPlayer }) {
      cancelPendingTimers();
      state.roster = [{ playerId: player.id, playerName: player.name, amount }];
      state.ownRemaining -= amount;
      state.ownMaxOffer = state.ownRemaining - 14;
      state.target = nextPlayer;
      state.currentBid = 1;
      state.leading = false;
      state.nominated = true;
    },
    produce: () => sandbox.produceContextForQa(),
    observe: () => sandbox.observeContextForQa(),
    hasCachedProducerContext: () => sandbox.hasCachedProducerContextForQa(),
    execute: (action) => sandbox.executeActionForQa(action),
    trackingFingerprint: () => sandbox.trackingFingerprintForQa(),
    executionMetrics: () => sandbox.executionMetricsForQa(),
    close() { cancelPendingTimers(); },
  };
}

function dispatchRuntimeMessage(listener, message, sender, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error(`EXTENSION_MESSAGE_TIMEOUT_${message.type}`));
    }, timeoutMs);
    const sendResponse = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    try {
      listener(message, sender, sendResponse);
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

async function createBackgroundHarness(content, leagueId = LEAGUE_ID, dispatchLeaseOrigin = null) {
  const sessionStorage = new Map([
    ["draftForgeActionBindingV1", {
      leagueId,
      teamId: TEAM_ID,
      season: SEASON,
      tabId: ESPN_TAB_ID,
      appTabId: APP_TAB_ID,
      commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
    }],
    ["draftForgeWorkspaceWriterV1", APP_TAB_ID],
  ]);
  const listeners = [];
  const appMessages = [];
  const nativeFetch = globalThis.fetch;
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const tabs = [
    { id: APP_TAB_ID, url: `${APP_ORIGIN}/`, windowId: 1, lastAccessed: 2 },
    { id: ESPN_TAB_ID, url: `https://fantasy.espn.com/football/draft?leagueId=${leagueId}&teamId=${TEAM_ID}&seasonId=${SEASON}`, windowId: 2, lastAccessed: 1 },
  ];

  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1:3000/api/draft-day?view=dispatch-lease")) {
      if (dispatchLeaseOrigin) {
        return nativeFetch(url.replace("http://127.0.0.1:3000", dispatchLeaseOrigin), init);
      }
      return Response.json({ ok: true, code: "DRAFT_ACTION_SERVER_LEASE_CURRENT" });
    }
    if (url.startsWith("chrome-extension://") || url.startsWith("https://lm-api-reads.fantasy.espn.com/")) {
      return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return nativeFetch(input, init);
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "qa-production-path" }),
      getURL: (entry) => `chrome-extension://qa/${entry}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      reload: () => {},
    },
    storage: {
      session: {
        async get(key) { return { [key]: sessionStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, value); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("TAB_NOT_FOUND");
        return { ...tab };
      },
      async query(query) {
        if (query?.url === "https://fantasy.espn.com/*") return tabs.filter((tab) => tab.id === ESPN_TAB_ID).map((tab) => ({ ...tab }));
        return tabs.map((tab) => ({ ...tab }));
      },
      async sendMessage(tabId, message) {
        if (tabId === ESPN_TAB_ID && message.type === "DF_GET_CONTEXT") return content.observe();
        if (tabId === ESPN_TAB_ID && message.type === "DF_EXECUTE_ACTION") return content.execute(message.payload);
        if (tabId === ESPN_TAB_ID && message.type === "DF_CANCEL_PENDING_ACTIONS") return { ok: true };
        if (tabId === APP_TAB_ID) {
          appMessages.push(message);
          return { ok: true };
        }
        throw new Error("MESSAGE_TARGET_UNKNOWN");
      },
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
    },
    windows: {
      create: async () => ({ id: 3 }),
      update: async () => {},
    },
  };

  backgroundImportSequence += 1;
  await import(`${pathToFileURL(path.join(projectRoot, "extension", "background.js")).href}?production-path=${backgroundImportSequence}`);
  if (listeners.length !== 1) throw new Error("BACKGROUND_LISTENER_NOT_INSTALLED");
  const listener = listeners[0];
  return {
    appMessages,
    dispatchApp: (message) => dispatchRuntimeMessage(listener, message, {
      url: `${APP_ORIGIN}/`,
      tab: tabs[0],
    }),
    dispatchEspn: (message) => dispatchRuntimeMessage(listener, message, {
      url: tabs[1].url,
      tab: tabs[1],
    }),
    restore() {
      globalThis.chrome = previousChrome;
      globalThis.fetch = previousFetch;
    },
  };
}

async function readNodeBody(request, maximum = 512 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("CONTENT_LENGTH_EXCEEDED");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function startDraftDayRouteServer() {
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      const body = ["GET", "HEAD"].includes(request.method || "GET") ? undefined : await readNodeBody(request);
      const target = new URL(request.url || "/", "http://127.0.0.1");
      const handler = target.pathname === "/api/draft-day"
        ? draftDayRoute[String(request.method || "GET").toUpperCase()]
        : null;
      if (typeof handler !== "function") {
        response.writeHead(handler ? 405 : 404).end();
        return;
      }
      const webRequest = new Request(`http://127.0.0.1${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
      });
      const webResponse = await handler(webRequest);
      const responseBody = Buffer.from(await webResponse.arrayBuffer());
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
      response.end(responseBody);
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, code: "PRODUCTION_PATH_ROUTE_FAILURE" }));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PRODUCTION_PATH_BIND_FAILED");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function measuredJson(url, init = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await response.json();
  return { status: response.status, latencyMs: performance.now() - startedAt, body };
}

function liveDecision(action, room, decidedAt) {
  const intendedPlayer = {
    playerId: action.playerId,
    playerName: action.playerName,
    position: action.position,
  };
  return {
    decisionId: "qa-auction-decision-1",
    decidedAt,
    contextCapturedAt: decidedAt,
    leagueId: LEAGUE_ID,
    teamId: TEAM_ID,
    tabId: ESPN_TAB_ID,
    operation: "BID",
    sourceSnapshotId: SOURCE_SNAPSHOT_ID,
    availabilityDigest: AVAILABILITY_DIGEST,
    availabilityDecisionDigest: AVAILABILITY_DECISION_DIGEST,
    expectedCurrentBid: room.currentBid,
    intendedOffer: action.amount,
    maxApprovedBid: action.maxApprovedBid,
    intendedPlayer,
    alternatives: [],
  };
}

function emptyLeagueBoard(league) {
  const teamIds = [...new Set([
    ...league.teams.map((team) => Number(team.id)),
    Number(league.teamId),
  ].filter((teamId) => Number.isSafeInteger(teamId) && teamId > 0))]
    .sort((left, right) => left - right)
    .slice(0, league.size);
  return {
    draftType: league.draftType,
    auctionBudget: league.draftType === "AUCTION" ? league.auctionBudget : null,
    rankingBasis: "AVERAGE_PROJECTION",
    recentPicks: [],
    ourRoster: [],
    teams: teamIds.map((teamId, index) => ({
      teamSlot: index + 1,
      ours: teamId === Number(league.teamId),
      rank: index + 1,
      playerCount: 0,
      projectedPoints: 0,
      averageProjectedPoints: 0,
      spent: league.draftType === "AUCTION" ? 0 : null,
      remainingBudget: league.draftType === "AUCTION" ? league.auctionBudget : null,
      positionCounts: {},
    })),
    recommendation: null,
  };
}

function auditSnapshot({ league, capturedAt, liveControl, actionState = "Production path ready", telemetry = [] }) {
  return {
    schemaVersion: 1,
    capturedAt,
    league: {
      id: league.id,
      teamId: league.teamId,
      season: league.season,
      draftType: league.draftType,
      size: league.size,
      rosterSize: league.rosterSize,
      auctionBudget: league.auctionBudget,
      secondsPerPick: league.secondsPerPick,
      scoringLabel: league.scoringLabel,
      scoringRules: league.scoringRules,
      keeperCount: league.keeperCount,
      lineupSlotCounts: league.lineupSlotCounts,
      positionLimits: league.positionLimits,
    },
    binding: {
      tabId: ESPN_TAB_ID,
      dashboardLoadedAt: "2026-08-28T00:00:00.000Z",
      commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
      commandCenterStartedAt: "2026-08-28T00:00:00.000Z",
      authenticatedImportAt: "2026-08-28T00:00:01.000Z",
    },
    runtime: {
      capturedAt,
      extensionVersion: "qa-production-path",
      extensionSourceSha256: "c".repeat(64),
      extensionSourceFileCount: 18,
      browserTabCount: 2,
      draftForgeTabCount: 1,
      espnTabCount: 1,
      managedCleanupReady: true,
    },
    safety: {
      settingsConfirmed: true,
      liveChecklistReady: true,
      extensionConnected: true,
      inDraftRoom: true,
      soundMuted: true,
      autopickActive: false,
      autoDraft: false,
      sourceCoverage: 5,
      sourceIds: ["espn", "ffc", "mfl", "tradyr", "gng"],
      sourceSnapshotId: SOURCE_SNAPSHOT_ID,
      sourceSnapshotGeneratedAt: liveControl.freshness.sourceSnapshotAt,
      actionState,
    },
    draft: { totalPicks: 0, appRoster: [], espnRoster: [] },
    telemetry: { actions: telemetry },
    ...(league.draftType === "AUCTION" ? { salaryCapEvidence: { sales: [] } } : {}),
    sleeperEvidence: { candidateCount: 0, candidates: [] },
    availability: {
      status: "READY",
      digest: AVAILABILITY_DIGEST,
      evaluatedAt: capturedAt,
      freshUntil: new Date(Date.parse(capturedAt) + 20 * 60_000).toISOString(),
      blockingReasons: [],
      vetoedPlayerIds: [],
    },
    leagueBoard: emptyLeagueBoard(league),
    operator: {
      room: { round: null, pick: null, onClock: false, secondsRemaining: null, nominee: null, currentBid: null, leader: null, maxLegalBid: null },
      team: { remainingBudget: league.draftType === "AUCTION" ? league.auctionBudget : null, openRosterSlots: league.rosterSize, primaryNeeds: [] },
      recommendation: null,
      alternatives: [],
      lastDecision: null,
    },
    liveControl,
  };
}

function checkpointPressureName(prefix, length = 120) {
  return String(prefix).slice(0, length).padEnd(length, "界");
}

function checkpointPressureCode(seed, index) {
  return `CHECKPOINT_${seed}_${String(index).padStart(4, "0")}`.padEnd(64, "X").slice(0, 64);
}

function checkpointPressureIdentifier(prefix, seed, index) {
  return `${prefix}-${seed}-${String(index).padStart(4, "0")}`.padEnd(128, "X").slice(0, 128);
}

function checkpointPressureEvidence(snapshot, seed) {
  const occurredAt = snapshot.capturedAt;
  const positions = ["QB", "RB", "WR", "TE", "DST", "K"];
  const telemetry = Array.from({ length: 256 }, (_, index) => ({
    occurredAt,
    operation: index % 2 ? "BID" : "NOMINATE",
    ok: true,
    code: checkpointPressureCode(seed, index),
    submitMs: 3_600_000,
    roundTripMs: 3_600_000,
    clockSeconds: 3_600,
    automatic: true,
    playerId: 8_000_000_000_000 + seed * 10_000 + index,
    amount: 1_000,
    maxApprovedBid: 1_000,
    nominationIntent: index % 2 ? null : "DRAIN",
  }));
  const sales = Array.from({ length: 800 }, (_, index) => ({
    sequence: (index % (snapshot.league.size * snapshot.league.rosterSize)) + 1,
    playerId: 7_000_000_000_000 + seed * 10_000 + index,
    position: positions[index % positions.length],
    closingPrice: snapshot.league.auctionBudget,
    sourceAuction: 999.9999999999999,
    fairValue: 999.9999999999999,
    targetBid: 1_000,
    maxApprovedBid: 1_000,
    highestObservedBid: 1_000,
    nominationIntent: index % 2 ? "TARGET" : "DRAIN",
    outcome: ["WON", "BID_LOST", "PASSED", "DRAINED"][index % 4],
    submittedBidCount: 1_000,
    highestSubmittedBid: 1_000,
  }));
  const sleeperCandidates = Array.from({ length: 64 }, (_, index) => ({
    playerId: 6_000_000_000_000 + seed * 1_000 + index,
    playerName: checkpointPressureName(`Checkpoint sleeper ${seed}-${index} `),
    position: positions[index % positions.length],
    adp: 9_999.999999999998,
    label: ["VALUE", "SLEEPER", "DEEP_STASH"][index % 3],
    score: 10_000,
    modelMarketEdge: 9_999.999999999998,
    modelSpread: 11.999999999999998,
    sourceCount: 5,
    firstSeenPick: 1,
    lastSeenPick: snapshot.league.size * snapshot.league.rosterSize,
    acquired: false,
    acquisitionPick: null,
    acquisitionAmount: 0,
  }));
  const opponentSlots = snapshot.leagueBoard.teams
    .filter((team) => !team.ours)
    .map((team) => team.teamSlot);
  const recentPicks = Array.from({ length: 24 }, (_, index) => ({
    overall: index + 1,
    round: null,
    teamSlot: opponentSlots[index % opponentSlots.length],
    ours: false,
    player: {
      playerId: 5_000_000_000_000 + seed * 1_000 + index,
      playerName: checkpointPressureName(`Checkpoint board ${seed}-${index} `),
      position: positions[index % positions.length],
      team: `QA${String(index).padStart(6, "0")}`.slice(0, 8),
    },
    amount: 1,
  }));
  const operatorPlayer = (index) => ({
    playerId: 4_000_000_000_000 + seed * 1_000 + index,
    playerName: checkpointPressureName(`Checkpoint operator ${seed}-${index} `),
    position: positions[index % positions.length],
    team: `OP${String(index).padStart(6, "0")}`.slice(0, 8),
  });
  const rosterPositions = ["QB", "QB", "RB", "RB", "RB", "RB", "RB", "WR", "WR", "WR", "WR", "WR", "TE", "TE", "DST", "K"];
  const roster = rosterPositions.map((position, index) => ({
    playerId: 3_500_000_000_000 + seed * 1_000 + index,
    playerName: checkpointPressureName(`Checkpoint roster ${seed}-${index} `),
    position,
    amount: 1,
  }));
  const ownTeam = snapshot.leagueBoard.teams.find((team) => team.ours);
  const positionCounts = rosterPositions.reduce((counts, position) => ({
    ...counts,
    [position]: Number(counts[position] || 0) + 1,
  }), {});
  const boardRoster = roster.map((entry, index) => ({
    overall: 100 + index,
    round: null,
    teamSlot: ownTeam.teamSlot,
    ours: true,
    player: {
      playerId: entry.playerId,
      playerName: entry.playerName,
      position: entry.position,
      team: `QR${String(index).padStart(6, "0")}`.slice(0, 8),
    },
    amount: entry.amount,
  }));
  return {
    ...snapshot,
    safety: {
      ...snapshot.safety,
      actionState: checkpointPressureName(`Checkpoint action state ${seed} `, 512),
    },
    draft: {
      totalPicks: 160,
      appRoster: roster,
      espnRoster: roster,
    },
    telemetry: { actions: telemetry },
    salaryCapEvidence: { sales },
    sleeperEvidence: { candidateCount: sleeperCandidates.length, candidates: sleeperCandidates },
    availability: {
      ...snapshot.availability,
      vetoedPlayerIds: Array.from(
        { length: 500 },
        (_, index) => 3_000_000_000_000 + seed * 1_000 + index,
      ),
    },
    leagueBoard: {
      ...snapshot.leagueBoard,
      recentPicks,
      ourRoster: boardRoster,
      teams: snapshot.leagueBoard.teams.map((team) => team.ours ? {
        ...team,
        playerCount: roster.length,
        projectedPoints: 1_000_000,
        averageProjectedPoints: 1_000_000,
        spent: roster.length,
        remainingBudget: snapshot.league.auctionBudget - roster.length,
        positionCounts,
      } : team),
      recommendation: {
        player: operatorPlayer(100),
        confidence: 100,
        reasons: Array.from(
          { length: 5 },
          (_, index) => checkpointPressureName(`Checkpoint reason ${seed}-${index} `, 160),
        ),
        sourceCount: 5,
        sourceSnapshotId: snapshot.safety.sourceSnapshotId,
      },
    },
    operator: {
      room: {
        round: 100,
        pick: 10_000,
        onClock: false,
        secondsRemaining: 3_600,
        nominee: operatorPlayer(200),
        currentBid: 1_000,
        leader: "UNKNOWN",
        maxLegalBid: 1_000,
      },
      team: {
        remainingBudget: 1_000,
        openRosterSlots: 64,
        primaryNeeds: ["QB", "RB", "WR", "TE", "FLEX", "OP", "DST", "K"]
          .map((position) => ({ position, count: 64 })),
      },
      recommendation: {
        state: "PREVIEW",
        action: "PASS",
        player: operatorPlayer(201),
        offer: 1_000,
        maxLegalBid: 1_000,
      },
      alternatives: Array.from({ length: 5 }, (_, index) => ({
        player: operatorPlayer(202 + index),
        maxLegalBid: 1_000,
      })),
      lastDecision: {
        operation: "BID",
        phase: "ACTION_COMPLETED",
        player: operatorPlayer(300),
        offer: 1_000,
        occurredAt,
        code: checkpointPressureCode(seed, 9999),
      },
    },
  };
}

function checkpointPressureSnapshot(snapshot, seed, { irreversiblePadding = false } = {}) {
  let pressured = checkpointPressureEvidence(snapshot, seed);
  if (!pressured.liveControl) throw new Error("CHECKPOINT_PRESSURE_LIVE_CONTROL_REQUIRED");
  let control = pressured.liveControl;
  let paddingIndex = 0;
  while (control.events.length < 256) {
    let candidateControl;
    if (irreversiblePadding && control.events.length <= 254) {
      const actionId = checkpointPressureIdentifier("checkpoint-action", seed, paddingIndex);
      const decisionId = checkpointPressureIdentifier("checkpoint-decision", seed, paddingIndex);
      const player = {
        playerId: 2_000_000_000_000 + seed * 1_000 + paddingIndex,
        playerName: checkpointPressureName(`Checkpoint lifecycle ${seed}-${paddingIndex} `),
        position: ["QB", "RB", "WR", "TE", "DST", "K"][paddingIndex % 6],
      };
      candidateControl = appendLiveControlEvent(control, {
        kind: "ACTION_LIFECYCLE",
        occurredAt: snapshot.capturedAt,
        actionId,
        decisionId,
        operation: "BID",
        phase: "PLANNED",
        intendedPlayer: player,
        intendedOffer: 1_000,
        code: checkpointPressureCode(seed, paddingIndex),
      });
      candidateControl = appendLiveControlEvent(candidateControl, {
        kind: "ACTION_LIFECYCLE",
        occurredAt: snapshot.capturedAt,
        actionId,
        decisionId,
        operation: "BID",
        phase: "ACTION_COMPLETED",
        intendedPlayer: player,
        resolvedPlayer: player,
        intendedOffer: 1_000,
        resolvedOffer: 1_000,
        code: checkpointPressureCode(seed, paddingIndex + 10_000),
      });
    } else {
      candidateControl = appendLiveControlEvent(control, {
        kind: "SAFETY",
        occurredAt: snapshot.capturedAt,
        condition: ["SOURCE_COVERAGE", "EXACT_BINDING", "CLOCK", "ACTION_SURFACE", "CODE_FREEZE"][paddingIndex % 5],
        active: paddingIndex % 2 === 0,
        code: checkpointPressureCode(seed, paddingIndex),
      });
    }
    const candidate = { ...pressured, liveControl: candidateControl };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > CHECKPOINT_ENTRY_TARGET_BYTES) break;
    control = candidateControl;
    pressured = candidate;
    paddingIndex += 1;
  }
  const entryBytes = Buffer.byteLength(JSON.stringify(pressured), "utf8");
  if (!isDraftAuditSnapshot(pressured)) throw new Error(`CHECKPOINT_PRESSURE_SNAPSHOT_INVALID_${seed}`);
  if (entryBytes > CHECKPOINT_ENTRY_MAX_BYTES) throw new Error(`CHECKPOINT_PRESSURE_ENTRY_TOO_LARGE_${entryBytes}`);
  return pressured;
}

function publication(snapshot) {
  return {
    digest: draftAuditPublicationDigest(snapshot),
    capturedAt: snapshot.capturedAt,
    snapshot,
    binding: {
      commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
      liveControlSessionId: LIVE_CONTROL_SESSION_ID,
      leagueId: LEAGUE_ID,
      teamId: TEAM_ID,
      tabId: ESPN_TAB_ID,
    },
    decisionId: snapshot.liveControl?.decision?.decisionId ?? null,
  };
}

function authorizedAction(action, actionRequestId) {
  const notAfter = Date.now() + 4_000;
  return {
    ...action,
    expectedTabId: ESPN_TAB_ID,
    commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
    dashboardLoadedAt: "2026-08-28T00:00:00.000Z",
    decisionId: `qa-production-action-${actionRequestId}`,
    authorizationEpoch: 0,
    actionRequestId,
    availabilityDigest: AVAILABILITY_DIGEST,
    availabilityDecisionDigest: AVAILABILITY_DECISION_DIGEST,
    notAfter,
    availabilityNotAfter: notAfter,
  };
}

async function runProductionActionMatrix({ players, sources, evaluatedAt, actionSamplesPerOperation }) {
  const operationModes = ["SELECT", "NOMINATE", "BID_INCREMENTAL", "BID_CUSTOM"];
  const latencyByOperation = Object.fromEntries(operationModes.map((mode) => [mode, []]));
  const planningLatencies = [];
  const resultsByOperation = Object.fromEntries(operationModes.map((mode) => [mode, {}]));
  let physicalClicks = 0;
  let preliminaryClicks = 0;
  let exactAcknowledgements = 0;
  let observerWrites = 0;
  let maximumInFlight = 0;
  let finalExecutionMetrics = null;
  let settlement = null;

  for (const mode of operationModes) {
    const content = await createFakeActionContent({ mode, players });
    const background = await createBackgroundHarness(content);
    const league = leagueFixture(mode === "SELECT" ? "SNAKE" : "AUCTION");
    const prepared = prepareDraftDayBridge(league, players, sources, evaluatedAt);
    try {
      if (mode === "SELECT") {
        content.beginSample({ currentPick: 1 });
        content.produce();
        await sleep(185);
      }
      for (let index = 0; index < actionSamplesPerOperation; index += 1) {
        const target = mode.startsWith("BID_") ? players[0] : null;
        const bidOutcome = mode.startsWith("BID_") && index % 4 === 0 && index + 1 < actionSamplesPerOperation
          ? "BID_SUPERSEDED"
          : "BID_CONFIRMED";
        content.beginSample({ target, currentBid: 8, currentPick: 1, bidOutcome });
        const room = content.produce();
        const planningStartedAt = performance.now();
        const decision = buildDraftDayBridgeResult({
          league,
          espnPlayers: players,
          picks: [],
          sources,
          room,
          strategy: "BALANCED",
          evaluatedAt,
          prepared,
        });
        planningLatencies.push(performance.now() - planningStartedAt);
        const expectedDecisionCode = mode === "SELECT"
          ? "SELECT_READY"
          : mode === "NOMINATE" ? "NOMINATION_READY" : "BID_READY";
        if (decision.code !== expectedDecisionCode || !decision.action) {
          throw new Error(`PRODUCTION_${mode}_PLANNER_NOT_READY_${decision.code}`);
        }
        content.beginSample({
          action: decision.action,
          target: mode.startsWith("BID_") ? players[0] : null,
          currentBid: 8,
          currentPick: 1,
          bidOutcome,
        });
        const fingerprintBeforeObserver = content.trackingFingerprint();
        content.observe();
        if (content.trackingFingerprint() !== fingerprintBeforeObserver) observerWrites += 1;

        const clicksBefore = content.state.finalClicks;
        const preliminaryBefore = content.state.preliminaryClicks;
        const messagesBefore = content.state.contentMessages.filter((message) => message.type === "ESPN_ACTION_SUBMITTED").length;
        const payload = authorizedAction(decision.action, index + 1);
        const actionStartedAt = performance.now();
        const first = background.dispatchApp({ type: "SUBMIT_ACTION", payload });
        const duplicate = background.dispatchApp({ type: "SUBMIT_ACTION", payload });
        const queueSamples = [];
        const queueSampler = setInterval(() => queueSamples.push(content.executionMetrics()), 5);
        queueSampler.unref();
        const actionResults = await Promise.all([first, duplicate]);
        clearInterval(queueSampler);
        queueSamples.push(content.executionMetrics());
        latencyByOperation[mode].push(performance.now() - actionStartedAt);
        maximumInFlight = Math.max(maximumInFlight, ...queueSamples.map((sample) => sample.inFlight));
        finalExecutionMetrics = content.executionMetrics();

        const expectedResult = mode === "SELECT"
          ? "ROSTER_CONFIRMED"
          : mode === "NOMINATE"
            ? "NOMINATION_CONFIRMED"
            : bidOutcome;
        if (actionResults.some((result) => result?.ok !== true || result?.code !== expectedResult)) {
          throw new Error(`PRODUCTION_${mode}_ACTION_FAILED_${actionResults.map((result) => result?.code).join("_")}`);
        }
        const resultCounts = resultsByOperation[mode];
        resultCounts[expectedResult] = Number(resultCounts[expectedResult] || 0) + 1;
        const finalClickDelta = content.state.finalClicks - clicksBefore;
        const preliminaryDelta = content.state.preliminaryClicks - preliminaryBefore;
        const messagesAfter = content.state.contentMessages.filter((message) => message.type === "ESPN_ACTION_SUBMITTED").length;
        if (finalClickDelta !== 1
          || preliminaryDelta !== (mode === "NOMINATE" ? 1 : 0)
          || messagesAfter - messagesBefore !== 1) {
          throw new Error(`PRODUCTION_${mode}_EXACTLY_ONCE_FAILED`);
        }
        physicalClicks += finalClickDelta;
        preliminaryClicks += preliminaryDelta;
        exactAcknowledgements += 1;
        const fingerprintBeforePostActionObserver = content.trackingFingerprint();
        content.observe();
        if (content.trackingFingerprint() !== fingerprintBeforePostActionObserver) observerWrites += 1;
      }

      if (mode === "BID_INCREMENTAL") {
        const soldPlayer = players[0];
        const soldAmount = content.state.currentBid;
        const trackedOffer = content.produce();
        if (trackedOffer.currentBid !== soldAmount || trackedOffer.leadingBid !== true) {
          throw new Error("AUCTION_SETTLEMENT_SOURCE_OFFER_NOT_TRACKED");
        }
        const nextPlayer = players[1];
        content.settleWonSale({ player: soldPlayer, amount: soldAmount, nextPlayer });
        const nextRoom = content.produce();
        const nextDecision = buildDraftDayBridgeResult({
          league,
          espnPlayers: players,
          picks: [{ playerId: soldPlayer.id, teamId: TEAM_ID, overall: 1, round: 1, amount: soldAmount }],
          sources,
          room: nextRoom,
          strategy: "BALANCED",
          evaluatedAt,
          prepared,
        });
        const recordedSale = nextRoom.auctionSales?.find((sale) => Number(sale.playerId) === Number(soldPlayer.id));
        const rosteredPlayer = nextRoom.ownRoster?.find((player) => Number(player.playerId) === Number(soldPlayer.id));
        if (nextRoom.auctionSettlementPending
          || recordedSale?.amount !== soldAmount
          || recordedSale?.teamName !== "QA Team"
          || rosteredPlayer?.amount !== soldAmount
          || nextRoom.maxLegalBid !== content.state.ownMaxOffer
          || nextDecision.code !== "BID_READY"
          || nextDecision.action?.expectedCurrentBid !== 1) {
          throw new Error(`AUCTION_NEXT_SALE_RECONCILIATION_FAILED_${JSON.stringify({ nextRoom, nextDecision: { code: nextDecision.code, action: nextDecision.action } })}`);
        }
        settlement = {
          playerId: soldPlayer.id,
          amount: soldAmount,
          remainingBudget: content.state.ownRemaining,
          maxLegalBid: nextRoom.maxLegalBid,
          rosterAmount: rosteredPlayer.amount,
          nextPlayerId: nextDecision.action.playerId,
          nextCurrentBid: nextDecision.action.expectedCurrentBid,
          pending: nextRoom.auctionSettlementPending,
        };
      }
    } finally {
      content.close();
      background.restore();
    }
  }

  return {
    samplesPerOperation: actionSamplesPerOperation,
    physicalClicks,
    preliminaryClicks,
    exactAcknowledgements,
    observerWrites,
    maximumInFlight,
    finalExecutionMetrics,
    resultCodes: resultsByOperation,
    samples: {
      planning: planningLatencies,
      action: operationModes.flatMap((mode) => latencyByOperation[mode]),
    },
    latencyMs: {
      planning: summarize(planningLatencies),
      action: summarize(operationModes.flatMap((mode) => latencyByOperation[mode])),
      byOperation: Object.fromEntries(operationModes.map((mode) => [mode, summarize(latencyByOperation[mode])])),
    },
    settlement,
  };
}

export async function runObserverCadence({
  durationMs,
  intervalMs,
  content,
  controlUrl,
  boardUrl,
  statusUrl,
  expectedSequence,
  readJsonImpl = measuredJson,
}) {
  const latencies = [];
  const boardLatencies = [];
  const contextLatencies = [];
  const statusLatencies = [];
  const errors = [];
  let observerWrites = 0;
  let lastControlSequence = Number.isSafeInteger(expectedSequence) ? expectedSequence : 0;
  let lastStatusSequence = Number.isSafeInteger(expectedSequence) ? expectedSequence : 0;
  const deadline = performance.now() + durationMs;
  let target = performance.now();
  while (target < deadline) {
    const waitMs = target - performance.now();
    if (waitMs > 0) await sleep(waitMs);
    try {
      if (content.hasCachedProducerContext?.() !== true) {
        throw new Error("OBSERVER_PRODUCER_CACHE_MISSING");
      }
      const fingerprint = content.trackingFingerprint();
      const contextStartedAt = performance.now();
      const observed = content.observe();
      contextLatencies.push(performance.now() - contextStartedAt);
      if (!observed.inDraftRoom || content.trackingFingerprint() !== fingerprint) {
        observerWrites += 1;
        throw new Error("OBSERVER_MUTATED_CONTENT_STATE");
      }
      const [response, boardResponse, statusResponse] = await Promise.all([
        readJsonImpl(controlUrl, { headers: { origin: APP_ORIGIN } }),
        boardUrl ? readJsonImpl(boardUrl, { headers: { origin: APP_ORIGIN } }) : Promise.resolve(null),
        statusUrl ? readJsonImpl(statusUrl, { headers: { origin: APP_ORIGIN } }) : Promise.resolve(null),
      ]);
      latencies.push(response.latencyMs);
      const controlSequence = Number(response.body.control?.sequence);
      if (response.status !== 200
        || !Number.isSafeInteger(controlSequence)
        || (Number.isSafeInteger(expectedSequence)
          ? controlSequence !== expectedSequence
          : controlSequence < lastControlSequence)) {
        throw new Error("OBSERVER_ROUTE_STATE_CHANGED");
      }
      lastControlSequence = controlSequence;
      if (boardResponse) {
        boardLatencies.push(boardResponse.latencyMs);
        if (boardResponse.status !== 200
          || boardResponse.body.code !== "DRAFT_LEAGUE_BOARD_READY"
          || Object.hasOwn(boardResponse.body, "control")
          || Object.hasOwn(boardResponse.body, "operator")) {
          throw new Error("BOARD_OBSERVER_ROUTE_INVALID");
        }
      }
      if (statusResponse) {
        statusLatencies.push(statusResponse.latencyMs);
        const statusSequence = Number(statusResponse.body.control?.sequence);
        if (statusResponse.status !== 200
          || statusResponse.body.code !== "DRAFT_DAY_STATUS_SNAPSHOT_READY"
          || !Number.isSafeInteger(statusSequence)
          || (Number.isSafeInteger(expectedSequence)
            ? statusSequence !== expectedSequence
            : statusSequence < lastStatusSequence)
          || Object.hasOwn(statusResponse.body.control || {}, "events")) {
          throw new Error("ATOMIC_STATUS_OBSERVER_ROUTE_INVALID");
        }
        lastStatusSequence = statusSequence;
      }
      // The synchronous check above proves the observer itself is read-only.
      // Do not compare the global content fingerprint across route I/O: the
      // deliberately concurrent action writer may advance exact clock or
      // settlement tracking while these independent GETs are in flight.
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    target += intervalMs;
  }
  return {
    latencies,
    boardLatencies,
    statusLatencies,
    contextLatencies,
    errors,
    observerWrites,
    lastControlSequence,
    lastStatusSequence,
  };
}

async function runCheckpointCriticalChurn({ routeServer, evaluatedAt, observerDurationMs, checkpointPath }) {
  const leagueId = "qa-interrupted-room-4";
  const league = leagueFixture("AUCTION", leagueId);
  const content = await createFakeAuctionContent();
  content.produce();
  const binding = {
    tabId: ESPN_TAB_ID,
    dashboardLoadedAt: new Date(Date.parse(evaluatedAt) + 1).toISOString(),
    commandCenterSessionId: "qa-checkpoint-pressure-publisher",
    commandCenterStartedAt: new Date(Date.parse(evaluatedAt) + 1).toISOString(),
    authenticatedImportAt: new Date(Date.parse(evaluatedAt) + 2).toISOString(),
  };
  let control = createLiveControlState("qa-checkpoint-pressure-live", {
    espnContextAt: evaluatedAt,
    pickFeedAt: null,
    pickFeedObservedAt: evaluatedAt,
    sourceSnapshotAt: evaluatedAt,
    lastActionAt: null,
  });
  let activeWriters = 0;
  let maximumActiveWriters = 0;
  let diskAcknowledgements = 0;
  const auditPostLatencies = [];
  const diskVerificationLatencies = [];
  const auditPostResults = [];
  const checkpointBytes = [];
  const postAudit = async (candidate, label) => {
    const payload = JSON.stringify({ operation: "AUDIT", audit: candidate });
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (payloadBytes > 512 * 1024) throw new Error(`CHECKPOINT_PRESSURE_POST_TOO_LARGE_${payloadBytes}`);
    activeWriters += 1;
    maximumActiveWriters = Math.max(maximumActiveWriters, activeWriters);
    const startedAt = performance.now();
    try {
      const response = await fetch(`${routeServer.origin}/api/draft-day`, {
        method: "POST",
        headers: { origin: APP_ORIGIN, "content-type": "application/json" },
        body: payload,
      });
      const body = await response.json();
      auditPostLatencies.push(performance.now() - startedAt);
      auditPostResults.push({ label, status: response.status, code: body.code });
      if (response.status !== 200 || body.ok !== true || body.code !== "DRAFT_AUDIT_RECORDED") {
        throw new Error(`CHECKPOINT_PRESSURE_AUDIT_REJECTED_${label}_${response.status}_${body.code}`);
      }
      const verificationStartedAt = performance.now();
      const expectedCheckpointDigest = draftAuditCheckpointDigest(candidate);
      const durableBytes = await readFile(checkpointPath, "utf8");
      if (!durableBytes.includes(`"digest":"${expectedCheckpointDigest}"`)) {
        throw new Error(`CHECKPOINT_PRESSURE_DISK_ACK_MISSING_${label}`);
      }
      diskAcknowledgements += 1;
      checkpointBytes.push((await stat(checkpointPath)).size);
      diskVerificationLatencies.push(performance.now() - verificationStartedAt);
    } finally {
      activeWriters -= 1;
    }
  };
  const snapshotAt = (offset) => new Date(Date.parse(evaluatedAt) + 10 + offset).toISOString();
  const pressureTemplateCapturedAt = snapshotAt(0);
  const pressureTemplate = checkpointPressureEvidence({
    ...auditSnapshot({
      league,
      capturedAt: pressureTemplateCapturedAt,
      liveControl: control,
      actionState: "Near-capacity critical salary-cap durability pressure",
    }),
    binding,
  }, 404);
  const buildSnapshot = (capturedAt) => ({
    ...pressureTemplate,
    capturedAt,
    runtime: { ...pressureTemplate.runtime, capturedAt },
    availability: {
      ...pressureTemplate.availability,
      evaluatedAt: capturedAt,
      freshUntil: new Date(Date.parse(capturedAt) + 20 * 60_000).toISOString(),
    },
    liveControl: control,
  });

  try {
    await postAudit(buildSnapshot(snapshotAt(0)), "RECOVERY_BASELINE");
    const controlUrl = `${routeServer.origin}/api/draft-day?view=control&leagueId=${leagueId}&teamId=${TEAM_ID}&since=0`;
    const statusUrl = `${routeServer.origin}/api/draft-day?view=status&leagueId=${leagueId}&teamId=${TEAM_ID}`;
    const contentionDurationMs = Math.max(
      observerDurationMs,
      CRITICAL_AUDIT_CHURN_INTERVAL_MS * CRITICAL_AUDIT_CHURN_WRITES + 100,
    );
    const normalObserver = runObserverCadence({
      durationMs: contentionDurationMs,
      intervalMs: 1_000,
      content,
      controlUrl,
      statusUrl,
      expectedSequence: null,
    });
    const burstObserver = runObserverCadence({
      durationMs: contentionDurationMs,
      intervalMs: 250,
      content,
      controlUrl,
      statusUrl,
      expectedSequence: null,
    });

    let previousAction = null;
    let nextStartAt = performance.now();
    const writeStartedAt = [];
    for (let index = 0; index < CRITICAL_AUDIT_CHURN_WRITES; index += 1) {
      const delayMs = nextStartAt - performance.now();
      if (delayMs > 0) await sleep(delayMs);
      writeStartedAt.push(performance.now());
      const occurredAt = snapshotAt(index + 1);
      if (previousAction) {
        control = appendLiveControlEvent(control, {
          kind: "ACTION_LIFECYCLE",
          occurredAt,
          actionId: previousAction.actionId,
          decisionId: previousAction.decisionId,
          operation: "BID",
          phase: "CANCELLED",
          intendedPlayer: previousAction.player,
          intendedOffer: previousAction.offer,
          code: "BID_SUPERSEDED",
        });
      }
      const actionId = `qa-checkpoint-pressure-action-${index}`;
      const decisionId = `qa-checkpoint-pressure-decision-${index}`;
      const currentBid = 8 + index;
      const offer = currentBid + 1;
      const player = {
        playerId: 10_001,
        playerName: "Production Path Receiver",
        position: "WR",
      };
      control = appendLiveControlEvent(control, {
        kind: "ACTION_LIFECYCLE",
        occurredAt,
        actionId,
        decisionId,
        operation: "BID",
        phase: "PLANNED",
        intendedPlayer: player,
        intendedOffer: offer,
        code: "AUTO_ACTION_PLANNED",
      });
      control = {
        ...control,
        decision: {
          decisionId,
          decidedAt: occurredAt,
          contextCapturedAt: occurredAt,
          leagueId,
          teamId: TEAM_ID,
          tabId: ESPN_TAB_ID,
          operation: "BID",
          sourceSnapshotId: SOURCE_SNAPSHOT_ID,
          availabilityDigest: AVAILABILITY_DIGEST,
          availabilityDecisionDigest: AVAILABILITY_DECISION_DIGEST,
          expectedCurrentBid: currentBid,
          intendedOffer: offer,
          maxApprovedBid: 50,
          intendedPlayer: player,
          alternatives: [],
        },
      };
      previousAction = { actionId, decisionId, player, offer };
      await postAudit(buildSnapshot(occurredAt), `CRITICAL_${index + 1}`);
      nextStartAt += CRITICAL_AUDIT_CHURN_INTERVAL_MS;
    }
    const [normal, burst] = await Promise.all([normalObserver, burstObserver]);
    const observerErrors = [...normal.errors, ...burst.errors];
    const observerWrites = normal.observerWrites + burst.observerWrites;
    const startIntervalsMs = writeStartedAt.slice(1).map((startedAt, index) => startedAt - writeStartedAt[index]);
    const finalCheckpointBytes = checkpointBytes.at(-1) ?? 0;
    const criticalPostLatencies = auditPostLatencies.slice(1);
    if (observerErrors.length
      || observerWrites !== 0
      || maximumActiveWriters !== 1
      || diskAcknowledgements !== CRITICAL_AUDIT_CHURN_WRITES + 1
      || percentile(criticalPostLatencies, .99) > 450
      || finalCheckpointBytes > CHECKPOINT_MAX_BYTES
      || normal.latencies.length !== Math.ceil(contentionDurationMs / 1_000)
      || burst.latencies.length !== Math.ceil(contentionDurationMs / 250)) {
      throw new Error(`CHECKPOINT_PRESSURE_CONTENTION_FAILED_${JSON.stringify({
        observerErrors,
        observerWrites,
        maximumActiveWriters,
        diskAcknowledgements,
        finalCheckpointBytes,
        auditPostP99: percentile(criticalPostLatencies, .99),
      })}`);
    }
    return {
      writes: CRITICAL_AUDIT_CHURN_WRITES,
      intervalMs: CRITICAL_AUDIT_CHURN_INTERVAL_MS,
      startIntervalsMs,
      diskAcknowledgements,
      maximumActiveWriters,
      auditPostLatencies: criticalPostLatencies,
      diskVerificationLatencies,
      auditPostResults,
      observerErrors,
      observerWrites,
      observerSamples: { normal: normal.latencies.length, burst: burst.latencies.length },
      checkpointBytes,
      finalCheckpointBytes,
      finalSequence: control.sequence,
    };
  } finally {
    content.close?.();
  }
}

async function runSnakeObserverOverlap({ players, sources, evaluatedAt, routeServer, observerDurationMs }) {
  const league = leagueFixture("SNAKE", SNAKE_LEAGUE_ID);
  const content = await createFakeActionContent({
    mode: "SELECT",
    players,
    leagueId: SNAKE_LEAGUE_ID,
    // Keep roster confirmation pending long enough for multiple 4Hz observer
    // reads to overlap the exact irreversible action path.
    selectionAcknowledgementDelayMs: 450,
  });
  const background = await createBackgroundHarness(content, SNAKE_LEAGUE_ID, routeServer.origin);
  try {
    const prepared = prepareDraftDayBridge(league, players, sources, evaluatedAt);
    content.beginSample({ currentPick: 1 });
    content.produce();
    await sleep(185);
    content.beginSample({ currentPick: 1 });
    const room = content.produce();
    const decision = buildDraftDayBridgeResult({
      league,
      espnPlayers: players,
      picks: [],
      sources,
      room,
      strategy: "BALANCED",
      evaluatedAt,
      prepared,
    });
    if (decision.code !== "SELECT_READY" || !decision.action) {
      throw new Error(`SNAKE_OBSERVER_PLANNER_NOT_READY_${decision.code}`);
    }
    content.beginSample({ action: decision.action, currentPick: 1 });

    const capturedAt = new Date().toISOString();
    const intendedPlayer = {
      playerId: decision.action.playerId,
      playerName: decision.action.playerName,
      position: decision.action.position,
    };
    const envelope = {
      decisionId: "qa-snake-observer-decision-1",
      decidedAt: capturedAt,
      contextCapturedAt: capturedAt,
      leagueId: SNAKE_LEAGUE_ID,
      teamId: TEAM_ID,
      tabId: ESPN_TAB_ID,
      operation: "SELECT",
      sourceSnapshotId: SOURCE_SNAPSHOT_ID,
      availabilityDigest: AVAILABILITY_DIGEST,
      availabilityDecisionDigest: AVAILABILITY_DECISION_DIGEST,
      expectedPick: 1,
      submitNotBeforeAt: capturedAt,
      submitTargetSeconds: 18,
      intendedPlayer,
      alternatives: [],
    };
    const emptyControl = createLiveControlState("qa-snake-observer-control-20260828", {
      espnContextAt: capturedAt,
      pickFeedAt: null,
      pickFeedObservedAt: capturedAt,
      sourceSnapshotAt: capturedAt,
      lastActionAt: null,
    });
    let liveControl = appendLiveControlEvent(emptyControl, {
      kind: "ACTION_LIFECYCLE",
      occurredAt: capturedAt,
      actionId: "qa-snake-observer-action-1",
      decisionId: envelope.decisionId,
      operation: "SELECT",
      phase: "PLANNED",
      intendedPlayer,
      code: "AUTO_ACTION_PLANNED",
    });
    liveControl = { ...liveControl, decision: envelope };
    const snapshot = auditSnapshot({ league, capturedAt, liveControl, actionState: "Snake observer overlap ready" });
    const recorded = await measuredJson(`${routeServer.origin}/api/draft-day`, {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ operation: "AUDIT", audit: snapshot }),
    });
    if (recorded.status !== 200 || recorded.body.code !== "DRAFT_AUDIT_RECORDED") {
      throw new Error(`SNAKE_OBSERVER_AUDIT_NOT_RECORDED_${recorded.body.code}`);
    }

    const controlUrl = `${routeServer.origin}/api/draft-day?view=control&leagueId=${SNAKE_LEAGUE_ID}&teamId=${TEAM_ID}&since=0`;
    const boardUrl = `${routeServer.origin}/api/draft-day?view=board&leagueId=${SNAKE_LEAGUE_ID}&teamId=${TEAM_ID}`;
    const statusUrl = `${routeServer.origin}/api/draft-day?view=status&leagueId=${SNAKE_LEAGUE_ID}&teamId=${TEAM_ID}`;
    const normalObserver = runObserverCadence({
      durationMs: observerDurationMs,
      intervalMs: 1_000,
      content,
      controlUrl,
      boardUrl,
      statusUrl,
      expectedSequence: liveControl.sequence,
    });
    const burstObserver = runObserverCadence({
      durationMs: observerDurationMs,
      intervalMs: 250,
      content,
      controlUrl,
      boardUrl,
      statusUrl,
      expectedSequence: liveControl.sequence,
    });
    await sleep(20);
    const clicksBefore = content.state.finalClicks;
    const messagesBefore = content.state.contentMessages.filter((message) => message.type === "ESPN_ACTION_SUBMITTED").length;
    const actionPayload = authorizedAction(decision.action, 88_001);
    actionPayload.decisionId = envelope.decisionId;
    const actionStartedAt = performance.now();
    const first = background.dispatchApp({ type: "SUBMIT_ACTION", payload: actionPayload });
    const duplicate = background.dispatchApp({ type: "SUBMIT_ACTION", payload: actionPayload });
    const queueSamples = [];
    const queueSampler = setInterval(() => queueSamples.push(content.executionMetrics()), 5);
    queueSampler.unref();
    const actionResults = await Promise.all([first, duplicate]);
    clearInterval(queueSampler);
    queueSamples.push(content.executionMetrics());
    const actionRoundTripMs = performance.now() - actionStartedAt;
    const [normal, burst] = await Promise.all([normalObserver, burstObserver]);
    const observerErrors = [...normal.errors, ...burst.errors];
    const finalClickDelta = content.state.finalClicks - clicksBefore;
    const submittedMessageDelta = content.state.contentMessages.filter((message) => message.type === "ESPN_ACTION_SUBMITTED").length - messagesBefore;
    const maximumInFlight = Math.max(0, ...queueSamples.map((sample) => sample.inFlight));
    const finalMetrics = content.executionMetrics();
    if (actionResults.some((result) => result?.ok !== true || result?.code !== "ROSTER_CONFIRMED")
      || finalClickDelta !== 1
      || submittedMessageDelta !== 1
      || maximumInFlight > 1
      || finalMetrics.inFlight !== 0
      || observerErrors.length) {
      throw new Error(`SNAKE_OBSERVER_OVERLAP_FAILED_${JSON.stringify({
        actionResults: actionResults.map((result) => result?.code),
        finalClickDelta,
        submittedMessageDelta,
        maximumInFlight,
        finalMetrics,
        observerErrors,
      })}`);
    }
    return {
      actionRoundTripMs,
      physicalClicks: finalClickDelta,
      exactAcknowledgements: 1,
      observerWrites: 0,
      observerSamples: { normal: normal.latencies.length, burst: burst.latencies.length },
      boardObserverSamples: { normal: normal.boardLatencies.length, burst: burst.boardLatencies.length },
      observerErrors,
      routeLatencies: [...normal.latencies, ...burst.latencies],
      boardRouteLatencies: [...normal.boardLatencies, ...burst.boardLatencies],
      statusRouteLatencies: [...normal.statusLatencies, ...burst.statusLatencies],
      contextLatencies: [...normal.contextLatencies, ...burst.contextLatencies],
      maximumInFlight,
      finalMetrics,
    };
  } finally {
    content.close();
    background.restore();
  }
}

export async function runLiveControlProductionPath({
  observerDurationMs = 1_250,
  actionSamplesPerOperation = ACTION_SAMPLES_PER_OPERATION,
} = {}) {
  if (!Number.isInteger(observerDurationMs) || observerDurationMs < 1_000 || observerDurationMs > 5_000) {
    throw new Error("OBSERVER_DURATION_MUST_BE_1000_TO_5000_MS");
  }
  if (!Number.isInteger(actionSamplesPerOperation) || actionSamplesPerOperation < 5 || actionSamplesPerOperation > 40) {
    throw new Error("ACTION_SAMPLES_PER_OPERATION_MUST_BE_5_TO_40");
  }
  const startedAt = performance.now();
  const eventLoop = monitorEventLoopDelay({ resolution: 5 });
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const memorySampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);
  memorySampler.unref();
  eventLoop.enable();

  let content = null;
  let background = null;
  let routeServer = null;
  let checkpointDirectory = null;
  const priorCheckpointEnv = {
    enabled: process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT,
    path: process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH,
    revision: process.env.DRAFTFORGE_RELEASE_REVISION,
  };
  try {
    const players = playersFixture();
    const league = leagueFixture();
    const evaluatedAt = new Date().toISOString();
    const sources = sourcesFixture(players, evaluatedAt);
    checkpointDirectory = await mkdtemp(path.join(tmpdir(), "draftforge-production-path-checkpoint-"));
    const checkpointPath = path.join(checkpointDirectory, "checkpoint.json");
    process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT = "1";
    process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH = checkpointPath;
    process.env.DRAFTFORGE_RELEASE_REVISION = "0".repeat(40);
    const checkpointLeagues = [LEAGUE_ID, SNAKE_LEAGUE_ID, "qa-interrupted-room-3", "qa-interrupted-room-4"];
    const checkpointSnapshots = checkpointLeagues.map((leagueId, index) => {
      const checkpointLeague = leagueFixture("AUCTION", leagueId);
      const checkpointControl = createLiveControlState(`qa-checkpoint-control-${index}`, {
        espnContextAt: evaluatedAt,
        pickFeedAt: null,
        pickFeedObservedAt: evaluatedAt,
        sourceSnapshotAt: evaluatedAt,
        lastActionAt: null,
      });
      const checkpointSnapshot = auditSnapshot({
        league: checkpointLeague,
        capturedAt: new Date(Date.parse(evaluatedAt) - 1_000 + index).toISOString(),
        liveControl: checkpointControl,
        actionState: "Preseeded legal recovery checkpoint under production-path pressure",
        telemetry: Array.from({ length: 256 }, (_, telemetryIndex) => ({
          occurredAt: evaluatedAt,
          operation: telemetryIndex % 2 ? "BID" : "NOMINATE",
          ok: true,
          code: "CHECKPOINT_PRESSURE_SAMPLE",
          submitMs: telemetryIndex,
          roundTripMs: telemetryIndex + 1,
          clockSeconds: 18,
          automatic: true,
          playerId: 100_000 + index * 1_000 + telemetryIndex,
          amount: 1,
          maxApprovedBid: 1,
          nominationIntent: telemetryIndex % 2 ? null : "DRAIN",
        })),
      });
      return checkpointPressureSnapshot({
        ...checkpointSnapshot,
        binding: {
          ...checkpointSnapshot.binding,
          dashboardLoadedAt: "2026-08-27T23:59:58.000Z",
          authenticatedImportAt: "2026-08-27T23:59:59.000Z",
          commandCenterSessionId: `qa-recovered-command-center-${index}`,
          commandCenterStartedAt: "2026-08-27T23:59:58.000Z",
        },
      }, index + 1, { irreversiblePadding: index === 2 });
    });
    await persistDraftAuditCheckpoint(checkpointSnapshots, checkpointPath, evaluatedAt, "0".repeat(40));
    const preseedCheckpointBytes = (await stat(checkpointPath)).size;
    const preseedEntryBytes = checkpointSnapshots.map((snapshot) => Buffer.byteLength(JSON.stringify(snapshot), "utf8"));
    if (preseedCheckpointBytes < CHECKPOINT_PRESEED_MIN_BYTES || preseedCheckpointBytes > CHECKPOINT_MAX_BYTES) {
      throw new Error(`CHECKPOINT_PRESEED_NOT_NEAR_CAP_${preseedCheckpointBytes}_${preseedEntryBytes.join("_")}`);
    }
    const actionMatrix = await runProductionActionMatrix({ players, sources, evaluatedAt, actionSamplesPerOperation });
    routeServer = await startDraftDayRouteServer();
    const checkpointCriticalChurn = await runCheckpointCriticalChurn({
      routeServer,
      evaluatedAt,
      observerDurationMs,
      checkpointPath,
    });
    const snakeObserverOverlap = await runSnakeObserverOverlap({
      players,
      sources,
      evaluatedAt,
      routeServer,
      observerDurationMs,
    });
    content = await createFakeAuctionContent();
    background = await createBackgroundHarness(content, LEAGUE_ID, routeServer.origin);
    const preparedStartedAt = performance.now();
    const prepared = prepareDraftDayBridge(league, players, sources, evaluatedAt);
    const preparationMs = performance.now() - preparedStartedAt;
    const planningLatencies = [];
    const contexts = [];
    const producerDeliveries = [];

    for (let index = 0; index < 6; index += 1) {
      content.setBid(9 + index);
      const room = content.produce();
      const planningStartedAt = performance.now();
      const decision = buildDraftDayBridgeResult({
        league,
        espnPlayers: players,
        picks: [],
        sources,
        room,
        strategy: "BALANCED",
        evaluatedAt,
        prepared,
      });
      planningLatencies.push(performance.now() - planningStartedAt);
      if (decision.code !== "BID_READY" || decision.action?.amount !== room.currentBid + 1) {
        throw new Error(`PRODUCTION_PLANNER_NOT_READY_${decision.code}`);
      }
      const producerContext = {
        ...room,
        producerSessionId: "qa-producer-session",
        producerRevision: index + 1,
        contextCapturedAt: new Date(Date.now() + index).toISOString(),
      };
      contexts.push({ room, decision, producerContext });
      if (index === 0 || index === 3) {
        producerDeliveries.push(await background.dispatchEspn({ type: "ESPN_CONTEXT", payload: producerContext }));
      } else if (index === 2 || index === 5) {
        producerDeliveries.push(await background.dispatchEspn({ type: "ESPN_CONTEXT", payload: producerContext }));
        producerDeliveries.push(await background.dispatchEspn({ type: "ESPN_CONTEXT", payload: contexts[index - 1].producerContext }));
      }
      if (index < 5) await sleep(75);
    }
    const acceptedProducerDeliveries = producerDeliveries.filter((result) => result?.ok && !result?.skipped).length;
    const rejectedProducerDeliveries = producerDeliveries.filter((result) => result?.code === "ESPN_CONTEXT_STALE_OR_UNSEQUENCED").length;
    if (acceptedProducerDeliveries !== 4 || rejectedProducerDeliveries !== 2) {
      throw new Error("PRODUCER_REORDER_FENCE_FAILED");
    }

    const final = contexts.at(-1);
    const decisionTime = new Date(Date.now() + 100).toISOString();
    const envelope = liveDecision(final.decision.action, final.room, decisionTime);
    const binding = {
      commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
      liveControlSessionId: LIVE_CONTROL_SESSION_ID,
      leagueId: LEAGUE_ID,
      teamId: TEAM_ID,
      tabId: ESPN_TAB_ID,
    };
    let postIndex = 0;
    let activePosts = 0;
    let maximumActivePosts = 0;
    const auditPostLatencies = [];
    const auditPostResults = [];
    const publisher = createDraftAuditPublisher({
      timeoutMs: 500,
      retryDelaysMs: [],
      post: async (candidate, signal) => {
        activePosts += 1;
        maximumActivePosts = Math.max(maximumActivePosts, activePosts);
        postIndex += 1;
        const postStartedAt = performance.now();
        try {
          if (postIndex === 1) await sleep(10);
          const response = await fetch(`${routeServer.origin}/api/draft-day`, {
            method: "POST",
            headers: { origin: APP_ORIGIN, "content-type": "application/json" },
            body: JSON.stringify({ operation: "AUDIT", audit: candidate.snapshot }),
            signal,
          });
          const payload = await response.json();
          const result = {
            ok: response.ok && payload.ok === true,
            status: response.status,
            code: payload.code,
            controlCode: payload.controlCode,
            recordedPublication: payload.recordedPublication,
            payload,
          };
          auditPostResults.push({ status: response.status, code: payload.code, controlCode: payload.controlCode });
          return result;
        } finally {
          auditPostLatencies.push(performance.now() - postStartedAt);
          activePosts -= 1;
        }
      },
    });
    publisher.bind(binding);

    const baselineTime = new Date(Date.parse(decisionTime) - 2).toISOString();
    const emptyControl = createLiveControlState(LIVE_CONTROL_SESSION_ID, {
      espnContextAt: baselineTime,
      pickFeedAt: null,
      pickFeedObservedAt: baselineTime,
      sourceSnapshotAt: baselineTime,
      lastActionAt: null,
    });
    const baselineSnapshot = auditSnapshot({ league, capturedAt: baselineTime, liveControl: emptyControl });
    if (!publisher.enqueue(publication(baselineSnapshot))) throw new Error("BASELINE_PUBLICATION_REJECTED");

    const intendedPlayer = envelope.intendedPlayer;
    let liveControl = appendLiveControlEvent(emptyControl, {
      kind: "ACTION_LIFECYCLE",
      occurredAt: decisionTime,
      actionId: "qa-auction-action-1",
      decisionId: envelope.decisionId,
      operation: "BID",
      phase: "PLANNED",
      intendedPlayer,
      intendedOffer: envelope.intendedOffer,
      code: "AUTO_ACTION_PLANNED",
    });
    liveControl = { ...liveControl, decision: envelope };
    const plannedSnapshot = auditSnapshot({ league, capturedAt: decisionTime, liveControl });
    if (!publisher.enqueue(publication(plannedSnapshot))) throw new Error("PLANNED_PUBLICATION_REJECTED");
    await publisher.flush();
    if (!publisher.isAuthorized(binding, envelope.decisionId) || maximumActivePosts !== 1) {
      throw new Error(`AUDIT_PUBLICATION_FENCE_FAILED_${JSON.stringify({
        ack: publisher.getAck(),
        decisionId: envelope.decisionId,
        maximumActivePosts,
        auditPostResults,
        auditPostLatencies,
      })}`);
    }
    const plannedDurable = await loadPersistedDraftAuditCheckpoint(checkpointPath, "0".repeat(40));
    const plannedDurableSnapshot = plannedDurable.ok
      ? plannedDurable.value.snapshots.find(({ snapshot }) => snapshot.league.id === LEAGUE_ID)?.snapshot
      : null;
    if (plannedDurableSnapshot?.liveControl?.decision?.decisionId !== envelope.decisionId) {
      throw new Error("AUDIT_DISK_ACK_MISSING_BEFORE_BID");
    }

    const controlUrl = `${routeServer.origin}/api/draft-day?view=control&leagueId=${LEAGUE_ID}&teamId=${TEAM_ID}&since=0`;
    const statusUrl = `${routeServer.origin}/api/draft-day?view=status&leagueId=${LEAGUE_ID}&teamId=${TEAM_ID}`;
    const normalObserver = runObserverCadence({
      durationMs: observerDurationMs,
      intervalMs: 1_000,
      content,
      controlUrl,
      statusUrl,
      expectedSequence: liveControl.sequence,
    });
    const burstObserver = runObserverCadence({
      durationMs: observerDurationMs,
      intervalMs: 250,
      content,
      controlUrl,
      statusUrl,
      expectedSequence: liveControl.sequence,
    });

    await sleep(80);
    const actionPayload = {
      ...final.decision.action,
      expectedTabId: ESPN_TAB_ID,
      commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
      dashboardLoadedAt: "2026-08-28T00:00:00.000Z",
      decisionId: envelope.decisionId,
      authorizationEpoch: 0,
      actionRequestId: 77,
      availabilityDigest: AVAILABILITY_DIGEST,
      availabilityDecisionDigest: AVAILABILITY_DECISION_DIGEST,
      notAfter: Date.now() + 4_000,
      availabilityNotAfter: Date.now() + 4_000,
    };
    const actionStartedAt = performance.now();
    const actionOne = background.dispatchApp({ type: "SUBMIT_ACTION", payload: actionPayload });
    const actionTwo = background.dispatchApp({ type: "SUBMIT_ACTION", payload: actionPayload });
    const queueSamples = [];
    const queueSampler = setInterval(() => queueSamples.push(content.executionMetrics()), 5);
    queueSampler.unref();
    const actionResults = await Promise.all([actionOne, actionTwo]);
    clearInterval(queueSampler);
    queueSamples.push(content.executionMetrics());
    const actionRoundTripMs = performance.now() - actionStartedAt;
    const [normal, burst] = await Promise.all([normalObserver, burstObserver]);
    const observerErrors = [...normal.errors, ...burst.errors];

    if (actionResults.some((result) => result?.ok !== true || result?.code !== "BID_CONFIRMED")) {
      throw new Error(`ACTION_NOT_ACKNOWLEDGED_${actionResults.map((result) => result?.code).join("_")}_${JSON.stringify({ state: content.state, context: content.observe() })}`);
    }
    const submittedMessages = content.state.contentMessages.filter((message) => message.type === "ESPN_ACTION_SUBMITTED");
    if (content.state.bidClicks !== 1
      || content.state.clickedAmounts[0] !== final.decision.action.amount
      || submittedMessages.length !== 1) {
      throw new Error("DUPLICATE_OR_INEXACT_ESPN_CLICK");
    }
    if (observerErrors.length) throw new Error(observerErrors[0]);
    if (queueSamples.some((sample) => sample.inFlight > 1 || sample.completed > 64 || sample.requestSignatures > 64)
      || content.executionMetrics().inFlight !== 0) {
      throw new Error("ACTION_QUEUE_BOUNDS_EXCEEDED");
    }

    const eventTime = (offset) => new Date(Date.parse(decisionTime) + offset).toISOString();
    liveControl = appendLiveControlEvent(liveControl, {
      kind: "ACTION_LIFECYCLE",
      occurredAt: eventTime(1),
      actionId: "qa-auction-action-1",
      decisionId: envelope.decisionId,
      operation: "BID",
      phase: "RESOLVED",
      intendedPlayer,
      resolvedPlayer: intendedPlayer,
      intendedOffer: envelope.intendedOffer,
      resolvedOffer: envelope.intendedOffer,
    });
    liveControl = { ...liveControl, decision: { ...envelope, resolvedPlayer: intendedPlayer, resolvedOffer: envelope.intendedOffer } };
    for (const [offset, phase, code] of [
      [2, "CLICK_SENT", "ESPN_CLICK_SENT"],
      [3, "ESPN_ACKNOWLEDGED", "BID_CONFIRMED"],
      [4, "ACTION_COMPLETED", "BID_CONFIRMED"],
    ]) {
      liveControl = appendLiveControlEvent(liveControl, {
        kind: "ACTION_LIFECYCLE",
        occurredAt: eventTime(offset),
        actionId: "qa-auction-action-1",
        decisionId: envelope.decisionId,
        operation: "BID",
        phase,
        intendedOffer: envelope.intendedOffer,
        resolvedOffer: envelope.intendedOffer,
        code,
      });
    }
    const finalCapturedAt = eventTime(5);
    const finalSnapshot = auditSnapshot({
      league,
      capturedAt: finalCapturedAt,
      liveControl,
      actionState: "Exact salary-cap bid acknowledged",
      telemetry: [{
        occurredAt: finalCapturedAt,
        operation: "BID",
        ok: true,
        code: "BID_CONFIRMED",
        submitMs: Math.round(actionRoundTripMs),
        roundTripMs: Math.round(actionRoundTripMs),
        clockSeconds: final.room.remainingSeconds,
        automatic: true,
        playerId: final.decision.action.playerId,
        amount: final.decision.action.amount,
        maxApprovedBid: final.decision.action.maxApprovedBid,
      }],
    });
    if (!publisher.enqueue(publication(finalSnapshot))) throw new Error("FINAL_PUBLICATION_REJECTED");
    await publisher.flush();
    const finalDurable = await loadPersistedDraftAuditCheckpoint(checkpointPath, "0".repeat(40));
    const finalDurableSnapshot = finalDurable.ok
      ? finalDurable.value.snapshots.find(({ snapshot }) => snapshot.league.id === LEAGUE_ID)?.snapshot
      : null;
    if (finalDurableSnapshot?.liveControl?.sequence !== 5) {
      throw new Error("FINAL_BID_LIFECYCLE_DISK_ACK_MISSING");
    }
    const finalCheckpointBytes = (await stat(checkpointPath)).size;
    const finalControl = await measuredJson(controlUrl, { headers: { origin: APP_ORIGIN } });
    if (finalControl.status !== 200
      || finalControl.body.control?.sequence !== 5
      || finalControl.body.control?.pendingActionCount !== 0
      || finalControl.body.control?.events?.filter((event) => event.phase === "ESPN_ACKNOWLEDGED").length !== 1) {
      throw new Error(`FINAL_AUDIT_ROUTE_STATE_INVALID_${JSON.stringify({ finalControl, auditPostResults })}`);
    }

    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const observerRouteLatencies = [...normal.latencies, ...burst.latencies];
    const observerContextLatencies = [...normal.contextLatencies, ...burst.contextLatencies];
    const statusRoute = summarize([...normal.statusLatencies, ...burst.statusLatencies]);
    const planning = summarize([...planningLatencies, ...actionMatrix.samples.planning]);
    const observerRoute = summarize(observerRouteLatencies);
    const observerContext = summarize(observerContextLatencies);
    const auditPosts = summarize(auditPostLatencies);
    const criticalAuditPosts = summarize(checkpointCriticalChurn.auditPostLatencies);
    const action = summarize([actionRoundTripMs, snakeObserverOverlap.actionRoundTripMs, ...actionMatrix.samples.action]);
    const snakeObserverRoute = summarize(snakeObserverOverlap.routeLatencies);
    const snakeBoardRoute = summarize(snakeObserverOverlap.boardRouteLatencies);
    const snakeStatusRoute = summarize(snakeObserverOverlap.statusRouteLatencies);
    const snakeObserverContext = summarize(snakeObserverOverlap.contextLatencies);
    const eventLoopP99Ms = eventLoop.percentile(99) / 1_000_000;
    const memory = evaluateProductionPathMemory({ baselineRss, peakRss });
    const durationMs = performance.now() - startedAt;
    const expectedNormal = Math.ceil(observerDurationMs / 1_000);
    const expectedBurst = Math.ceil(observerDurationMs / 250);
    const passed = planning.p95 <= 50
      && planning.p99 <= 100
      && observerContext.p95 <= 25
      && observerContext.p99 <= 50
      && observerRoute.p95 <= 100
      && observerRoute.p99 <= 200
      && statusRoute.p99 <= 200
      && auditPosts.p99 <= 450
      && criticalAuditPosts.count === CRITICAL_AUDIT_CHURN_WRITES
      && criticalAuditPosts.p99 <= 450
      && checkpointCriticalChurn.maximumActiveWriters === 1
      && checkpointCriticalChurn.diskAcknowledgements === CRITICAL_AUDIT_CHURN_WRITES + 1
      && checkpointCriticalChurn.observerWrites === 0
      && checkpointCriticalChurn.observerErrors.length === 0
      && checkpointCriticalChurn.finalCheckpointBytes <= CHECKPOINT_MAX_BYTES
      && action.p99 <= 1_200
      && Object.values(actionMatrix.latencyMs.byOperation).every((summary) => (
        summary.count >= actionSamplesPerOperation && summary.p95 <= 1_000 && summary.p99 <= 1_500
      ))
      && actionMatrix.physicalClicks === actionSamplesPerOperation * 4
      && actionMatrix.preliminaryClicks === actionSamplesPerOperation
      && actionMatrix.exactAcknowledgements === actionSamplesPerOperation * 4
      && actionMatrix.observerWrites === 0
      && actionMatrix.maximumInFlight <= 1
      && actionMatrix.finalExecutionMetrics?.inFlight === 0
      && actionMatrix.finalExecutionMetrics?.completed <= 64
      && actionMatrix.finalExecutionMetrics?.requestSignatures <= 64
      && actionMatrix.settlement?.pending === false
      && snakeObserverOverlap.physicalClicks === 1
      && snakeObserverOverlap.exactAcknowledgements === 1
      && snakeObserverOverlap.observerWrites === 0
      && snakeObserverOverlap.observerErrors.length === 0
      && snakeObserverOverlap.observerSamples.normal === expectedNormal
      && snakeObserverOverlap.observerSamples.burst === expectedBurst
      && snakeObserverOverlap.boardObserverSamples.normal === expectedNormal
      && snakeObserverOverlap.boardObserverSamples.burst === expectedBurst
      && snakeObserverOverlap.maximumInFlight <= 1
      && snakeObserverOverlap.finalMetrics?.inFlight === 0
      && snakeObserverRoute.p99 <= 200
      && snakeBoardRoute.p99 <= 200
      && snakeStatusRoute.p99 <= 200
      && snakeObserverContext.p99 <= 50
      && snakeObserverOverlap.actionRoundTripMs <= 1_500
      && eventLoopP99Ms <= 75
      && memory.passed
      && durationMs < 30_000
      && preseedCheckpointBytes >= CHECKPOINT_PRESEED_MIN_BYTES
      && preseedCheckpointBytes <= CHECKPOINT_MAX_BYTES
      && finalCheckpointBytes <= 2 * 1024 * 1024
      && normal.latencies.length === expectedNormal
      && burst.latencies.length === expectedBurst;
    return {
      ok: passed,
      code: passed ? "LIVE_CONTROL_PRODUCTION_PATH_PASSED" : "LIVE_CONTROL_PRODUCTION_PATH_FAILED",
      scenario: {
        formats: ["SNAKE", "AUCTION"],
        bidChurnMs: 75,
        bidStates: contexts.map((entry) => entry.room.currentBid),
        producerDeliveries: { accepted: acceptedProducerDeliveries, staleRejected: rejectedProducerDeliveries },
        observerCadenceHz: [1, 4],
        duplicateSubmissions: actionSamplesPerOperation * 4 * 2 + 4,
        physicalClicks: actionMatrix.physicalClicks + content.state.bidClicks + snakeObserverOverlap.physicalClicks,
        preliminaryNominationClicks: actionMatrix.preliminaryClicks,
        exactAcknowledgements: actionMatrix.exactAcknowledgements + 1 + snakeObserverOverlap.exactAcknowledgements,
        observerWrites: actionMatrix.observerWrites + snakeObserverOverlap.observerWrites,
        snakeObserverOverlap: {
          delayedConfirmationMs: 450,
          physicalClicks: snakeObserverOverlap.physicalClicks,
          exactAcknowledgements: snakeObserverOverlap.exactAcknowledgements,
          observerSamples: snakeObserverOverlap.observerSamples,
          boardObserverSamples: snakeObserverOverlap.boardObserverSamples,
          statusObserverSamples: snakeObserverOverlap.observerSamples,
          observerWrites: snakeObserverOverlap.observerWrites,
          maximumInFlight: snakeObserverOverlap.maximumInFlight,
        },
        samplesPerOperation: actionMatrix.samplesPerOperation,
        persistentCheckpoint: {
          enabled: true,
          entries: 4,
          minimumPreseedBytes: CHECKPOINT_PRESEED_MIN_BYTES,
          preseedBytes: preseedCheckpointBytes,
          preseedEntryBytes,
          finalBytes: finalCheckpointBytes,
          plannedDiskAck: true,
          finalDiskAck: true,
        },
        criticalAuditChurn: {
          writes: checkpointCriticalChurn.writes,
          intervalMs: checkpointCriticalChurn.intervalMs,
          diskAcknowledgements: checkpointCriticalChurn.diskAcknowledgements,
          maximumActiveWriters: checkpointCriticalChurn.maximumActiveWriters,
          observerSamples: checkpointCriticalChurn.observerSamples,
          observerWrites: checkpointCriticalChurn.observerWrites,
          observerErrors: checkpointCriticalChurn.observerErrors,
          finalCheckpointBytes: checkpointCriticalChurn.finalCheckpointBytes,
          finalSequence: checkpointCriticalChurn.finalSequence,
        },
        resultCodes: actionMatrix.resultCodes,
        settlement: actionMatrix.settlement,
      },
      latencyMs: {
        preparation: preparationMs,
        planning,
        observerContext,
        observerRoute,
        statusRoute,
        snakeObserverContext,
        snakeObserverRoute,
        snakeBoardRoute,
        snakeStatusRoute,
        auditPosts,
        criticalAuditPosts,
        action,
        actionByOperation: actionMatrix.latencyMs.byOperation,
      },
      budgets: {
        planningP95Ms: 50,
        planningP99Ms: 100,
        observerContextP95Ms: 25,
        observerContextP99Ms: 50,
        observerRouteP95Ms: 100,
        observerRouteP99Ms: 200,
        auditPostP99Ms: 450,
        actionP99Ms: 1_200,
        eventLoopP99Ms: 75,
        peakRssMb: PRODUCTION_PATH_MEMORY_BUDGETS.peakRssMb,
        totalDurationMs: 30_000,
      },
      resources: {
        durationMs,
        eventLoopP99Ms,
        ...memory,
        maximumActiveAuditPosts: maximumActivePosts,
        queue: {
          maximumInFlight: Math.max(
            snakeObserverOverlap.maximumInFlight,
            0,
            ...queueSamples.map((sample) => sample.inFlight),
          ),
          matrixMaximumInFlight: actionMatrix.maximumInFlight,
          matrixFinal: actionMatrix.finalExecutionMetrics,
          final: content.executionMetrics(),
        },
      },
      observers: {
        expected: { normal: expectedNormal, burst: expectedBurst },
        actual: { normal: normal.latencies.length, burst: burst.latencies.length },
        errors: observerErrors,
        snake: {
          actual: snakeObserverOverlap.observerSamples,
          boardActual: snakeObserverOverlap.boardObserverSamples,
          errors: snakeObserverOverlap.observerErrors,
        },
      },
      finalControl: {
        sequence: finalControl.body.control.sequence,
        pendingActionCount: finalControl.body.control.pendingActionCount,
        eventCount: finalControl.body.control.events.length,
      },
    };
  } finally {
    clearInterval(memorySampler);
    eventLoop.disable();
    if (routeServer) await routeServer.close();
    background?.restore();
    if (priorCheckpointEnv.enabled === undefined) delete process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT;
    else process.env.DRAFTFORGE_PERSIST_DRAFT_AUDIT_CHECKPOINT = priorCheckpointEnv.enabled;
    if (priorCheckpointEnv.path === undefined) delete process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH;
    else process.env.DRAFTFORGE_DRAFT_AUDIT_CHECKPOINT_PATH = priorCheckpointEnv.path;
    if (priorCheckpointEnv.revision === undefined) delete process.env.DRAFTFORGE_RELEASE_REVISION;
    else process.env.DRAFTFORGE_RELEASE_REVISION = priorCheckpointEnv.revision;
    if (checkpointDirectory) await rm(checkpointDirectory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  if (argv.length === 0) return { observerDurationMs: 1_250 };
  if (argv.length !== 2 || argv[0] !== "--observer-duration-ms") throw new Error("USAGE");
  const observerDurationMs = Number(argv[1]);
  if (!Number.isInteger(observerDurationMs) || observerDurationMs < 1_000 || observerDurationMs > 5_000) {
    throw new Error("USAGE");
  }
  return { observerDurationMs };
}

async function main() {
  try {
    const result = await runLiveControlProductionPath(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error instanceof Error && error.message === "USAGE" ? "USAGE" : "LIVE_CONTROL_PRODUCTION_PATH_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = error instanceof Error && error.message === "USAGE" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
