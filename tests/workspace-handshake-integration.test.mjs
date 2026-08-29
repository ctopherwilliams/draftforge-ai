import assert from "node:assert/strict";
import test from "node:test";

const backgroundUrl = new URL("../extension/background.js", import.meta.url);

function dispatch(listener, message, sender) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message.type} timed out`)), 1_500);
    listener(message, sender, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function loadBackground({ tabs, stored = new Map(), context = null }) {
  const listeners = [];
  const removed = [];
  const remaining = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
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
        async get(key) { return { [key]: stored.get(key) }; },
        async set(entries) { for (const [key, value] of Object.entries(entries)) stored.set(key, value); },
        async remove(key) { stored.delete(key); },
      },
    },
    tabs: {
      async get(tabId) {
        const tab = remaining.get(Number(tabId));
        if (!tab) throw new Error("tab not found");
        return { ...tab };
      },
      async query(query = {}) {
        const all = [...remaining.values()].map((tab) => ({ ...tab }));
        return query.url ? all.filter((tab) => tab.url.startsWith("https://fantasy.espn.com/")) : all;
      },
      async sendMessage(tabId, message) {
        if (message.type === "DF_GET_CONTEXT" && Number(tabId) === 20 && context) return { ...context };
        if (message.type === "DF_CANCEL_PENDING_ACTIONS") return { ok: true, code: "ACTION_AUTHORIZATION_REVOKED" };
        return { ok: true };
      },
      async remove(tabIds) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          if (!remaining.has(Number(tabId))) continue;
          removed.push(Number(tabId));
          remaining.delete(Number(tabId));
        }
      },
      reload: async () => {},
      update: async () => {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    windows: { create: async () => ({ id: 2 }), update: async () => {} },
  };
  await import(`${backgroundUrl.href}?workspace-handshake=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    listener: listeners[0],
    removed,
    remaining,
    stored,
    restore() {
      globalThis.chrome = previousChrome;
      globalThis.fetch = previousFetch;
    },
  };
}

const appSender = (id) => ({
  url: "http://127.0.0.1:3000/",
  tab: { id, url: "http://127.0.0.1:3000/" },
});

test("concurrent pre-live handshakes elect the newest local DraftForge tab and clean only duplicates", async () => {
  const fixture = await loadBackground({
    tabs: [
      { id: 10, url: "http://127.0.0.1:3000/", lastAccessed: 100, windowId: 1 },
      { id: 11, url: "http://127.0.0.1:3000/", lastAccessed: 200, windowId: 1 },
      { id: 20, url: "https://fantasy.espn.com/football/league?leagueId=701", lastAccessed: 300, windowId: 1 },
      { id: 30, url: "https://mail.google.com/", lastAccessed: 400, windowId: 1 },
    ],
  });
  try {
    const [older, newer] = await Promise.all([
      dispatch(fixture.listener, { type: "APP_HELLO", payload: { commandCenterSessionId: "older-session", commandCenterDocumentId: "older-document" } }, appSender(10)),
      dispatch(fixture.listener, { type: "APP_HELLO", payload: { commandCenterSessionId: "newer-session", commandCenterDocumentId: "newer-document" } }, appSender(11)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(older.workspace.writerTabId, 11);
    assert.equal(older.workspace.role, "observer");
    assert.equal(newer.workspace.writerTabId, 11);
    assert.equal(newer.workspace.role, "writer");
    assert.equal(fixture.stored.get("draftForgeWorkspaceWriterV1"), 11);
    assert.deepEqual([...new Set(fixture.removed)], [10]);
    assert.equal(fixture.remaining.has(20), true, "ESPN is never a dashboard cleanup target");
    assert.equal(fixture.remaining.has(30), true, "unrelated tabs are never cleanup targets");
  } finally {
    fixture.restore();
  }
});

test("service-worker restart preserves a bound writer and closes only duplicate local observers", async () => {
  const binding = {
    leagueId: "701",
    teamId: 5,
    season: 2026,
    tabId: 20,
    appTabId: 10,
    commandCenterSessionId: "bound-writer-session",
    commandCenterDocumentId: "bound-writer-document",
    producerSessionId: "bound-espn-producer-session",
  };
  const stored = new Map([
    ["draftForgeActionBindingV2", binding],
    ["draftForgeWorkspaceWriterV1", 11],
  ]);
  const fixture = await loadBackground({
    stored,
    context: {
      leagueId: "701",
      teamId: 5,
      season: 2026,
      inDraftRoom: true,
      producerSessionId: "bound-espn-producer-session",
    },
    tabs: [
      { id: 10, url: "http://127.0.0.1:3000/", lastAccessed: 100, windowId: 1 },
      { id: 11, url: "http://127.0.0.1:3000/", lastAccessed: 900, windowId: 1 },
      { id: 20, url: "https://fantasy.espn.com/football/draft?leagueId=701&teamId=5&seasonId=2026", lastAccessed: 500, windowId: 1 },
      { id: 30, url: "https://example.com/", lastAccessed: 800, windowId: 1 },
    ],
  });
  try {
    const observer = await dispatch(fixture.listener, {
      type: "APP_HELLO",
      payload: { commandCenterSessionId: "observer-session", commandCenterDocumentId: "observer-document" },
    }, appSender(11));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(observer.workspace.writerTabId, 10);
    assert.equal(observer.workspace.role, "observer");
    assert.equal(fixture.stored.get("draftForgeWorkspaceWriterV1"), 10);
    assert.deepEqual(fixture.stored.get("draftForgeActionBindingV2"), binding);
    assert.deepEqual(fixture.removed, [11]);
    assert.equal(fixture.remaining.has(20), true);
    assert.equal(fixture.remaining.has(30), true);
  } finally {
    fixture.restore();
  }
});
