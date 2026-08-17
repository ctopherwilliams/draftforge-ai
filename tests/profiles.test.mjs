import assert from "node:assert/strict";
import test from "node:test";
import {
  compactDraftProfiles,
  MAX_PERSISTED_DRAFT_PROFILES,
  persistDraftProfiles,
  profileForEspnRoom,
  upsertDraftProfile,
} from "../app/lib/profiles.ts";

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

test("repeated ESPN practice rooms keep a bounded cache and preserve stable leagues", () => {
  let profiles = {};
  profiles = upsertDraftProfile(profiles, profile("111", "Tuesday League", 1));
  profiles = upsertDraftProfile(profiles, profile("222", "Saturday League", 2));
  for (let index = 0; index < 12; index += 1) {
    profiles = upsertDraftProfile(profiles, {
      ...profile(String(1000 + index), "Practice Draft for Tuesday League", 100 + index),
      savedAt: `2026-08-12T00:${String(index).padStart(2, "0")}:00.000Z`,
    });
  }
  assert.ok(Object.keys(profiles).length <= MAX_PERSISTED_DRAFT_PROFILES);
  assert.ok(profiles["111"]);
  assert.ok(profiles["222"]);
  assert.ok(profiles["1011"]);
  assert.deepEqual(compactDraftProfiles(profiles), profiles);
});

test("a storage quota failure cannot crash the draft cockpit", () => {
  const writes = [];
  let attempts = 0;
  const storage = {
    removeItem(key) { writes.push(["remove", key]); },
    setItem(key, value) {
      attempts += 1;
      if (attempts === 1) throw new DOMException("quota", "QuotaExceededError");
      writes.push(["set", key, value]);
    },
  };
  const profiles = { "111": profile("111", "Tuesday League", 1) };
  assert.doesNotThrow(() => persistDraftProfiles(storage, "draftforge-leagues-v1", profiles));
  assert.equal(writes[0][0], "remove");
  assert.equal(JSON.parse(writes[1][2])["111"].league.name, "Tuesday League");
});
