import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const espnContentPath = path.join(projectRoot, "extension", "espn-content.js");

export const LAB_BROWSER_RUNTIME_MODE = "LAB_ONLY_COMPANION_DISABLED";

function requireLabOnly(options) {
  if (options?.mode !== LAB_BROWSER_RUNTIME_MODE || options?.companionDisabled !== true) {
    throw new Error("DRAFTFORGE_LAB_RUNTIME_REQUIRES_DISABLED_COMPANION");
  }
}

/**
 * Build a temporary, page-scoped, read-only observer for isolated lab work.
 *
 * This is deliberately not a production recovery path. It exposes context
 * reads only and requires an explicit assertion that the Chrome companion is
 * disabled. Browser actions have one production writer: the installed Chrome
 * companion. Keeping the observer read-only prevents a second MutationObserver
 * runtime from ever competing to submit a pick, bid, or nomination.
 */
export async function buildDraftDayRuntimeExpression(options = {}) {
  requireLabOnly(options);
  const contentScript = await readFile(espnContentPath, "utf8");
  const readOnlyContentScript = contentScript.replace(
    "  enforceMutedDraftSound(context);",
    "  // LAB OBSERVER: never mutate ESPN sound or any other action control.",
  );
  if (readOnlyContentScript === contentScript) throw new Error("DRAFTFORGE_LAB_RUNTIME_READ_ONLY_PATCH_MISSING");
  return `(() => {
    try { globalThis.__DRAFTFORGE_CHAT_RUNTIME__?.stop?.(); } catch {}
    try { globalThis.__DRAFTFORGE_AUTOPILOT__?.stop?.("LAB_RUNTIME_REPLACED"); } catch {}
    try { globalThis.__DRAFTFORGE_LAB_RUNTIME__?.stop?.(); } catch {}
    delete globalThis.__DRAFTFORGE_CHAT_RUNTIME__;
    delete globalThis.__DRAFTFORGE_AUTOPILOT__;
    const chrome = {
      runtime: {
        id: null,
        onMessage: { addListener() {} },
        sendMessage() { return Promise.resolve({ ok: true }); },
      },
    };
    ${readOnlyContentScript}
    globalThis.__DRAFTFORGE_LAB_RUNTIME__ = Object.freeze({
      mode: "READ_ONLY_LAB",
      getContext: getTrackedContext,
      stop() {
        contextObserver.disconnect();
        clearInterval(contextWatchdog);
        if (scheduledContextRefresh) clearTimeout(scheduledContextRefresh);
      },
    });
    return { installed: true, mode: "READ_ONLY_LAB", context: getTrackedContext() };
  })()`;
}

export function buildSourceWarmupExpression({ leagueId, teamId, season = 2026, ...options }) {
  requireLabOnly(options);
  const leagueIdLiteral = JSON.stringify(String(leagueId));
  return `(async () => {
    const leagueId = ${leagueIdLiteral};
    const base = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${Number(season)}/segments/0/leagues/" + leagueId;
    const leaguePayload = await fetch(base + "?view=mSettings&view=mTeam&view=mRoster&view=mDraftDetail", { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error("ESPN_LEAGUE_" + response.status);
        return response.json();
      });
    const response = await fetch("http://127.0.0.1:3000/api/draft-day", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "WARM",
        leaguePayload,
        room: { leagueId, teamId: ${Number(teamId)}, inDraftRoom: false },
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok || result.sourceCoverage !== 5) {
      throw new Error(result.code || "FIVE_SOURCE_WARMUP_FAILED");
    }
    return result;
  })()`;
}

export function buildLeagueSpecificMockLaunchExpression({ leagueId, draftPosition = null, ...options }) {
  requireLabOnly(options);
  const position = draftPosition === null ? "null" : String(Math.max(1, Number(draftPosition)));
  const leagueIdLiteral = JSON.stringify(String(leagueId));
  return `(async () => {
    const targetLeagueId = ${leagueIdLiteral};
    const buttons = [...document.querySelectorAll("button")].filter((node) => node.textContent.trim() === "Practice Draft");
    let props = null;
    for (const button of buttons) {
      const key = Object.keys(button).find((name) => name.startsWith("__reactInternalInstance"));
      let fiber = key ? button[key] : null;
      for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
        const candidate = fiber.memoizedProps || {};
        if (String(candidate.league?.id || "") === targetLeagueId && candidate.team?.id) {
          props = candidate;
          break;
        }
      }
      if (props) break;
    }
    if (!props) throw new Error("LEAGUE_PRACTICE_CONTROL_NOT_FOUND");
    const { config, guest, league: leagueRef, team } = props;
    const api = window.webpackJsonp([], {}, [14]);
    const urlBuilder = window.webpackJsonp([], {}, [379]);
    const league = await api.z({ config, guest, leagueId: leagueRef.id, seasonId: config.currentSeason, view: ["mSettings"] });
    let pickOrder = Array.isArray(league.pickOrder) ? league.pickOrder.slice() : undefined;
    const requestedPosition = ${position};
    if (pickOrder && requestedPosition !== null) {
      pickOrder = pickOrder.filter((id) => Number(id) !== Number(team.id));
      pickOrder.splice(Math.min(pickOrder.length, requestedPosition - 1), 0, team.id);
    }
    const mockLeagueId = await api.V({ config, leagueId: leagueRef.id, pickOrder, teamId: team.id });
    const url = urlBuilder.a({ config, guest, leagueId: mockLeagueId, seasonId: config.currentSeason, teamId: team.id });
    if (!url) throw new Error("NO_AUTHENTICATED_DRAFT_URL");
    location.assign(url);
    return { mockLeagueId, sourceLeagueId: leagueRef.id, teamId: team.id };
  })()`;
}

export function buildDraftDayDecisionExpression({ strategy = "BALANCED", ...options } = {}) {
  requireLabOnly(options);
  const strategyLiteral = JSON.stringify(String(strategy));
  return `(async () => {
    const runtime = globalThis.__DRAFTFORGE_LAB_RUNTIME__;
    if (!runtime) throw new Error("DRAFTFORGE_RUNTIME_NOT_INSTALLED");
    const room = runtime.getContext();
    const season = Number(new URL(location.href).searchParams.get("seasonId") || 2026);
    const base = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" + season + "/segments/0/leagues/" + room.leagueId;
    const leaguePayload = await fetch(base + "?view=mSettings&view=mTeam&view=mRoster&view=mDraftDetail", { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error("ESPN_LEAGUE_" + response.status);
        return response.json();
      });
    let cache = globalThis.__DRAFTFORGE_CHAT_DATA__;
    let sessionId = globalThis.__DRAFTFORGE_CHAT_SESSION__;
    if (!sessionId && (!cache || String(cache.leagueId) !== String(room.leagueId))) {
      const scoringItems = leaguePayload.settings?.scoringSettings?.scoringItems || [];
      const reception = Number(scoringItems.find((item) => Number(item.statId) === 53)?.points || 0);
      const scoring = reception === 1 ? "PPR" : "STANDARD";
      const filter = { players: {
        limit: 500,
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: scoring },
        filterRanksForRankTypes: { value: [scoring] },
        filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 20, 21, 23] },
      } };
      const playerPayload = await fetch(base + "?view=kona_player_info", {
        credentials: "include",
        headers: { "X-Fantasy-Filter": JSON.stringify(filter) },
      }).then((response) => {
        if (!response.ok) throw new Error("ESPN_PLAYERS_" + response.status);
        return response.json();
      });
      cache = globalThis.__DRAFTFORGE_CHAT_DATA__ = { leagueId: room.leagueId, playerPayload };
    }
    const response = await fetch("http://127.0.0.1:3000/api/draft-day", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionId
        ? { operation: "DECIDE", sessionId, leaguePayload, room }
        : { operation: "PREPARE", leaguePayload, playerPayload: cache.playerPayload, room, strategy: ${strategyLiteral} }),
    });
    const result = await response.json();
    if (response.status === 409 && result.code === "DRAFT_DAY_SESSION_EXPIRED") {
      delete globalThis.__DRAFTFORGE_CHAT_SESSION__;
      throw new Error(result.code);
    }
    if (!response.ok) throw new Error(result.code || "DRAFT_DAY_DECISION_FAILED");
    if (result.sessionId) globalThis.__DRAFTFORGE_CHAT_SESSION__ = result.sessionId;
    return result;
  })()`;
}

export function buildExecuteDraftDayActionExpression() {
  throw new Error("DRAFTFORGE_LAB_RUNTIME_ACTIONS_DISABLED_USE_COMPANION");
}

export function buildGuardedDraftLoopExpression() {
  throw new Error("DRAFTFORGE_LAB_AUTOPILOT_DISABLED_USE_COMPANION");
}
