#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  sanitizeDraftLeagueBoardSnapshot,
  sanitizeDraftOperatorSnapshot,
} from "../app/lib/draft-audit.ts";
import {
  normalizeDraftDayLoopbackOrigin,
  parseStrictCliOptions,
} from "./draft-day-cli-lib.mjs";

export const DRAFT_DAY_STATUS_MAX_RESPONSE_BYTES = 64 * 1024;
export const DRAFT_DAY_STATUS_MAX_OUTPUT_BYTES = 64 * 1024;
export const DRAFT_DAY_STATUS_TIMEOUT_MS = 750;
export const DRAFT_DAY_STATUS_MAX_AGE_MS = 15_000;
export const DRAFT_DAY_STATUS_FUTURE_SKEW_MS = 2_000;

const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const STATUS_CONTROL_KEYS = [
  "decisionActive",
  "historicalAutopickDetected",
  "pendingActionCount",
  "schemaVersion",
  "sequence",
  "unattributedRosterCount",
  "uncontrolledRosterAdditionDetected",
];
const STATUS_HEALTH_KEYS = [
  "auditAgeMs",
  "autoDraft",
  "autopickActive",
  "availabilityRemainingMs",
  "blockers",
  "espnContextAgeMs",
  "extensionConnected",
  "inDraftRoom",
  "liveChecklistReady",
  "liveReady",
  "pickFeedLagging",
  "pickFeedObservedAgeMs",
  "sourceCoverage",
  "sourceSnapshotAgeMs",
];

function statusError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  if (!isRecord(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key))
    && keys.every((key) => Object.hasOwn(value, key));
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveSafeIntegerText(value, option) {
  const text = String(value || "");
  const parsed = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw statusError(`DRAFT_DAY_STATUS_${option}_INVALID`);
  }
  return { text, parsed };
}

export function parseDraftDayStatusArguments(argv) {
  const { values } = parseStrictCliOptions(argv, {
    valueOptions: ["--league", "--team", "--origin"],
  });
  const league = positiveSafeIntegerText(values.get("--league"), "LEAGUE");
  const team = positiveSafeIntegerText(values.get("--team"), "TEAM");
  return {
    origin: normalizeDraftDayLoopbackOrigin(values.get("--origin")),
    leagueId: league.text,
    teamId: team.parsed,
  };
}

async function readBoundedJson(response) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) throw statusError("DRAFT_DAY_STATUS_RESPONSE_MALFORMED");
    if (Number(declaredLength) > DRAFT_DAY_STATUS_MAX_RESPONSE_BYTES) {
      throw statusError("DRAFT_DAY_STATUS_RESPONSE_TOO_LARGE");
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw statusError("DRAFT_DAY_STATUS_RESPONSE_MALFORMED");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DRAFT_DAY_STATUS_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw statusError("DRAFT_DAY_STATUS_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw statusError("DRAFT_DAY_STATUS_RESPONSE_MALFORMED");
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    const value = JSON.parse(decoded);
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw statusError("DRAFT_DAY_STATUS_RESPONSE_MALFORMED");
  }
}

async function fetchStatusView(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(statusError("DRAFT_DAY_STATUS_TIMEOUT"));
    }, timeoutMs);
  });
  const request = (async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw statusError("DRAFT_DAY_STATUS_TIMEOUT");
      }
      throw statusError("DRAFT_DAY_STATUS_UNREACHABLE");
    }
    const body = await readBoundedJson(response);
    if (!response.ok) throw statusError("DRAFT_DAY_STATUS_NOT_READY");
    return body;
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function validateLeagueIdentity(response, leagueId, teamId) {
  if (!isRecord(response.league)
    || response.league.id !== leagueId
    || response.league.teamId !== teamId
    || !["SNAKE", "AUCTION"].includes(response.league.draftType)) {
    throw statusError("DRAFT_DAY_STATUS_IDENTITY_MISMATCH");
  }
  return response.league;
}

function validateStatusResponse(response, leagueId, teamId, now) {
  if (!hasOnlyKeys(response, ["ok", "code", "capturedAt", "league", "control", "health", "operator", "leagueBoard"])
    || response.ok !== true
    || response.code !== "DRAFT_DAY_STATUS_SNAPSHOT_READY"
    || !isTimestamp(response.capturedAt)) {
    throw statusError("DRAFT_DAY_STATUS_SNAPSHOT_MALFORMED");
  }
  const capturedAtMs = Date.parse(response.capturedAt);
  const auditAgeMs = now - capturedAtMs;
  if (!Number.isFinite(auditAgeMs) || auditAgeMs < -DRAFT_DAY_STATUS_FUTURE_SKEW_MS) {
    throw statusError("DRAFT_DAY_STATUS_CLOCK_SKEW");
  }
  if (auditAgeMs > DRAFT_DAY_STATUS_MAX_AGE_MS) throw statusError("DRAFT_DAY_STATUS_STALE");
  const league = validateLeagueIdentity(response, leagueId, teamId);
  const control = response.control;
  if (!hasOnlyKeys(control, STATUS_CONTROL_KEYS)
    || control.schemaVersion !== 1
    || !isNonNegativeSafeInteger(control.sequence)
    || !isNonNegativeSafeInteger(control.pendingActionCount)
    || typeof control.decisionActive !== "boolean"
    || typeof control.historicalAutopickDetected !== "boolean"
    || typeof control.uncontrolledRosterAdditionDetected !== "boolean"
    || !isNonNegativeSafeInteger(control.unattributedRosterCount)
    || control.pendingActionCount > 64
    || control.unattributedRosterCount > 64) {
    throw statusError("DRAFT_DAY_STATUS_SNAPSHOT_MALFORMED");
  }
  const health = response.health;
  if (!hasOnlyKeys(health, STATUS_HEALTH_KEYS)
    || typeof health.liveReady !== "boolean"
    || !Array.isArray(health.blockers)
    || health.blockers.length > 24
    || !health.blockers.every((code) => typeof code === "string" && SAFE_CODE.test(code))
    || new Set(health.blockers).size !== health.blockers.length
    || health.liveReady !== (health.blockers.length === 0)
    || !["auditAgeMs", "espnContextAgeMs", "pickFeedObservedAgeMs", "sourceSnapshotAgeMs", "availabilityRemainingMs"].every((key) => (
      health[key] === null || (Number.isSafeInteger(health[key]) && Math.abs(health[key]) <= 86_400_000)
    ))
    || health.auditAgeMs === null
    || Math.abs(health.auditAgeMs - auditAgeMs) > DRAFT_DAY_STATUS_TIMEOUT_MS + 250
    || !["extensionConnected", "inDraftRoom", "autopickActive", "autoDraft", "liveChecklistReady", "pickFeedLagging"].every((key) => typeof health[key] === "boolean")
    || !Number.isSafeInteger(health.sourceCoverage)
    || health.sourceCoverage < 0
    || health.sourceCoverage > 5) {
    throw statusError("DRAFT_DAY_STATUS_HEALTH_MALFORMED");
  }
  const operator = sanitizeDraftOperatorSnapshot(response.operator);
  const leagueBoard = sanitizeDraftLeagueBoardSnapshot(response.leagueBoard);
  if (!operator || !leagueBoard || leagueBoard.draftType !== league.draftType) {
    throw statusError("DRAFT_DAY_STATUS_SNAPSHOT_MALFORMED");
  }
  return { league, control, health, operator, leagueBoard, capturedAt: response.capturedAt };
}

function publicPlayer(player) {
  if (!player) return null;
  return {
    playerId: player.playerId,
    playerName: player.playerName,
    ...(player.position ? { position: player.position } : {}),
    ...(player.team ? { team: player.team } : {}),
  };
}

function publicPick(pick) {
  return {
    overall: pick.overall,
    round: pick.round,
    teamSlot: pick.teamSlot,
    ours: pick.ours,
    player: publicPlayer(pick.player),
    amount: pick.amount,
  };
}

function buildStatusSummary(statusView, leagueId, teamId) {
  const { control, health, operator, leagueBoard } = statusView;
  const recommendation = health.liveReady ? {
    action: operator.recommendation ? {
      state: operator.recommendation.state,
      action: operator.recommendation.action,
      player: publicPlayer(operator.recommendation.player),
      offer: operator.recommendation.offer,
      maxLegalBid: operator.recommendation.maxLegalBid,
    } : null,
    analysis: leagueBoard.recommendation ? {
      player: publicPlayer(leagueBoard.recommendation.player),
      confidence: leagueBoard.recommendation.confidence,
      reasons: [...leagueBoard.recommendation.reasons],
      sourceCount: leagueBoard.recommendation.sourceCount,
    } : null,
  } : { action: null, analysis: null };
  const summary = {
    ok: true,
    code: health.liveReady ? "DRAFT_DAY_STATUS_READY" : "DRAFT_DAY_STATUS_BLOCKED",
    liveReady: health.liveReady,
    blockers: [...health.blockers],
    health: { ...health },
    capturedAt: {
      control: statusView.capturedAt,
      board: statusView.capturedAt,
    },
    league: {
      id: leagueId,
      teamId,
      draftType: statusView.league.draftType,
    },
    room: {
      round: operator.room.round,
      pick: operator.room.pick,
      onClock: operator.room.onClock,
      secondsRemaining: operator.room.secondsRemaining,
      nominee: publicPlayer(operator.room.nominee),
      currentBid: operator.room.currentBid,
      leader: operator.room.leader,
      maxLegalBid: operator.room.maxLegalBid,
    },
    ourRoster: leagueBoard.ourRoster.map(publicPick),
    recentPicks: leagueBoard.recentPicks.map(publicPick),
    teamRanks: leagueBoard.teams.map((team) => ({
      teamSlot: team.teamSlot,
      ours: team.ours,
      rank: team.rank,
      playerCount: team.playerCount,
      projectedPoints: team.projectedPoints,
      averageProjectedPoints: team.averageProjectedPoints,
      spent: team.spent,
      remainingBudget: team.remainingBudget,
      positionCounts: { ...team.positionCounts },
    })),
    ourTeam: {
      remainingBudget: operator.team.remainingBudget,
      openRosterSlots: operator.team.openRosterSlots,
      primaryNeeds: operator.team.primaryNeeds.map((need) => ({ ...need })),
    },
    recommendation,
    controlActionState: {
      sequence: control.sequence,
      pendingActionCount: control.pendingActionCount,
      decisionActive: control.decisionActive,
      historicalAutopickDetected: control.historicalAutopickDetected,
      uncontrolledRosterAdditionDetected: control.uncontrolledRosterAdditionDetected,
      unattributedRosterCount: control.unattributedRosterCount,
      lastDecision: operator.lastDecision ? {
        operation: operator.lastDecision.operation,
        phase: operator.lastDecision.phase,
        player: publicPlayer(operator.lastDecision.player),
        offer: operator.lastDecision.offer,
        occurredAt: operator.lastDecision.occurredAt,
        ...(operator.lastDecision.code && SAFE_CODE.test(operator.lastDecision.code)
          ? { code: operator.lastDecision.code }
          : {}),
      } : null,
    },
  };
  if (new TextEncoder().encode(JSON.stringify(summary)).byteLength > DRAFT_DAY_STATUS_MAX_OUTPUT_BYTES) {
    throw statusError("DRAFT_DAY_STATUS_OUTPUT_TOO_LARGE");
  }
  return summary;
}

export async function fetchDraftDayStatus(options, dependencies = {}) {
  const league = positiveSafeIntegerText(options?.leagueId, "LEAGUE");
  const team = positiveSafeIntegerText(options?.teamId, "TEAM");
  const origin = normalizeDraftDayLoopbackOrigin(options?.origin);
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? DRAFT_DAY_STATUS_TIMEOUT_MS;
  const now = typeof dependencies.now === "function" ? dependencies.now() : Date.now();
  if (typeof fetchImpl !== "function") throw statusError("DRAFT_DAY_STATUS_FETCH_UNAVAILABLE");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DRAFT_DAY_STATUS_TIMEOUT_MS) {
    throw statusError("DRAFT_DAY_STATUS_TIMEOUT_INVALID");
  }
  const identity = `leagueId=${encodeURIComponent(league.text)}&teamId=${team.parsed}`;
  const statusUrl = `${origin}/api/draft-day?${identity}&view=status`;
  const rawStatus = await fetchStatusView(statusUrl, { fetchImpl, timeoutMs });
  const statusView = validateStatusResponse(rawStatus, league.text, team.parsed, now);
  return buildStatusSummary(statusView, league.text, team.parsed);
}

function publicFailureCode(error) {
  return SAFE_CODE.test(String(error?.code || ""))
    ? error.code
    : "DRAFT_DAY_STATUS_FAILED";
}

async function main() {
  try {
    const options = parseDraftDayStatusArguments(process.argv.slice(2));
    const summary = await fetchDraftDayStatus(options);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: publicFailureCode(error) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
