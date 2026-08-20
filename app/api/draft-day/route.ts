import {
  buildDraftDayBridgeResult,
  prepareDraftDayBridge,
  type DraftDayPreparedState,
} from "../../lib/draft-day-bridge.ts";
import { fetchIntelligenceSnapshot } from "../../lib/intelligence-sources.ts";
import { intelligenceQuarterbackMode, isCompleteFreshIntelligenceSnapshot } from "../../lib/consensus.ts";
import { reconcileEspnPicks, resolveAuctionSales } from "../../lib/espn-reconciliation.ts";
import type { DraftPick, DraftPlayer, LeagueSettings, StrategyId } from "../../lib/draft-engine.ts";
import type { EspnContext } from "../../lib/espn-context-state.ts";
import {
  evaluateDraftAuditSnapshot,
  isDraftAuditSnapshot,
  type DraftAuditSnapshot,
} from "../../lib/draft-audit.ts";
import { normalizeImportPicks, normalizePicks } from "../../../extension/draft-normalizers.js";
import { normalizeSettings } from "../../../extension/league-import.js";
import { normalizePlayers } from "../../../extension/player-normalizers.js";

const ESPN_ORIGIN = "https://fantasy.espn.com";
const LOCAL_ORIGINS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
const ALLOWED_STRATEGIES = new Set<StrategyId>(["BALANCED", "HERO_RB", "ZERO_RB", "ELITE_QB", "CUSTOM"]);

type DraftDayRequest = {
  operation?: "WARM" | "PREPARE" | "DECIDE" | "AUDIT";
  profile?: { scoring?: string; teams?: number; season?: number; qbs?: number };
  sessionId?: string;
  leaguePayload?: Record<string, unknown>;
  playerPayload?: Record<string, unknown>;
  room?: EspnContext;
  strategy?: StrategyId;
  audit?: DraftAuditSnapshot;
};

type DraftDaySession = {
  createdAt: number;
  league: LeagueSettings;
  espnPlayers: DraftPlayer[];
  sources: Awaited<ReturnType<typeof fetchIntelligenceSnapshot>>["sources"];
  sourceGeneratedAt: string;
  prepared: DraftDayPreparedState;
  strategy: StrategyId;
};

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 4;
const draftDaySessions = new Map<string, DraftDaySession>();
const draftAuditSnapshots = new Map<string, DraftAuditSnapshot>();

function auditKey(leagueId: string, teamId: number) {
  return `${leagueId}:${teamId}`;
}

function pruneAudits(now = Date.now()) {
  const ttl = 24 * 60 * 60 * 1000;
  for (const [key, snapshot] of draftAuditSnapshots) {
    if (now - Date.parse(snapshot.capturedAt) > ttl) draftAuditSnapshots.delete(key);
  }
  while (draftAuditSnapshots.size > 8) {
    const oldest = [...draftAuditSnapshots.entries()].sort((left, right) => Date.parse(left[1].capturedAt) - Date.parse(right[1].capturedAt))[0];
    if (!oldest) break;
    draftAuditSnapshots.delete(oldest[0]);
  }
}

function pruneSessions(now = Date.now()) {
  for (const [id, session] of draftDaySessions) {
    if (now - session.createdAt > SESSION_TTL_MS) draftDaySessions.delete(id);
  }
  while (draftDaySessions.size >= MAX_SESSIONS) {
    const oldest = [...draftDaySessions.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!oldest) break;
    draftDaySessions.delete(oldest[0]);
  }
}

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin === ESPN_ORIGIN || (origin && LOCAL_ORIGINS.has(origin)) ? origin : "";
  return {
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function response(origin: string | null, body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function requestOriginAllowed(origin: string | null) {
  return origin === null || origin === ESPN_ORIGIN || LOCAL_ORIGINS.has(origin);
}

function isLoopbackRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function mergePicks(primary: DraftPick[], fallback: DraftPick[]) {
  const byPlayer = new Map<number, DraftPick>();
  for (const pick of [...fallback, ...primary]) byPlayer.set(pick.playerId, pick);
  return [...byPlayer.values()].sort((left, right) => left.overall - right.overall);
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  if (!isLoopbackRequest(request) || !requestOriginAllowed(origin)) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (!isLoopbackRequest(request) || (origin !== null && !LOCAL_ORIGINS.has(origin))) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }
  pruneAudits();
  const url = new URL(request.url);
  const leagueId = String(url.searchParams.get("leagueId") || "").trim();
  const teamId = Number(url.searchParams.get("teamId"));
  const snapshot = leagueId && Number.isInteger(teamId) && teamId > 0
    ? draftAuditSnapshots.get(auditKey(leagueId, teamId))
    : [...draftAuditSnapshots.values()].sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0];
  if (!snapshot) return response(origin, { ok: false, code: "DRAFT_AUDIT_NOT_FOUND" }, 404);
  return response(origin, {
    ok: true,
    code: "DRAFT_AUDIT_READY",
    snapshot,
    evaluation: evaluateDraftAuditSnapshot(snapshot),
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!isLoopbackRequest(request) || !requestOriginAllowed(origin)) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }

  let body: DraftDayRequest;
  try {
    body = await request.json() as DraftDayRequest;
  } catch {
    return response(origin, { ok: false, code: "INVALID_JSON" }, 400);
  }
  if (body.operation === "AUDIT") {
    if (!isLoopbackRequest(request) || !origin || !LOCAL_ORIGINS.has(origin)) {
      return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
    }
    if (!isDraftAuditSnapshot(body.audit)) return response(origin, { ok: false, code: "DRAFT_AUDIT_INVALID" }, 400);
    pruneAudits();
    const key = auditKey(body.audit.league.id, body.audit.league.teamId);
    const previous = draftAuditSnapshots.get(key);
    const previousPublisher = previous?.binding.commandCenterSessionId;
    const nextPublisher = body.audit.binding.commandCenterSessionId;
    const previousPublisherStartedAt = Date.parse(String(previous?.binding.commandCenterStartedAt || ""));
    const nextPublisherStartedAt = Date.parse(String(body.audit.binding.commandCenterStartedAt || ""));
    const samePublisher = Boolean(previousPublisher && nextPublisher && previousPublisher === nextPublisher);
    const newerPublisher = Boolean(
      nextPublisher
      && Number.isFinite(nextPublisherStartedAt)
      && (!previousPublisher || !Number.isFinite(previousPublisherStartedAt) || nextPublisherStartedAt > previousPublisherStartedAt)
    );
    const stalePublisher = Boolean(previousPublisher && !samePublisher && !newerPublisher);
    if (stalePublisher && previous) {
      return response(origin, {
        ok: false,
        code: "DRAFT_AUDIT_STALE_PUBLISHER",
        evaluation: evaluateDraftAuditSnapshot(previous),
      }, 409);
    }
    if (!previous || newerPublisher || (samePublisher && Date.parse(body.audit.capturedAt) >= Date.parse(previous.capturedAt)) || (!previousPublisher && !nextPublisher && Date.parse(body.audit.capturedAt) >= Date.parse(previous.capturedAt))) {
      draftAuditSnapshots.set(key, body.audit);
    }
    const snapshot = draftAuditSnapshots.get(key) as DraftAuditSnapshot;
    return response(origin, {
      ok: true,
      code: "DRAFT_AUDIT_RECORDED",
      evaluation: evaluateDraftAuditSnapshot(snapshot),
    });
  }
  if (body.operation === "WARM" && body.profile && !body.leaguePayload) {
    const scoring = String(body.profile.scoring || "").trim();
    const teams = Number(body.profile.teams);
    const season = Number(body.profile.season);
    if (!scoring || !Number.isInteger(teams) || teams < 8 || teams > 16 || !Number.isInteger(season) || season < 2026) {
      return response(origin, { ok: false, code: "DRAFT_DAY_PROFILE_INVALID" }, 400);
    }
    const qbs = Number(body.profile.qbs) >= 2 ? 2 : 1;
    const intelligence = await fetchIntelligenceSnapshot({ scoring, teams, season, qbs });
    const ready = isCompleteFreshIntelligenceSnapshot(intelligence.sources, Date.now());
    return response(origin, {
      ok: ready,
      code: ready ? "FIVE_SOURCE_READY" : "FIVE_SOURCE_SNAPSHOT_NOT_READY",
      sourceCoverage: ready ? 5 : 1,
      sourceIds: ["espn", ...intelligence.sources.map((source) => source.id)],
      sourceGeneratedAt: intelligence.generatedAt,
      profile: { scoring, teams, season, qbs },
      sources: intelligence.sources.map((source) => ({
        id: source.id,
        status: source.status,
        players: source.players.length,
        updatedAt: source.updatedAt || source.retrievedAt || null,
        error: source.error || null,
      })),
    }, ready ? 200 : 503);
  }
  if (body.operation === "DECIDE" && body.sessionId) {
    pruneSessions();
    const session = draftDaySessions.get(body.sessionId);
    if (!session) return response(origin, { ok: false, code: "DRAFT_DAY_SESSION_EXPIRED" }, 409);
    if (!body.leaguePayload || !body.room) return response(origin, { ok: false, code: "DRAFT_DAY_PAYLOAD_INCOMPLETE" }, 400);
    const room = body.room;
    const liveLeague = normalizeSettings(body.leaguePayload, {
      leagueId: room.leagueId,
      teamId: room.teamId,
      season: session.league.season,
    }) as LeagueSettings;
    if (liveLeague.id !== session.league.id
      || Number(liveLeague.teamId) !== Number(session.league.teamId)
      || liveLeague.draftType !== session.league.draftType) {
      return response(origin, { ok: false, code: "DRAFT_DAY_SESSION_MISMATCH" }, 409);
    }
    const apiPicks = normalizePicks(body.leaguePayload);
    const reconciled = reconcileEspnPicks(apiPicks, room, session.league.teamId, session.espnPlayers, session.league);
    const auctionSales = resolveAuctionSales(room, session.league, session.espnPlayers);
    const picks = mergePicks(reconciled, auctionSales);
    const result = buildDraftDayBridgeResult({
      league: session.league,
      espnPlayers: session.espnPlayers,
      picks,
      room,
      sources: session.sources,
      strategy: session.strategy,
      evaluatedAt: Date.now(),
      prepared: session.prepared,
    });
    return response(origin, {
      ...result,
      sessionId: body.sessionId,
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: session.sourceGeneratedAt,
      league: {
        id: session.league.id,
        name: session.league.name,
        season: session.league.season,
        teamId: session.league.teamId,
        draftType: session.league.draftType,
        size: session.league.size,
        rosterSize: session.league.rosterSize,
        auctionBudget: session.league.auctionBudget,
        scoringLabel: session.league.scoringLabel,
        scoringRules: session.league.scoringRules,
        keeperCount: session.league.keeperCount,
      },
      observed: {
        picks: picks.length,
        players: session.espnPlayers.length,
        remainingSeconds: room.remainingSeconds ?? null,
        currentPick: room.currentPick ?? null,
        currentBid: room.currentBid ?? 0,
      },
    });
  }

  if (!body.leaguePayload) {
    return response(origin, { ok: false, code: "DRAFT_DAY_PAYLOAD_INCOMPLETE" }, 400);
  }

  const room = body.room || {};
  const context = {
    leagueId: room.leagueId,
    teamId: room.teamId,
    season: Number(body.leaguePayload.seasonId || new Date().getFullYear()),
  };
  const league = normalizeSettings(body.leaguePayload, context) as LeagueSettings;
  if (body.operation === "WARM") {
    const intelligence = await fetchIntelligenceSnapshot({
      scoring: league.scoringLabel,
      teams: league.size,
      season: league.season,
      qbs: intelligenceQuarterbackMode(league.lineupSlotCounts),
    });
    const ready = isCompleteFreshIntelligenceSnapshot(intelligence.sources, intelligence.generatedAt);
    return response(origin, {
      ok: ready,
      code: ready ? "FIVE_SOURCE_READY" : "FIVE_SOURCE_SNAPSHOT_NOT_READY",
      sourceCoverage: ready ? 5 : 1,
      sourceIds: ["espn", ...intelligence.sources.map((source) => source.id)],
      sourceGeneratedAt: intelligence.generatedAt,
      league: {
        id: league.id,
        name: league.name,
        season: league.season,
        teamId: league.teamId,
        draftType: league.draftType,
        size: league.size,
        rosterSize: league.rosterSize,
        auctionBudget: league.auctionBudget,
        scoringLabel: league.scoringLabel,
        scoringRules: league.scoringRules,
        keeperCount: league.keeperCount,
      },
      sources: intelligence.sources.map((source) => ({
        id: source.id,
        status: source.status,
        players: source.players.length,
        updatedAt: source.updatedAt || source.retrievedAt || null,
        error: source.error || null,
      })),
    }, ready ? 200 : 503);
  }
  if (!body.playerPayload || !body.room) {
    return response(origin, { ok: false, code: "DRAFT_DAY_PAYLOAD_INCOMPLETE" }, 400);
  }
  const espnPlayers = normalizePlayers(body.playerPayload) as DraftPlayer[];
  const apiPicks = body.leaguePayload.draftDetail
    ? normalizePicks(body.leaguePayload)
    : normalizeImportPicks(body.leaguePayload);
  const reconciled = reconcileEspnPicks(apiPicks, room, league.teamId, espnPlayers, league);
  const auctionSales = resolveAuctionSales(room, league, espnPlayers);
  const picks = mergePicks(reconciled, auctionSales);
  const strategy = ALLOWED_STRATEGIES.has(body.strategy || "BALANCED") ? body.strategy || "BALANCED" : "BALANCED";
  const intelligence = await fetchIntelligenceSnapshot({
    scoring: league.scoringLabel,
    teams: league.size,
    season: league.season,
    qbs: intelligenceQuarterbackMode(league.lineupSlotCounts),
  });
  const prepared = prepareDraftDayBridge(league, espnPlayers, intelligence.sources, intelligence.generatedAt);
  const result = buildDraftDayBridgeResult({
    league,
    espnPlayers,
    picks,
    room,
    sources: intelligence.sources,
    strategy,
    evaluatedAt: intelligence.generatedAt,
    prepared,
  });

  let sessionId: string | undefined;
  if (body.operation === "PREPARE") {
    pruneSessions();
    sessionId = crypto.randomUUID();
    draftDaySessions.set(sessionId, {
      createdAt: Date.now(),
      league,
      espnPlayers,
      sources: intelligence.sources,
      sourceGeneratedAt: intelligence.generatedAt,
      prepared,
      strategy,
    });
  }

  return response(origin, {
    ...result,
    ...(sessionId ? { sessionId } : {}),
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: intelligence.generatedAt,
    league: {
      id: league.id,
      name: league.name,
      season: league.season,
      teamId: league.teamId,
      draftType: league.draftType,
      size: league.size,
      rosterSize: league.rosterSize,
      auctionBudget: league.auctionBudget,
      scoringLabel: league.scoringLabel,
      scoringRules: league.scoringRules,
      keeperCount: league.keeperCount,
    },
    observed: {
      picks: picks.length,
      players: espnPlayers.length,
      remainingSeconds: room.remainingSeconds ?? null,
      currentPick: room.currentPick ?? null,
      currentBid: room.currentBid ?? 0,
    },
  });
}
