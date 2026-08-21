import test from "node:test";
import assert from "node:assert/strict";
import { recoverExactDraftRoomContext } from "../extension/recovery-context.js";

test("live recovery reuses one exact healthy room without reloading it", async () => {
  const exact = { leagueId: "room-1", teamId: 6, tabId: 41, inDraftRoom: true };
  let reloads = 0;
  let waits = 0;

  const result = await recoverExactDraftRoomContext({
    draftLeagueId: "room-1",
    teamId: 6,
    roomTabId: 41,
    findContext: async () => exact,
    reloadTab: async () => { reloads += 1; },
    waitForContext: async () => { waits += 1; return null; },
  });

  assert.deepEqual(result, { context: exact, reloadedRoom: false });
  assert.equal(reloads, 0);
  assert.equal(waits, 0);
});

test("live recovery reloads and waits when the existing context is not exact", async () => {
  const recovered = { leagueId: "room-1", teamId: 6, tabId: 41, inDraftRoom: true };
  const calls = [];

  const result = await recoverExactDraftRoomContext({
    draftLeagueId: "room-1",
    teamId: 6,
    roomTabId: 41,
    findContext: async () => ({ leagueId: "room-1", teamId: 7, tabId: 41, inDraftRoom: true }),
    reloadTab: async (tabId) => { calls.push(["reload", tabId]); },
    waitForContext: async (...args) => { calls.push(["wait", ...args]); return recovered; },
  });

  assert.deepEqual(result, { context: recovered, reloadedRoom: true });
  assert.deepEqual(calls, [
    ["reload", 41],
    ["wait", "room-1", 6, 41],
  ]);
});

test("live recovery keeps the fail-closed reload path after a context read error", async () => {
  let reloads = 0;
  const result = await recoverExactDraftRoomContext({
    draftLeagueId: "room-1",
    teamId: 6,
    roomTabId: 41,
    findContext: async () => { throw new Error("disconnected"); },
    reloadTab: async () => { reloads += 1; },
    waitForContext: async () => null,
  });

  assert.deepEqual(result, { context: null, reloadedRoom: true });
  assert.equal(reloads, 1);
});
