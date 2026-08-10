import assert from "node:assert/strict";
import test from "node:test";
import { profileForEspnRoom, upsertDraftProfile } from "../app/lib/profiles.ts";

function profile(id, name, playerId) {
  return {
    league: { id, name },
    espnPlayers: [{ id: playerId, name: `Player ${playerId}` }],
    picks: [{ playerId, teamId: 1, overall: 1, round: 1, amount: 0 }],
    settingsConfirmed: true,
    strategy: id === "111" ? "HERO_RB" : "ZERO_RB",
    savedAt: "2026-08-10T00:00:00.000Z",
  };
}

test("two ESPN leagues retain isolated settings, picks, players, and strategy", () => {
  const first = profile("111", "Tuesday League", 1);
  const second = profile("222", "Saturday League", 2);
  const profiles = upsertDraftProfile(upsertDraftProfile({}, first), second);
  assert.deepEqual(profileForEspnRoom(profiles, 111), first);
  assert.deepEqual(profileForEspnRoom(profiles, "222"), second);
  assert.notDeepEqual(profiles["111"].picks, profiles["222"].picks);
  assert.notEqual(profiles["111"].strategy, profiles["222"].strategy);
});
