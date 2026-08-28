import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeWorkspaceMessage,
  completedAuditProvesPracticeRoom,
  practiceWorkspaceCleanupTabIds,
  resolveWorkspaceRole,
  resolveWorkspaceWriterTabId,
  selectManagedWorkspaceCleanup,
} from "../extension/workspace-lifecycle.js";
import { tabRemovalInvalidatesActionBinding } from "../extension/action-binding.js";

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

test("a bound writer cannot be displaced by observer open, poll, mutation, or close", () => {
  const actionBinding = Object.freeze({
    leagueId: "44050",
    teamId: 7,
    season: 2026,
    tabId: 41,
    appTabId: 17,
    commandCenterSessionId: "writer-session",
  });
  const authority = { actionBinding, liveRoomWatch: null, writerAppTabId: 99 };

  assert.equal(resolveWorkspaceWriterTabId(authority), 17, "the exact action binding outranks every newer tab or stale lease");
  assert.deepEqual(resolveWorkspaceRole(authority, 17), {
    ok: true,
    code: "WORKSPACE_WRITER",
    role: "writer",
    writerTabId: 17,
  });
  assert.deepEqual(resolveWorkspaceRole(authority, 99), {
    ok: true,
    code: "WORKSPACE_OBSERVER",
    role: "observer",
    writerTabId: 17,
  });

  for (const messageType of ["APP_HELLO", "GET_RUNTIME_DIAGNOSTICS"]) {
    assert.equal(authorizeWorkspaceMessage(authority, 99, messageType).ok, true, `${messageType} remains read-only`);
  }
  for (const messageType of [
    "SUBMIT_ACTION",
    "CONNECT_ESPN",
    "RECOVER_LIVE_WORKSPACE",
    "CLEAN_LOCAL_WORKSPACE",
    "CLOSE_PRACTICE_ROOM",
    "ARM_LIVE_ROOM_WATCH",
    "REFRESH_ESPN_CONTEXT",
    "DISABLE_ESPN_AUTOPICK",
    "RELOAD_EXTENSION",
  ]) {
    assert.deepEqual(authorizeWorkspaceMessage(authority, 99, messageType), {
      ok: false,
      code: "WORKSPACE_OBSERVER_READ_ONLY",
      role: "observer",
      writerTabId: 17,
    }, `${messageType} cannot cross the observer boundary`);
  }

  assert.equal(tabRemovalInvalidatesActionBinding(actionBinding, 99), false, "closing an observer preserves the writer binding");
  assert.equal(tabRemovalInvalidatesActionBinding(actionBinding, 17), true, "only closing the exact writer revokes authority");
  assert.equal(actionBinding.appTabId, 17, "all observer operations leave the immutable binding unchanged");
});

test("an observer cannot use workspace cleanup to close the protected writer", () => {
  const result = selectManagedWorkspaceCleanup([
    { id: 17, url: "http://127.0.0.1:3000/", lastAccessed: 100 },
    { id: 99, url: "http://127.0.0.1:3000/", lastAccessed: 900 },
    { id: 101, url: "about:blank", lastAccessed: 1000 },
  ], {
    senderTabId: 99,
    appOrigins: APP_ORIGINS,
    ownedBlankTabIds: [101],
    protectedWriterTabId: 17,
  });
  assert.deepEqual(result, {
    ok: false,
    code: "WORKSPACE_OBSERVER_READ_ONLY",
    role: "observer",
    writerTabId: 17,
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
