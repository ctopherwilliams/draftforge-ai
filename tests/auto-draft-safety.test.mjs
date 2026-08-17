import assert from "node:assert/strict";
import test from "node:test";
import { canArmAutoDraft } from "../app/lib/auto-draft-safety.ts";

const exactRoom = { inDraftRoom: true, leagueId: "701", teamId: 7, tabId: 41 };
const ready = {
  checklistReady: true,
  extensionConnected: true,
  context: exactRoom,
  leagueId: "701",
  teamId: 7,
  tabId: 41,
};

test("Auto-Draft can arm only against the current exact ESPN room", () => {
  assert.equal(canArmAutoDraft(ready), true);
  assert.equal(canArmAutoDraft({ ...ready, checklistReady: false }), false);
  assert.equal(canArmAutoDraft({ ...ready, extensionConnected: false }), false);
  assert.equal(canArmAutoDraft({ ...ready, context: { ...exactRoom, tabId: 42 } }), false);
  assert.equal(canArmAutoDraft({ ...ready, context: { ...exactRoom, leagueId: "702" } }), false);
  assert.equal(canArmAutoDraft({ ...ready, context: { ...exactRoom, teamId: 8 } }), false);
  assert.equal(canArmAutoDraft({ ...ready, context: { ...exactRoom, inDraftRoom: false } }), false);
});
