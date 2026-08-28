"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  auctionBudgetUsage,
  describeRecommendation,
  buildDraftDecision,
  buildPlayerPoolIndex,
  chooseAuctionNomination,
  type DraftPick,
  type DraftPlayer,
  type LeagueSettings,
  type Recommendation,
  type StrategyId,
} from "./lib/draft-engine";
import {
  isCompleteFreshIntelligenceSnapshot,
  isIntelligenceSourceFresh,
  intelligenceQuarterbackMode,
  intelligenceSnapshotCacheKey,
  mergeConsensus,
  preserveCompleteFreshIntelligenceSnapshot,
  readCompleteFreshIntelligenceSnapshot,
  rememberCompleteFreshIntelligenceSnapshot,
  type IntelligenceSource,
} from "./lib/consensus";
import { contextCanRebindDraftTab, contextMatchesActiveDraftTab } from "./lib/espn-context";
import { resolveEspnNominatedPlayer, resolveLiveBoardDisplayRank, stabilizeEspnContext, type EspnContext } from "./lib/espn-context-state";
import { canArmAutoDraft } from "./lib/auto-draft-safety";
import { liveEspnRecommendations, reconcileEspnPicks, resolveAuctionSales, resolveOwnRoster } from "./lib/espn-reconciliation";
import { draftUiReducer, INITIAL_DRAFT_UI_STATE } from "./lib/draft-ui-state";
import { buildDraftPresentation, resolveActionSurfaceStatus, resolveLiveOperatorStatus } from "./lib/draft-presentation";
import {
  draftAuditChecklistBindingKey,
  MAX_DRAFT_ACTION_TELEMETRY_EVENTS,
  resolveDraftAuditChecklistReady,
  type DraftActionTelemetryEvent,
  type DraftAuditRosterEntry,
  type DraftAuditSnapshot,
  type DraftRuntimeDiagnostics,
} from "./lib/draft-audit";
import { compactDraftProfiles, persistDraftProfiles, upsertDraftProfile, type DraftProfile } from "./lib/profiles";
import {
  buildSalaryCapEvidence,
  observeSalaryCapDecision,
  type SalaryCapDecisionObservation,
} from "./lib/salary-cap-evidence";
import { mergeAuthenticatedSleeperEvidence } from "./lib/sleeper-evidence";
import {
  canRetryPracticeRoomCleanup,
  MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS,
  resolvePracticeRoomCleanupRequest,
} from "./lib/practice-room-cleanup";

const DEMO_PLAYERS: DraftPlayer[] = [
  { id: 1, name: "Ja'Marr Chase", team: "CIN", pos: "WR", rank: 1, adp: 1.4, auction: 61, projected: 312 },
  { id: 2, name: "Bijan Robinson", team: "ATL", pos: "RB", rank: 2, adp: 2.1, auction: 59, projected: 298 },
  { id: 3, name: "Jahmyr Gibbs", team: "DET", pos: "RB", rank: 3, adp: 3.2, auction: 57, projected: 291 },
  { id: 4, name: "Justin Jefferson", team: "MIN", pos: "WR", rank: 4, adp: 4.6, auction: 56, projected: 300 },
  { id: 5, name: "CeeDee Lamb", team: "DAL", pos: "WR", rank: 5, adp: 5.1, auction: 54, projected: 294 },
  { id: 6, name: "Puka Nacua", team: "LAR", pos: "WR", rank: 6, adp: 6.8, auction: 51, projected: 286 },
  { id: 7, name: "Saquon Barkley", team: "PHI", pos: "RB", rank: 7, adp: 7.5, auction: 49, projected: 276 },
  { id: 8, name: "Malik Nabers", team: "NYG", pos: "WR", rank: 8, adp: 9.7, auction: 47, projected: 278 },
  { id: 9, name: "Amon-Ra St. Brown", team: "DET", pos: "WR", rank: 9, adp: 8.4, auction: 46, projected: 281 },
  { id: 10, name: "De'Von Achane", team: "MIA", pos: "RB", rank: 10, adp: 11.8, auction: 44, projected: 265 },
  { id: 11, name: "Brock Bowers", team: "LV", pos: "TE", rank: 11, adp: 13.5, auction: 39, projected: 244 },
  { id: 12, name: "Nico Collins", team: "HOU", pos: "WR", rank: 12, adp: 14.9, auction: 38, projected: 260 },
  { id: 13, name: "Josh Allen", team: "BUF", pos: "QB", rank: 13, adp: 20.3, auction: 36, projected: 388 },
  { id: 14, name: "Brian Thomas Jr.", team: "JAX", pos: "WR", rank: 14, adp: 17.1, auction: 35, projected: 252 },
  { id: 15, name: "Jonathan Taylor", team: "IND", pos: "RB", rank: 15, adp: 15.8, auction: 34, projected: 251 },
  { id: 16, name: "Lamar Jackson", team: "BAL", pos: "QB", rank: 16, adp: 23.8, auction: 31, projected: 374 },
  { id: 17, name: "Trey McBride", team: "ARI", pos: "TE", rank: 17, adp: 22.4, auction: 29, projected: 221 },
  { id: 18, name: "Drake London", team: "ATL", pos: "WR", rank: 18, adp: 19.2, auction: 29, projected: 247 },
  { id: 19, name: "Bucky Irving", team: "TB", pos: "RB", rank: 19, adp: 24.7, auction: 27, projected: 238 },
  { id: 20, name: "Jayden Daniels", team: "WAS", pos: "QB", rank: 20, adp: 27.3, auction: 25, projected: 356 },
];

const DEMO_AUCTION_VALUES = new Map(DEMO_PLAYERS.map((player) => [player.id, Number(player.auction || 1)]));

function displayAuctionValue(playerId: number, leagueId: string, calculated: number) {
  // The preview intentionally ships a short 20-player board, not a complete
  // 12-team auction pool. Show its explicit ESPN-style dollar examples rather
  // than the production curve that allocates a full room budget across the
  // complete imported player universe.
  return Math.round(leagueId === "demo" ? DEMO_AUCTION_VALUES.get(playerId) || calculated : calculated);
}

const DEMO_LEAGUE: LeagueSettings = {
  id: "demo", name: "ESPN League Preview", season: 2026, size: 12, teamId: 4, draftType: "SNAKE",
  secondsPerPick: 90, rosterSize: 16, auctionBudget: 200, lineupSlotCounts: { "0": 1, "2": 2, "4": 2, "6": 1, "23": 1, "16": 1, "17": 1, "20": 7 },
  positionLimits: {}, scoringLabel: "PPR", scoringRules: 19, keeperCount: 0, pickOrder: [], teams: [],
};

const DEMO_SALARY_LEAGUE: LeagueSettings = {
  ...DEMO_LEAGUE,
  name: "ESPN Salary-Cap Preview",
  draftType: "AUCTION",
};

const FILTERS = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"] as const;
const STRATEGIES: { id: StrategyId; label: string; description: string }[] = [
  { id: "BALANCED", label: "Balanced value", description: "Take the strongest value while filling starters naturally." },
  { id: "HERO_RB", label: "Hero RB", description: "Secure one premium RB, then lean into receivers and value." },
  { id: "ZERO_RB", label: "Zero RB", description: "Prioritize elite receivers and onesie positions early." },
  { id: "ELITE_QB", label: "Elite QB", description: "Raise the value of top dual-threat quarterbacks." },
];

type ExtensionStatus = "checking" | "missing" | "ready" | "connecting" | "connected" | "error";

function sendToExtension(type: string, payload: Record<string, unknown> = {}) {
  window.postMessage({ source: "draftforge-web", type, payload }, window.location.origin);
}

function rosterSlots(league: LeagueSettings) {
  const labels: Record<string, string> = { "0": "QB", "2": "RB", "3": "RB/WR", "4": "WR", "5": "WR/TE", "6": "TE", "7": "OP", "16": "DST", "17": "K", "20": "BN", "21": "IR", "23": "FLEX" };
  const slots = Object.entries(league.lineupSlotCounts || {}).flatMap(([slot, count]) => slot === "21"
    ? []
    : Array.from({ length: Number(count) }, () => labels[slot] || `S${slot}`));
  // ESPN does not guarantee lineup-slot key order and often returns bench
  // before FLEX. Assign every starter before bench so the displayed lineup
  // agrees with the engine's starter/flex deficit calculation.
  return [...slots.filter((slot) => slot !== "BN"), ...slots.filter((slot) => slot === "BN")];
}

function actualPicks(picks: DraftPick[] | undefined) {
  return (picks || []).filter((pick) => ![0, -1].includes(Number(pick.playerId)) && Number(pick.teamId) > 0);
}

function mergeDraftPicks(current: DraftPick[], incoming: DraftPick[]) {
  const merged = new Map(current.map((pick) => [pick.playerId, pick]));
  for (const pick of incoming) merged.set(pick.playerId, { ...merged.get(pick.playerId), ...pick });
  return [...merged.values()].sort((a, b) => a.overall - b.overall);
}

function normalizeName(value: string | null | undefined) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const ESPN_ROSTER_CONFIRMATION_GRACE_MS = 6000;
const INTELLIGENCE_REFRESH_MS = 5 * 60 * 1000;
const EXACT_TAB_WATCHDOG_MS = 5000;
const ACTION_CANDIDATE_LIMIT = 64;
const MIN_SNAKE_SELECTION_WINDOW_SECONDS = 10;
const MIN_OTHER_ACTION_WINDOW_SECONDS = 5;
const COMMAND_CENTER_PUBLISHER = {
  sessionId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  startedAt: new Date().toISOString(),
};
const RETRIABLE_SELECT_CODES = new Set(["PLAYER_NOT_FOUND", "ACTION_TIMEOUT", "ROSTER_NOT_CONFIRMED"]);
const RETRIABLE_TURN_CODES = new Set(["ACTION_NOT_FOUND", "PLAYER_CONTROL_DRIFT", "PLAYER_POOL_STALE", "PICK_CHANGED", "NOT_ON_CLOCK", "CLOCK_TOO_SHORT", "BID_CHANGED", "BID_OUT_OF_SEQUENCE"]);
const RETRIABLE_BID_CODES = new Set([...RETRIABLE_TURN_CODES, "ACTION_TIMEOUT", "NOMINEE_MISMATCH", "NOMINEE_UNKNOWN"]);
const RETRIABLE_NOMINATION_CODES = new Set(["NOT_ON_CLOCK", "CLOCK_TOO_SHORT", "NOMINATION_ACTIVE"]);

function normalizeImportedLeague(league: LeagueSettings) {
  const rawSettings = league.rawSettings as { draftSettings?: { type?: unknown; keeperCount?: unknown } } | undefined;
  const draft = rawSettings?.draftSettings;
  const draftType = String(draft?.type || "").trim().toUpperCase() === "AUCTION" || Number(draft?.type) === 2 ? "AUCTION" : league.draftType;
  const keeperCount = Number(draft?.keeperCount);
  return {
    ...league,
    draftType,
    keeperCount: Number.isInteger(keeperCount) && keeperCount >= 0 ? keeperCount : league.keeperCount,
  };
}

export default function Home() {
  const [extension, setExtension] = useState<ExtensionStatus>("checking");
  const [context, setContext] = useState<EspnContext>({});
  const [league, setLeague] = useState<LeagueSettings>(DEMO_LEAGUE);
  const [espnPlayers, setEspnPlayers] = useState<DraftPlayer[]>(DEMO_PLAYERS);
  const [sources, setSources] = useState<IntelligenceSource[]>([]);
  const intelligenceSnapshotsRef = useRef(new Map<string, IntelligenceSource[]>());
  const [ui, dispatchUi] = useReducer(draftUiReducer, INITIAL_DRAFT_UI_STATE);
  const { sourcesOpen, intelligenceLoading, settingsOpen, rawSettingsOpen, strategyOpen, autoWarning } = ui;
  const [picks, setPicks] = useState<DraftPick[]>([]);
  const [settingsConfirmed, setSettingsConfirmed] = useState(false);
  const [leagueId, setLeagueId] = useState("");
  const [strategy, setStrategy] = useState<StrategyId>("BALANCED");
  const [autoDraft, setAutoDraft] = useState(false);
  const [autoArmVerification, setAutoArmVerification] = useState<{ requestId: number; context: EspnContext } | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(1);
  const [actionState, setActionState] = useState("Waiting for ESPN connection.");
  const [profiles, setProfiles] = useState<Record<string, DraftProfile>>({});
  const [rejectedSnakePlayerIds, setRejectedSnakePlayerIds] = useState<number[]>([]);
  const [actionRetryNonce, setActionRetryNonce] = useState(0);
  const [activeEspnTabId, setActiveEspnTabId] = useState<number | null>(null);
  const [authenticatedImportAt, setAuthenticatedImportAt] = useState("");
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<DraftRuntimeDiagnostics | null>(null);
  const [auditHeartbeat, setAuditHeartbeat] = useState(0);
  const [telemetryVersion, setTelemetryVersion] = useState(0);
  const [pendingAuctionNomination, setPendingAuctionNomination] = useState<{
    playerId: number;
    playerName: string;
    intent: "TARGET" | "DRAIN";
  } | null>(null);
  const lastAutoAction = useRef("");
  const profilesRef = useRef<Record<string, DraftProfile>>({});
  const espnPlayersRef = useRef<DraftPlayer[]>(DEMO_PLAYERS);
  const activeLeagueSettingsRef = useRef<LeagueSettings>(DEMO_LEAGUE);
  const activeLeagueRef = useRef("demo");
  const activeSourceLeagueRef = useRef("demo");
  const activeEspnTabRef = useRef<number | null>(null);
  const activeEspnTeamRef = useRef<number | null>(null);
  const actionRequestSequenceRef = useRef(0);
  const autoArmRequestSequenceRef = useRef(0);
  const pendingAutoArmRequestRef = useRef<number | null>(null);
  const pendingLiveRoomAutoArmRef = useRef(false);
  const latestActionRequestRef = useRef(0);
  const pendingSnakeActionRef = useRef<{
    playerId: number;
    playerName: string;
    expectedPick: number;
    sentAt: number;
    beforeRosterPlayerIds: number[];
    failed?: boolean;
  } | null>(null);
  const pendingAuctionNominationRef = useRef<{
    playerId: number;
    playerName: string;
    intent: "TARGET" | "DRAIN";
  } | null>(null);
  const pendingAuctionBidRef = useRef<{
    actionRequestId: number;
    playerId: number;
    playerName: string;
    beforeRosterPlayerIds: number[];
  } | null>(null);
  const draftAuditDigestRef = useRef("");
  const draftAuditPendingRef = useRef("");
  const finalizedPracticeRoomRef = useRef("");
  const practiceRoomCleanupAttemptRef = useRef({ key: "", attempts: 0 });
  const actionTelemetryRef = useRef<DraftActionTelemetryEvent[]>([]);
  const pendingActionTelemetryRef = useRef(new Map<number, {
    sentAt: number;
    submittedAt: number | null;
    operation: "SELECT" | "BID" | "NOMINATE";
    clockSeconds: number | null;
    automatic: boolean;
    playerId: number;
    amount: number;
    maxApprovedBid: number;
    nominationIntent: "TARGET" | "DRAIN" | null;
  }>());
  const salaryCapDecisionObservationsRef = useRef(new Map<number, SalaryCapDecisionObservation>());
  const sleeperEvidenceLedgerRef = useRef<{ leagueId: string; candidates: DraftAuditSnapshot["sleeperEvidence"]["candidates"] }>({
    leagueId: "",
    candidates: [],
  });
  const lastRosterStatusKeyRef = useRef("");
  const lastValidatedLiveChecklistBindingRef = useRef("");
  const authoritativeRosterContext = useMemo(() => ({
    inDraftRoom: context.inDraftRoom,
    ownRoster: context.ownRoster,
    snakePicks: context.snakePicks,
  }), [context.inDraftRoom, context.ownRoster, context.snakePicks]);
  // ESPN's visible roster can advance several $1 auctions between API polls.
  // Reconcile it synchronously for every decision instead of waiting for the
  // state-sync effect below to commit on a later render.
  const authoritativePicks = useMemo(
    () => reconcileEspnPicks(picks, authoritativeRosterContext, league.teamId, espnPlayers, league),
    [picks, authoritativeRosterContext, league, espnPlayers],
  );

  function activateProfile(profile: DraftProfile, roomContext?: EspnContext) {
    activeLeagueRef.current = profile.league.id;
    activeSourceLeagueRef.current = profile.league.id;
    finalizedPracticeRoomRef.current = "";
    practiceRoomCleanupAttemptRef.current = { key: "", attempts: 0 };
    activeLeagueSettingsRef.current = profile.league;
    // A saved profile does not prove which currently-open ESPN tab supplied
    // it. Require a fresh explicit import before it can become actionable.
    activeEspnTabRef.current = null;
    setActiveEspnTabId(null);
    setAuthenticatedImportAt("");
    setRuntimeDiagnostics(null);
    activeEspnTeamRef.current = null;
    latestActionRequestRef.current = ++actionRequestSequenceRef.current;
    pendingSnakeActionRef.current = null;
    pendingAuctionNominationRef.current = null;
    pendingAuctionBidRef.current = null;
    setPendingAuctionNomination(null);
    setRejectedSnakePlayerIds([]);
    pendingActionTelemetryRef.current.clear();
    actionTelemetryRef.current = [];
    salaryCapDecisionObservationsRef.current.clear();
    sleeperEvidenceLedgerRef.current = { leagueId: profile.league.id, candidates: [] };
    setTelemetryVersion((version) => version + 1);
    setLeague(profile.league);
    setEspnPlayers(profile.espnPlayers);
    setPicks(profile.picks);
    setSettingsConfirmed(profile.settingsConfirmed);
    setStrategy(profile.strategy);
    setLeagueId(profile.league.id);
    setAutoDraft(false);
    pendingLiveRoomAutoArmRef.current = false;
    pendingAutoArmRequestRef.current = null;
    setAutoArmVerification(null);
    dispatchUi({ type: "set", key: "autoWarning", value: false });
    // Never carry an on-clock state from a different ESPN tab into this league.
    setContext(roomContext && contextMatchesActiveDraftTab(roomContext, profile.league.id, activeEspnTabRef.current) ? roomContext : {});
    setExtension("connected");
    dispatchUi({ type: "set", key: "settingsOpen", value: !profile.settingsConfirmed });
    setActionState(`${profile.league.name} loaded. Auto-Draft is off.`);
  }

  function startAnotherLeague() {
    activeLeagueRef.current = "demo";
    activeSourceLeagueRef.current = "demo";
    finalizedPracticeRoomRef.current = "";
    practiceRoomCleanupAttemptRef.current = { key: "", attempts: 0 };
    activeLeagueSettingsRef.current = DEMO_LEAGUE;
    activeEspnTabRef.current = null;
    setActiveEspnTabId(null);
    setAuthenticatedImportAt("");
    setRuntimeDiagnostics(null);
    activeEspnTeamRef.current = null;
    latestActionRequestRef.current = ++actionRequestSequenceRef.current;
    pendingSnakeActionRef.current = null;
    pendingAuctionNominationRef.current = null;
    pendingAuctionBidRef.current = null;
    setPendingAuctionNomination(null);
    setRejectedSnakePlayerIds([]);
    pendingActionTelemetryRef.current.clear();
    actionTelemetryRef.current = [];
    salaryCapDecisionObservationsRef.current.clear();
    sleeperEvidenceLedgerRef.current = { leagueId: "demo", candidates: [] };
    setTelemetryVersion((version) => version + 1);
    setLeague(DEMO_LEAGUE);
    setEspnPlayers(DEMO_PLAYERS);
    setPicks([]);
    setLeagueId("");
    setSettingsConfirmed(false);
    setAutoDraft(false);
    pendingLiveRoomAutoArmRef.current = false;
    pendingAutoArmRequestRef.current = null;
    setAutoArmVerification(null);
    dispatchUi({ type: "set", key: "autoWarning", value: false });
    setContext({});
    setExtension("ready");
    dispatchUi({ type: "set", key: "settingsOpen", value: true });
    setActionState("Open the other ESPN league, then import it.");
  }

  function previewDraftFormat(draftType: "SNAKE" | "AUCTION") {
    const previewLeague = draftType === "AUCTION" ? DEMO_SALARY_LEAGUE : DEMO_LEAGUE;
    activeLeagueRef.current = previewLeague.id;
    activeSourceLeagueRef.current = previewLeague.id;
    finalizedPracticeRoomRef.current = "";
    practiceRoomCleanupAttemptRef.current = { key: "", attempts: 0 };
    activeLeagueSettingsRef.current = previewLeague;
    activeEspnTabRef.current = null;
    setActiveEspnTabId(null);
    setAuthenticatedImportAt("");
    setRuntimeDiagnostics(null);
    activeEspnTeamRef.current = null;
    latestActionRequestRef.current = ++actionRequestSequenceRef.current;
    pendingSnakeActionRef.current = null;
    pendingAuctionNominationRef.current = null;
    pendingAuctionBidRef.current = null;
    pendingAutoArmRequestRef.current = null;
    setPendingAuctionNomination(null);
    setRejectedSnakePlayerIds([]);
    pendingActionTelemetryRef.current.clear();
    actionTelemetryRef.current = [];
    salaryCapDecisionObservationsRef.current.clear();
    sleeperEvidenceLedgerRef.current = { leagueId: previewLeague.id, candidates: [] };
    setTelemetryVersion((version) => version + 1);
    setAutoArmVerification(null);
    dispatchUi({ type: "set", key: "autoWarning", value: false });
    setLeague(previewLeague);
    setEspnPlayers(DEMO_PLAYERS);
    setPicks([]);
    setSettingsConfirmed(false);
    setAutoDraft(false);
    pendingLiveRoomAutoArmRef.current = false;
    setContext({});
    setExtension("ready");
    dispatchUi({ type: "set", key: "settingsOpen", value: false });
    setActionState(`${draftType === "AUCTION" ? "Salary-cap" : "Snake"} preview only. Import ESPN before any draft action.`);
  }

  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const reloadCompanion = currentUrl.searchParams.get("reloadCompanion") === "1";
    const recoverLive = currentUrl.searchParams.get("recoverLive") === "1";
    const closePractice = currentUrl.searchParams.get("closePractice") === "1";
    const cleanWorkspace = currentUrl.searchParams.get("cleanWorkspace") === "1";
    const ownedBlankTabIds = (currentUrl.searchParams.get("ownedBlankTabIds") || "")
      .split(",")
      .map(Number)
      .filter(Number.isInteger);
    const recoveryPayload = recoverLive && ["localhost", "127.0.0.1"].includes(currentUrl.hostname)
      ? {
          draftLeagueId: currentUrl.searchParams.get("draftLeagueId") || "",
          sourceLeagueId: currentUrl.searchParams.get("sourceLeagueId") || "",
          teamId: Number(currentUrl.searchParams.get("teamId") || 0),
          season: Number(currentUrl.searchParams.get("season") || 0),
        }
      : null;
    const closePracticePayload = closePractice && ["localhost", "127.0.0.1"].includes(currentUrl.hostname)
      ? {
          draftLeagueId: currentUrl.searchParams.get("draftLeagueId") || "",
          sourceLeagueId: currentUrl.searchParams.get("sourceLeagueId") || "",
          teamId: Number(currentUrl.searchParams.get("teamId") || 0),
          season: Number(currentUrl.searchParams.get("season") || 0),
        }
      : null;
    if (reloadCompanion) {
      currentUrl.searchParams.delete("reloadCompanion");
      window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      sendToExtension("RELOAD_EXTENSION");
    }
    if (recoverLive || closePractice || cleanWorkspace) {
      ["recoverLive", "closePractice", "cleanWorkspace", "ownedBlankTabIds", "draftLeagueId", "sourceLeagueId", "teamId", "season"].forEach((key) => currentUrl.searchParams.delete(key));
      window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    }
    try {
      const saved = compactDraftProfiles(JSON.parse(window.localStorage.getItem("draftforge-leagues-v1") || "{}"));
      profilesRef.current = saved;
      // Local storage is an external system; hydrate the interactive league switcher once it is available.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProfiles(saved);
    } catch { /* ignore an invalid local draft cache */ }
    const timeout = window.setTimeout(() => setExtension((status) => status === "checking" ? "missing" : status), 1200);
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== "draftforge-extension") return;
      const { type, payload } = event.data;
      if ((type === "EXTENSION_READY" || type === "COMMAND_RESULT") && payload?.runtime) {
        setRuntimeDiagnostics(payload.runtime as DraftRuntimeDiagnostics);
      }
      if (type === "EXTENSION_READY" || (type === "COMMAND_RESULT" && payload?.ready)) {
        setExtension((current) => current === "connected" ? current : "ready");
        const roomContext = payload?.context as EspnContext | undefined;
        // A browser can have several active ESPN mocks. Never let an arbitrary
        // tab select a league or make this dashboard look actionable.
        if (contextMatchesActiveDraftTab(roomContext, activeLeagueRef.current, activeEspnTabRef.current)) {
          setContext((current) => stabilizeEspnContext(current, roomContext || {}));
          setExtension("connected");
        }
      }
      if (type === "DF_ESPN_CONTEXT") {
        const roomContext = payload as EspnContext | undefined;
        if (contextMatchesActiveDraftTab(roomContext, activeLeagueRef.current, activeEspnTabRef.current)) {
          setContext((current) => stabilizeEspnContext(current, roomContext || {}));
          setExtension("connected");
        }
      }
      if (type === "COMMAND_RESULT" && payload?.context) {
        const roomContext = payload.context as EspnContext;
        if (contextMatchesActiveDraftTab(roomContext, activeLeagueRef.current, activeEspnTabRef.current)) {
          setContext((current) => stabilizeEspnContext(current, roomContext));
          setExtension("connected");
        } else if (payload.rebound === true && contextCanRebindDraftTab(roomContext, activeLeagueRef.current, activeEspnTeamRef.current)) {
          activeEspnTabRef.current = Number(roomContext.tabId);
          setActiveEspnTabId(Number(roomContext.tabId));
          setContext((current) => stabilizeEspnContext(current, roomContext));
          setExtension("connected");
        }
        const autoArmRequestId = Number(payload.autoArmRequestId);
        if (Number.isInteger(autoArmRequestId) && autoArmRequestId === pendingAutoArmRequestRef.current) {
          setAutoArmVerification({ requestId: autoArmRequestId, context: roomContext });
        }
      }
      if (type === "DF_IMPORT_SUCCESS" || (type === "COMMAND_RESULT" && payload?.data?.league)) {
        const data = type === "DF_IMPORT_SUCCESS" ? payload : payload.data;
        const importedLeague = normalizeImportedLeague(data.league);
        const importedPlayers = data.players?.length ? data.players : DEMO_PLAYERS;
        const importedContext = data.context as EspnContext | undefined;
        const importedPicks = reconcileEspnPicks(
          mergeDraftPicks(actualPicks(data.picks), resolveAuctionSales(importedContext, importedLeague, importedPlayers)),
          importedContext,
          importedLeague.teamId,
          importedPlayers,
          importedLeague,
        );
        const importedTabId = Number(importedContext?.tabId);
        activeLeagueRef.current = importedLeague.id;
        activeSourceLeagueRef.current = String(
          data.roomWatch?.sourceLeagueId
          || data.workspaceRecovery?.sourceLeagueId
          || importedLeague.id,
        );
        finalizedPracticeRoomRef.current = "";
        practiceRoomCleanupAttemptRef.current = { key: "", attempts: 0 };
        activeLeagueSettingsRef.current = importedLeague;
        activeEspnTabRef.current = Number.isInteger(importedTabId) ? importedTabId : null;
        setActiveEspnTabId(Number.isInteger(importedTabId) ? importedTabId : null);
        setAuthenticatedImportAt(new Date().toISOString());
        if (data.runtime) setRuntimeDiagnostics(data.runtime as DraftRuntimeDiagnostics);
        activeEspnTeamRef.current = Number(importedContext?.teamId || importedLeague.teamId || 0) || null;
        latestActionRequestRef.current = ++actionRequestSequenceRef.current;
        pendingSnakeActionRef.current = null;
        pendingAuctionNominationRef.current = null;
        pendingAuctionBidRef.current = null;
        setPendingAuctionNomination(null);
        setRejectedSnakePlayerIds([]);
        setAutoDraft(false);
        lastAutoAction.current = "";
        setActionRetryNonce(0);
        pendingActionTelemetryRef.current.clear();
        actionTelemetryRef.current = [];
        salaryCapDecisionObservationsRef.current.clear();
        sleeperEvidenceLedgerRef.current = { leagueId: importedLeague.id, candidates: [] };
        setTelemetryVersion((version) => version + 1);
        pendingAutoArmRequestRef.current = null;
        setAutoArmVerification(null);
        dispatchUi({ type: "set", key: "autoWarning", value: false });
        const watchedAutoArm = data.roomWatch?.recovered === true && data.roomWatch?.autoArmRequested === true;
        pendingLiveRoomAutoArmRef.current = watchedAutoArm;
        setLeague(importedLeague);
        espnPlayersRef.current = importedPlayers;
        setEspnPlayers(importedPlayers);
        setPicks(importedPicks);
        setContext(contextMatchesActiveDraftTab(importedContext, importedLeague.id, activeEspnTabRef.current) ? importedContext || {} : {});
        setLeagueId(String(importedLeague.id));
        setExtension("connected");
        dispatchUi({ type: "set", key: "settingsOpen", value: !watchedAutoArm });
        setSettingsConfirmed(watchedAutoArm);
        setActionState(data.roomWatch?.recovered === true
          ? watchedAutoArm
            ? "Exact ESPN live room auto-bound without a reload. Revalidating the room and arming Auto-Draft before the opening pick."
            : "Exact ESPN live room auto-bound without a reload. Confirm the live-room checklist, then enable Auto-Draft."
          : "ESPN settings imported. Confirm them before drafting.");
        const profile: DraftProfile = { league: importedLeague, espnPlayers: importedPlayers, picks: importedPicks, settingsConfirmed: watchedAutoArm, strategy: "BALANCED", savedAt: new Date().toISOString() };
        profilesRef.current = upsertDraftProfile(profilesRef.current, profile);
        setProfiles(profilesRef.current);
      }
      if (type === "DF_DRAFT_UPDATE") {
        if (!contextMatchesActiveDraftTab(payload?.context, activeLeagueRef.current, activeEspnTabRef.current)) return;
        const liveLeague = activeLeagueSettingsRef.current;
        const reconciled = reconcileEspnPicks(
          mergeDraftPicks(actualPicks(payload.picks), resolveAuctionSales(payload.context, liveLeague, espnPlayersRef.current)),
          payload.context,
          activeEspnTeamRef.current,
          espnPlayersRef.current,
          liveLeague,
        );
        setPicks((current) => reconcileEspnPicks(
          mergeDraftPicks(current, reconciled),
          payload.context,
          activeEspnTeamRef.current,
          espnPlayersRef.current,
          liveLeague,
        ));
        setContext((current) => stabilizeEspnContext(current, payload.context || {}));
      }
      if (type === "DF_ACTION_RESOLVED") {
        const actionRequestId = Number(payload.actionRequestId);
        const pending = pendingSnakeActionRef.current;
        if (pending
          && Number.isInteger(actionRequestId)
          && actionRequestId === latestActionRequestRef.current
          && payload.operation === "SELECT"
          && Number(payload.tabId) === activeEspnTabRef.current) {
          pending.playerId = Number(payload.playerId);
          pending.playerName = String(payload.playerName || pending.playerName);
        }
        const pendingTelemetry = pendingActionTelemetryRef.current.get(actionRequestId);
        if (pendingTelemetry
          && Number.isInteger(actionRequestId)
          && actionRequestId === latestActionRequestRef.current
          && payload.operation === "SELECT"
          && Number(payload.tabId) === activeEspnTabRef.current
          && Number.isInteger(Number(payload.playerId))
          && Number(payload.playerId) !== 0) {
          // Candidate fallback is resolved against ESPN's current visible pool.
          // Attribute the action to the player actually submitted, not the
          // recommendation that initiated the request.
          pendingTelemetry.playerId = Number(payload.playerId);
        }
      }
      if (type === "DF_ACTION_SUBMITTED") {
        const actionRequestId = Number(payload.actionRequestId);
        const pendingTelemetry = pendingActionTelemetryRef.current.get(actionRequestId);
        const submittedAt = Number(payload.submittedAt);
        if (pendingTelemetry
          && Number.isInteger(actionRequestId)
          && actionRequestId === latestActionRequestRef.current
          && Number(payload.tabId) === activeEspnTabRef.current
          && Number.isFinite(submittedAt)
          && submittedAt >= pendingTelemetry.sentAt
          && pendingTelemetry.submittedAt === null) {
          pendingTelemetry.submittedAt = submittedAt;
        }
      }
      if (type === "DF_ACTION_RESULT") {
        const actionRequestId = Number(payload.action?.actionRequestId);
        if (Number.isInteger(actionRequestId) && actionRequestId !== latestActionRequestRef.current) return;
        const pendingTelemetry = pendingActionTelemetryRef.current.get(actionRequestId);
        if (pendingTelemetry) {
          pendingActionTelemetryRef.current.delete(actionRequestId);
          const resolvedPlayerId = Number(payload.action?.playerId);
          if (pendingTelemetry.operation === "SELECT"
            && Number.isInteger(resolvedPlayerId)
            && resolvedPlayerId !== 0) {
            pendingTelemetry.playerId = resolvedPlayerId;
          }
          const resultSubmittedAt = Number(payload.action?.submittedAt);
          const submittedAt = pendingTelemetry.submittedAt ?? (
            Number.isFinite(resultSubmittedAt) && resultSubmittedAt >= pendingTelemetry.sentAt
              ? resultSubmittedAt
              : null
          );
          actionTelemetryRef.current = [...actionTelemetryRef.current, {
            occurredAt: new Date().toISOString(),
            operation: pendingTelemetry.operation,
            ok: payload.ok === true,
            code: String(payload.code || (payload.ok ? "ACTION_OK" : "ACTION_FAILED")),
            submitMs: submittedAt === null
              ? null
              : Math.max(0, Math.round(submittedAt - pendingTelemetry.sentAt)),
            roundTripMs: Math.max(0, Math.round(Date.now() - pendingTelemetry.sentAt)),
            clockSeconds: pendingTelemetry.clockSeconds,
            automatic: pendingTelemetry.automatic,
            playerId: pendingTelemetry.playerId,
            amount: pendingTelemetry.amount,
            maxApprovedBid: pendingTelemetry.maxApprovedBid,
            nominationIntent: pendingTelemetry.nominationIntent,
          }].slice(-MAX_DRAFT_ACTION_TELEMETRY_EVENTS);
          setTelemetryVersion((version) => version + 1);
        }
        if (!payload.ok && payload.action?.operation === "NOMINATE") {
          pendingAuctionNominationRef.current = null;
          setPendingAuctionNomination(null);
          if (RETRIABLE_NOMINATION_CODES.has(String(payload.code || ""))) {
            lastAutoAction.current = "";
            setExtension("connected");
            setActionRetryNonce((nonce) => nonce + 1);
            setActionState(`ESPN nomination turn changed (${payload.code}). Waiting for the next live turn.`);
            return;
          }
        }
        if (payload.ok && payload.action?.operation === "SELECT" && pendingSnakeActionRef.current) {
          const selectedPlayerId = Number(payload.action.playerId);
          const selectedPlayerName = String(payload.action.playerName || "");
          if (selectedPlayerId > 0 && selectedPlayerName) {
            pendingSnakeActionRef.current.playerId = selectedPlayerId;
            pendingSnakeActionRef.current.playerName = selectedPlayerName;
          }
          if (payload.code === "ROSTER_CONFIRMED") {
            pendingSnakeActionRef.current = null;
            setExtension("connected");
          }
        }
        if (!payload.ok && payload.action?.operation === "BID" && RETRIABLE_BID_CODES.has(String(payload.code || ""))) {
          pendingAuctionBidRef.current = null;
          lastAutoAction.current = "";
          setExtension("connected");
          setActionRetryNonce((nonce) => nonce + 1);
          setActionState(`ESPN offer changed (${payload.code}). Re-evaluating the live bid immediately.`);
          return;
        }
        if (!payload.ok && pendingSnakeActionRef.current) {
          const pending = pendingSnakeActionRef.current;
          if (RETRIABLE_SELECT_CODES.has(String(payload.code || ""))) {
            // An exact ESPN control that has disappeared cannot become
            // draftable again later in the same room. Keep it rejected across
            // snake-turn boundaries, including consecutive picks at the turn.
            setRejectedSnakePlayerIds((current) => [...new Set([...current, pending.playerId])]);
            pendingSnakeActionRef.current = null;
            lastAutoAction.current = "";
            setExtension("connected");
            setActionState(`${pending.playerName} left ESPN's live pool (${payload.code}). Retrying this pick immediately.`);
            return;
          }
          if (RETRIABLE_TURN_CODES.has(String(payload.code || ""))) {
            pendingSnakeActionRef.current = null;
            lastAutoAction.current = "";
            setExtension("connected");
            setActionRetryNonce((nonce) => nonce + 1);
            setActionState(`ESPN control changed (${payload.code}). Re-evaluating the live turn immediately.`);
            return;
          }
          pending.failed = true;
          setAutoDraft(false);
        }
        if (!payload.ok) setAutoDraft(false);
        setActionState(payload.ok ? payload.message : `Action stopped: ${payload.message}`);
      }
      if (type === "DF_EXTENSION_ERROR" || type === "EXTENSION_ERROR") {
        pendingAutoArmRequestRef.current = null;
        setAutoArmVerification(null);
        dispatchUi({ type: "set", key: "autoWarning", value: false });
        setAutoDraft(false);
        setExtension("error");
        setActionState(payload.message || "The ESPN companion reported an error.");
      }
      if (type === "COMMAND_RESULT" && payload?.code === "LIVE_ROOM_WATCH_ARMED") {
        if (payload.runtime) setRuntimeDiagnostics(payload.runtime as DraftRuntimeDiagnostics);
        setExtension("connected");
        setActionState("Exact ESPN live-room handoff armed. Open the league-specific draft; DraftForge will bind and foreground the command center automatically.");
      }
      if (type === "COMMAND_RESULT" && payload?.commandType === "CLOSE_PRACTICE_ROOM") {
        if (payload?.ok === true) {
          if (payload.runtime) setRuntimeDiagnostics(payload.runtime as DraftRuntimeDiagnostics);
          setExtension("connected");
          setActionState("Final audit passed. DraftForge closed the verified practice room and its exact stale workspace tabs.");
        } else {
          const attempts = practiceRoomCleanupAttemptRef.current.attempts;
          if (canRetryPracticeRoomCleanup(attempts)) {
            finalizedPracticeRoomRef.current = "";
            setActionState(`Draft complete. Practice-room cleanup stayed fail closed; exact retry ${attempts + 1}/${MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS} is queued.`);
          } else {
            setActionState(`Draft complete. Practice-room cleanup stopped after ${MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS} exact attempts; no unrelated tab was touched.`);
          }
        }
        return;
      }
      if (type === "COMMAND_RESULT" && payload?.ok === false) {
        // SUBMIT_ACTION is broadcast as DF_ACTION_RESULT first so its retry or
        // fail-closed policy is handled exactly once.
        if (payload.action) return;
        const autoArmRequestId = Number(payload.autoArmRequestId);
        if (Number.isInteger(autoArmRequestId) && autoArmRequestId === pendingAutoArmRequestRef.current) {
          pendingAutoArmRequestRef.current = null;
          setAutoArmVerification(null);
          dispatchUi({ type: "set", key: "autoWarning", value: false });
          dispatchUi({ type: "set", key: "settingsOpen", value: true });
          setAutoDraft(false);
          setExtension("error");
          setActionState("Auto-Draft locked: the exact ESPN draft tab changed or could not be verified. Reconnect and rerun the live-room checklist.");
          return;
        }
        if (pendingSnakeActionRef.current) {
          pendingSnakeActionRef.current.failed = true;
          setAutoDraft(false);
        }
        setExtension((current) => current === "connected" && payload.code === "NO_LEAGUE"
          ? current
          : payload.code === "NO_LEAGUE" ? "ready" : "error");
        setActionState(payload.message || "Could not connect to ESPN.");
      }
    }
    window.addEventListener("message", onMessage);
    // The content script can initialize before React attaches this listener; request a second handshake.
    if (!reloadCompanion) {
      sendToExtension("APP_HELLO");
      if (recoveryPayload) window.setTimeout(() => sendToExtension("RECOVER_LIVE_WORKSPACE", recoveryPayload), 0);
      if (closePracticePayload) window.setTimeout(async () => {
        let completedAuditProof = null;
        try {
          const response = await fetch(`/api/draft-day?leagueId=${encodeURIComponent(closePracticePayload.draftLeagueId)}&teamId=${closePracticePayload.teamId}`, { cache: "no-store" });
          const result = await response.json();
          if (response.ok
            && result?.evaluation?.finalReady === true
            && result?.evaluation?.parity === true
            && result?.snapshot?.safety?.autoDraft === false
            && String(result?.snapshot?.league?.id) === closePracticePayload.draftLeagueId
            && Number.isInteger(result?.snapshot?.binding?.tabId)) {
            completedAuditProof = {
              leagueId: closePracticePayload.draftLeagueId,
              teamId: closePracticePayload.teamId,
              tabId: result.snapshot.binding.tabId,
              finalReady: true,
              parity: true,
              autoDraftOff: true,
            };
          }
        } catch { /* expired-room cleanup remains fail closed without an exact completed audit */ }
        sendToExtension("CLOSE_PRACTICE_ROOM", { ...closePracticePayload, completedAuditProof });
      }, 0);
      if (cleanWorkspace) window.setTimeout(() => sendToExtension("CLEAN_LOCAL_WORKSPACE", { ownedBlankTabIds }), 0);
    }
    return () => { window.clearTimeout(timeout); window.removeEventListener("message", onMessage); };
  }, []);

  useEffect(() => {
    profilesRef.current = profiles;
    persistDraftProfiles(window.localStorage, "draftforge-leagues-v1", profiles);
  }, [profiles]);

  useEffect(() => {
    const captureRequested = new URL(window.location.href).searchParams.get("capture") === "sanitized";
    if (!captureRequested || !["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
    const capture = document.createElement("script");
    capture.id = "draftforge-sanitized-capture";
    capture.type = "application/json";
    const safeLeague = { ...league };
    delete safeLeague.rawSettings;
    capture.textContent = JSON.stringify({
      league: {
        ...safeLeague,
        name: "Sanitized ESPN snapshot",
        teams: Array.from({ length: league.size }, (_, index) => ({ id: index + 1, name: `Snapshot Team ${index + 1}`, abbrev: `S${index + 1}` })),
      },
      espnPlayers,
      picks: authoritativePicks,
    }).replaceAll("<", "\\u003c");
    document.body.appendChild(capture);
    return () => capture.remove();
  }, [league, espnPlayers, authoritativePicks]);

  useEffect(() => {
    espnPlayersRef.current = espnPlayers;
  }, [espnPlayers]);

  useEffect(() => {
    if (league.id === "demo" || extension !== "connected") return;
    activeLeagueRef.current = league.id;
    activeLeagueSettingsRef.current = league;
    // Persist a snapshot whenever ESPN sends new draft state so league switches stay isolated.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProfiles((current) => upsertDraftProfile(current, { league, espnPlayers, picks: authoritativePicks, settingsConfirmed, strategy, savedAt: new Date().toISOString() }));
  }, [league, espnPlayers, authoritativePicks, settingsConfirmed, strategy, extension]);

  useEffect(() => {
    if (league.id === "demo" || extension !== "connected") return;
    const refreshExactDraftTab = () => {
      const expectedTabId = activeEspnTabRef.current;
      if (!Number.isInteger(expectedTabId)) return;
      sendToExtension("REFRESH_ESPN_CONTEXT", { expectedLeagueId: league.id, expectedTeamId: activeEspnTeamRef.current, expectedTabId });
    };
    refreshExactDraftTab();
    const refreshTimer = window.setInterval(refreshExactDraftTab, EXACT_TAB_WATCHDOG_MS);
    return () => window.clearInterval(refreshTimer);
  }, [extension, league.id]);

  useEffect(() => {
    if (!league.teamId || !Array.isArray(context.ownRoster)) return;
    // ESPN's visible roster is an external source of truth for submitted picks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPicks((current) => {
      const reconciled = reconcileEspnPicks(current, context, league.teamId, espnPlayers, league);
      const unchanged = reconciled.length === current.length && reconciled.every((pick, index) => (
        pick.playerId === current[index]?.playerId && pick.teamId === current[index]?.teamId && pick.amount === current[index]?.amount
      ));
      return unchanged ? current : reconciled;
    });
    const ownRoster = resolveOwnRoster(context, espnPlayers);
    const pendingAuctionBid = pendingAuctionBidRef.current;
    if (pendingAuctionBid) {
      const wonPlayer = ownRoster.some((entry) => entry.playerId === pendingAuctionBid.playerId);
      if (wonPlayer) {
        // The live ESPN roster is authoritative. Invalidate any slower action
        // response so a pre-win bid race cannot overwrite this confirmation.
        latestActionRequestRef.current = ++actionRequestSequenceRef.current;
        pendingAuctionBidRef.current = null;
        pendingAuctionNominationRef.current = null;
        setPendingAuctionNomination(null);
        setActionState(`ESPN confirmed ${pendingAuctionBid.playerName} on your roster.`);
      } else {
        const nomineeChanged = Boolean(context.nominatedPlayer)
          && normalizeName(context.nominatedPlayer) !== normalizeName(pendingAuctionBid.playerName);
        const wasAlreadyOwned = pendingAuctionBid.beforeRosterPlayerIds.includes(pendingAuctionBid.playerId);
        if (nomineeChanged || wasAlreadyOwned) pendingAuctionBidRef.current = null;
      }
    }
    const pending = pendingSnakeActionRef.current;
    if (!pending) return;
    const confirmed = ownRoster.some((entry) => entry.playerId === pending.playerId);
    const pickAdvanced = Number(context.currentPick || 0) > pending.expectedPick;
    const previousRoster = new Set(pending.beforeRosterPlayerIds);
    const newOwnRoster = ownRoster.filter((entry) => !previousRoster.has(entry.playerId));
    if (!confirmed && pickAdvanced && Date.now() - pending.sentAt >= ESPN_ROSTER_CONFIRMATION_GRACE_MS) {
      pending.failed = true;
      setPicks((current) => current.filter((pick) => pick.playerId !== pending.playerId));
      setAutoDraft(false);
      const unexpected = newOwnRoster.length === 1
        ? espnPlayers.find((player) => player.id === newOwnRoster[0].playerId)?.name || "another player"
        : null;
      setActionState(unexpected
        ? `Action stopped: ESPN added ${unexpected} instead of DraftForge's intended ${pending.playerName} selection (possible Autopick).`
        : `Action stopped: ESPN did not confirm ${pending.playerName} on your roster.`);
    }
  }, [context, espnPlayers, league]);

  useEffect(() => {
    const pending = pendingSnakeActionRef.current;
    if (!pending || pending.failed || !league.teamId) return;
    const confirmedInContext = resolveOwnRoster(context, espnPlayers).some((entry) => entry.playerId === pending.playerId);
    const confirmedInPicks = picks.some((pick) => pick.playerId === pending.playerId && pick.teamId === league.teamId);
    if (confirmedInContext && confirmedInPicks) pendingSnakeActionRef.current = null;
  }, [context, espnPlayers, league.teamId, picks]);

  useEffect(() => {
    if (!autoDraft && pendingSnakeActionRef.current?.failed) pendingSnakeActionRef.current = null;
  }, [autoDraft]);

  useEffect(() => {
    if (!autoDraft || context.autopickActive !== true) return;
    // ESPN Autopick is authoritative external state. Mirror its emergency
    // shutdown synchronously so no later action effect can remain armed.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoDraft(false);
    setActionState("Action stopped: ESPN Autopick became active. This draft is excluded from verification.");
    const expectedTabId = activeEspnTabRef.current;
    if (Number.isInteger(expectedTabId)) {
      sendToExtension("DISABLE_ESPN_AUTOPICK", { expectedLeagueId: league.id, expectedTabId });
    }
  }, [autoDraft, context.autopickActive, league.id]);

  const sourceQuarterbackMode = intelligenceQuarterbackMode(league.lineupSlotCounts);
  useEffect(() => {
    if (league.id === "demo") return;
    const key = intelligenceSnapshotCacheKey(league.scoringLabel, league.size, league.season, sourceQuarterbackMode);
    rememberCompleteFreshIntelligenceSnapshot(intelligenceSnapshotsRef.current, key, sources);
  }, [league.id, league.scoringLabel, league.size, league.season, sourceQuarterbackMode, sources]);

  useEffect(() => {
    if (league.id === "demo") {
      const previewTimer = window.setTimeout(() => {
        setSources([]);
        dispatchUi({ type: "set", key: "intelligenceLoading", value: false });
      }, 0);
      return () => window.clearTimeout(previewTimer);
    }
    let cancelled = false;
    const qbs = sourceQuarterbackMode;
    const intelligenceKey = intelligenceSnapshotCacheKey(league.scoringLabel, league.size, league.season, qbs);
    const cachedSources = readCompleteFreshIntelligenceSnapshot(intelligenceSnapshotsRef.current, intelligenceKey);
    if (cachedSources) setSources(cachedSources);
    const intelligenceUrl = `/api/intelligence?scoring=${encodeURIComponent(league.scoringLabel)}&teams=${league.size}&season=${league.season}&qbs=${qbs}`;
    const refreshIntelligence = () => {
      fetch(intelligenceUrl, { cache: "no-store" })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then((data) => {
          if (!cancelled) {
            setSources((current) => {
              const next = preserveCompleteFreshIntelligenceSnapshot(current, data.sources || []);
              rememberCompleteFreshIntelligenceSnapshot(intelligenceSnapshotsRef.current, intelligenceKey, next);
              return next;
            });
          }
        })
        // Preserve the newest validated snapshot if a background refresh fails.
        .catch(() => {})
        .finally(() => { if (!cancelled) dispatchUi({ type: "set", key: "intelligenceLoading", value: false }); });
    };
    // Every imported draft gets a fresh, non-blocking source snapshot. Long
    // drafts refresh in the background without putting a network call on the clock.
    dispatchUi({ type: "set", key: "intelligenceLoading", value: true });
    refreshIntelligence();
    const refreshTimer = window.setInterval(refreshIntelligence, INTELLIGENCE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [league.id, league.scoringLabel, league.size, league.season, sourceQuarterbackMode]);

  const players = useMemo(() => mergeConsensus(espnPlayers, sources, league), [espnPlayers, sources, league]);
  const playerPool = useMemo(() => buildPlayerPoolIndex(players, league), [players, league]);

  const recommendationPick = league.draftType === "SNAKE" && Number(context.currentPick) > 0 ? Number(context.currentPick) : authoritativePicks.length + 1;
  const decision = useMemo(
    () => buildDraftDecision(players, authoritativePicks, league, strategy, recommendationPick, context.auctionBudgets, playerPool),
    [players, authoritativePicks, league, strategy, recommendationPick, context.auctionBudgets, playerPool],
  );
  const recommendations = decision.recommendations;
  const currentSleeperEvidence = useMemo(() => recommendations
    .filter((player) => player.sleeperLabel !== "NONE")
    .slice(0, 20)
    .map((player) => ({
      playerId: player.id,
      playerName: player.name,
      position: player.pos,
      adp: Number(player.adp),
      label: player.sleeperLabel as "VALUE" | "SLEEPER" | "DEEP_STASH",
      score: Number(player.sleeperScore),
      modelMarketEdge: Number(player.modelMarketEdge || 0),
      modelSpread: Number(player.modelSpread || 0),
      sourceCount: Number(player.sourceCount || 0),
    })), [recommendations]);
  const remainingRosterSlots = Math.max(0, league.rosterSize - authoritativePicks.filter((pick) => pick.teamId === league.teamId).length);
  const liveRecommendations = useMemo(() => {
    return liveEspnRecommendations(recommendations, context, rejectedSnakePlayerIds, remainingRosterSlots);
  }, [context, recommendations, rejectedSnakePlayerIds, remainingRosterSlots]);
  const auctionPlan = decision.auctionPlan;
  const auctionUsage = auctionBudgetUsage(auctionPlan);
  const auctionNomination = useMemo(
    () => chooseAuctionNomination(liveRecommendations, league, auctionPlan),
    [liveRecommendations, league, auctionPlan],
  );
  const selected = liveRecommendations.find((player) => player.id === selectedId) || liveRecommendations[0];
  const nominated = context.nominatedPlayer ? resolveEspnNominatedPlayer(recommendations, context) : undefined;
  const ownNominationIntent = nominated
    && pendingAuctionNomination
    && normalizeName(pendingAuctionNomination.playerName) === normalizeName(nominated.name)
      ? pendingAuctionNomination.intent
      : null;
  useEffect(() => {
    if (league.draftType !== "AUCTION" || !nominated) return;
    salaryCapDecisionObservationsRef.current.set(nominated.id, observeSalaryCapDecision(
      salaryCapDecisionObservationsRef.current.get(nominated.id),
      nominated,
      Number(context.currentBid || 0),
      ownNominationIntent,
    ));
  }, [context.currentBid, league.draftType, nominated, ownNominationIntent]);
  const focusPlayer = league.draftType === "AUCTION" && nominated
    ? nominated
    : league.draftType === "AUCTION" && auctionNomination
      ? auctionNomination.player
      : selected;
  const nextBid = focusPlayer ? Math.max(1, Number(context.currentBid || 0) + 1) : 1;
  const draftedIds = useMemo(() => new Set(authoritativePicks.map((pick) => pick.playerId)), [authoritativePicks]);
  const normalizedQuery = query.toLowerCase();
  const visible = liveRecommendations.filter((player) =>
    (filter === "ALL" || player.pos === filter) && `${player.name} ${player.team}`.toLowerCase().includes(normalizedQuery)
  );
  const myPicks = useMemo(
    () => authoritativePicks.filter((pick) => pick.teamId === league.teamId),
    [authoritativePicks, league.teamId],
  );
  const myPickCount = myPicks.length;
  useEffect(() => {
    const rosterStatusKey = `${league.id}:${activeEspnTabId ?? "none"}:${myPickCount}`;
    if (lastRosterStatusKeyRef.current === rosterStatusKey) return;
    lastRosterStatusKeyRef.current = rosterStatusKey;
    if (context.inDraftRoom !== true || myPickCount <= 0 || myPickCount >= league.rosterSize) return;
    // Roster reconciliation is authoritative even when a rapid ESPN action
    // result arrives out of order. Keep the command status aligned with the
    // visible roster instead of leaving an older player confirmation behind.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActionState(`ESPN confirmed roster ${myPickCount}/${league.rosterSize}. Recommendations and roster needs updated.`);
  }, [activeEspnTabId, context.inDraftRoom, league.id, league.rosterSize, myPickCount]);
  const myRoster = myPicks.map((pick) => ({ pick, player: playerPool.playerById.get(pick.playerId) })).filter((item) => item.player) as { pick: DraftPick; player: DraftPlayer }[];
  const currentPick = recommendationPick;
  const currentRound = league.draftType === "SNAKE" ? Math.floor((Math.max(1, currentPick) - 1) / league.size) + 1 : null;
  const remainingSeconds = typeof context.remainingSeconds === "number" ? context.remainingSeconds : Number.NaN;
  const minimumActionWindow = league.draftType === "SNAKE" ? MIN_SNAKE_SELECTION_WINDOW_SECONDS : MIN_OTHER_ACTION_WINDOW_SECONDS;
  const healthySources = useMemo(() => sources.filter(isIntelligenceSourceFresh), [sources]);
  const sourceCoverageReady = isCompleteFreshIntelligenceSnapshot(sources);
  const actionWindowOpen = sourceCoverageReady && context.actionSurfaceReady === true && context.autopickActive !== true && Boolean(context.onClock) && Number.isFinite(remainingSeconds) && remainingSeconds >= minimumActionWindow;
  const bidWindowOpen = sourceCoverageReady && context.autopickActive !== true && Number.isFinite(remainingSeconds) && remainingSeconds >= MIN_OTHER_ACTION_WINDOW_SECONDS;
  const spent = myPicks.reduce((sum, pick) => sum + pick.amount, 0);
  const strategyInfo = STRATEGIES.find((item) => item.id === strategy) || STRATEGIES[0];
  const preflightChecks = [
    { label: `Exact ESPN league ${league.id} and team ${league.teamId || "—"}`, ok: league.id !== "demo" && Number(league.teamId) > 0 },
    { label: `${league.draftType === "AUCTION" ? `$${league.auctionBudget} salary cap` : "Snake order"}, ${league.size} teams, ${league.rosterSize} draftable slots`, ok: league.size > 1 && league.rosterSize > 0 && rosterSlots(league).length === league.rosterSize },
    { label: `${league.scoringLabel} scoring and ${league.scoringRules} ESPN scoring rules`, ok: Boolean(league.scoringLabel) && league.scoringRules > 0 },
    { label: `${espnPlayers.length} ESPN players with projections/market values`, ok: espnPlayers.length >= league.size * league.rosterSize },
    { label: `${healthySources.length + 1}/5 fresh deterministic sources`, ok: healthySources.length === 4 },
    { label: "Companion-managed one-dashboard workspace cleanup", ok: runtimeDiagnostics?.managedCleanupReady === true },
    { label: `${strategyInfo.label} strategy and ${league.draftType === "AUCTION" ? "$" + Object.values(auctionPlan.positionBudgets).reduce((sum, amount) => sum + amount, 0) + " planned" : "position priorities"}`, ok: league.draftType !== "AUCTION" || Object.values(auctionPlan.positionBudgets).reduce((sum, amount) => sum + amount, 0) === league.auctionBudget },
  ];
  const preflightReady = preflightChecks.every((check) => check.ok);
  const liveChecks = [
    { label: "Exact imported league and team are bound to one ESPN draft tab", ok: context.inDraftRoom === true && String(context.leagueId) === String(league.id) && Number(context.teamId) === Number(league.teamId) },
    { label: "Live player pool, roster, timer, and action controls resolved", ok: Boolean(context.actionSurfaceReady && context.availablePlayerIds?.length && Array.isArray(context.ownRoster) && Number.isFinite(context.remainingSeconds)) },
    { label: "ESPN draft sound is muted", ok: context.inDraftRoom === true && context.soundMuted === true },
    { label: "ESPN Autopick is off", ok: context.inDraftRoom === true && context.autopickActive !== true },
    { label: "No-click dry run resolves the top legal recommendation", ok: context.inDraftRoom === true && Boolean(context.availablePlayerIds?.length) && Boolean(liveRecommendations[0]) },
  ];
  const liveChecklistReady = settingsConfirmed && preflightReady && liveChecks.every((check) => check.ok);
  useEffect(() => {
    if (!pendingLiveRoomAutoArmRef.current || !liveChecklistReady || extension !== "connected") return;
    const expectedTabId = activeEspnTabRef.current;
    // Consume the one-shot handoff intent before the asynchronous exact-tab
    // verification so no render or response can arm it twice.
    pendingLiveRoomAutoArmRef.current = false;
    if (!Number.isInteger(expectedTabId)) {
      setAutoDraft(false);
      dispatchUi({ type: "set", key: "settingsOpen", value: true });
      setActionState("Auto-Draft locked: the verified live-room tab disappeared during handoff.");
      return;
    }
    const requestId = ++autoArmRequestSequenceRef.current;
    pendingAutoArmRequestRef.current = requestId;
    setAutoDraft(false);
    setActionState("Revalidating the exact ESPN draft tab before the opening pick…");
    sendToExtension("REFRESH_ESPN_CONTEXT", {
      expectedLeagueId: league.id,
      expectedTeamId: activeEspnTeamRef.current,
      expectedTabId,
      autoArmRequestId: requestId,
    });
  }, [liveChecklistReady, extension, league.id]);
  useEffect(() => {
    if (!autoArmVerification) return;
    const requestIsCurrent = autoArmVerification.requestId === pendingAutoArmRequestRef.current;
    const armReady = requestIsCurrent && canArmAutoDraft({
      checklistReady: liveChecklistReady,
      extensionConnected: extension === "connected",
      context: autoArmVerification.context,
      leagueId: league.id,
      teamId: league.teamId,
      tabId: activeEspnTabRef.current,
    });
    pendingAutoArmRequestRef.current = null;
    // The exact-tab response is an external verification result; consume it once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoArmVerification(null);
    if (!armReady) {
      setAutoDraft(false);
      dispatchUi({ type: "set", key: "settingsOpen", value: true });
      setActionState("Auto-Draft locked: ESPN room state changed during verification. Rerun the exact live-room checklist.");
      return;
    }
    setAutoDraft(true);
    setActionState("Auto-Draft armed after the exact ESPN tab and live-room checks were revalidated.");
  }, [autoArmVerification, extension, league.id, league.teamId, liveChecklistReady]);

  useEffect(() => {
    if (!autoDraft || sourceCoverageReady || myPickCount >= league.rosterSize) return;
    // Source coverage is an action-time invariant, not only a pre-draft
    // checklist. Disarm immediately if the last validated snapshot expires.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoDraft(false);
    setActionState("Action stopped: five-source intelligence is no longer fresh and complete. Refresh sources, re-check the room, and re-enable Auto-Draft.");
  }, [autoDraft, league.rosterSize, myPickCount, sourceCoverageReady]);

  function connect() {
    setExtension("connecting");
    setActionState("Reading your signed-in ESPN league…");
    sendToExtension("CONNECT_ESPN", { ...(leagueId.trim() ? { leagueId: leagueId.trim() } : {}), season: league.season || new Date().getFullYear() });
  }

  function confirmPreDraftChecklist() {
    setSettingsConfirmed(true);
    dispatchUi({ type: "set", key: "settingsOpen", value: false });
    if (context.inDraftRoom !== true) {
      sendToExtension("ARM_LIVE_ROOM_WATCH", {
        sourceLeagueId: league.id,
        sourceTabId: context.tabId,
        teamId: league.teamId,
        season: league.season,
        draftType: league.draftType,
        autoArmRequested: true,
      });
      setActionState("Pre-draft rules, sources, roster, and strategy confirmed. Auto-Draft will arm only after the exact live room passes every safety check.");
      return;
    }
    setActionState("Exact live-room rules, muted audio, player pool, roster, clock, and no-click dry run confirmed.");
  }

  const submit = useCallback((player: Recommendation | undefined, automatic = false, operation?: "SELECT" | "NOMINATE" | "BID", amount?: number, nominationIntent: "TARGET" | "DRAIN" = "TARGET") => {
    if (!player || !settingsConfirmed || extension !== "connected") {
      setActionState("Connect ESPN and confirm the imported rules first.");
      return;
    }
    if (!sourceCoverageReady) {
      setAutoDraft(false);
      setActionState("Action stopped: five-source intelligence is no longer fresh and complete. No ESPN action was sent.");
      return;
    }
    if (myPickCount >= league.rosterSize) {
      setAutoDraft(false);
      setActionState("Draft complete: ESPN confirmed every roster spot. No further action was sent.");
      return;
    }
    const resolvedOperation = operation || (league.draftType === "AUCTION" ? "NOMINATE" : "SELECT");
    const expectedTabId = activeEspnTabRef.current;
    if (!Number.isInteger(expectedTabId)) {
      setActionState("Reconnect the exact ESPN draft tab before submitting.");
      return;
    }
    if ((resolvedOperation === "BID" ? !bidWindowOpen : !actionWindowOpen)) {
      setActionState(`Waiting for a safe ESPN action window (need at least ${resolvedOperation === "SELECT" ? MIN_SNAKE_SELECTION_WINDOW_SECONDS : MIN_OTHER_ACTION_WINDOW_SECONDS} seconds; ESPN shows ${Number.isFinite(remainingSeconds) ? `${remainingSeconds}s` : "no timer"}).`);
      return;
    }
    if (resolvedOperation === "SELECT" && pendingSnakeActionRef.current && !pendingSnakeActionRef.current.failed) {
      setActionState(`Waiting for ESPN to confirm ${pendingSnakeActionRef.current.playerName}.`);
      return;
    }
    if (resolvedOperation === "SELECT") {
      pendingSnakeActionRef.current = {
        playerId: player.id,
        playerName: player.name,
        expectedPick: currentPick,
        sentAt: Date.now(),
        beforeRosterPlayerIds: resolveOwnRoster(context, espnPlayers).map((entry) => entry.playerId),
      };
    }
    if (resolvedOperation === "NOMINATE") {
      const nomination = {
        playerId: player.id,
        playerName: player.name,
        intent: nominationIntent,
      };
      pendingAuctionNominationRef.current = nomination;
      setPendingAuctionNomination(nomination);
    }
    const actionRequestId = ++actionRequestSequenceRef.current;
    latestActionRequestRef.current = actionRequestId;
    pendingActionTelemetryRef.current.set(actionRequestId, {
      sentAt: Date.now(),
      submittedAt: null,
      operation: resolvedOperation,
      clockSeconds: Number.isFinite(remainingSeconds) ? remainingSeconds : null,
      automatic,
      playerId: player.id,
      amount: Math.max(0, Math.trunc(Number(amount ?? (resolvedOperation === "BID" ? player.maxBid : resolvedOperation === "NOMINATE" ? 1 : 0)))),
      maxApprovedBid: resolvedOperation === "BID" ? Math.max(0, Math.trunc(Number(player.maxBid || 0))) : 0,
      nominationIntent: resolvedOperation === "NOMINATE" ? nominationIntent : null,
    });
    while (pendingActionTelemetryRef.current.size > MAX_DRAFT_ACTION_TELEMETRY_EVENTS) {
      const oldestRequestId = pendingActionTelemetryRef.current.keys().next().value;
      if (oldestRequestId === undefined) break;
      pendingActionTelemetryRef.current.delete(oldestRequestId);
    }
    if (resolvedOperation === "BID") {
      pendingAuctionBidRef.current = {
        actionRequestId,
        playerId: player.id,
        playerName: player.name,
        beforeRosterPlayerIds: resolveOwnRoster(context, espnPlayers).map((entry) => entry.playerId),
      };
    }
    setActionState(`${automatic ? "Auto-Draft is submitting" : "Submitting"} ${player.name} in ESPN…`);
    const automaticRecommendations = player.fillsMandatoryStarter
      ? recommendations.filter((candidate) => candidate.fillsMandatoryStarter)
      : [...recommendations];
    const orderedCandidates = automatic
      ? [...automaticRecommendations.slice(0, 6), player, ...automaticRecommendations.slice(6)]
          .filter((candidate, index, all) => all.findIndex((item) => item.id === candidate.id) === index)
      : [player, ...recommendations.filter((candidate) => candidate.id !== player.id)];
    sendToExtension("SUBMIT_ACTION", {
      actionRequestId,
      operation: resolvedOperation,
      playerId: player.id,
      playerName: player.name,
      candidates: resolvedOperation === "BID" ? undefined : orderedCandidates
        .slice(0, ACTION_CANDIDATE_LIMIT)
        .map((candidate) => ({ playerId: candidate.id, playerName: candidate.name, position: candidate.pos, fillsMandatoryStarter: candidate.fillsMandatoryStarter })),
      amount: resolvedOperation === "BID" ? amount ?? player.maxBid : resolvedOperation === "NOMINATE" ? amount ?? 1 : undefined,
      maxApprovedBid: resolvedOperation === "BID" ? player.maxBid : undefined,
      nominationIntent: resolvedOperation === "NOMINATE" ? nominationIntent : undefined,
      expectedCurrentBid: resolvedOperation === "BID" ? Number(context.currentBid || 0) : undefined,
      requireOnClock: resolvedOperation !== "BID",
      expectedLeagueId: league.id,
      expectedTabId,
      expectedPick: currentPick,
    });
  }, [actionWindowOpen, bidWindowOpen, context, currentPick, espnPlayers, extension, league.draftType, league.id, league.rosterSize, myPickCount, recommendations, remainingSeconds, settingsConfirmed, sourceCoverageReady]);

  useEffect(() => {
    if (!autoDraft || !settingsConfirmed || extension !== "connected" || !actionWindowOpen || !liveRecommendations[0] || myPickCount >= league.rosterSize) return;
    if (league.draftType === "SNAKE" && pendingSnakeActionRef.current) return;
    if (league.draftType === "AUCTION" && (nominated || context.nominatedPlayer || Number(context.currentBid || 0) > 0)) return;
    const automaticPlayer = league.draftType === "AUCTION" ? auctionNomination?.player : liveRecommendations[0];
    if (!automaticPlayer) return;
    const key = `${league.id}:${currentPick}:${automaticPlayer.id}:${league.draftType}:${auctionNomination?.intent || "PICK"}:${actionRetryNonce}`;
    if (lastAutoAction.current === key) return;
    lastAutoAction.current = key;
    submit(
      automaticPlayer,
      true,
      league.draftType === "AUCTION" ? "NOMINATE" : "SELECT",
      league.draftType === "AUCTION" ? auctionNomination?.openingBid : undefined,
      auctionNomination?.intent || "TARGET",
    );
  }, [actionRetryNonce, autoDraft, settingsConfirmed, extension, actionWindowOpen, liveRecommendations, auctionNomination, league.id, league.draftType, league.rosterSize, myPickCount, currentPick, nominated, context.nominatedPlayer, context.currentBid, submit]);

  useEffect(() => {
    if (!autoDraft || !settingsConfirmed || extension !== "connected" || league.draftType !== "AUCTION" || !bidWindowOpen || !nominated || context.leadingBid || ownNominationIntent === "DRAIN" || myPickCount >= league.rosterSize) return;
    const bid = Math.max(1, Number(context.currentBid || 0) + 1);
    if (bid > nominated.maxBid) return;
    const key = `${league.id}:bid:${nominated.id}:${bid}`;
    if (lastAutoAction.current === key) return;
    lastAutoAction.current = key;
    submit(nominated, true, "BID", bid);
  }, [actionRetryNonce, autoDraft, settingsConfirmed, extension, league.draftType, league.id, league.rosterSize, myPickCount, nominated, ownNominationIntent, context.currentBid, context.leadingBid, bidWindowOpen, submit]);

  useEffect(() => {
    if (!autoDraft || myPickCount < league.rosterSize || context.autopickActive === true) return;
    const completionTimer = window.setTimeout(() => {
      setAutoDraft(false);
      setActionState("Draft complete: ESPN confirmed every roster spot. No further action was sent.");
    }, 0);
    return () => window.clearTimeout(completionTimer);
  }, [autoDraft, context.autopickActive, league.rosterSize, myPickCount]);

  function enableAutoDraft() {
    if (autoDraft) { setAutoDraft(false); return; }
    if (!liveChecklistReady) {
      dispatchUi({ type: "set", key: "settingsOpen", value: true });
      setActionState("Auto-Draft locked: complete the pre-draft and live-room checklists first.");
      return;
    }
    dispatchUi({ type: "set", key: "autoWarning", value: true });
  }

  function confirmEnableAutoDraft() {
    const expectedTabId = activeEspnTabRef.current;
    if (!liveChecklistReady || extension !== "connected" || !Number.isInteger(expectedTabId)) {
      dispatchUi({ type: "set", key: "autoWarning", value: false });
      dispatchUi({ type: "set", key: "settingsOpen", value: true });
      setAutoDraft(false);
      setActionState("Auto-Draft locked: ESPN room state changed. Rerun the exact live-room checklist.");
      return;
    }
    const requestId = ++autoArmRequestSequenceRef.current;
    pendingAutoArmRequestRef.current = requestId;
    setAutoDraft(false);
    dispatchUi({ type: "set", key: "autoWarning", value: false });
    setActionState("Revalidating the exact ESPN draft tab before arming Auto-Draft…");
    sendToExtension("REFRESH_ESPN_CONTEXT", {
      expectedLeagueId: league.id,
      expectedTeamId: activeEspnTeamRef.current,
      expectedTabId,
      autoArmRequestId: requestId,
    });
  }

  const slots = rosterSlots(league);
  const assigned = new Set<number>();
  const rosterRows = slots.map((slot) => {
    const item = myRoster.find(({ player }) => !assigned.has(player.id) && (
      slot === "FLEX" ? ["RB", "WR", "TE"].includes(player.pos)
        : slot === "RB/WR" ? ["RB", "WR"].includes(player.pos)
          : slot === "WR/TE" ? ["WR", "TE"].includes(player.pos)
            : slot === "OP" ? ["QB", "RB", "WR", "TE"].includes(player.pos)
              : slot === "BN" || player.pos === slot
    ));
    if (item) assigned.add(item.player.id);
    return { slot, item };
  });

  // Presentation-only state for the command center. These values describe the
  // already-computed recommendation and never alter engine ordering or action
  // authorization.
  const openRosterRows = rosterRows.filter(({ item }) => !item);
  const currentReserve = league.draftType === "AUCTION" ? openRosterRows.length : 0;
  const postWinReserve = Math.max(0, currentReserve - 1);
  const remainingBudget = league.auctionBudget - spent;
  const spendableBudget = Math.max(0, remainingBudget - currentReserve);
  const auctionCanBid = league.draftType === "AUCTION"
    && Boolean(nominated)
    && !context.leadingBid
    && ownNominationIntent !== "DRAIN"
    && nextBid <= (focusPlayer?.maxBid || 0)
    && bidWindowOpen;
  const presentation = buildDraftPresentation({
    draftType: league.draftType,
    focusPlayer: focusPlayer ? { name: focusPlayer.name, maxBid: focusPlayer.maxBid } : undefined,
    auctionNominationPlayerName: auctionNomination?.player.name,
    ownNominationIntent,
    nominated: Boolean(nominated),
    leadingBid: context.leadingBid === true,
    nextBid,
    auctionCanBid,
    actionWindowOpen,
    bidWindowOpen,
    sourceCoverageReady,
    settingsConfirmed,
    extensionConnected: extension === "connected",
    autopickActive: context.autopickActive === true,
    inDraftRoom: context.inDraftRoom === true,
    rosterComplete: myPickCount >= league.rosterSize,
  });

  useEffect(() => {
    if (league.id === "demo" || !Number.isInteger(activeEspnTabId)) return;
    const timer = window.setInterval(() => {
      setAuditHeartbeat((heartbeat) => heartbeat + 1);
      sendToExtension("GET_RUNTIME_DIAGNOSTICS");
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeEspnTabId, league.id]);

  useEffect(() => {
    const exactTabId = activeEspnTabId;
    if (league.id === "demo" || !Number.isInteger(exactTabId) || Number(exactTabId) <= 0 || !runtimeDiagnostics || !authenticatedImportAt) return;
    const currentLiveChecklistBindingKey = draftAuditChecklistBindingKey(
      league.id,
      Number(league.teamId),
      Number(exactTabId),
    );
    if (liveChecklistReady && currentLiveChecklistBindingKey) {
      lastValidatedLiveChecklistBindingRef.current = currentLiveChecklistBindingKey;
    }
    const auditLiveChecklistReady = resolveDraftAuditChecklistReady({
      currentReady: liveChecklistReady,
      rosterComplete: myPickCount >= league.rosterSize,
      currentBindingKey: currentLiveChecklistBindingKey,
      lastValidatedBindingKey: lastValidatedLiveChecklistBindingRef.current,
    });
    const toAuditEntry = (playerId: number, amount: number): DraftAuditRosterEntry | null => {
      const player = playerPool.playerById.get(playerId);
      return player ? {
        playerId,
        playerName: player.name,
        position: player.pos,
        amount: Math.max(0, Math.trunc(Number(amount || 0))),
      } : null;
    };
    const appRoster = myPicks
      .map((pick) => toAuditEntry(pick.playerId, pick.amount))
      .filter((entry): entry is DraftAuditRosterEntry => Boolean(entry));
    const espnRoster = (context.inDraftRoom === true ? resolveOwnRoster(context, espnPlayers) : [])
      .map((entry) => toAuditEntry(entry.playerId, entry.amount))
      .filter((entry): entry is DraftAuditRosterEntry => Boolean(entry));
    if (sleeperEvidenceLedgerRef.current.leagueId !== league.id) {
      sleeperEvidenceLedgerRef.current = { leagueId: league.id, candidates: [] };
    }
    const sleeperEvidence = mergeAuthenticatedSleeperEvidence({
      current: sleeperEvidenceLedgerRef.current.candidates,
      observed: currentSleeperEvidence,
      ownPicks: myPicks,
      currentPick: recommendationPick,
    });
    sleeperEvidenceLedgerRef.current = { leagueId: league.id, candidates: sleeperEvidence };
    const salaryCapEvidence = league.draftType === "AUCTION"
      ? buildSalaryCapEvidence({
        sales: context.auctionSales || [],
        playerById: playerPool.playerById,
        ownPlayerIds: new Set(myPicks.map((pick) => pick.playerId)),
        actions: actionTelemetryRef.current,
        observations: salaryCapDecisionObservationsRef.current,
      })
      : [];
    const stable = {
      league: league.id,
      team: league.teamId,
      tab: exactTabId,
      authenticatedImportAt,
      runtimeDiagnostics,
      settingsConfirmed,
      liveChecklistReady: auditLiveChecklistReady,
      extension,
      inDraftRoom: context.inDraftRoom === true,
      soundMuted: context.soundMuted === true,
      autopickActive: context.autopickActive === true,
      autoDraft,
      sourceCoverage: 1 + healthySources.length,
      sourceIds: ["espn", ...healthySources.map((source) => source.id)].sort(),
      actionState,
      totalPicks: authoritativePicks.length,
      appRoster,
      espnRoster,
      telemetryVersion,
      auditHeartbeat,
      sleeperEvidence,
      salaryCapEvidence,
    };
    const digest = JSON.stringify(stable);
    if (draftAuditDigestRef.current === digest || draftAuditPendingRef.current === digest) return;
    const snapshot: DraftAuditSnapshot = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      league: {
        id: league.id,
        teamId: Number(league.teamId),
        season: Number(league.season),
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
        tabId: Number(exactTabId),
        commandCenterSessionId: COMMAND_CENTER_PUBLISHER.sessionId,
        commandCenterStartedAt: COMMAND_CENTER_PUBLISHER.startedAt,
        authenticatedImportAt,
      },
      runtime: runtimeDiagnostics,
      safety: {
        settingsConfirmed,
        liveChecklistReady: auditLiveChecklistReady,
        extensionConnected: extension === "connected",
        inDraftRoom: context.inDraftRoom === true,
        soundMuted: context.soundMuted === true,
        autopickActive: context.autopickActive === true,
        autoDraft,
        sourceCoverage: 1 + healthySources.length,
        sourceIds: ["espn", ...healthySources.map((source) => source.id)].sort(),
        actionState,
      },
      draft: {
        totalPicks: authoritativePicks.length,
        appRoster,
        espnRoster,
      },
      telemetry: {
        actions: [...actionTelemetryRef.current],
      },
      ...(league.draftType === "AUCTION" ? { salaryCapEvidence: { sales: salaryCapEvidence } } : {}),
      sleeperEvidence: {
        candidateCount: sleeperEvidence.length,
        candidates: sleeperEvidence,
      },
    };
    draftAuditPendingRef.current = digest;
    void (async () => {
      for (let attempt = 0; attempt < 3 && draftAuditPendingRef.current === digest; attempt += 1) {
        try {
          const response = await fetch("/api/draft-day", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operation: "AUDIT", audit: snapshot }),
            cache: "no-store",
          });
          const result = await response.json().catch(() => null) as {
            code?: string;
            evaluation?: { finalReady?: boolean; parity?: boolean };
          } | null;
          if (!response.ok || result?.code !== "DRAFT_AUDIT_RECORDED") throw new Error(result?.code || `HTTP_${response.status}`);
          if (draftAuditPendingRef.current === digest) {
            draftAuditDigestRef.current = digest;
            draftAuditPendingRef.current = "";
          }
          const cleanup = resolvePracticeRoomCleanupRequest({
            sourceLeagueId: activeSourceLeagueRef.current,
            snapshot,
            evaluation: result?.evaluation,
            finalizedKey: finalizedPracticeRoomRef.current,
          });
          if (cleanup) {
            finalizedPracticeRoomRef.current = cleanup.key;
            const previousAttempt = practiceRoomCleanupAttemptRef.current;
            practiceRoomCleanupAttemptRef.current = {
              key: cleanup.key,
              attempts: previousAttempt.key === cleanup.key ? previousAttempt.attempts + 1 : 1,
            };
            sendToExtension("CLOSE_PRACTICE_ROOM", cleanup.payload);
          }
          return;
        } catch {
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      if (draftAuditPendingRef.current === digest) draftAuditPendingRef.current = "";
    })();
  }, [actionState, activeEspnTabId, auditHeartbeat, authenticatedImportAt, autoDraft, authoritativePicks.length, context, currentSleeperEvidence, espnPlayers, extension, healthySources, league, liveChecklistReady, myPickCount, myPicks, playerPool.playerById, recommendationPick, runtimeDiagnostics, settingsConfirmed, telemetryVersion]);

  const { commandLabel, safetyLabel } = presentation;
  const displayCommandLabel = presentation.stateTone === "blocked" && context.autopickActive !== true && focusPlayer
    ? `${league.draftType === "SNAKE" ? "PREPARE" : "TRACK"} ${focusPlayer.name}`
    : commandLabel;
  const displayLiveBoardRank = resolveLiveBoardDisplayRank(focusPlayer, liveRecommendations);
  const actionSurfaceStatus = resolveActionSurfaceStatus({
    actionWindowOpen,
    onClock: context.onClock === true,
    inDraftRoom: context.inDraftRoom === true,
    remainingSeconds,
    minimumActionWindow,
  });
  const displayActionState = resolveLiveOperatorStatus({
    actionState,
    draftType: league.draftType,
    commandLabel: displayCommandLabel,
    nominatedPlayerName: nominated?.name,
    currentBid: context.currentBid,
  });
  const alternatives = liveRecommendations.filter((player) => player.id !== focusPlayer?.id).slice(0, 3);

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">DF</span><span>DraftForge <b>AI</b></span></div>
      <div className={`draft-status ${actionWindowOpen ? "on-clock" : ""}`}><span className="live-dot" />{extension === "connected" ? actionSurfaceStatus.header : "DRAFT CONTROL ROOM"}<strong>{league.draftType === "SNAKE" ? `Round ${currentRound} · Pick ${currentPick}${Number.isFinite(remainingSeconds) ? ` · ${remainingSeconds}s` : ""}` : `$${league.auctionBudget - spent} remaining`}</strong></div>
      <div className="header-actions">
        <button className={`auto-toggle ${autoDraft ? "enabled" : ""}`} onClick={enableAutoDraft} disabled={autoDraft ? false : !liveChecklistReady} aria-label={`Auto-Draft ${autoDraft ? "ON" : "OFF"}`}><i /><span className="desktop-label">Auto-Draft {autoDraft ? "ON" : "OFF"}</span><span className="mobile-label">Auto {autoDraft ? "ON" : "OFF"}</span></button>
        <button className="settings-button" onClick={() => dispatchUi({ type: "set", key: "settingsOpen", value: true })}><span className="desktop-label">League rules</span><span className="mobile-label">Rules</span></button>
      </div>
    </header>

    <section className="operations-bar" aria-label="Live draft operations">
      <div className="ops-league"><span className="platform-chip">E</span><div><select className="league-switcher" aria-label="Active ESPN league" value={league.id} onChange={(event) => { if (event.target.value === "__new") startAnotherLeague(); else { const profile = profiles[event.target.value]; if (profile) activateProfile(profile); } }}><option value="demo">{league.id === "demo" ? league.name : "Choose draft"}</option>{Object.values(profiles).sort((a, b) => a.league.name.localeCompare(b.league.name)).map((profile) => <option key={profile.league.id} value={profile.league.id}>{profile.league.name}</option>)}<option value="__new">＋ Import another ESPN league</option></select><small>{league.size}-team · {league.scoringLabel} · {league.draftType === "AUCTION" ? `$${league.auctionBudget} salary cap` : "Snake"}</small></div></div>
      <div className="ops-progress"><div><span>Draft progress</span><b>{authoritativePicks.length} / {league.size * league.rosterSize}</b></div><div className="progress" role="progressbar" aria-label="Draft progress" aria-valuemin={0} aria-valuemax={league.size * league.rosterSize} aria-valuenow={authoritativePicks.length}><i style={{ width: `${Math.min(100, authoritativePicks.length / Math.max(1, league.size * league.rosterSize) * 100)}%` }} /></div><small>{league.draftType === "SNAKE" ? `Round ${currentRound} · Pick ${currentPick}` : `$${remainingBudget} remaining · ${openRosterRows.length} spots open`}</small></div>
      <div className="ops-controls">
        <button className="ops-control" onClick={() => dispatchUi({ type: "toggle", key: "strategyOpen" })} aria-expanded={strategyOpen}><span>Strategy</span><b>{strategyInfo.label}</b><small>{strategyInfo.description}</small></button>
        <button className={`ops-control intelligence-control ${sourceCoverageReady ? "healthy" : "blocked"}`} onClick={() => dispatchUi({ type: "toggle", key: "sourcesOpen" })} aria-expanded={sourcesOpen}><span>Decision data</span><b>{intelligenceLoading ? "Refreshing…" : `${1 + healthySources.length}/5 sources live`}</b><small>Deterministic weighted consensus</small></button>
      </div>
      <div className={`ops-status ${displayActionState.includes("stopped") || presentation.stateTone === "blocked" ? "blocked" : ""}`} role="status" aria-live="polite"><span>{extension === "connected" ? "LIVE STATUS" : "CONNECTION"}</span><b>{displayActionState}</b><small><i aria-hidden="true">●</i>{extension === "connected" ? `Exact ESPN league ${league.id}` : extension === "missing" ? "Companion not detected" : extension === "connecting" ? "Connecting to ESPN…" : "ESPN companion ready"}</small></div>
      {strategyOpen && <div className="strategy-menu">{STRATEGIES.map((item) => <button key={item.id} className={strategy === item.id ? "active" : ""} onClick={() => { setStrategy(item.id); dispatchUi({ type: "set", key: "strategyOpen", value: false }); }}><b>{item.label}</b><small>{item.description}</small></button>)}</div>}
      {sourcesOpen && <div className="sources-menu"><div><b>Decision intelligence</b><button onClick={() => dispatchUi({ type: "set", key: "sourcesOpen", value: false })} aria-label="Close source details">×</button></div><p>ESPN anchors league projections and salary values at 30%. Every healthy ranking feed is converted into a league-normalized theoretical dollar curve; MFL AAV and ESPN dollars remain live market anchors.</p><ul><li><span className="source-ok">●</span><b>ESPN Fantasy</b><small>30% · projection, ADP, salary value</small></li>{sources.map((source) => { const fresh = isIntelligenceSourceFresh(source); return <li key={source.id}><span className={fresh ? "source-ok" : "source-error"}>●</span><b>{source.name}</b><small>{Math.round(source.weight * 100)}% · {source.kind}{source.sampleSize ? ` · ${source.sampleSize.toLocaleString()} drafts` : ""}{source.updatedAt ? ` · ${new Date(source.updatedAt).toLocaleString()}` : ""} · <a href={source.url} target="_blank" rel="noreferrer">source</a></small></li>; })}</ul><small>Failed or stale sources are removed, weights renormalize, and no generated projection replaces missing data.</small></div>}
    </section>

    {(settingsOpen || (extension !== "connected" && league.id !== "demo")) && <section className="setup-drawer">
      {extension !== "connected" ? <div className="connect-card">
        <div><p className="eyebrow">PREFLIGHT 1 OF 2 · CONNECT ESPN</p><h1>Import your real draft.</h1><p>Open your ESPN league in another Chrome tab. The companion reads your authenticated settings without exposing your password or cookies.</p></div>
        <label>League ID <input value={leagueId} onChange={(event) => setLeagueId(event.target.value.replace(/\D/g, ""))} placeholder="Auto-detect or enter ID" inputMode="numeric" /></label>
        <button className="primary-button" onClick={connect} disabled={extension === "missing" || extension === "connecting"}>{extension === "connecting" ? "Importing…" : "Import from ESPN"}</button>
        {extension === "missing" && <p className="connect-error">Download and unzip the Chrome companion, load that folder at chrome://extensions, then refresh this page.</p>}
        <a className="extension-download" href="/draftforge-espn-companion.zip" download>Download Chrome companion ↓</a>
        <div className="preview-formats" aria-label="Preview a draft command center">
          <span>Preview the command center</span>
          <button className={league.id === "demo" && league.draftType === "SNAKE" ? "active" : ""} onClick={() => previewDraftFormat("SNAKE")}>Snake</button>
          <button className={league.id === "demo" && league.draftType === "AUCTION" ? "active" : ""} onClick={() => previewDraftFormat("AUCTION")}>Salary cap</button>
        </div>
      </div> : <div className="rules-card">
        <div className="rules-heading"><div><p className="eyebrow">PREFLIGHT 2 OF 2 · VERIFY LEAGUE</p><h2>Confirm ESPN league rules</h2><p>Draft actions stay locked until these imported settings match your ESPN league.</p></div><button onClick={() => dispatchUi({ type: "set", key: "settingsOpen", value: false })} aria-label="Close settings">×</button></div>
        <div className="rule-grid">
          <div><span>Draft</span><b>{league.draftType === "AUCTION" ? "Salary cap" : "Snake"}</b><small>{league.secondsPerPick}s timer{league.keeperCount ? ` · ${league.keeperCount} keepers` : " · no keepers"}</small></div>
          <div><span>League</span><b>{league.size} teams</b><small>{league.rosterSize} roster spots</small></div>
          <div><span>Scoring</span><b>{league.scoringLabel}</b><small>{league.scoringRules} imported scoring rules</small></div>
          <div><span>{league.draftType === "AUCTION" ? "Budget" : "Draft order"}</span><b>{league.draftType === "AUCTION" ? `$${league.auctionBudget}` : league.pickOrder.length ? `${league.pickOrder.length} slots imported` : "Set by ESPN"}</b><small>{league.draftType === "AUCTION" ? "$1 minimum per open slot" : "Live order follows ESPN"}</small></div>
        </div>
        <div className="slot-summary"><span>Roster:</span>{Object.entries(league.lineupSlotCounts).filter(([, count]) => Number(count) > 0).map(([slot, count]) => <b key={slot}>{rosterSlots({ ...league, lineupSlotCounts: { [slot]: count } })[0] || `Slot ${slot}`} × {count}</b>)}</div>
        <div className="checklist-grid">
          <div><b>Pre-draft import check</b>{preflightChecks.map((check) => <span className={check.ok ? "pass" : "fail"} key={check.label}>{check.ok ? "✓" : "○"} {check.label}</span>)}</div>
          <div><b>Live-room dry run</b>{liveChecks.map((check) => <span className={check.ok ? "pass" : "fail"} key={check.label}>{check.ok ? "✓" : "○"} {check.label}</span>)}</div>
        </div>
        {league.draftType === "AUCTION" && <div className="auction-plan"><b>Predefined budget plan</b>{Object.entries(auctionPlan.positionBudgets).map(([position, amount]) => <span key={position}>{position} <strong>${amount}</strong></span>)}<small>${auctionPlan.endgameReserve} late leverage protected. Walk-away prices adapt to remaining-dollar inflation and tier supply without crossing these portfolio envelopes.</small></div>}
        <button className="raw-toggle" onClick={() => dispatchUi({ type: "toggle", key: "rawSettingsOpen" })}>{rawSettingsOpen ? "Hide" : "Inspect"} all imported ESPN fields</button>
        {rawSettingsOpen && <pre className="raw-settings">{JSON.stringify(league.rawSettings || league, null, 2)}</pre>}
        <div className="rule-actions"><button className="secondary-button" onClick={connect}>Re-import</button><button className="primary-button" disabled={!preflightReady} onClick={confirmPreDraftChecklist}>{context.inDraftRoom === true ? "Confirm live-room checklist" : "Confirm + arm live draft"}</button></div>
      </div>}
    </section>}

    <section className="workspace">
      <aside className="coach-column">
        {(focusPlayer || myPickCount >= league.rosterSize) && <section className="recommendation panel" aria-labelledby="decision-title">
          <div className="decision-head">
            <div><p className="eyebrow">DO THIS NOW · {league.draftType === "AUCTION" ? "SALARY CAP" : "SNAKE"}</p><h1 id="decision-title">{displayCommandLabel}</h1></div>
            <span className={`decision-state ${presentation.stateTone}`}>{presentation.stateLabel}</span>
          </div>
          {myPickCount >= league.rosterSize ? <>
            <div className="decision-hero completion-hero">
              <div className="rec-player"><div className="avatar">✓</div><div><h2>ESPN roster confirmed</h2><p>{myPickCount} of {league.rosterSize} slots complete · exact room {league.id}</p></div></div>
              <div className="command-number"><span>FINAL ROSTER</span><strong>{myPickCount}/{league.rosterSize}</strong><small>{league.draftType === "AUCTION" ? `$${remainingBudget} remaining` : "Every pick reconciled"}</small></div>
            </div>
            <div className="decision-safety" role="status" aria-live="polite"><span aria-hidden="true">✓</span><b>{safetyLabel}</b></div>
          </> : focusPlayer ? <>
          {nominated && <p className="auction-live">LIVE NOMINATION · {context.currentBid ? `$${context.currentBid}` : "Opening bid"}{ownNominationIntent ? ` · ${ownNominationIntent}` : ""}</p>}
          {!nominated && league.draftType === "AUCTION" && auctionNomination && <p className="auction-live">{auctionNomination.intent} NOMINATION · OPEN ${auctionNomination.openingBid}</p>}
          <div className="decision-hero">
            <div className="rec-player"><div className={`avatar ${focusPlayer.pos.toLowerCase()}`}>{focusPlayer.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</div><div><h2>{focusPlayer.name}</h2><p>{focusPlayer.pos} · {focusPlayer.team} <span>Live board #{displayLiveBoardRank || "—"}</span>{focusPlayer.sleeperLabel !== "NONE" && <span className="sleeper-chip">{focusPlayer.sleeperLabel.replace("_", " ")} {focusPlayer.sleeperScore}/100</span>}</p></div></div>
            <div className="command-number"><span>{league.draftType === "AUCTION" ? nominated ? "NEXT LEGAL BID" : "OPENING BID" : "ESPN CLOCK"}</span><strong>{league.draftType === "AUCTION" ? `$${nominated ? nextBid : auctionNomination?.openingBid || 1}` : Number.isFinite(remainingSeconds) ? `${remainingSeconds}s` : "—"}</strong><small>{league.draftType === "AUCTION" ? `Walk at $${focusPlayer.maxBid}` : `Round ${currentRound} · Pick ${currentPick}`}</small></div>
          </div>
          <div className={`decision-safety ${presentation.stateTone === "blocked" ? "blocked" : ""}`} role="status" aria-live="polite"><span aria-hidden="true">{presentation.stateTone === "blocked" ? "!" : "✓"}</span><b>{safetyLabel}</b></div>
          <div className="decision-metrics">
            {league.draftType === "AUCTION" ? <>
              <div><span>Current offer</span><b>{context.currentBid ? `$${context.currentBid}` : "—"}</b></div>
              <div><span>Fair value</span><b>${displayAuctionValue(focusPlayer.id, league.id, focusPlayer.fairValue)}</b></div>
              <div className="metric-emphasis"><span>Hard ceiling</span><b>${focusPlayer.maxBid}</b></div>
              <div><span>{nominated ? "After next bid" : "Reserve floor"}</span><b>{nominated ? `$${Math.max(0, remainingBudget - nextBid)} left` : `$${currentReserve}`}</b><small>{nominated ? `$${postWinReserve} reserve required` : "$1 per open slot"}</small></div>
            </> : <>
              <div><span>ADP edge</span><b>{`${focusPlayer.adpValue >= 0 ? "+" : ""}${focusPlayer.adpValue.toFixed(1)}`}</b></div>
              <div><span>VORP</span><b>+{focusPlayer.vorp.toFixed(1)}</b></div>
              <div><span>Tier drop</span><b>{focusPlayer.scarcity.toFixed(1)}</b></div>
              <div><span>Source confidence</span><b>{focusPlayer.confidence}%</b></div>
            </>}
          </div>
          {league.draftType === "SNAKE" ? <button className="draft-button full" onClick={() => submit(focusPlayer, false, "SELECT")} disabled={!settingsConfirmed || extension !== "connected" || !actionWindowOpen}>Draft {focusPlayer.name} in ESPN<small>{Number.isFinite(remainingSeconds) ? `${remainingSeconds}s remaining` : "Waiting for verified clock"}</small></button> : <div className="pick-actions"><button className="draft-button" onClick={() => auctionNomination && submit(auctionNomination.player, false, "NOMINATE", auctionNomination.openingBid, auctionNomination.intent)} disabled={!settingsConfirmed || extension !== "connected" || !actionWindowOpen || Boolean(nominated || context.nominatedPlayer || Number(context.currentBid || 0) > 0) || !auctionNomination}>Nominate {auctionNomination?.intent === "DRAIN" ? "budget drain" : "target"}<small>Open ${auctionNomination?.openingBid || 1}</small></button><button className="bid-button" onClick={() => submit(focusPlayer, false, "BID", nextBid)} disabled={!settingsConfirmed || extension !== "connected" || !nominated || context.leadingBid || ownNominationIntent === "DRAIN" || nextBid > focusPlayer.maxBid || !bidWindowOpen}>{ownNominationIntent === "DRAIN" ? "Pass — no price enforcing" : context.leadingBid ? "Hold — already leading" : nextBid > focusPlayer.maxBid ? "Pass — ceiling reached" : `Bid $${nextBid}`}<small>{ownNominationIntent === "DRAIN" ? "Decoy nomination" : `Hard stop $${focusPlayer.maxBid}`}</small></button></div>}
          {!settingsConfirmed && <small className="locked-note">Confirm imported league rules to unlock ESPN actions.</small>}
          <details className="decision-details"><summary>Decision intelligence <span>{focusPlayer.confidence}% confidence</span></summary><div className="confidence"><div><span>Source agreement · {focusPlayer.sourceCount || 1}/5 sources</span><b>{focusPlayer.confidence}%</b></div><div className="confidence-track"><i style={{ width: `${focusPlayer.confidence}%` }} /></div></div><p className="reason">{describeRecommendation(focusPlayer, league, strategy)}</p>{league.draftType === "AUCTION" && focusPlayer.sourceAuctions && <div className="source-values">{Object.entries(focusPlayer.sourceAuctions).map(([source, amount]) => <span key={source}>{source.toUpperCase()} <b>${Math.round(amount)}</b></span>)}</div>}<ul className="reason-list">{focusPlayer.reasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul></details>
          </> : null}
        </section>}
        <section className="on-clock-card panel"><span className={actionWindowOpen ? "pulse" : ""} aria-hidden="true">●</span><div><b>{actionSurfaceStatus.detail}</b><small>{autoDraft ? "Auto-Draft is armed only for this verified league and tab." : "Guided mode: you approve every pick, nomination, and bid."}</small></div></section>
      </aside>

      <aside className="roster-panel panel">
        <div className="roster-head"><div><p className="eyebrow">ROSTER CONTROL</p><h2>Team build</h2></div><span>{myRoster.length} / {league.rosterSize}</span></div>
        <div className="needs-block"><div><span>Open roster spots</span><b>{openRosterRows.length}</b></div><div className="needs-chips">{openRosterRows.slice(0, 8).map(({ slot }, index) => <span key={`${slot}-${index}`}>{slot}</span>)}{openRosterRows.length > 8 && <span>+{openRosterRows.length - 8}</span>}</div></div>
        {league.draftType === "AUCTION" && <>
          <div className="budget-card"><div><span>Remaining</span><b>${remainingBudget}</b></div><div><span>Protected reserve</span><b>${currentReserve}</b><small>$1 per open slot</small></div><div><span>Room market</span><b>{auctionPlan.roomInflation.toFixed(2)}×</b><small>{Math.round(auctionPlan.knownSaleCoverage * 100)}% exact sales</small></div></div>
          <div className="budget-runway"><div><span>Spendable runway</span><b>${spendableBudget}</b><small>${currentReserve} untouchable reserve</small></div><div className="budget-runway-track" role="progressbar" aria-label="Spendable salary-cap runway" aria-valuemin={0} aria-valuemax={Math.max(1, remainingBudget)} aria-valuenow={spendableBudget}><i style={{ width: `${Math.min(100, spendableBudget / Math.max(1, remainingBudget) * 100)}%` }} /></div><p>Every offer must leave $1 for each open roster spot. The hard ceiling can only move down as the room changes.</p></div>
          <div className="budget-plan-mini">{Object.entries(auctionPlan.positionBudgets).map(([position, budget]) => <span key={position}>{position} <b>${auctionUsage.usage[position] || 0} / ${budget}</b></span>)}{auctionUsage.reallocated > 0 && <span>VALUE <b>${auctionUsage.reallocated} reallocated</b></span>}</div>
          <details className="secondary-details"><summary>Opponent leverage <span>${auctionPlan.opponentSpend} spent</span></summary><div className="opponent-budgets">{[...auctionPlan.opponents].sort((left, right) => right.maxOffer - left.maxOffer).map((opponent) => <span key={opponent.teamId}><em>{opponent.name}</em><small>{opponent.players} players · ${opponent.spent} spent · max ${opponent.maxOffer} · needs {Object.entries(opponent.openStarters).filter(([, count]) => count > 0).map(([position, count]) => `${position}${count > 1 ? count : ""}`).join("/") || "depth"}</small></span>)}</div></details>
        </>}
        <div className="roster-list">{rosterRows.map(({ slot, item }, index) => <div className={`roster-row ${item ? "filled" : ""}`} key={`${slot}-${index}`}><span>{slot}</span>{item ? <><div><b>{item.player.name}</b><small>{item.player.team}{item.pick.amount ? ` · $${item.pick.amount}` : ""}</small></div><i className={`pos ${item.player.pos.toLowerCase()}`}>{item.player.pos}</i></> : <em>Open</em>}</div>)}</div>
        <details className="secondary-details activity-details"><summary>Recent ESPN activity <span>{authoritativePicks.length} picks</span></summary><div className="draft-log">{authoritativePicks.slice(-5).reverse().map((pick) => { const player = players.find((item) => item.id === pick.playerId); return <div key={`${pick.overall}-${pick.playerId}`}><span>{pick.overall}</span><b>{player?.name || `Player ${pick.playerId}`}</b><small>{pick.amount ? `$${pick.amount}` : `Team ${pick.teamId}`}</small></div>; })}{!authoritativePicks.length && <small>No picks imported yet.</small>}</div></details>
      </aside>

      <section className="players-panel panel">
        <div className="panel-head"><div><p className="eyebrow">NEXT BEST OPTIONS</p><h2>Live player board</h2></div><label className="search-box"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player or team" aria-label="Search player or team" /></label></div>
        {alternatives.length > 0 && <div className="alternatives" aria-label="Top alternatives">{alternatives.map((player, index) => <button key={player.id} onClick={() => setSelectedId(player.id)}><span>#{index + 2} alternative</span><b>{player.name}</b><small>{player.pos} · {league.draftType === "AUCTION" ? `$${displayAuctionValue(player.id, league.id, player.fairValue)} fair` : `ADP ${player.adp < 900 ? player.adp.toFixed(1) : "—"}`}</small></button>)}</div>}
        <div className="filters" aria-label="Filter player board">{FILTERS.map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)} aria-pressed={filter === item}>{item}</button>)}</div>
        <div className="table-head" aria-hidden="true"><span>#</span><span>PLAYER</span><span>POS</span><span>{league.draftType === "AUCTION" ? "FAIR $" : "ADP"}</span><span>PROJ</span><span>MODEL</span></div>
        <div className="player-list">{visible.slice(0, 150).map((player, index) => <button key={player.id} className={`player-row ${selected?.id === player.id ? "selected" : ""}`} onClick={() => setSelectedId(player.id)} aria-pressed={selected?.id === player.id}>
          <span className="rank">{index + 1}</span><span className="player-name"><span><b>{player.name}</b><small>{player.team}{player.injured ? " · Injury flag" : ""}{player.sleeperLabel !== "NONE" ? ` · ${player.sleeperLabel.replace("_", " ")} ${player.sleeperScore}` : ""}</small></span></span><i className={`pos ${player.pos.toLowerCase()}`}>{player.pos}</i><span>{league.draftType === "AUCTION" ? `$${displayAuctionValue(player.id, league.id, player.fairValue)}` : player.adp < 900 ? player.adp.toFixed(1) : "—"}</span><span>{player.projected ? player.projected.toFixed(1) : "—"}</span><span className="model-score">{Math.round(player.score)}</span>
          {index === 0 && <em className="best-badge">BEST FIT</em>}
        </button>)}</div>
      </section>
    </section>

    {autoWarning && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Enable Auto-Draft"><div className="warning-modal"><span className="warning-icon">!</span><h2>Live-room checklist passed</h2><p>The extension is bound to the exact imported ESPN draft tab and the local control room completed a no-click recommendation dry run.</p><ul>{liveChecks.map((check) => <li key={check.label}>✓ {check.label}</li>)}<li>{league.draftType === "AUCTION" ? "Offers rise by exactly $1 and stop at the lower of fair value, portfolio walk-away, pacing guardrail, and ESPN's legal maximum; DraftForge never rebids on its own DRAIN nomination." : "Each pick is re-ranked against the live remaining pool and positional tier cliffs."}</li><li>Turn Auto-Draft off at any time.</li></ul><div><button className="secondary-button" onClick={() => dispatchUi({ type: "set", key: "autoWarning", value: false })}>Cancel</button><button className="danger-button" onClick={confirmEnableAutoDraft}>Enable Auto-Draft</button></div></div></div>}
    <footer><span>DraftForge AI · draft-only ESPN control room</span><span>{draftedIds.size} drafted · five-source deterministic consensus</span></footer>
  </main>;
}
