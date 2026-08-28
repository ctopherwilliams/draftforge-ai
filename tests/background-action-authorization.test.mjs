import assert from "node:assert/strict";
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
      query: async () => [],
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
    for (let index = 0; index < 20 && contextReads < 2; index += 1) await Promise.resolve();
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
      query: async () => [{ id: newEspnTabId, url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026&draftId=new", windowId: 2 }],
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
