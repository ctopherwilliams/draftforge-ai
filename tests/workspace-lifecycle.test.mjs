import assert from "node:assert/strict";
import test from "node:test";
import {
  completedAuditProvesPracticeRoom,
  practiceWorkspaceCleanupTabIds,
  selectManagedWorkspaceCleanup,
} from "../extension/workspace-lifecycle.js";

const APP_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

test("newest DraftForge dashboard becomes leader and only exact owned tabs are selected", () => {
  const result = selectManagedWorkspaceCleanup([
    { id: 10, url: "http://localhost:3000/", lastAccessed: 100 },
    { id: 11, url: "http://127.0.0.1:3000/", lastAccessed: 200 },
    { id: 12, url: "about:blank", lastAccessed: 300 },
    { id: 13, url: "about:blank", lastAccessed: 400 },
    { id: 14, url: "https://fantasy.espn.com/football/draft?leagueId=777", lastAccessed: 500 },
    { id: 15, url: "https://mail.google.com/", lastAccessed: 600 },
  ], {
    senderTabId: 11,
    appOrigins: APP_ORIGINS,
    ownedBlankTabIds: [12],
    electNewest: true,
  });
  assert.deepEqual(result, {
    ok: true,
    code: "LOCAL_WORKSPACE_CLEAN",
    leaderTabId: 11,
    cleanupTabIds: [10, 12],
  });
});

test("stale DraftForge dashboard stands by instead of closing the elected leader", () => {
  const result = selectManagedWorkspaceCleanup([
    { id: 10, url: "http://localhost:3000/", lastAccessed: 100 },
    { id: 11, url: "http://127.0.0.1:3000/", lastAccessed: 200 },
  ], {
    senderTabId: 10,
    appOrigins: APP_ORIGINS,
    electNewest: true,
  });
  assert.deepEqual(result, {
    ok: true,
    code: "LOCAL_WORKSPACE_STANDBY",
    leaderTabId: 11,
    cleanupTabIds: [],
  });
});

test("managed cleanup fails closed for a non-DraftForge sender", () => {
  const result = selectManagedWorkspaceCleanup([
    { id: 10, url: "http://localhost:3000/", lastAccessed: 100 },
    { id: 11, url: "https://example.com/", lastAccessed: 200 },
  ], {
    senderTabId: 11,
    appOrigins: APP_ORIGINS,
    electNewest: true,
  });
  assert.deepEqual(result, { ok: false, code: "LOCAL_WORKSPACE_SENDER_MISMATCH" });
});

test("completed audit proof binds an exact generated practice room", () => {
  const proof = { leagueId: "777", teamId: 7, tabId: 44, finalReady: true, parity: true, autoDraftOff: true };
  assert.equal(completedAuditProvesPracticeRoom({
    proof,
    draftLeagueId: "777",
    sourceLeagueId: "44050",
    teamId: 7,
    roomTabId: 44,
  }), true);
  assert.equal(completedAuditProvesPracticeRoom({
    proof,
    draftLeagueId: "777",
    sourceLeagueId: "777",
    teamId: 7,
    roomTabId: 44,
  }), false);
  assert.equal(completedAuditProvesPracticeRoom({
    proof: { ...proof, parity: false },
    draftLeagueId: "777",
    sourceLeagueId: "44050",
    teamId: 7,
    roomTabId: 44,
  }), false);
});

test("finalized practice cleanup includes only exact room, stale dashboard, and source league", () => {
  assert.deepEqual(practiceWorkspaceCleanupTabIds({
    roomTabId: 44,
    staleAppTabIds: [10, 11],
    sourceLeagueTabIds: [22],
  }, 11), [44, 10, 22]);
});
