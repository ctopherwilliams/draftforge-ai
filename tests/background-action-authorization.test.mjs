import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const backgroundUrl = new URL("../extension/background.js", import.meta.url);

function dispatchRuntimeMessage(listener, message, sender) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error(`message timed out: ${message.type}`));
    }, 1_000);
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

async function assertLateWorkspaceExtraTabBlocks(extraTab, importLabel, extraVisibleAfterContextReads = 1) {
  const appTabId = 310;
  const espnTabId = 320;
  const sessionId = `late-workspace-${importLabel}-session`;
  const appTab = { id: appTabId, url: "http://127.0.0.1:3000/", windowId: 1 };
  const espnTab = {
    id: espnTabId,
    url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026",
    windowId: 1,
  };
  const context = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    inDraftRoom: true,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV1", {
      leagueId: "701",
      teamId: 5,
      season: 2026,
      tabId: espnTabId,
      appTabId,
      commandCenterSessionId: sessionId,
    }],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const executeMessages = [];
  let exactContextReads = 0;
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("integrity fixture intentionally offline"); };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      reload: () => {},
    },
    storage: {
      local: {
        async get(key) { return { [key]: localStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) localStorage.set(key, structuredClone(value)); },
        async remove(key) { localStorage.delete(key); },
      },
      session: {
        async get(key) { return { [key]: sessionStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, value); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return appTab;
        if (tabId === espnTabId) return espnTab;
        if (tabId === extraTab.id) return extraTab;
        throw new Error("tab not found");
      },
      async query(query) {
        if (query?.url === "https://fantasy.espn.com/*") return [espnTab];
        return exactContextReads >= extraVisibleAfterContextReads
          ? [appTab, espnTab, extraTab]
          : [appTab, espnTab];
      },
      async sendMessage(tabId, message) {
        if (tabId === espnTabId && message.type === "DF_GET_CONTEXT") {
          exactContextReads += 1;
          return context;
        }
        if (tabId === espnTabId && message.type === "DF_EXECUTE_ACTION") {
          executeMessages.push(message);
          return { ok: true, code: "UNEXPECTED_EXECUTION" };
        }
        return { ok: true };
      },
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };

  try {
    await import(`${backgroundUrl.href}?late-workspace-${importLabel}=${Date.now()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    const now = Date.now();
    const result = await dispatchRuntimeMessage(listeners[0], {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 12345,
        playerName: "Exact Player",
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, { url: appTab.url, tab: appTab });
    assert.equal(exactContextReads >= extraVisibleAfterContextReads, true, "the extra tab appears only after the configured exact-room verification boundary");
    assert.equal(result.code, "DRAFT_WORKSPACE_CARDINALITY_CHANGED");
    assert.equal(executeMessages.length, 0, "no content action is dispatched after workspace cardinality changes");
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
}

test("a command-center cancellation during delayed context verification prevents ESPN dispatch", async () => {
  const appTabId = 10;
  const espnTabId = 20;
  const sessionId = "authorization-race-session";
  const binding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: espnTabId,
    appTabId,
    commandCenterSessionId: sessionId,
  };
  const context = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    inDraftRoom: true,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV1", binding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const executeMessages = [];
  const cancellationMessages = [];
  let contextReads = 0;
  let releaseDelayedContext;
  const delayedContext = new Promise((resolve) => { releaseDelayedContext = resolve; });

  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("integrity fixture intentionally offline"); };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      reload: () => {},
    },
    storage: {
      local: {
        async get(key) { return { [key]: localStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) localStorage.set(key, structuredClone(value)); },
        async remove(key) { localStorage.delete(key); },
      },
      session: {
        async get(key) { return { [key]: sessionStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, value); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return { id: appTabId, url: "http://127.0.0.1:3000/", windowId: 1 };
        if (tabId === espnTabId) return { id: espnTabId, url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026", windowId: 1 };
        throw new Error("tab not found");
      },
      query: async () => [{
        id: espnTabId,
        url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026",
        windowId: 1,
      }],
      async sendMessage(tabId, message) {
        if (tabId === espnTabId && message.type === "DF_GET_CONTEXT") {
          contextReads += 1;
          return contextReads === 1 ? context : delayedContext;
        }
        if (tabId === espnTabId && message.type === "DF_CANCEL_PENDING_ACTIONS") {
          cancellationMessages.push(message);
          return { ok: true };
        }
        if (tabId === espnTabId && message.type === "DF_EXECUTE_ACTION") {
          executeMessages.push(message);
          return { ok: true, code: "UNEXPECTED_EXECUTION" };
        }
        return { ok: true };
      },
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
    },
    windows: {
      create: async () => ({ id: 2 }),
      update: async () => {},
    },
  };

  try {
    await import(`${backgroundUrl.href}?authorization-race=${Date.now()}`);
    assert.equal(listeners.length, 1);
    for (let index = 0; index < 20 && contextReads < 1; index += 1) await Promise.resolve();
    assert.equal(contextReads, 1, "the persisted exact binding is restored first");

    const listener = listeners[0];
    const sender = { url: "http://127.0.0.1:3000/", tab: { id: appTabId, url: "http://127.0.0.1:3000/" } };
    const now = Date.now();
    const actionPromise = dispatchRuntimeMessage(listener, {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "BID",
        commandCenterSessionId: sessionId,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 12345,
        playerName: "Exact Player",
        expectedCurrentBid: 27,
        amount: 28,
        maxApprovedBid: 35,
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, sender);
    for (let index = 0; index < 20 && contextReads < 2; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(contextReads, 2, "the action waits on a fresh exact-room context");

    const cancellation = await dispatchRuntimeMessage(listener, {
      type: "CANCEL_PENDING_ACTIONS",
      payload: {
        commandCenterSessionId: sessionId,
        expectedLeagueId: "701",
        expectedTeamId: 5,
        expectedTabId: espnTabId,
        minimumAuthorizationEpoch: 1,
      },
    }, sender);
    assert.equal(cancellation.code, "ACTION_AUTHORIZATION_REVOKED");
    assert.equal(cancellationMessages.length, 1, "the content-script floor is updated too");

    releaseDelayedContext(context);
    const result = await actionPromise;
    assert.equal(result.code, "ACTION_AUTHORIZATION_REVOKED");
    assert.equal(executeMessages.length, 0, "no DF_EXECUTE_ACTION crosses the revoked handoff");
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("same-league tab rebound revokes the old actuator before publishing the replacement binding", async () => {
  const appTabId = 110;
  const oldEspnTabId = 120;
  const newEspnTabId = 121;
  const sessionId = "binding-rebound-race-session";
  const oldBinding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: oldEspnTabId,
    appTabId,
    commandCenterSessionId: sessionId,
  };
  const exactContext = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    inDraftRoom: true,
    autopickActive: false,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV1", oldBinding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const cancellationMessages = [];
  let oldContextAvailable = true;
  let oldActionRevoked = false;
  let oldActionClicked = false;
  let rejectNewRevocation = false;
  const reloadedTabIds = [];
  let releaseOldAction;
  let markOldActionStarted;
  const oldActionStarted = new Promise((resolve) => { markOldActionStarted = resolve; });
  const oldActionRelease = new Promise((resolve) => { releaseOldAction = resolve; });

  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("integrity fixture intentionally offline"); };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      reload: () => {},
    },
    storage: {
      local: {
        async get(key) { return { [key]: localStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) localStorage.set(key, structuredClone(value)); },
        async remove(key) { localStorage.delete(key); },
      },
      session: {
        async get(key) { return { [key]: sessionStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, value); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return { id: appTabId, url: "http://127.0.0.1:3000/", windowId: 1 };
        if (tabId === oldEspnTabId) return { id: oldEspnTabId, url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026", windowId: 1 };
        if (tabId === newEspnTabId) return { id: newEspnTabId, url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026&draftId=new", windowId: 2 };
        throw new Error("tab not found");
      },
      query: async (query) => {
        const roomTabs = oldContextAvailable
          ? [{ id: oldEspnTabId, url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026", windowId: 1 }]
          : [{ id: newEspnTabId, url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026&draftId=new", windowId: 2 }];
        return query?.url === "https://fantasy.espn.com/*"
          ? roomTabs
          : [{ id: appTabId, url: "http://127.0.0.1:3000/", windowId: 1 }, ...roomTabs];
      },
      async sendMessage(tabId, message) {
        if (tabId === appTabId) return { ok: true };
        if (tabId === oldEspnTabId && message.type === "DF_GET_CONTEXT") {
          if (!oldContextAvailable) throw new Error("old context disappeared");
          return exactContext;
        }
        if (tabId === newEspnTabId && message.type === "DF_GET_CONTEXT") return exactContext;
        if (tabId === oldEspnTabId && message.type === "DF_CANCEL_PENDING_ACTIONS") {
          cancellationMessages.push(message);
          oldActionRevoked = true;
          return { ok: true, code: "ACTION_AUTHORIZATION_REVOKED" };
        }
        if (tabId === oldEspnTabId && message.type === "DF_EXECUTE_ACTION") {
          markOldActionStarted();
          await oldActionRelease;
          if (oldActionRevoked) return { ok: false, code: "ACTION_AUTHORIZATION_REVOKED", clicked: false };
          oldActionClicked = true;
          return { ok: true, code: "BID_CONFIRMED", clicked: true };
        }
        if (tabId === newEspnTabId && message.type === "DF_CANCEL_PENDING_ACTIONS" && rejectNewRevocation) {
          throw new Error("content ACK intentionally unavailable");
        }
        return { ok: true };
      },
      reload: async (tabId) => { reloadedTabIds.push(tabId); },
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
    },
    windows: {
      create: async () => ({ id: 2 }),
      update: async () => {},
    },
  };

  try {
    await import(`${backgroundUrl.href}?binding-rebound-race=${Date.now()}`);
    assert.equal(listeners.length, 1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    const listener = listeners[0];
    const sender = { url: "http://127.0.0.1:3000/", tab: { id: appTabId, url: "http://127.0.0.1:3000/" } };
    const now = Date.now();
    const actionPromise = dispatchRuntimeMessage(listener, {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "BID",
        commandCenterSessionId: sessionId,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: oldEspnTabId,
        playerId: 12345,
        playerName: "Exact Player",
        expectedCurrentBid: 27,
        amount: 28,
        maxApprovedBid: 35,
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, sender);
    await oldActionStarted;
    oldContextAvailable = false;

    const rebound = await dispatchRuntimeMessage(listener, {
      type: "REFRESH_ESPN_CONTEXT",
      payload: {
        commandCenterSessionId: sessionId,
        expectedLeagueId: "701",
        expectedTeamId: 5,
        expectedTabId: oldEspnTabId,
      },
    }, sender);
    assert.equal(rebound.ok, true);
    assert.equal(rebound.rebound, true);
    assert.equal(rebound.previousTabId, oldEspnTabId);
    assert.equal(rebound.context.tabId, newEspnTabId);
    assert.equal(cancellationMessages.length, 1, "old content must acknowledge revocation before rebind returns");
    assert.equal(cancellationMessages[0].payload.minimumAuthorizationEpoch, Number.MAX_SAFE_INTEGER);

    const latePageCancellation = await dispatchRuntimeMessage(listener, {
      type: "CANCEL_PENDING_ACTIONS",
      payload: {
        commandCenterSessionId: sessionId,
        expectedLeagueId: "701",
        expectedTeamId: 5,
        expectedTabId: oldEspnTabId,
        minimumAuthorizationEpoch: 1,
      },
    }, sender);
    assert.equal(latePageCancellation.code, "ACTION_CANCELLATION_BINDING_MISMATCH");

    releaseOldAction();
    const action = await actionPromise;
    assert.equal(action.code, "ACTION_AUTHORIZATION_REVOKED");
    assert.equal(oldActionClicked, false, "old content cannot click after replacement authority is published");
    assert.equal(sessionStorage.get("draftForgeActionBindingV1").tabId, newEspnTabId);

    rejectNewRevocation = true;
    const transitionRevocation = await dispatchRuntimeMessage(listener, {
      type: "REVOKE_ACTION_BINDING",
      payload: {
        transitionRequestId: "preview-transition-1",
        commandCenterSessionId: sessionId,
        expectedLeagueId: "701",
        expectedTeamId: 5,
        expectedTabId: newEspnTabId,
      },
    }, sender);
    assert.deepEqual(transitionRevocation, {
      ok: true,
      code: "ACTION_BINDING_REVOKED",
      transitionRequestId: "preview-transition-1",
      revokedTabId: newEspnTabId,
      revokedLeagueId: "701",
      revokedTeamId: 5,
      minimumAuthorizationEpoch: Number.MAX_SAFE_INTEGER,
    });
    assert.deepEqual(reloadedTabIds, [newEspnTabId], "a living ESPN tab is force-reloaded when content cannot ACK revocation");
    assert.equal(sessionStorage.has("draftForgeActionBindingV1"), false, "the transition clears persisted authority only after revocation");
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("an exact duplicate ESPN live room appearing after binding fails the final dispatch race closed", async () => {
  const appTabId = 210;
  const espnTabId = 220;
  const duplicateTabId = 221;
  const sessionId = "duplicate-live-room-race-session";
  const binding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: espnTabId,
    appTabId,
    commandCenterSessionId: sessionId,
  };
  const context = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    inDraftRoom: true,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV1", binding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const executeMessages = [];
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("integrity fixture intentionally offline"); };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      reload: () => {},
    },
    storage: {
      local: {
        async get(key) { return { [key]: localStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) localStorage.set(key, structuredClone(value)); },
        async remove(key) { localStorage.delete(key); },
      },
      session: {
        async get(key) { return { [key]: sessionStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, value); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return { id: appTabId, url: "http://127.0.0.1:3000/", windowId: 1 };
        if ([espnTabId, duplicateTabId].includes(tabId)) {
          return { id: tabId, url: `https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026&draftId=${tabId}`, windowId: tabId };
        }
        throw new Error("tab not found");
      },
      query: async () => [
        { id: appTabId, url: "http://127.0.0.1:3000/", windowId: 1 },
        ...[espnTabId, duplicateTabId].map((tabId) => ({
          id: tabId,
          url: `https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026&draftId=${tabId}`,
          windowId: tabId,
        })),
      ],
      async sendMessage(tabId, message) {
        if ([espnTabId, duplicateTabId].includes(tabId) && message.type === "DF_GET_CONTEXT") return context;
        if (tabId === espnTabId && message.type === "DF_EXECUTE_ACTION") {
          executeMessages.push(message);
          return { ok: true, code: "UNEXPECTED_EXECUTION" };
        }
        return { ok: true };
      },
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };

  try {
    await import(`${backgroundUrl.href}?duplicate-live-room-race=${Date.now()}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    const now = Date.now();
    const result = await dispatchRuntimeMessage(listeners[0], {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 12345,
        playerName: "Exact Player",
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, { url: "http://127.0.0.1:3000/", tab: { id: appTabId, url: "http://127.0.0.1:3000/" } });
    assert.equal(result.code, "ESPN_EXACT_ROOM_CARDINALITY_CHANGED");
    assert.equal(executeMessages.length, 0, "no content action is dispatched after the exact room becomes ambiguous");
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("an arbitrary tab opened after page diagnostics blocks final ESPN dispatch", async () => {
  await assertLateWorkspaceExtraTabBlocks({
    id: 330,
    url: "https://example.com/late-unmanaged-tab",
    windowId: 2,
  }, "arbitrary-tab");
});

test("a second DraftForge tab opened after page diagnostics blocks final ESPN dispatch", async () => {
  await assertLateWorkspaceExtraTabBlocks({
    id: 331,
    url: "http://localhost:3000/duplicate-command-center",
    windowId: 2,
  }, "duplicate-draftforge");
});

test("an arbitrary tab created by the final context probe blocks ESPN dispatch", async () => {
  await assertLateWorkspaceExtraTabBlocks({
    id: 332,
    url: "https://example.com/context-probe-race",
    windowId: 2,
  }, "context-probe-race", 2);
});

test("only the exact token holder can retire its own pre-click auction permit", async () => {
  const tabId = 330;
  const token = "exact-pre-click-token-0000000000000001";
  const key = "701:5:2026";
  const action = {
    operation: "BID",
    actionRequestId: 1,
    actionId: "pre-click-action-330",
    decisionId: "pre-click-decision-330",
    commandCenterSessionId: "pre-click-command-center-330",
    authorizationEpoch: 0,
    expectedLeagueId: "701",
    expectedTeamId: 5,
    expectedSeason: 2026,
    playerId: 12345,
    amount: 28,
  };
  const now = Date.now();
  const record = {
    key,
    armedTabId: tabId,
    leagueId: "701",
    teamId: 5,
    season: 2026,
    operation: "BID",
    playerId: 12345,
    amount: 28,
    armedAt: now - 100,
    latestPermitAt: now - 50,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    stage: "SUBMIT",
    actionIdentity: {
      actionId: action.actionId,
      decisionId: action.decisionId,
      commandCenterSessionId: action.commandCenterSessionId,
      authorizationEpoch: 0,
      actionRequestId: 1,
    },
  };
  const localStorage = new Map([["draftForgeAuctionClickUncertaintyV1", { [key]: record }]]);
  const sessionStorage = new Map();
  const listeners = [];
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("integrity fixture intentionally offline"); };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      reload: () => {},
    },
    storage: {
      local: {
        async get(storageKey) { return { [storageKey]: localStorage.get(storageKey) }; },
        async set(entries) { for (const [storageKey, value] of Object.entries(entries)) localStorage.set(storageKey, structuredClone(value)); },
        async remove(storageKey) { localStorage.delete(storageKey); },
      },
      session: {
        async get(storageKey) { return { [storageKey]: sessionStorage.get(storageKey) }; },
        async set(entries) { for (const [storageKey, value] of Object.entries(entries)) sessionStorage.set(storageKey, structuredClone(value)); },
        async remove(storageKey) { sessionStorage.delete(storageKey); },
      },
    },
    tabs: {
      get: async () => Promise.reject(new Error("tab not found")),
      query: async () => [],
      sendMessage: async () => ({ ok: true }),
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };
  const sender = {
    url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026",
    tab: { id: tabId, url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026" },
  };
  try {
    await import(`${backgroundUrl.href}?pre-click-retirement=${Date.now()}`);
    const listener = listeners[0];
    const wrongToken = await dispatchRuntimeMessage(listener, {
      type: "AUCTION_CLICK_UNCERTAINTY",
      payload: { mode: "CANCEL_PRE_CLICK", stage: "SUBMIT", token: `${token}-wrong`, action },
    }, sender);
    assert.equal(wrongToken.code, "AUCTION_CLICK_UNCERTAIN");
    assert.equal(Object.keys(localStorage.get("draftForgeAuctionClickUncertaintyV1")).length, 1);

    const irreversibleStage = await dispatchRuntimeMessage(listener, {
      type: "AUCTION_CLICK_UNCERTAINTY",
      payload: { mode: "CANCEL_PRE_CLICK", stage: "CONFIRMATION", token, action },
    }, sender);
    assert.equal(irreversibleStage.code, "AUCTION_UNCERTAINTY_STAGE_INVALID");
    assert.equal(Object.keys(localStorage.get("draftForgeAuctionClickUncertaintyV1")).length, 1);

    const retired = await dispatchRuntimeMessage(listener, {
      type: "AUCTION_CLICK_UNCERTAINTY",
      payload: { mode: "CANCEL_PRE_CLICK", stage: "SUBMIT", token, action },
    }, sender);
    assert.equal(retired.code, "AUCTION_UNCERTAINTY_PRE_CLICK_RETIRED");
    assert.deepEqual(localStorage.get("draftForgeAuctionClickUncertaintyV1"), {});
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("corrupt durable auction storage fails closed and blocks extension reload", async () => {
  const listeners = [];
  let reloads = 0;
  const sessionStorage = new Map([["draftForgeWorkspaceWriterV1", 10]]);
  const localStorage = new Map([["draftForgeAuctionClickUncertaintyV1", { corrupt: true }]]);
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("integrity fixture intentionally offline"); };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      reload: () => { reloads += 1; },
    },
    storage: {
      local: {
        async get(key) { return { [key]: localStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) localStorage.set(key, structuredClone(value)); },
        async remove(key) { localStorage.delete(key); },
      },
      session: {
        async get(key) { return { [key]: sessionStorage.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, value); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      get: async (tabId) => tabId === 10
        ? { id: 10, url: "http://127.0.0.1:3000/", windowId: 1 }
        : Promise.reject(new Error("tab not found")),
      query: async () => [],
      sendMessage: async () => ({ ok: true }),
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };
  try {
    await import(`${backgroundUrl.href}?corrupt-auction-storage=${Date.now()}`);
    const result = await dispatchRuntimeMessage(listeners[0], { type: "RELOAD_EXTENSION" }, {
      url: "http://127.0.0.1:3000/",
      tab: { id: 10, url: "http://127.0.0.1:3000/" },
    });
    assert.equal(result.code, "AUCTION_UNCERTAINTY_STORAGE_UNVERIFIED");
    assert.equal(reloads, 0);
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});
