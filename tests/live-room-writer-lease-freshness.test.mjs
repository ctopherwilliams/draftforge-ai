import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createAuthenticatedEspnPlayerPoolEnvelope,
  createLiveRoomWatch,
  sanitizeLiveRoomWatchForStorage,
} from "../extension/live-room-watch.js";

const backgroundUrl = new URL("../extension/background.js", import.meta.url);
const APP_TAB_ID = 10;
const SOURCE_TAB_ID = 11;
const ROOM_TAB_ID = 20;
const SOURCE_LEAGUE_ID = "701";
const ROOM_LEAGUE_ID = "702";
const TEAM_ID = 5;
const SEASON = 2026;
const COMMAND_CENTER_SESSION_ID = "cold-live-room-session";
const COMMAND_CENTER_DOCUMENT_ID = "cold-live-room-document";
const WRITER_LEASE_TTL_MS = 1_500;
const DEFERRED_PRESENTATION_MS = WRITER_LEASE_TTL_MS + 101;

const lineupSlotCounts = Object.freeze({
  0: 1,
  2: 2,
  4: 2,
  6: 1,
  7: 1,
  16: 1,
  17: 1,
  20: 6,
  23: 1,
});
const positionLimits = Object.freeze({ 0: 4, 2: 8, 4: 8, 6: 3, 16: 3, 17: 3 });

function leagueRaw(leagueId, name) {
  return {
    id: leagueId,
    seasonId: SEASON,
    settings: {
      name,
      size: 10,
      draftSettings: {
        type: "SNAKE",
        timePerSelection: 30,
        auctionBudget: 200,
        keeperCount: 0,
      },
      rosterSettings: { lineupSlotCounts, positionLimits },
      scoringSettings: { scoringItems: [{ statId: 53, points: 1 }] },
    },
    draftDetail: { inProgress: true, drafted: false, picks: [] },
    teams: [],
  };
}

const sourceLeague = Object.freeze({
  id: SOURCE_LEAGUE_ID,
  name: "Writer Lease Test League",
  season: SEASON,
  size: 10,
  teamId: TEAM_ID,
  draftType: "SNAKE",
  secondsPerPick: 30,
  rosterSize: 16,
  auctionBudget: 200,
  lineupSlotCounts,
  positionLimits,
  scoringLabel: "PPR",
  scoringRules: 1,
  keeperCount: 0,
});

const authenticatedPlayers = Array.from({ length: 500 }, (_, index) => ({
  id: index + 1,
  name: `Player ${index + 1}`,
  team: "ATL",
  pos: ["QB", "RB", "WR", "TE"][index % 4],
  rank: index + 1,
  adp: index + 1,
  auction: Math.max(1, 50 - Math.floor(index / 10)),
  projected: Math.max(1, 300 - index / 2),
  availabilityStatus: "ACTIVE",
  injured: false,
  unavailable: false,
}));
const authenticatedPlayersFetchedAt = "2026-08-29T12:00:00.000Z";
const authenticatedPlayerPoolEnvelope = createAuthenticatedEspnPlayerPoolEnvelope({
  players: authenticatedPlayers,
  fetchedAt: authenticatedPlayersFetchedAt,
  leagueId: SOURCE_LEAGUE_ID,
  teamId: TEAM_ID,
  season: SEASON,
});

function playerPoolRaw() {
  return {
    players: authenticatedPlayers.map((player, index) => ({
      player: {
        id: player.id,
        fullName: player.name,
        proTeamId: 1,
        defaultPositionId: [1, 2, 3, 4][index % 4],
        injuryStatus: "ACTIVE",
        ownership: {
          averageDraftPosition: player.adp,
          auctionValueAverage: player.auction,
        },
        stats: [{ statSourceId: 1, scoringPeriodId: 0, appliedTotal: player.projected }],
      },
    })),
  };
}

function dispatch(listener, message, sender) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${message.type} timed out`)), 2_000);
    listener(message, sender, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

function exactAppSender() {
  return {
    url: "http://127.0.0.1:3000/",
    tab: {
      id: APP_TAB_ID,
      url: "http://127.0.0.1:3000/",
      windowId: 1,
    },
  };
}

function exactRoomContext(producerSessionId = "cold-room-producer") {
  return {
    leagueId: ROOM_LEAGUE_ID,
    teamId: TEAM_ID,
    season: SEASON,
    tabId: ROOM_TAB_ID,
    inDraftRoom: true,
    producerSessionId,
  };
}

function exactSourceContext() {
  return {
    leagueId: SOURCE_LEAGUE_ID,
    teamId: TEAM_ID,
    season: SEASON,
    tabId: SOURCE_TAB_ID,
    inDraftRoom: false,
    producerSessionId: "cold-source-producer",
  };
}

function writerHeartbeatPayload(
  transitionRequestId,
  {
    commandCenterDocumentId = COMMAND_CENTER_DOCUMENT_ID,
    producerSessionId = "cold-room-producer",
  } = {},
) {
  return {
    commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
    commandCenterDocumentId,
    expectedLeagueId: ROOM_LEAGUE_ID,
    expectedTeamId: TEAM_ID,
    expectedSeason: SEASON,
    expectedTabId: ROOM_TAB_ID,
    expectedProducerSessionId: producerSessionId,
    transitionRequestId,
  };
}

async function loadFixture({ path, initialNow, deferWatchDiagnostics = false }) {
  let now = initialNow;
  let presentationAdvanced = false;
  let heartbeatAtImport = null;
  let roomProducerSessionId = "cold-room-producer";
  let commandCenterDocumentId = COMMAND_CENTER_DOCUMENT_ID;
  let watchDiagnosticsDeferred = false;
  let markWatchDiagnosticsStarted;
  let releaseWatchDiagnostics;
  const watchDiagnosticsStarted = new Promise((resolve) => { markWatchDiagnosticsStarted = resolve; });
  const watchDiagnosticsGate = new Promise((resolve) => { releaseWatchDiagnostics = resolve; });
  let listener;
  const broadcasts = [];
  const cancellations = [];
  const executedActions = [];
  const removed = [];
  const session = new Map([["draftForgeWorkspaceWriterV1", APP_TAB_ID]]);
  const local = new Map();
  const tabs = new Map([
    [APP_TAB_ID, { id: APP_TAB_ID, url: "http://127.0.0.1:3000/", lastAccessed: 300, windowId: 1 }],
    [SOURCE_TAB_ID, {
      id: SOURCE_TAB_ID,
      url: `https://fantasy.espn.com/football/team?leagueId=${SOURCE_LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON}`,
      lastAccessed: 100,
      windowId: 1,
    }],
    [ROOM_TAB_ID, {
      id: ROOM_TAB_ID,
      url: `https://fantasy.espn.com/football/draft?leagueId=${ROOM_LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON}`,
      lastAccessed: 200,
      windowId: 1,
    }],
  ]);

  if (path === "watch") {
    const watch = createLiveRoomWatch({
      appTabId: APP_TAB_ID,
      sourceContext: {
        leagueId: SOURCE_LEAGUE_ID,
        teamId: TEAM_ID,
        season: SEASON,
        tabId: SOURCE_TAB_ID,
        inDraftRoom: false,
      },
      sourceLeague,
      sourcePlayers: authenticatedPlayers,
      sourcePlayersFetchedAt: authenticatedPlayersFetchedAt,
      sourcePlayerEnvelope: authenticatedPlayerPoolEnvelope,
      now,
      windowMs: 60_000,
    });
    watch.commandCenterSessionId = COMMAND_CENTER_SESSION_ID;
    watch.commandCenterDocumentId = COMMAND_CENTER_DOCUMENT_ID;
    session.set("draftForgeLiveRoomWatchV1", sanitizeLiveRoomWatchForStorage(watch));
  }

  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  Date.now = () => now;

  function advanceDeferredPresentation(kind) {
    if (presentationAdvanced) return;
    if ((path === "watch" && kind !== "diagnostics")
      || (path === "recovery" && kind !== "visibility")) return;
    now += DEFERRED_PRESENTATION_MS;
    presentationAdvanced = true;
  }

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("chrome-extension://")) {
      throw new Error("integrity fixture intentionally offline");
    }
    const views = new URL(href).searchParams.getAll("view");
    const requestedLeagueId = href.match(/\/leagues\/([^/?]+)/)?.[1] || ROOM_LEAGUE_ID;
    const body = views.includes("kona_player_info") || options.headers?.["X-Fantasy-Filter"]
      ? playerPoolRaw()
      : requestedLeagueId === SOURCE_LEAGUE_ID
        ? leagueRaw(SOURCE_LEAGUE_ID, sourceLeague.name)
        : leagueRaw(ROOM_LEAGUE_ID, `Practice Draft for ${sourceLeague.name}`);
    return { ok: true, status: 200, async json() { return body; } };
  };

  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (relativePath) => `chrome-extension://test/${relativePath}`,
      onMessage: { addListener: (nextListener) => { listener = nextListener; } },
      reload: () => {},
    },
    storage: {
      local: {
        async get(key) { return { [key]: local.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) local.set(key, structuredClone(value)); },
        async remove(key) { local.delete(key); },
        setAccessLevel: async () => {},
      },
      session: {
        async get(key) { return { [key]: session.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) session.set(key, structuredClone(value)); },
        async remove(key) { session.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error("tab not found");
        return { ...tab };
      },
      async query(query = {}) {
        if (Object.keys(query).length === 0) {
          advanceDeferredPresentation("diagnostics");
          if (path === "watch" && deferWatchDiagnostics && !watchDiagnosticsDeferred) {
            watchDiagnosticsDeferred = true;
            markWatchDiagnosticsStarted();
            await watchDiagnosticsGate;
          }
        }
        const all = [...tabs.values()].map((tab) => ({ ...tab }));
        return query.url ? all.filter((tab) => tab.url.startsWith("https://fantasy.espn.com/")) : all;
      },
      async sendMessage(tabId, message) {
        if (Number(tabId) === ROOM_TAB_ID && message.type === "DF_GET_CONTEXT") {
          return exactRoomContext(roomProducerSessionId);
        }
        if (Number(tabId) === SOURCE_TAB_ID && message.type === "DF_GET_CONTEXT") return exactSourceContext();
        if (Number(tabId) === ROOM_TAB_ID && message.type === "DF_CANCEL_PENDING_ACTIONS") {
          cancellations.push(structuredClone(message));
          return { ok: true };
        }
        if (Number(tabId) === ROOM_TAB_ID && message.type === "DF_EXECUTE_ACTION") {
          executedActions.push(structuredClone(message));
          return { ok: true, code: "SYNTHETIC_ACTION_ACCEPTED" };
        }
        if (Number(tabId) === APP_TAB_ID) {
          broadcasts.push(message.type);
          if (message.type === "DF_IMPORT_SUCCESS") {
            heartbeatAtImport = await dispatch(listener, {
              type: "WRITER_HEARTBEAT",
              payload: writerHeartbeatPayload(`${path}-first-heartbeat`, {
                commandCenterDocumentId,
                producerSessionId: roomProducerSessionId,
              }),
            }, exactAppSender());
          }
        }
        return { ok: true };
      },
      async reload() {},
      async remove(tabIds) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          if (tabs.delete(Number(tabId))) removed.push(Number(tabId));
        }
      },
      async update() {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    windows: {
      async create() {
        advanceDeferredPresentation("visibility");
        return { id: 2 };
      },
      async update() {},
    },
  };

  await import(`${backgroundUrl.href}?writer-lease-freshness=${path}-${process.hrtime.bigint()}`);
  await new Promise((resolve) => setImmediate(resolve));

  return {
    listener,
    broadcasts,
    cancellations,
    executedActions,
    removed,
    session,
    get now() { return now; },
    get presentationAdvanced() { return presentationAdvanced; },
    get heartbeatAtImport() { return heartbeatAtImport; },
    watchDiagnosticsStarted,
    releaseWatchDiagnostics,
    setRoomAuthority({ producerSessionId, documentId }) {
      roomProducerSessionId = producerSessionId;
      commandCenterDocumentId = documentId;
    },
    restore() {
      Date.now = previousNow;
      globalThis.chrome = previousChrome;
      globalThis.fetch = previousFetch;
    },
  };
}

test("a stale watched-room handoff cannot roll back a newer verified action binding", async () => {
  const replacementProducerSessionId = "replacement-room-producer";
  const replacementDocumentId = "replacement-command-document";
  const fixture = await loadFixture({
    path: "watch",
    initialNow: Date.parse("2026-08-29T12:30:00.000Z"),
    deferWatchDiagnostics: true,
  });
  try {
    const staleHandoff = dispatch(fixture.listener, {
      type: "ESPN_CONTEXT",
      payload: {
        ...exactRoomContext(),
        producerRevision: 1,
        contextCapturedAt: "2026-08-29T12:30:00.000Z",
      },
    }, {
      url: `https://fantasy.espn.com/football/draft?leagueId=${ROOM_LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON}`,
      tab: { id: ROOM_TAB_ID, windowId: 1 },
    });
    await fixture.watchDiagnosticsStarted;

    fixture.setRoomAuthority({
      producerSessionId: replacementProducerSessionId,
      documentId: replacementDocumentId,
    });
    const replacementHello = await dispatch(fixture.listener, {
      type: "APP_HELLO",
      payload: {
        commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
        commandCenterDocumentId: replacementDocumentId,
      },
    }, exactAppSender());
    assert.equal(replacementHello.ready, true);

    const replacementConnect = await dispatch(fixture.listener, {
      type: "CONNECT_ESPN",
      payload: {
        leagueId: ROOM_LEAGUE_ID,
        season: SEASON,
        commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
        commandCenterDocumentId: replacementDocumentId,
      },
    }, exactAppSender());
    assert.equal(replacementConnect.ok, true, "the replacement page verifies and establishes authority C");

    fixture.releaseWatchDiagnostics();
    const staleResult = await staleHandoff;
    assert.equal(staleResult.ok, true);
    assert.equal(staleResult.roomWatch, null, "the superseded handoff retires without publishing its stale room");

    const heartbeat = await dispatch(fixture.listener, {
      type: "WRITER_HEARTBEAT",
      payload: writerHeartbeatPayload("replacement-binding-heartbeat", {
        commandCenterDocumentId: replacementDocumentId,
        producerSessionId: replacementProducerSessionId,
      }),
    }, exactAppSender());
    assert.equal(heartbeat.code, "WRITER_LEASE_RENEWED", "the stale handoff cannot clear replacement authority C");

    const refresh = await dispatch(fixture.listener, {
      type: "REFRESH_ESPN_CONTEXT",
      payload: {
        commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
        commandCenterDocumentId: replacementDocumentId,
        expectedLeagueId: ROOM_LEAGUE_ID,
        expectedProducerSessionId: replacementProducerSessionId,
        expectedTeamId: TEAM_ID,
        expectedSeason: SEASON,
        expectedTabId: ROOM_TAB_ID,
      },
    }, exactAppSender());
    assert.equal(refresh.ok, true, "replacement authority remains usable after stale rollback cleanup");
    assert.equal(fixture.session.get("draftForgeActionBindingV2")?.producerSessionId, replacementProducerSessionId);
    assert.equal(fixture.session.get("draftForgeActionBindingV2")?.commandCenterDocumentId, replacementDocumentId);
  } finally {
    fixture.releaseWatchDiagnostics();
    fixture.restore();
  }
});

test("a same-identity explicit re-establish rotates authority beyond stale handoff cleanup", async () => {
  const fixture = await loadFixture({
    path: "watch",
    initialNow: Date.parse("2026-08-29T12:45:00.000Z"),
    deferWatchDiagnostics: true,
  });
  try {
    const staleHandoff = dispatch(fixture.listener, {
      type: "ESPN_CONTEXT",
      payload: {
        ...exactRoomContext(),
        producerRevision: 1,
        contextCapturedAt: "2026-08-29T12:45:00.000Z",
      },
    }, {
      url: `https://fantasy.espn.com/football/draft?leagueId=${ROOM_LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON}`,
      tab: { id: ROOM_TAB_ID, windowId: 1 },
    });
    await fixture.watchDiagnosticsStarted;

    const replacementWatch = await dispatch(fixture.listener, {
      type: "ARM_LIVE_ROOM_WATCH",
      payload: {
        sourceLeagueId: SOURCE_LEAGUE_ID,
        sourceTabId: SOURCE_TAB_ID,
        teamId: TEAM_ID,
        season: SEASON,
        draftType: "SNAKE",
        commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
        commandCenterDocumentId: COMMAND_CENTER_DOCUMENT_ID,
      },
    }, exactAppSender());
    assert.equal(replacementWatch.code, "LIVE_ROOM_WATCH_ARMED", "a newer watch supersedes the in-flight handoff claim");

    const sameIdentityConnect = await dispatch(fixture.listener, {
      type: "CONNECT_ESPN",
      payload: {
        leagueId: ROOM_LEAGUE_ID,
        season: SEASON,
        commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
        commandCenterDocumentId: COMMAND_CENTER_DOCUMENT_ID,
      },
    }, exactAppSender());
    assert.equal(sameIdentityConnect.ok, true, "authority is explicitly re-established with the same exact identity");

    fixture.releaseWatchDiagnostics();
    const staleResult = await staleHandoff;
    assert.equal(staleResult.roomWatch, null);

    const heartbeat = await dispatch(fixture.listener, {
      type: "WRITER_HEARTBEAT",
      payload: writerHeartbeatPayload("same-identity-reestablish-heartbeat"),
    }, exactAppSender());
    assert.equal(
      heartbeat.code,
      "WRITER_LEASE_RENEWED",
      "the older generation token cannot clear a later same-identity establish",
    );
  } finally {
    fixture.releaseWatchDiagnostics();
    fixture.restore();
  }
});

test("a same-authority successor watch survives stale handoff cleanup with finite authorization intact", async () => {
  const fixture = await loadFixture({
    path: "watch",
    initialNow: Date.parse("2026-08-29T12:55:00.000Z"),
    deferWatchDiagnostics: true,
  });
  try {
    const staleHandoff = dispatch(fixture.listener, {
      type: "ESPN_CONTEXT",
      payload: {
        ...exactRoomContext(),
        producerRevision: 1,
        contextCapturedAt: "2026-08-29T12:55:00.000Z",
      },
    }, {
      url: `https://fantasy.espn.com/football/draft?leagueId=${ROOM_LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON}`,
      tab: { id: ROOM_TAB_ID, windowId: 1 },
    });
    await fixture.watchDiagnosticsStarted;

    const successorArm = await dispatch(fixture.listener, {
      type: "ARM_LIVE_ROOM_WATCH",
      payload: {
        sourceLeagueId: SOURCE_LEAGUE_ID,
        sourceTabId: SOURCE_TAB_ID,
        teamId: TEAM_ID,
        season: SEASON,
        draftType: "SNAKE",
        commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
        commandCenterDocumentId: COMMAND_CENTER_DOCUMENT_ID,
      },
    }, exactAppSender());
    assert.equal(successorArm.code, "LIVE_ROOM_WATCH_ARMED");

    fixture.releaseWatchDiagnostics();
    const staleResult = await staleHandoff;
    assert.equal(staleResult.roomWatch, null, "the superseded handoff does not publish");
    assert.equal(
      fixture.cancellations.length,
      0,
      "same-authority supersession clears the unpublished lease without MAX-revoking its reusable finite floor",
    );

    const successorHandoff = await dispatch(fixture.listener, {
      type: "ESPN_HEARTBEAT",
      payload: {
        ...exactRoomContext(),
      },
    }, {
      url: `https://fantasy.espn.com/football/draft?leagueId=${ROOM_LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON}`,
      tab: { id: ROOM_TAB_ID, windowId: 1 },
    });
    assert.equal(
      successorHandoff.roomWatch?.recovered,
      true,
      "the unchanged ESPN room heartbeat lets the exact successor watch own the room",
    );
    assert.equal(fixture.heartbeatAtImport?.code, "WRITER_LEASE_RENEWED");

    const finiteCancel = await dispatch(fixture.listener, {
      type: "CANCEL_PENDING_ACTIONS",
      payload: {
        ...writerHeartbeatPayload("unused-transition"),
        minimumAuthorizationEpoch: 1,
      },
    }, exactAppSender());
    assert.equal(finiteCancel.code, "ACTION_AUTHORIZATION_REVOKED");
    assert.equal(finiteCancel.minimumAuthorizationEpoch, 1);
    assert.deepEqual(
      fixture.cancellations.map((entry) => entry.payload.minimumAuthorizationEpoch),
      [1],
      "the successor authority receives only the explicit finite floor",
    );

    const action = await dispatch(fixture.listener, {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        actionId: "successor-watch-action",
        decisionId: "successor-watch-decision",
        actionRequestId: 1,
        commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
        commandCenterDocumentId: COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 1,
        expectedLeagueId: ROOM_LEAGUE_ID,
        expectedTeamId: TEAM_ID,
        expectedSeason: SEASON,
        expectedTabId: ROOM_TAB_ID,
        expectedProducerSessionId: "cold-room-producer",
        playerId: 1,
        playerName: "Player 1",
        notAfter: fixture.now + 9_000,
        availabilityNotAfter: fixture.now + 9_000,
      },
    }, exactAppSender());
    assert.equal(action.ok, true, "the successor can authorize at the finite epoch instead of inheriting MAX");
    assert.equal(fixture.executedActions.length, 1);
    assert.equal(fixture.executedActions[0].payload.authorizationEpoch, 1);
  } finally {
    fixture.releaseWatchDiagnostics();
    fixture.restore();
  }
});

test("cold watched-room handoff mints authority after deferred diagnostics so its first heartbeat succeeds", async () => {
  const fixture = await loadFixture({
    path: "watch",
    initialNow: Date.parse("2026-08-29T13:00:00.000Z"),
  });
  try {
    const result = await dispatch(fixture.listener, {
      type: "ESPN_CONTEXT",
      payload: {
        ...exactRoomContext(),
        producerSessionId: "cold-room-producer",
        producerRevision: 1,
        contextCapturedAt: "2026-08-29T13:00:00.000Z",
      },
    }, {
      url: `https://fantasy.espn.com/football/draft?leagueId=${ROOM_LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON}`,
      tab: { id: ROOM_TAB_ID, windowId: 1 },
    });

    assert.equal(result.ok, true);
    assert.equal(result.roomWatch?.recovered, true);
    assert.equal(fixture.presentationAdvanced, true, "diagnostics consume more than one old lease TTL without a real sleep");
    assert.equal(fixture.heartbeatAtImport?.code, "WRITER_LEASE_RENEWED");
    assert.equal(fixture.heartbeatAtImport?.transitionRequestId, "watch-first-heartbeat");
    assert.equal(
      fixture.heartbeatAtImport?.expiresAt,
      fixture.now + WRITER_LEASE_TTL_MS,
      "DF_IMPORT_SUCCESS exposes a lease minted from the post-diagnostics clock",
    );
    assert.ok(fixture.broadcasts.includes("DF_IMPORT_SUCCESS"));
  } finally {
    fixture.restore();
  }
});

test("explicit live-workspace recovery mints authority after deferred visibility work so its first heartbeat succeeds", async () => {
  const fixture = await loadFixture({
    path: "recovery",
    initialNow: Date.parse("2026-08-29T14:00:00.000Z"),
  });
  try {
    const result = await dispatch(fixture.listener, {
      type: "RECOVER_LIVE_WORKSPACE",
      payload: {
        draftLeagueId: ROOM_LEAGUE_ID,
        sourceLeagueId: SOURCE_LEAGUE_ID,
        teamId: TEAM_ID,
        season: SEASON,
        commandCenterSessionId: COMMAND_CENTER_SESSION_ID,
        commandCenterDocumentId: COMMAND_CENTER_DOCUMENT_ID,
      },
    }, exactAppSender());

    assert.equal(result.ok, true);
    assert.equal(result.code, "LIVE_WORKSPACE_RECOVERED");
    assert.equal(fixture.presentationAdvanced, true, "window separation consumes more than one old lease TTL without a real sleep");
    assert.equal(fixture.heartbeatAtImport?.code, "WRITER_LEASE_RENEWED");
    assert.equal(fixture.heartbeatAtImport?.transitionRequestId, "recovery-first-heartbeat");
    assert.equal(
      fixture.heartbeatAtImport?.expiresAt,
      fixture.now + WRITER_LEASE_TTL_MS,
      "DF_IMPORT_SUCCESS exposes a lease minted from the post-visibility clock",
    );
    assert.ok(fixture.broadcasts.includes("DF_IMPORT_SUCCESS"));
    assert.ok(fixture.removed.includes(SOURCE_TAB_ID));
  } finally {
    fixture.restore();
  }
});

test("both cold-control paths keep lease creation as the final awaited authority step before import publication", async () => {
  const source = await readFile(backgroundUrl, "utf8");
  const freshenHelper = source.slice(
    source.indexOf("async function freshenEstablishedWriterLease"),
    source.indexOf("async function restoreActionBinding"),
  );
  assert.match(freshenHelper, /sameActionBinding\(actionBinding, expectedBinding\)/);
  assert.match(freshenHelper, /return establishWriterLease\(actionBinding\)/);
  const watchFlow = source.slice(
    source.indexOf("async function performWatchedLiveRoomRecovery"),
    source.indexOf("async function recoverWatchedLiveRoom"),
  );
  const recoveryFlow = source.slice(
    source.indexOf('    if (message.type === "RECOVER_LIVE_WORKSPACE")'),
    source.indexOf('    if (message.type === "ESPN_CONTEXT")'),
  );

  for (const [label, flow] of [["watched handoff", watchFlow], ["explicit recovery", recoveryFlow]]) {
    const bindingIndex = flow.lastIndexOf("await establishActionBinding(");
    const freshenIndex = flow.lastIndexOf("await freshenEstablishedWriterLease(");
    const publishIndex = flow.indexOf('await broadcast("DF_IMPORT_SUCCESS", data)');
    assert.ok(bindingIndex >= 0, `${label} establishes exact action authority`);
    assert.ok(freshenIndex > bindingIndex, `${label} refreshes only its still-current established binding`);
    assert.ok(publishIndex > freshenIndex, `${label} refreshes authority before publishing the import`);
    const awaitsBeforePublish = [...flow.slice(0, publishIndex).matchAll(/\bawait\b/g)];
    const finalAwaitIndex = awaitsBeforePublish.at(-1)?.index ?? -1;
    assert.equal(
      finalAwaitIndex,
      freshenIndex,
      `${label} performs no deferred await between the final lease mint and DF_IMPORT_SUCCESS`,
    );
  }
});
