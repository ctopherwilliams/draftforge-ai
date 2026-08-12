import assert from "node:assert/strict";
import test from "node:test";
import { contextCanRebindDraftTab, contextMatchesActiveDraftTab, contextMatchesActiveLeague } from "../app/lib/espn-context.ts";

test("ESPN context is accepted only for the active imported league", () => {
  assert.equal(contextMatchesActiveLeague({ leagueId: "701" }, "701"), true);
  assert.equal(contextMatchesActiveLeague({ leagueId: "702" }, "701"), false);
  assert.equal(contextMatchesActiveLeague({}, "701"), false);
  assert.equal(contextMatchesActiveLeague(undefined, "701"), false);
});

test("a waiting-room tab may rebind only to the proven live league and team", () => {
  assert.equal(contextCanRebindDraftTab({ leagueId: "701", teamId: 7, tabId: 99, inDraftRoom: true }, "701", 7), true);
  assert.equal(contextCanRebindDraftTab({ leagueId: "701", teamId: 8, tabId: 99, inDraftRoom: true }, "701", 7), false);
  assert.equal(contextCanRebindDraftTab({ leagueId: "702", teamId: 7, tabId: 99, inDraftRoom: true }, "701", 7), false);
  assert.equal(contextCanRebindDraftTab({ leagueId: "701", teamId: 7, tabId: 99, inDraftRoom: false }, "701", 7), false);
});

test("ESPN context must also come from the exact imported draft tab", () => {
  assert.equal(contextMatchesActiveDraftTab({ leagueId: "701", tabId: 45 }, "701", 45), true);
  assert.equal(contextMatchesActiveDraftTab({ leagueId: "701", tabId: 46 }, "701", 45), false);
  assert.equal(contextMatchesActiveDraftTab({ leagueId: "702", tabId: 45 }, "701", 45), false);
  assert.equal(contextMatchesActiveDraftTab({ leagueId: "701" }, "701", 45), false);
  assert.equal(contextMatchesActiveDraftTab({ leagueId: "701", tabId: 45 }, "701", null), false);
});
