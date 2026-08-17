import {
  buildDraftDecision,
  buildPlayerPoolIndex,
  chooseAuctionNomination,
  type DraftPick,
  type DraftPlayer,
  type LeagueSettings,
  type PlayerPoolIndex,
  type Recommendation,
  type StrategyId,
} from "./draft-engine.ts";
import {
  isCompleteFreshIntelligenceSnapshot,
  mergeConsensus,
  normalizePlayerName,
  type IntelligenceSource,
} from "./consensus.ts";
import type { EspnContext } from "./espn-context-state.ts";

export type DraftDayBridgeInput = {
  league: LeagueSettings;
  espnPlayers: DraftPlayer[];
  picks: DraftPick[];
  sources: IntelligenceSource[];
  room: EspnContext;
  strategy?: StrategyId;
  evaluatedAt?: string | number | Date;
  prepared?: DraftDayPreparedState;
};

export type DraftDayPreparedState = {
  players: DraftPlayer[];
  playerPool: PlayerPoolIndex;
};

export type DraftDayCandidate = {
  playerId: number;
  playerName: string;
  position: string;
  fillsMandatoryStarter: boolean;
};

export type DraftDayAction = {
  operation: "SELECT" | "BID" | "NOMINATE";
  expectedLeagueId: string;
  expectedPick?: number;
  expectedCurrentBid?: number;
  requireOnClock?: boolean;
  playerId: number;
  playerName: string;
  position: string;
  fillsMandatoryStarter: boolean;
  amount?: number;
  maxApprovedBid?: number;
  candidates?: DraftDayCandidate[];
};

export type DraftDayBridgeResult = {
  ok: boolean;
  code: string;
  blockers: string[];
  sourceCoverage: number;
  sourceIds: string[];
  action: DraftDayAction | null;
  actionReason: string;
  recommendations: Recommendation[];
  auctionPlan: ReturnType<typeof buildDraftDecision>["auctionPlan"];
};

const MIN_ACTION_SECONDS = 5;
const MAX_ACTION_CANDIDATES = 20;

export function prepareDraftDayBridge(
  league: LeagueSettings,
  espnPlayers: DraftPlayer[],
  sources: IntelligenceSource[],
  evaluatedAt?: string | number | Date,
): DraftDayPreparedState {
  const players = mergeConsensus(espnPlayers, sources, league, { evaluatedAt });
  return { players, playerPool: buildPlayerPoolIndex(players, league) };
}

function roomPlayerMatches(player: Recommendation, room: EspnContext) {
  const nominatedPlayerId = Number(room.nominatedPlayerId);
  if (Number.isInteger(nominatedPlayerId) && nominatedPlayerId > 0) {
    return nominatedPlayerId === player.id;
  }
  const nominee = normalizePlayerName(String(room.nominatedPlayer || ""));
  const playerName = normalizePlayerName(player.name);
  return Boolean(nominee && playerName && nominee === playerName);
}

function duplicatePickIds(picks: DraftPick[]) {
  const ids = picks.map((pick) => pick.playerId);
  return ids.some((id, index) => ids.indexOf(id) !== index);
}

function globalBlockers(input: DraftDayBridgeInput) {
  const { league, espnPlayers, picks, room, sources } = input;
  const blockers: string[] = [];
  if (!isCompleteFreshIntelligenceSnapshot(sources, input.evaluatedAt)) blockers.push("FIVE_SOURCE_SNAPSHOT_NOT_READY");
  if (espnPlayers.length < league.size * league.rosterSize) blockers.push("ESPN_PLAYER_POOL_INCOMPLETE");
  if (!Number.isInteger(league.teamId) || Number(league.teamId) <= 0) blockers.push("ESPN_TEAM_UNKNOWN");
  if (String(room.leagueId || "") !== String(league.id)) blockers.push("WRONG_ESPN_LEAGUE");
  if (Number(room.teamId) !== Number(league.teamId)) blockers.push("WRONG_ESPN_TEAM");
  if (room.inDraftRoom !== true) blockers.push("NOT_IN_ESPN_DRAFT_ROOM");
  if (room.soundMuted !== true) blockers.push("ESPN_SOUND_NOT_MUTED");
  if (room.autopickActive === true) blockers.push("ESPN_AUTOPICK_ACTIVE");
  if (duplicatePickIds(picks)) blockers.push("DUPLICATE_ESPN_PLAYER");
  return blockers;
}

function candidate(player: Recommendation): DraftDayCandidate {
  return {
    playerId: player.id,
    playerName: player.name,
    position: player.pos,
    fillsMandatoryStarter: player.fillsMandatoryStarter,
  };
}

function nominationShortlist(
  recommendations: Recommendation[],
  league: LeagueSettings,
  auctionPlan: ReturnType<typeof buildDraftDecision>["auctionPlan"],
) {
  const ordered: DraftDayCandidate[] = [];
  let remaining = [...recommendations];
  while (ordered.length < MAX_ACTION_CANDIDATES && remaining.length) {
    const next = chooseAuctionNomination(remaining, league, auctionPlan);
    if (!next) break;
    ordered.push(candidate(next.player));
    remaining = remaining.filter((player) => player.id !== next.player.id);
  }
  return ordered;
}

function actionWindowReady(room: EspnContext) {
  return Number.isFinite(room.remainingSeconds) && Number(room.remainingSeconds) >= MIN_ACTION_SECONDS;
}

export function buildDraftDayBridgeResult(input: DraftDayBridgeInput): DraftDayBridgeResult {
  const strategy = input.strategy || "BALANCED";
  const blockers = globalBlockers(input);
  const prepared = input.prepared || prepareDraftDayBridge(input.league, input.espnPlayers, input.sources, input.evaluatedAt);
  const { players, playerPool } = prepared;
  const decision = buildDraftDecision(
    players,
    input.picks,
    input.league,
    strategy,
    Number(input.room.currentPick || input.picks.length + 1),
    input.room.auctionBudgets || [],
    playerPool,
  );
  const recommendations = decision.recommendations;
  const base = {
    sourceCoverage: isCompleteFreshIntelligenceSnapshot(input.sources, input.evaluatedAt) ? 5 : 1,
    sourceIds: ["espn", ...input.sources.map((source) => source.id)],
    recommendations: recommendations.slice(0, 5),
    auctionPlan: decision.auctionPlan,
  };
  if (blockers.length) {
    return { ok: false, code: blockers[0], blockers, action: null, actionReason: "DraftForge stopped before producing an actionable command.", ...base };
  }

  const room = input.room;
  const league = input.league;
  if (league.draftType === "SNAKE") {
    if (!room.onClock) return { ok: true, code: "MONITORING", blockers: [], action: null, actionReason: "Waiting for ESPN to put this exact team on the clock.", ...base };
    if (!actionWindowReady(room)) return { ok: false, code: "CLOCK_TOO_SHORT", blockers: ["CLOCK_TOO_SHORT"], action: null, actionReason: "The safe action window has closed.", ...base };
    if (room.actionSurfaceReady !== true) return { ok: false, code: "PLAYER_POOL_STALE", blockers: ["PLAYER_POOL_STALE"], action: null, actionReason: "ESPN's player surface is still changing.", ...base };
    const top = recommendations[0];
    if (!top) return { ok: false, code: "NO_LEGAL_PLAYER", blockers: ["NO_LEGAL_PLAYER"], action: null, actionReason: "No legal roster candidate remains.", ...base };
    // ESPN virtualizes the available-player table and may not render the top
    // recommendation immediately. Keep a deeper, deterministic action
    // shortlist so the page runtime can preserve model order while resolving
    // the best player ESPN actually exposes for this exact turn.
    const shortlist = recommendations.slice(0, MAX_ACTION_CANDIDATES).map(candidate);
    return {
      ok: true,
      code: "SELECT_READY",
      blockers: [],
      actionReason: top.reasons[0] || "Highest expected-value legal selection.",
      action: {
        operation: "SELECT",
        expectedLeagueId: league.id,
        expectedPick: Number(room.currentPick || input.picks.length + 1),
        requireOnClock: true,
        ...candidate(top),
        candidates: shortlist,
      },
      ...base,
    };
  }

  if (room.nominatedPlayer && Number(room.currentBid) > 0) {
    const nominated = recommendations.find((player) => roomPlayerMatches(player, room));
    if (!nominated) return { ok: true, code: "PASS_UNRANKED_NOMINEE", blockers: [], action: null, actionReason: "The nominee is unavailable, already rostered, or outside the legal player pool.", ...base };
    if (room.leadingBid) return { ok: true, code: "HOLD_LEADING_BID", blockers: [], action: null, actionReason: "Already leading; never raise our own offer.", ...base };
    if (!actionWindowReady(room)) return { ok: false, code: "CLOCK_TOO_SHORT", blockers: ["CLOCK_TOO_SHORT"], action: null, actionReason: "The safe action window has closed.", ...base };
    const nextOffer = Number(room.currentBid) + 1;
    const legalEspnMaximum = Number(room.maxLegalBid);
    if (!Number.isFinite(legalEspnMaximum) || legalEspnMaximum < 1) {
      return { ok: false, code: "BUDGET_UNKNOWN", blockers: ["BUDGET_UNKNOWN"], action: null, actionReason: "ESPN did not expose the one-dollar-reserve maximum.", ...base };
    }
    const ceiling = Math.min(nominated.maxBid, legalEspnMaximum);
    if (nextOffer > ceiling) {
      return { ok: true, code: "WALK_AWAY", blockers: [], action: null, actionReason: `Walk at $${ceiling}; the next legal offer is $${nextOffer}.`, ...base };
    }
    return {
      ok: true,
      code: "BID_READY",
      blockers: [],
      actionReason: `Bid exactly $${nextOffer}; never exceed the $${ceiling} source-backed ceiling.`,
      action: {
        operation: "BID",
        expectedLeagueId: league.id,
        expectedCurrentBid: Number(room.currentBid),
        requireOnClock: false,
        ...candidate(nominated),
        amount: nextOffer,
        maxApprovedBid: ceiling,
      },
      ...base,
    };
  }

  if (room.onClock) {
    if (!actionWindowReady(room)) return { ok: false, code: "CLOCK_TOO_SHORT", blockers: ["CLOCK_TOO_SHORT"], action: null, actionReason: "The safe nomination window has closed.", ...base };
    if (room.actionSurfaceReady !== true) return { ok: false, code: "PLAYER_POOL_STALE", blockers: ["PLAYER_POOL_STALE"], action: null, actionReason: "ESPN's nomination surface is still changing.", ...base };
    const nomination = chooseAuctionNomination(recommendations, league, decision.auctionPlan);
    if (!nomination) return { ok: false, code: "NO_LEGAL_NOMINATION", blockers: ["NO_LEGAL_NOMINATION"], action: null, actionReason: "No legal salary-cap nomination remains.", ...base };
    const legalEspnMaximum = Number(room.maxLegalBid);
    if (!Number.isFinite(legalEspnMaximum) || legalEspnMaximum < nomination.openingBid) {
      return { ok: false, code: "BUDGET_RESERVE", blockers: ["BUDGET_RESERVE"], action: null, actionReason: "The opening offer would violate ESPN's one-dollar reserve.", ...base };
    }
    return {
      ok: true,
      code: "NOMINATION_READY",
      blockers: [],
      actionReason: nomination.reason,
      action: {
        operation: "NOMINATE",
        expectedLeagueId: league.id,
        requireOnClock: true,
        ...candidate(nomination.player),
        amount: nomination.openingBid,
        candidates: nominationShortlist(recommendations, league, decision.auctionPlan),
      },
      ...base,
    };
  }

  return { ok: true, code: "MONITORING", blockers: [], action: null, actionReason: "Monitoring the active offer and nomination order.", ...base };
}
