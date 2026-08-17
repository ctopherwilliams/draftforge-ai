import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const espnContentPath = path.join(projectRoot, "extension", "espn-content.js");

/**
 * Build the temporary, page-scoped runtime installed by Codex in the
 * authenticated in-app browser. The same selector, clock, bid, reserve, and
 * verification code used by the Chrome companion is reused verbatim.
 */
export async function buildDraftDayRuntimeExpression() {
  const contentScript = await readFile(espnContentPath, "utf8");
  return `(() => {
    try { globalThis.__DRAFTFORGE_CHAT_RUNTIME__?.stop?.(); } catch {}
    const chrome = {
      runtime: {
        id: null,
        onMessage: { addListener() {} },
        sendMessage() { return Promise.resolve({ ok: true }); },
      },
    };
    ${contentScript}
    globalThis.__DRAFTFORGE_CHAT_RUNTIME__ = Object.freeze({
      getContext: getTrackedContext,
      executeAction,
      disableAutopick: disableEspnAutopick,
      stop() {
        contextObserver.disconnect();
        clearInterval(contextWatchdog);
        if (scheduledContextRefresh) clearTimeout(scheduledContextRefresh);
      },
    });
    return { installed: true, context: getTrackedContext() };
  })()`;
}

export function buildSourceWarmupExpression({ leagueId, teamId, season = 2026 }) {
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

export function buildLeagueSpecificMockLaunchExpression({ leagueId, draftPosition = null }) {
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

export function buildDraftDayDecisionExpression({ strategy = "BALANCED" } = {}) {
  const strategyLiteral = JSON.stringify(String(strategy));
  return `(async () => {
    const runtime = globalThis.__DRAFTFORGE_CHAT_RUNTIME__;
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

export function buildExecuteDraftDayActionExpression(action) {
  return `globalThis.__DRAFTFORGE_CHAT_RUNTIME__.executeAction(${JSON.stringify(action)})`;
}

export function buildGuardedDraftLoopExpression({ strategy = "BALANCED", pollMs = 100 } = {}) {
  const decisionExpression = buildDraftDayDecisionExpression({ strategy });
  return `(() => {
    try { globalThis.__DRAFTFORGE_AUTOPILOT__?.stop?.(); } catch {}
    const runtime = globalThis.__DRAFTFORGE_CHAT_RUNTIME__;
    if (!runtime) throw new Error("DRAFTFORGE_RUNTIME_NOT_INSTALLED");
    const state = {
      running: true,
      busy: false,
      errors: 0,
      autopickInterventions: 0,
      failedActions: 0,
      retriableActions: 0,
      successfulActions: { SELECT: 0, BID: 0, NOMINATE: 0 },
      events: [],
      handledSignature: null,
      walkedNomineeKey: null,
      lastDecision: null,
      lastAction: null,
    };
    const record = (event) => {
      state.events.push({ ...event, at: new Date().toISOString() });
      if (state.events.length > 100) state.events.shift();
    };
    const stop = (reason = "STOPPED") => {
      state.running = false;
      clearInterval(state.timer);
      record({ type: "STOPPED", reason });
    };
    const retriableActionCodes = new Set([
      "ACTION_NOT_FOUND",
      "ACTION_TIMEOUT",
      "BID_CHANGED",
      "BID_OUT_OF_SEQUENCE",
      "CLOCK_TOO_SHORT",
      "NOMINATION_ACTIVE",
      "NOMINEE_MISMATCH",
      "NOMINEE_UNKNOWN",
      "NOT_ON_CLOCK",
      "PICK_CHANGED",
      "PLAYER_POOL_STALE",
    ]);
    const tick = async () => {
      if (!state.running || state.busy) return;
      let context = runtime.getContext();
      if (context.autopickActive) {
        state.busy = true;
        try {
          const result = await runtime.disableAutopick({ expectedLeagueId: context.leagueId });
          state.autopickInterventions += 1;
          record({ type: "AUTOPICK", code: result.code });
          if (!result.ok) throw new Error(result.code || "AUTOPICK_DISABLE_FAILED");
          state.errors = 0;
        } catch (error) {
          state.errors += 1;
          record({ type: "ERROR", message: String(error) });
          if (state.errors >= 3) stop("AUTOPICK_DISABLE_FAILED");
        } finally {
          state.busy = false;
        }
        return;
      }
      const activeAuctionOffer = Boolean(context.auctionActive && context.nominatedPlayer && Number(context.currentBid) > 0);
      const nomineeKey = activeAuctionOffer
        ? String(context.nominatedPlayerId || context.nominatedPlayer || "")
        : null;
      if (!activeAuctionOffer) state.walkedNomineeKey = null;
      if (activeAuctionOffer && state.walkedNomineeKey === nomineeKey) return;
      if (activeAuctionOffer && state.walkedNomineeKey !== nomineeKey) state.walkedNomineeKey = null;
      const needsPrepare = !globalThis.__DRAFTFORGE_CHAT_SESSION__;
      if (!needsPrepare && !context.onClock && !activeAuctionOffer) return;
      const signature = [context.leagueId, context.currentPick, context.onClock, context.nominatedPlayerId || context.nominatedPlayer || "", context.currentBid || 0, context.leadingBid || false].join(":");
      if (state.handledSignature === signature) return;
      state.busy = true;
      try {
        const decision = await ${decisionExpression};
        state.lastDecision = { code: decision.code, observed: decision.observed, sourceCoverage: decision.sourceCoverage };
        if (decision.action) {
          const result = await runtime.executeAction(decision.action);
          state.lastAction = {
            code: result.code,
            ok: result.ok,
            operation: decision.action.operation,
            playerName: result.action?.playerName || decision.action.playerName,
          };
          record({ type: "ACTION", ...state.lastAction });
          if (!result.ok && retriableActionCodes.has(result.code)) {
            state.retriableActions += 1;
            if (result.code === "CLOCK_TOO_SHORT") state.handledSignature = signature;
            record({ type: "WAIT", code: result.code });
          } else if (!result.ok) {
            state.failedActions += 1;
            record({ type: "BLOCKED", code: result.code || "ACTION_FAILED" });
            stop(result.code || "ACTION_FAILED");
            return;
          } else {
            if (Object.hasOwn(state.successfulActions, decision.action.operation)) {
              state.successfulActions[decision.action.operation] += 1;
            }
            state.handledSignature = signature;
          }
        } else if (decision.ok) {
          if (decision.code === "WALK_AWAY") state.walkedNomineeKey = nomineeKey;
          state.handledSignature = signature;
          if (decision.code !== "MONITORING") record({ type: "DECISION", code: decision.code });
        } else if (["PLAYER_POOL_STALE", "CLOCK_TOO_SHORT"].includes(decision.code)) {
          record({ type: "WAIT", code: decision.code });
        } else {
          record({ type: "BLOCKED", code: decision.code });
          stop(decision.code);
        }
        state.errors = 0;
        const latest = runtime.getContext();
        if (decision.league && latest.ownRoster?.length >= decision.league.rosterSize) stop("DRAFT_COMPLETE");
      } catch (error) {
        state.errors += 1;
        record({ type: "ERROR", message: String(error) });
        if (state.errors >= 3) stop("THREE_CONSECUTIVE_ERRORS");
      } finally {
        state.busy = false;
      }
    };
    state.timer = setInterval(tick, ${Math.max(75, Number(pollMs) || 100)});
    state.stop = stop;
    state.status = () => ({
      running: state.running,
      busy: state.busy,
      errors: state.errors,
      autopickInterventions: state.autopickInterventions,
      failedActions: state.failedActions,
      retriableActions: state.retriableActions,
      successfulActions: { ...state.successfulActions },
      events: [...state.events],
      lastDecision: state.lastDecision,
      lastAction: state.lastAction,
      context: runtime.getContext(),
    });
    globalThis.__DRAFTFORGE_AUTOPILOT__ = state;
    tick();
    return { started: true };
  })()`;
}
