import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const backgroundUrl = new URL("../extension/background.js", import.meta.url);
const DEFAULT_PRODUCER_SESSION_ID = "espn-producer-session-default";
const DEFAULT_COMMAND_CENTER_DOCUMENT_ID = "command-center-document-default";

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

async function establishExactWriterLease(listener, sender, commandCenterSessionId) {
  const result = await dispatchRuntimeMessage(listener, {
    type: "APP_HELLO",
    payload: {
      commandCenterSessionId,
      commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
    },
  }, sender);
  assert.equal(result?.ready, true, "the exact command center completes its recovery handshake");
  return result;
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
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    inDraftRoom: true,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", {
      leagueId: "701",
      teamId: 5,
      season: 2026,
      tabId: espnTabId,
      appTabId,
      producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
      commandCenterSessionId: sessionId,
      commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
    }],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const executeMessages = [];
  let exactContextReads = 0;
  let leaseEstablished = false;
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
        return leaseEstablished && exactContextReads >= extraVisibleAfterContextReads
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
    const sender = { url: appTab.url, tab: appTab };
    await establishExactWriterLease(listeners[0], sender, sessionId);
    exactContextReads = 0;
    leaseEstablished = true;
    const now = Date.now();
    const result = await dispatchRuntimeMessage(listeners[0], {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 12345,
        playerName: "Exact Player",
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, sender);
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
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    commandCenterSessionId: sessionId,
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
  };
  const context = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    inDraftRoom: true,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", binding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const executeMessages = [];
  const cancellationMessages = [];
  let contextReads = 0;
  let delayActionContext = false;
  let delayedActionContextStarted = false;
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
          if (delayActionContext) {
            delayedActionContextStarted = true;
            return delayedContext;
          }
          return context;
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
    await establishExactWriterLease(listener, sender, sessionId);
    delayActionContext = true;
    const now = Date.now();
    const actionPromise = dispatchRuntimeMessage(listener, {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "BID",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
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
    for (let index = 0; index < 20 && !delayedActionContextStarted; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delayedActionContextStarted, true, "the action waits on a fresh exact-room context");

    const cancellation = await dispatchRuntimeMessage(listener, {
      type: "CANCEL_PENDING_ACTIONS",
      payload: {
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
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

test("server authorization verification rechecks a concurrently raised background floor even when content cancellation fails", async () => {
  const appTabId = 70;
  const espnTabId = 80;
  const sessionId = "server-verification-cancel-race";
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
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    inDraftRoom: true,
  };
  const binding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: espnTabId,
    appTabId,
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    commandCenterSessionId: sessionId,
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", binding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  let exactAction;
  let cancelDeliveryAttempts = 0;
  let markServerVerificationStarted;
  let releaseServerVerification;
  const serverVerificationStarted = new Promise((resolve) => { markServerVerificationStarted = resolve; });
  const serverVerificationGate = new Promise((resolve) => { releaseServerVerification = resolve; });
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith("http://127.0.0.1:3000/api/draft-day?view=dispatch-lease")) {
      throw new Error("integrity fixture intentionally offline");
    }
    markServerVerificationStarted();
    await serverVerificationGate;
    return {
      ok: true,
      async json() { return { ok: true, code: "DRAFT_ACTION_SERVER_LEASE_CURRENT" }; },
    };
  };
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
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, structuredClone(value)); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return appTab;
        if (tabId === espnTabId) return espnTab;
        throw new Error("tab not found");
      },
      async query(query) {
        return query?.url === "https://fantasy.espn.com/*" ? [espnTab] : [appTab, espnTab];
      },
      async sendMessage(tabId, message) {
        if (tabId === espnTabId && message.type === "DF_GET_CONTEXT") return context;
        if (tabId === espnTabId && message.type === "DF_CANCEL_PENDING_ACTIONS") {
          cancelDeliveryAttempts += 1;
          throw new Error("content cancellation delivery intentionally failed");
        }
        if (tabId === espnTabId && message.type === "DF_EXECUTE_ACTION") {
          exactAction = structuredClone(message.payload);
          return { ok: false, code: "TEST_ACTION_CAPTURED", clicked: false };
        }
        return { ok: true };
      },
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };

  try {
    await import(`${backgroundUrl.href}?server-verification-cancel-race=${process.hrtime.bigint()}`);
    await new Promise((resolve) => setImmediate(resolve));
    const appSender = { url: appTab.url, tab: appTab };
    await establishExactWriterLease(listeners[0], appSender, sessionId);
    const now = Date.now();
    const submitted = await dispatchRuntimeMessage(listeners[0], {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 12345,
        playerName: "Exact Player",
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, appSender);
    assert.equal(submitted.code, "TEST_ACTION_CAPTURED");
    assert.match(String(exactAction?.writerLeaseId || ""), /.+/);

    const verification = dispatchRuntimeMessage(listeners[0], {
      type: "VERIFY_ACTION_AUTHORIZATION",
      payload: exactAction,
    }, { url: espnTab.url, tab: espnTab });
    await serverVerificationStarted;

    const cancellation = await dispatchRuntimeMessage(listeners[0], {
      type: "CANCEL_PENDING_ACTIONS",
      payload: {
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
        expectedTeamId: 5,
        expectedTabId: espnTabId,
        minimumAuthorizationEpoch: 1,
      },
    }, appSender);
    assert.deepEqual(cancellation, {
      ok: true,
      code: "ACTION_AUTHORIZATION_REVOKED",
      minimumAuthorizationEpoch: 1,
    });
    assert.equal(cancelDeliveryAttempts, 1, "the authoritative background floor does not depend on content delivery");

    releaseServerVerification();
    const verificationResult = await verification;
    assert.deepEqual(verificationResult, { ok: false, code: "ACTION_AUTHORIZATION_REVOKED" });
  } finally {
    releaseServerVerification?.();
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("an explicit finite binding revoke invalidates an older epoch captured during the transition", async () => {
  const appTabId = 90;
  const espnTabId = 100;
  const sessionId = "finite-binding-revoke-race";
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
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    inDraftRoom: true,
  };
  const binding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: espnTabId,
    appTabId,
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    commandCenterSessionId: sessionId,
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", binding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const executeMessages = [];
  const contentCancellationMessages = [];
  let delayActionContext = false;
  let markDelayedContextStarted;
  let releaseDelayedContext;
  const delayedContextStarted = new Promise((resolve) => { markDelayedContextStarted = resolve; });
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
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, structuredClone(value)); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return appTab;
        if (tabId === espnTabId) return espnTab;
        throw new Error("tab not found");
      },
      async query(query) {
        return query?.url === "https://fantasy.espn.com/*" ? [espnTab] : [appTab, espnTab];
      },
      async sendMessage(tabId, message) {
        if (tabId === espnTabId && message.type === "DF_GET_CONTEXT") {
          if (delayActionContext) {
            markDelayedContextStarted();
            return delayedContext;
          }
          return context;
        }
        if (tabId === espnTabId && message.type === "DF_CANCEL_PENDING_ACTIONS") {
          contentCancellationMessages.push(structuredClone(message));
          return { ok: true, code: "ACTION_AUTHORIZATION_REVOKED" };
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
      onUpdated: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };

  try {
    await import(`${backgroundUrl.href}?finite-binding-revoke-race=${process.hrtime.bigint()}`);
    await new Promise((resolve) => setImmediate(resolve));
    const sender = { url: appTab.url, tab: appTab };
    await establishExactWriterLease(listeners[0], sender, sessionId);
    delayActionContext = true;
    const now = Date.now();
    const capturedAction = dispatchRuntimeMessage(listeners[0], {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 12345,
        playerName: "Transition Player",
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, sender);
    await delayedContextStarted;

    const revocation = await dispatchRuntimeMessage(listeners[0], {
      type: "REVOKE_ACTION_BINDING",
      payload: {
        transitionRequestId: "finite-revoke-transition",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
        expectedTeamId: 5,
        expectedTabId: espnTabId,
        minimumAuthorizationEpoch: 1,
      },
    }, sender);
    assert.deepEqual(revocation, {
      ok: true,
      code: "ACTION_BINDING_REVOKED",
      transitionRequestId: "finite-revoke-transition",
      revokedTabId: espnTabId,
      revokedLeagueId: "701",
      revokedTeamId: 5,
      minimumAuthorizationEpoch: 1,
    });
    assert.equal(contentCancellationMessages.length, 1);
    assert.equal(contentCancellationMessages[0].payload.minimumAuthorizationEpoch, 1, "content receives the exact finite floor ACKed to the page");
    assert.equal(contentCancellationMessages[0].payload.expectedProducerSessionId, DEFAULT_PRODUCER_SESSION_ID);

    releaseDelayedContext(context);
    const actionResult = await capturedAction;
    assert.equal(actionResult.code, "ACTION_AUTHORIZATION_REVOKED", "the epoch captured before transition cannot cross the raised background floor");
    assert.equal(executeMessages.length, 0);
  } finally {
    releaseDelayedContext?.(context);
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("same-session tab rebound revokes the old actuator and authorizes the replacement generation", async () => {
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
    producerSessionId: "espn-producer-session-old",
    commandCenterSessionId: sessionId,
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
  };
  const exactContext = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    producerSessionId: "espn-producer-session-old",
    inDraftRoom: true,
    autopickActive: false,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", oldBinding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const cancellationMessages = [];
  let oldContextAvailable = true;
  let oldActionRevoked = false;
  let oldActionClicked = false;
  const newExecuteMessages = [];
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
        if (tabId === newEspnTabId && message.type === "DF_GET_CONTEXT") {
          return { ...exactContext, producerSessionId: "espn-producer-session-new" };
        }
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
        if (tabId === newEspnTabId && message.type === "DF_EXECUTE_ACTION") {
          newExecuteMessages.push(message);
          return { ok: true, code: "PLAYER_SELECTED", clicked: true };
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
    await establishExactWriterLease(listener, sender, sessionId);
    const now = Date.now();
    const actionPromise = dispatchRuntimeMessage(listener, {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "BID",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: "espn-producer-session-old",
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
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: "espn-producer-session-old",
        expectedTeamId: 5,
        expectedTabId: oldEspnTabId,
      },
    }, sender);
    assert.equal(rebound.ok, true);
    assert.equal(rebound.rebound, true);
    assert.equal(rebound.previousTabId, oldEspnTabId);
    assert.equal(rebound.context.tabId, newEspnTabId);
    assert.equal(rebound.context.producerSessionId, "espn-producer-session-new");
    assert.equal(cancellationMessages.length, 1, "old content must acknowledge revocation before rebind returns");
    assert.equal(cancellationMessages[0].payload.minimumAuthorizationEpoch, Number.MAX_SAFE_INTEGER);

    const latePageCancellation = await dispatchRuntimeMessage(listener, {
      type: "CANCEL_PENDING_ACTIONS",
      payload: {
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: "espn-producer-session-old",
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
    assert.equal(sessionStorage.get("draftForgeActionBindingV2").tabId, newEspnTabId);
    assert.equal(sessionStorage.get("draftForgeActionBindingV2").producerSessionId, "espn-producer-session-new");

    const replacementHeartbeat = await dispatchRuntimeMessage(listener, {
      type: "WRITER_HEARTBEAT",
      payload: {
        transitionRequestId: "replacement-heartbeat",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: "espn-producer-session-new",
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: newEspnTabId,
      },
    }, sender);
    assert.equal(replacementHeartbeat.code, "WRITER_LEASE_RENEWED");

    const replacementAction = await dispatchRuntimeMessage(listener, {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: "espn-producer-session-new",
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: newEspnTabId,
        playerId: 54321,
        playerName: "Replacement Player",
        notAfter: Date.now() + 9_000,
        availabilityNotAfter: Date.now() + 9_000,
      },
    }, sender);
    assert.equal(replacementAction.code, "PLAYER_SELECTED", "the replacement generation does not inherit the prior generation's MAX authorization floor");
    assert.equal(newExecuteMessages.length, 1, "the replacement exact tab receives one ESPN dispatch");
    assert.equal(newExecuteMessages[0].payload.expectedTabId, newEspnTabId);
    assert.equal(newExecuteMessages[0].payload.authorizationEpoch, 0);
    assert.equal(oldActionClicked, false, "authorizing the replacement never restores the revoked old actuator");

    rejectNewRevocation = true;
    const transitionRevocation = await dispatchRuntimeMessage(listener, {
      type: "REVOKE_ACTION_BINDING",
      payload: {
        transitionRequestId: "preview-transition-1",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: "espn-producer-session-new",
        expectedTeamId: 5,
        expectedTabId: newEspnTabId,
        minimumAuthorizationEpoch: 1,
      },
    }, sender);
    assert.deepEqual(transitionRevocation, {
      ok: true,
      code: "ACTION_BINDING_REVOKED",
      transitionRequestId: "preview-transition-1",
      revokedTabId: newEspnTabId,
      revokedLeagueId: "701",
      revokedTeamId: 5,
      minimumAuthorizationEpoch: 1,
    });
    assert.deepEqual(reloadedTabIds, [newEspnTabId], "a living ESPN tab is force-reloaded when content cannot ACK revocation");
    assert.equal(sessionStorage.has("draftForgeActionBindingV2"), false, "the transition clears persisted authority only after revocation");
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("same-tab ESPN producer replacement rebinds without reloading and permanently rejects stale producer actions", async () => {
  const appTabId = 130;
  const espnTabId = 140;
  const sessionId = "same-tab-producer-reconnect-session";
  const producerOne = "espn-producer-session-p1";
  const producerTwo = "espn-producer-session-p2";
  const appTab = { id: appTabId, url: "http://127.0.0.1:3000/", windowId: 1 };
  const espnTab = {
    id: espnTabId,
    url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026",
    windowId: 1,
  };
  let currentProducer = producerOne;
  const context = () => ({
    leagueId: "701",
    teamId: 5,
    season: 2026,
    producerSessionId: currentProducer,
    inDraftRoom: true,
  });
  const binding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: espnTabId,
    appTabId,
    producerSessionId: producerOne,
    commandCenterSessionId: sessionId,
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", binding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const cancelMessages = [];
  const executeMessages = [];
  const reloadedTabs = [];
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
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, structuredClone(value)); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return appTab;
        if (tabId === espnTabId) return espnTab;
        throw new Error("tab not found");
      },
      async query(query) {
        return query?.url === "https://fantasy.espn.com/*" ? [espnTab] : [appTab, espnTab];
      },
      async sendMessage(tabId, message) {
        if (tabId === espnTabId && message.type === "DF_GET_CONTEXT") return context();
        if (tabId === espnTabId && message.type === "DF_CANCEL_PENDING_ACTIONS") {
          cancelMessages.push(structuredClone(message));
          return message.payload?.expectedProducerSessionId !== currentProducer
            ? { ok: false, code: "ACTION_AUTHORIZATION_PRODUCER_CHANGED" }
            : { ok: true, code: "ACTION_AUTHORIZATION_REVOKED" };
        }
        if (tabId === espnTabId && message.type === "DF_EXECUTE_ACTION") {
          executeMessages.push(structuredClone(message));
          return { ok: true, code: "PLAYER_SELECTED", clicked: true };
        }
        return { ok: true };
      },
      reload: async (tabId) => { reloadedTabs.push(tabId); },
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };

  try {
    await import(`${backgroundUrl.href}?same-tab-producer-reconnect=${process.hrtime.bigint()}`);
    await new Promise((resolve) => setImmediate(resolve));
    const sender = { url: appTab.url, tab: appTab };
    await establishExactWriterLease(listeners[0], sender, sessionId);
    currentProducer = producerTwo;

    const rebound = await dispatchRuntimeMessage(listeners[0], {
      type: "REFRESH_ESPN_CONTEXT",
      payload: {
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: producerOne,
        expectedTeamId: 5,
        expectedTabId: espnTabId,
      },
    }, sender);
    assert.equal(rebound.ok, true);
    assert.equal(rebound.rebound, true);
    assert.equal(rebound.previousTabId, espnTabId);
    assert.equal(rebound.context.producerSessionId, producerTwo);
    assert.equal(cancelMessages.length, 1);
    assert.equal(cancelMessages[0].payload.expectedProducerSessionId, producerOne);
    assert.deepEqual(reloadedTabs, [], "a verified new producer document already destroyed every P1 closure");
    assert.equal(sessionStorage.get("draftForgeActionBindingV2").producerSessionId, producerTwo);

    const heartbeat = await dispatchRuntimeMessage(listeners[0], {
      type: "WRITER_HEARTBEAT",
      payload: {
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: producerTwo,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        transitionRequestId: "p2-heartbeat",
      },
    }, sender);
    assert.equal(heartbeat.code, "WRITER_LEASE_RENEWED");

    const newAction = await dispatchRuntimeMessage(listeners[0], {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: producerTwo,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 22222,
        playerName: "P2 Player",
        notAfter: Date.now() + 9_000,
        availabilityNotAfter: Date.now() + 9_000,
      },
    }, sender);
    assert.equal(newAction.code, "PLAYER_SELECTED");
    assert.equal(executeMessages.length, 1);
    assert.equal(executeMessages[0].payload.expectedProducerSessionId, producerTwo);

    const staleAction = await dispatchRuntimeMessage(listeners[0], {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: producerOne,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 11111,
        playerName: "Stale P1 Player",
        notAfter: Date.now() + 9_000,
        availabilityNotAfter: Date.now() + 9_000,
      },
    }, sender);
    assert.equal(staleAction.ok, false);
    assert.equal(staleAction.code, "DRAFT_ACTION_IDENTITY_CHANGED");
    assert.equal(executeMessages.length, 1, "stale P1 authority never reaches the P2 content document");
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
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    commandCenterSessionId: sessionId,
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
  };
  const context = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    inDraftRoom: true,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", binding],
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
    const sender = { url: "http://127.0.0.1:3000/", tab: { id: appTabId, url: "http://127.0.0.1:3000/" } };
    await establishExactWriterLease(listeners[0], sender, sessionId);
    const now = Date.now();
    const result = await dispatchRuntimeMessage(listeners[0], {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 12345,
        playerName: "Exact Player",
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, sender);
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

test("an expired exact writer lease cannot be renewed or used until an explicit recovery handshake", async () => {
  const appTabId = 410;
  const espnTabId = 420;
  const sessionId = "expired-writer-lease-session";
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
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    inDraftRoom: true,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", {
      leagueId: "701",
      teamId: 5,
      season: 2026,
      tabId: espnTabId,
      appTabId,
      producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
      commandCenterSessionId: sessionId,
      commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
    }],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const executeMessages = [];
  let now = Date.parse("2026-08-29T15:00:00.000Z");
  const previousNow = Date.now;
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  Date.now = () => now;
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
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, structuredClone(value)); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return appTab;
        if (tabId === espnTabId) return espnTab;
        throw new Error("tab not found");
      },
      async query(query) {
        if (query?.url === "https://fantasy.espn.com/*") return [espnTab];
        return [appTab, espnTab];
      },
      async sendMessage(tabId, message) {
        if (tabId === espnTabId && message.type === "DF_GET_CONTEXT") return context;
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
      onUpdated: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };

  try {
    await import(`${backgroundUrl.href}?expired-writer-lease=${process.hrtime.bigint()}`);
    const listener = listeners[0];
    const sender = { url: appTab.url, tab: appTab };
    const heartbeatPayload = {
      commandCenterSessionId: sessionId,
      commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
      expectedLeagueId: "701",
      expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
      expectedTeamId: 5,
      expectedSeason: 2026,
      expectedTabId: espnTabId,
    };

    await establishExactWriterLease(listener, sender, sessionId);
    const initialHeartbeat = await dispatchRuntimeMessage(listener, {
      type: "WRITER_HEARTBEAT",
      payload: { ...heartbeatPayload, transitionRequestId: "initial-heartbeat" },
    }, sender);
    assert.equal(initialHeartbeat.code, "WRITER_LEASE_RENEWED");
    assert.equal(initialHeartbeat.expiresAt, now + 1_500);

    now = initialHeartbeat.expiresAt;
    const expiredHeartbeat = await dispatchRuntimeMessage(listener, {
      type: "WRITER_HEARTBEAT",
      payload: { ...heartbeatPayload, transitionRequestId: "expired-heartbeat" },
    }, sender);
    assert.deepEqual(expiredHeartbeat, {
      ok: false,
      code: "WRITER_LEASE_EXPIRED",
      transitionRequestId: "expired-heartbeat",
    });

    const action = await dispatchRuntimeMessage(listener, {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        authorizationEpoch: 0,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        playerId: 12345,
        playerName: "Exact Player",
        notAfter: now + 9_000,
        availabilityNotAfter: now + 9_000,
      },
    }, sender);
    assert.equal(action.code, "WRITER_LEASE_EXPIRED");
    assert.equal(executeMessages.length, 0, "an expired lease never dispatches DF_EXECUTE_ACTION");

    const stillExpired = await dispatchRuntimeMessage(listener, {
      type: "WRITER_HEARTBEAT",
      payload: { ...heartbeatPayload, transitionRequestId: "heartbeat-after-action" },
    }, sender);
    assert.equal(stillExpired.code, "WRITER_LEASE_EXPIRED", "heartbeat and action traffic cannot resurrect the expired lease");

    await establishExactWriterLease(listener, sender, sessionId);
    const recoveredHeartbeat = await dispatchRuntimeMessage(listener, {
      type: "WRITER_HEARTBEAT",
      payload: { ...heartbeatPayload, transitionRequestId: "recovered-heartbeat" },
    }, sender);
    assert.equal(recoveredHeartbeat.code, "WRITER_LEASE_RENEWED");
    assert.equal(recoveredHeartbeat.expiresAt, now + 1_500, "the explicit exact recovery handshake establishes a fresh lease");
  } finally {
    Date.now = previousNow;
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("a cold APP_HELLO mints its writer lease only after delayed runtime diagnostics", async () => {
  const appTabId = 610;
  const espnTabId = 620;
  const sessionId = "cold-app-hello-session";
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
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    inDraftRoom: true,
  };
  const binding = {
    ...context,
    tabId: espnTabId,
    appTabId,
    commandCenterSessionId: sessionId,
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
  };
  delete binding.inDraftRoom;
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", binding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  let now = Date.parse("2026-08-29T16:00:00.000Z");
  let emptyQueryCount = 0;
  const previousNow = Date.now;
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  Date.now = () => now;
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
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, structuredClone(value)); },
        async remove(key) { sessionStorage.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return appTab;
        if (tabId === espnTabId) return espnTab;
        throw new Error("tab not found");
      },
      async query(query = {}) {
        if (Object.keys(query).length === 0) {
          emptyQueryCount += 1;
          if (emptyQueryCount === 2) now += 1_601;
        }
        return query?.url === "https://fantasy.espn.com/*" ? [espnTab] : [appTab, espnTab];
      },
      async sendMessage(tabId, message) {
        if (tabId === espnTabId && message.type === "DF_GET_CONTEXT") return context;
        return { ok: true };
      },
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };

  try {
    await import(`${backgroundUrl.href}?cold-app-hello=${process.hrtime.bigint()}`);
    await new Promise((resolve) => setImmediate(resolve));
    const sender = { url: appTab.url, tab: appTab };
    const hello = await dispatchRuntimeMessage(listeners[0], {
      type: "APP_HELLO",
      payload: {
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
      },
    }, sender);
    assert.equal(emptyQueryCount, 2);
    assert.equal(hello.writerLeaseEstablished, true);

    const heartbeat = await dispatchRuntimeMessage(listeners[0], {
      type: "WRITER_HEARTBEAT",
      payload: {
        commandCenterSessionId: sessionId,
        commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
        expectedLeagueId: "701",
        expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
        expectedTeamId: 5,
        expectedSeason: 2026,
        expectedTabId: espnTabId,
        transitionRequestId: "cold-app-hello-first-heartbeat",
      },
    }, sender);
    assert.equal(heartbeat.code, "WRITER_LEASE_RENEWED");
    assert.equal(heartbeat.transitionRequestId, "cold-app-hello-first-heartbeat");
    assert.equal(heartbeat.expiresAt, now + 1_500, "the first heartbeat extends a post-diagnostics lease");
  } finally {
    Date.now = previousNow;
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("a deferred binding-storage removal cannot resurrect revoked live authority", async () => {
  const appTabId = 510;
  const espnTabId = 520;
  const sessionId = "deferred-binding-removal-session";
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
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    inDraftRoom: true,
  };
  const binding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: espnTabId,
    appTabId,
    producerSessionId: DEFAULT_PRODUCER_SESSION_ID,
    commandCenterSessionId: sessionId,
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
  };
  const sessionStorage = new Map([
    ["draftForgeActionBindingV2", binding],
    ["draftForgeWorkspaceWriterV1", appTabId],
  ]);
  const localStorage = new Map();
  const listeners = [];
  const executeMessages = [];
  let markBindingRemoveStarted;
  let releaseBindingRemove;
  let bindingRemoveReleased = false;
  const bindingRemoveStarted = new Promise((resolve) => { markBindingRemoveStarted = resolve; });
  const bindingRemoveGate = new Promise((resolve) => {
    releaseBindingRemove = () => {
      bindingRemoveReleased = true;
      resolve();
    };
  });
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
        async set(entries) { for (const [key, value] of Object.entries(entries)) sessionStorage.set(key, structuredClone(value)); },
        async remove(key) {
          if (key === "draftForgeActionBindingV2") {
            markBindingRemoveStarted();
            await bindingRemoveGate;
          }
          sessionStorage.delete(key);
        },
      },
    },
    tabs: {
      async get(tabId) {
        if (tabId === appTabId) return appTab;
        if (tabId === espnTabId) return espnTab;
        throw new Error("tab not found");
      },
      async query(query) {
        if (query?.url === "https://fantasy.espn.com/*") return [espnTab];
        return [appTab, espnTab];
      },
      async sendMessage(tabId, message) {
        if (tabId === espnTabId && message.type === "DF_GET_CONTEXT") return context;
        if (tabId === espnTabId && message.type === "DF_CANCEL_PENDING_ACTIONS") {
          return { ok: true, code: "ACTION_AUTHORIZATION_REVOKED" };
        }
        if (tabId === espnTabId && message.type === "DF_EXECUTE_ACTION") {
          executeMessages.push(message);
          return { ok: true, code: "UNEXPECTED_EXECUTION", clicked: true };
        }
        return { ok: true };
      },
      reload: async () => {},
      remove: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };

  try {
    await import(`${backgroundUrl.href}?deferred-binding-removal=${process.hrtime.bigint()}`);
    const listener = listeners[0];
    const sender = { url: appTab.url, tab: appTab };
    const exactPayload = {
      commandCenterSessionId: sessionId,
      commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
      expectedLeagueId: "701",
      expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
      expectedTeamId: 5,
      expectedSeason: 2026,
      expectedTabId: espnTabId,
    };
    await establishExactWriterLease(listener, sender, sessionId);

    const revocationPromise = dispatchRuntimeMessage(listener, {
      type: "REVOKE_ACTION_BINDING",
      payload: {
        ...exactPayload,
        transitionRequestId: "deferred-removal-revocation",
        minimumAuthorizationEpoch: 1,
      },
    }, sender);
    await bindingRemoveStarted;
    assert.deepEqual(sessionStorage.get("draftForgeActionBindingV2"), binding, "the deferred remove leaves the stale startup record observable during the race");

    let overlappingHeartbeatSettled = false;
    const overlappingHeartbeatPromise = dispatchRuntimeMessage(listener, {
      type: "WRITER_HEARTBEAT",
      payload: { ...exactPayload, transitionRequestId: "overlapping-heartbeat" },
    }, sender).then((result) => {
      overlappingHeartbeatSettled = true;
      return result;
    });
    for (let turn = 0; turn < 12 && !overlappingHeartbeatSettled; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const settledBeforeRemoval = overlappingHeartbeatSettled;

    // If ensureActionBinding re-reads the stale session record, this exact
    // handshake would mint a fresh lease for authority already cleared in
    // memory. A serialized, startup-only restore makes the handshake wait for
    // the clear and then observe no binding.
    const overlappingHelloPromise = establishExactWriterLease(listener, sender, sessionId);
    releaseBindingRemove();
    const [revocation, overlappingHeartbeat, overlappingHello] = await Promise.all([
      revocationPromise,
      overlappingHeartbeatPromise,
      overlappingHelloPromise,
    ]);
    assert.equal(bindingRemoveReleased, true);
    assert.equal(settledBeforeRemoval, false, "ensureActionBinding waits for the in-flight clear instead of re-reading stale storage");
    assert.equal(revocation.code, "ACTION_BINDING_REVOKED");
    assert.equal(overlappingHeartbeat.code, "WRITER_LEASE_BINDING_MISMATCH");
    assert.equal(overlappingHello.ready, true);
    assert.equal(sessionStorage.has("draftForgeActionBindingV2"), false);

    const action = await dispatchRuntimeMessage(listener, {
      type: "SUBMIT_ACTION",
      payload: {
        operation: "SELECT",
        ...exactPayload,
        authorizationEpoch: 0,
        playerId: 12345,
        playerName: "Revoked Player",
        notAfter: Date.now() + 9_000,
        availabilityNotAfter: Date.now() + 9_000,
      },
    }, sender);
    assert.equal(action.code, "DRAFT_BINDING_REQUIRED");
    assert.equal(executeMessages.length, 0, "stale storage never restores, leases, or dispatches the revoked binding");
  } finally {
    if (!bindingRemoveReleased) releaseBindingRemove();
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
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
    commandCenterDocumentId: DEFAULT_COMMAND_CENTER_DOCUMENT_ID,
    authorizationEpoch: 0,
    expectedLeagueId: "701",
    expectedProducerSessionId: DEFAULT_PRODUCER_SESSION_ID,
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
      commandCenterDocumentId: action.commandCenterDocumentId,
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
