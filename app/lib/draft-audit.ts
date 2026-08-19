import { openStarterSlots, type LeagueSettings, type Position } from "./draft-engine.ts";

export type DraftAuditRosterEntry = {
  playerId: number;
  playerName: string;
  position: string;
  amount: number;
};

export type DraftActionTelemetryEvent = {
  occurredAt: string;
  operation: "SELECT" | "BID" | "NOMINATE";
  ok: boolean;
  code: string;
  roundTripMs: number;
  clockSeconds: number | null;
  automatic: boolean;
};

export type DraftAuditSleeperCandidate = {
  playerId: number;
  playerName: string;
  position: string;
  adp: number;
  label: "VALUE" | "SLEEPER" | "DEEP_STASH";
  score: number;
  modelMarketEdge: number;
  modelSpread: number;
  sourceCount: number;
};

export type DraftRuntimeDiagnostics = {
  capturedAt: string;
  extensionVersion: string;
  browserTabCount: number;
  draftForgeTabCount: number;
  espnTabCount: number;
};

export type DraftAuditSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  league: {
    id: string;
    teamId: number;
    season: number;
    draftType: "SNAKE" | "AUCTION";
    size: number;
    rosterSize: number;
    auctionBudget: number;
    secondsPerPick: number;
    scoringLabel: string;
    scoringRules: number;
    keeperCount: number;
    lineupSlotCounts: Record<string, number>;
    positionLimits: Record<string, number>;
  };
  binding: {
    tabId: number;
    commandCenterSessionId?: string;
    commandCenterStartedAt?: string;
    authenticatedImportAt: string;
  };
  runtime: DraftRuntimeDiagnostics;
  safety: {
    settingsConfirmed: boolean;
    liveChecklistReady: boolean;
    extensionConnected: boolean;
    inDraftRoom: boolean;
    soundMuted: boolean;
    autopickActive: boolean;
    autoDraft: boolean;
    sourceCoverage: number;
    sourceIds: string[];
    actionState: string;
  };
  draft: {
    totalPicks: number;
    appRoster: DraftAuditRosterEntry[];
    espnRoster: DraftAuditRosterEntry[];
  };
  telemetry: {
    actions: DraftActionTelemetryEvent[];
  };
  sleeperEvidence: {
    candidateCount: number;
    candidates: DraftAuditSleeperCandidate[];
  };
};

export type DraftAuditEvaluation = {
  complete: boolean;
  finalReady: boolean;
  parity: boolean;
  openSlots: number;
  spent: number;
  remainingBudget: number;
  hardViolations: string[];
  finalViolations: string[];
};

export function draftAuditChecklistBindingKey(leagueId: string, teamId: number, tabId: number) {
  const normalizedLeagueId = String(leagueId || "").trim();
  if (!normalizedLeagueId || !Number.isInteger(teamId) || teamId <= 0 || !Number.isInteger(tabId) || tabId <= 0) return "";
  return `${normalizedLeagueId}:${teamId}:${tabId}`;
}

export function resolveDraftAuditChecklistReady(input: {
  currentReady: boolean;
  rosterComplete: boolean;
  currentBindingKey: string;
  lastValidatedBindingKey: string;
}) {
  return input.currentReady || (
    input.rosterComplete
    && Boolean(input.currentBindingKey)
    && input.currentBindingKey === input.lastValidatedBindingKey
  );
}

const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const POSITION_LIMIT_KEYS: Record<string, string[]> = {
  QB: ["QB", "1"],
  RB: ["RB", "2"],
  WR: ["WR", "3"],
  TE: ["TE", "4"],
  K: ["K", "5", "17"],
  DST: ["DST", "D/ST", "16"],
};

function unique(values: string[]) {
  return [...new Set(values)];
}

function rosterKey(entry: DraftAuditRosterEntry, includeAmount: boolean) {
  return `${entry.playerId}:${includeAmount ? entry.amount : 0}`;
}

function duplicatePlayerIds(roster: DraftAuditRosterEntry[]) {
  const ids = roster.map((entry) => entry.playerId);
  return ids.some((id, index) => ids.indexOf(id) !== index);
}

function positionLimit(snapshot: DraftAuditSnapshot, position: string) {
  const configured = (POSITION_LIMIT_KEYS[position] || [])
    .map((key) => Number(snapshot.league.positionLimits?.[key]))
    .find((value) => Number.isInteger(value) && value >= 0);
  return configured === undefined ? Number.POSITIVE_INFINITY : configured;
}

function rosterParity(snapshot: DraftAuditSnapshot) {
  const includeAmount = snapshot.league.draftType === "AUCTION";
  const app = snapshot.draft.appRoster.map((entry) => rosterKey(entry, includeAmount)).sort();
  const espn = snapshot.draft.espnRoster.map((entry) => rosterKey(entry, includeAmount)).sort();
  return app.length === espn.length && app.every((entry, index) => entry === espn[index]);
}

export function isDraftAuditSnapshot(value: unknown): value is DraftAuditSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<DraftAuditSnapshot>;
  const league = snapshot.league;
  const binding = snapshot.binding;
  const runtime = snapshot.runtime;
  const safety = snapshot.safety;
  const draft = snapshot.draft;
  if (snapshot.schemaVersion !== 1 || !Number.isFinite(Date.parse(String(snapshot.capturedAt || "")))) return false;
  if (!league || !String(league.id || "").trim() || !Number.isInteger(league.teamId) || Number(league.teamId) <= 0) return false;
  if (!["SNAKE", "AUCTION"].includes(String(league.draftType))) return false;
  if (!Number.isInteger(league.season) || Number(league.season) < 2026) return false;
  if (!Number.isInteger(league.size) || Number(league.size) < 2 || !Number.isInteger(league.rosterSize) || Number(league.rosterSize) < 1) return false;
  if (!Number.isFinite(league.auctionBudget) || Number(league.auctionBudget) < 0) return false;
  if (!Number.isInteger(league.secondsPerPick) || Number(league.secondsPerPick) < 1) return false;
  if (!String(league.scoringLabel || "").trim() || !Number.isInteger(league.scoringRules) || Number(league.scoringRules) < 1) return false;
  if (!Number.isInteger(league.keeperCount) || Number(league.keeperCount) < 0) return false;
  if (!league.lineupSlotCounts || !league.positionLimits || !binding || !Number.isInteger(binding.tabId) || Number(binding.tabId) <= 0) return false;
  if (!Number.isFinite(Date.parse(String(binding.authenticatedImportAt || "")))) return false;
  const hasPublisherId = typeof binding.commandCenterSessionId === "string" && binding.commandCenterSessionId.trim().length >= 8;
  const hasPublisherStartedAt = Number.isFinite(Date.parse(String(binding.commandCenterStartedAt || "")));
  if (binding.commandCenterSessionId !== undefined || binding.commandCenterStartedAt !== undefined) {
    if (!hasPublisherId || !hasPublisherStartedAt) return false;
  }
  if (!runtime || !Number.isFinite(Date.parse(String(runtime.capturedAt || ""))) || !String(runtime.extensionVersion || "").trim()) return false;
  if (![runtime.browserTabCount, runtime.draftForgeTabCount, runtime.espnTabCount].every((count) => Number.isInteger(count) && Number(count) >= 0)) return false;
  if (!safety || !draft || !Number.isInteger(draft.totalPicks) || Number(draft.totalPicks) < 0) return false;
  if ([
    safety.settingsConfirmed,
    safety.liveChecklistReady,
    safety.extensionConnected,
    safety.inDraftRoom,
    safety.soundMuted,
    safety.autopickActive,
    safety.autoDraft,
  ].some((value) => typeof value !== "boolean")) return false;
  if (!Number.isInteger(safety.sourceCoverage) || typeof safety.actionState !== "string") return false;
  if (!Array.isArray(safety.sourceIds) || safety.sourceIds.some((id) => typeof id !== "string")) return false;
  if (!Array.isArray(draft.appRoster) || !Array.isArray(draft.espnRoster)) return false;
  if (!snapshot.telemetry) return false;
  if (!Array.isArray(snapshot.telemetry.actions) || snapshot.telemetry.actions.length > 25) return false;
  if (!snapshot.telemetry.actions.every((event) => (
    Number.isFinite(Date.parse(String(event?.occurredAt || "")))
    && ["SELECT", "BID", "NOMINATE"].includes(String(event?.operation))
    && typeof event?.ok === "boolean"
    && Boolean(String(event?.code || "").trim())
    && Number.isInteger(event?.roundTripMs)
    && Number(event.roundTripMs) >= 0
    && (event.clockSeconds === null || (Number.isFinite(event.clockSeconds) && Number(event.clockSeconds) >= 0))
    && typeof event?.automatic === "boolean"
  ))) return false;
  if (!snapshot.sleeperEvidence || !Number.isInteger(snapshot.sleeperEvidence.candidateCount) || snapshot.sleeperEvidence.candidateCount < 0) return false;
  if (!Array.isArray(snapshot.sleeperEvidence.candidates) || snapshot.sleeperEvidence.candidates.length > 20) return false;
  if (snapshot.sleeperEvidence.candidateCount !== snapshot.sleeperEvidence.candidates.length) return false;
  if (!snapshot.sleeperEvidence.candidates.every((candidate) => (
    Number.isInteger(candidate?.playerId)
    && candidate.playerId !== 0
    && Boolean(String(candidate.playerName || "").trim())
    && POSITIONS.has(String(candidate.position))
    && Number.isFinite(candidate.adp)
    && ["VALUE", "SLEEPER", "DEEP_STASH"].includes(String(candidate.label))
    && Number.isInteger(candidate.score)
    && candidate.score >= 50
    && Number.isFinite(candidate.modelMarketEdge)
    && candidate.modelMarketEdge >= 8
    && Number.isFinite(candidate.modelSpread)
    && candidate.modelSpread <= 12
    && Number.isInteger(candidate.sourceCount)
    && candidate.sourceCount >= 4
  ))) return false;
  return [...draft.appRoster, ...draft.espnRoster].every((entry) => (
    Number.isInteger(entry?.playerId)
    && Number(entry.playerId) !== 0
    && (Number(entry.playerId) > 0 || String(entry.position) === "DST")
    && Boolean(String(entry.playerName || "").trim())
    && POSITIONS.has(String(entry.position))
    && Number.isInteger(entry.amount)
    && Number(entry.amount) >= 0
  ));
}

export function evaluateDraftAuditSnapshot(snapshot: DraftAuditSnapshot): DraftAuditEvaluation {
  const roster = snapshot.draft.appRoster;
  const openSlots = Math.max(0, snapshot.league.rosterSize - roster.length);
  const spent = roster.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const remainingBudget = snapshot.league.draftType === "AUCTION"
    ? snapshot.league.auctionBudget - spent
    : 0;
  const counts = roster.reduce<Record<string, number>>((result, entry) => {
    result[entry.position] = Number(result[entry.position] || 0) + 1;
    return result;
  }, {});
  const hardViolations: string[] = [];
  if (duplicatePlayerIds(roster) || duplicatePlayerIds(snapshot.draft.espnRoster)) hardViolations.push("DUPLICATE_PLAYER");
  if (Number(counts.K || 0) > 1) hardViolations.push("UNNECESSARY_SECOND_K");
  if (Number(counts.DST || 0) > 1) hardViolations.push("UNNECESSARY_SECOND_DST");
  for (const [position, count] of Object.entries(counts)) {
    if (count > positionLimit(snapshot, position)) hardViolations.push(`POSITION_CAP_${position}`);
  }
  if (snapshot.league.draftType === "AUCTION") {
    if (roster.some((entry) => entry.amount < 1)) hardViolations.push("INVALID_SALARY");
    if (spent > snapshot.league.auctionBudget) hardViolations.push("SALARY_CAP_EXCEEDED");
    if (remainingBudget < openSlots) hardViolations.push("ONE_DOLLAR_RESERVE_VIOLATION");
  }
  if (snapshot.safety.soundMuted !== true) hardViolations.push("SOUND_NOT_MUTED");
  if (snapshot.safety.autopickActive === true) hardViolations.push("ESPN_AUTOPICK_ACTIVE");
  if (snapshot.safety.extensionConnected !== true) hardViolations.push("EXTENSION_NOT_CONNECTED");
  if (snapshot.safety.inDraftRoom !== true) hardViolations.push("NOT_IN_DRAFT_ROOM");
  if (!Number.isInteger(snapshot.binding.tabId) || snapshot.binding.tabId <= 0) hardViolations.push("EXACT_TAB_MISSING");

  const complete = roster.length === snapshot.league.rosterSize;
  const parity = rosterParity(snapshot);
  const finalViolations = [...hardViolations];
  if (!complete) finalViolations.push("ROSTER_INCOMPLETE");
  if (complete && openStarterSlots(
    snapshot.league as LeagueSettings,
    roster.map((entry) => entry.position as Position),
  ) > 0) finalViolations.push("MANDATORY_STARTER_MISSING");
  if (complete && !parity) finalViolations.push("ESPN_APP_ROSTER_MISMATCH");
  if (complete && Number(counts.K || 0) !== 1) finalViolations.push("MANDATORY_K_MISSING");
  if (complete && Number(counts.DST || 0) !== 1) finalViolations.push("MANDATORY_DST_MISSING");
  if (complete && snapshot.safety.autoDraft === true) finalViolations.push("AUTO_DRAFT_NOT_SHUT_DOWN");
  if (snapshot.safety.settingsConfirmed !== true) finalViolations.push("LEAGUE_RULES_NOT_CONFIRMED");
  if (snapshot.safety.liveChecklistReady !== true) finalViolations.push("LIVE_CHECKLIST_NOT_READY");
  if (snapshot.safety.sourceCoverage !== 5) finalViolations.push("FIVE_SOURCE_COVERAGE_INCOMPLETE");
  if (/stopped|excluded|autopick/i.test(snapshot.safety.actionState)) finalViolations.push("FATAL_ACTION_STATE");

  return {
    complete,
    finalReady: complete && unique(finalViolations).length === 0,
    parity,
    openSlots,
    spent,
    remainingBudget,
    hardViolations: unique(hardViolations),
    finalViolations: unique(finalViolations),
  };
}
