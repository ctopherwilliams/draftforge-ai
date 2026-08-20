import assert from "node:assert/strict";
import test from "node:test";
import { selectRecoveryWorkspace } from "../extension/recovery-targets.js";

const APP_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

test("live workspace recovery selects one exact room and only owned stale tabs", () => {
  const result = selectRecoveryWorkspace([
    { id: 1, url: "http://127.0.0.1:3000/" },
    { id: 2, url: "http://localhost:3000/" },
    { id: 3, url: "https://fantasy.espn.com/football/team?leagueId=44050&teamId=7&seasonId=2026" },
    { id: 4, url: "https://fantasy.espn.com/football/draft?leagueId=777573388&teamId=7&seasonId=2026" },
    { id: 5, url: "https://fantasy.espn.com/football/team?leagueId=44050&teamId=8&seasonId=2026" },
    { id: 6, url: "https://fantasy.espn.com/football/team?leagueId=999&teamId=7&seasonId=2026" },
    { id: 7, url: "https://example.com/" },
  ], {
    appTabId: 1,
    draftLeagueId: "777573388",
    sourceLeagueId: "44050",
    teamId: 7,
    season: 2026,
    appOrigins: APP_ORIGINS,
  });
  assert.deepEqual(result, { ok: true, roomTabId: 4, staleAppTabIds: [2], sourceLeagueTabIds: [3] });
});

test("live workspace recovery fails closed on missing, ambiguous, or malformed targets", () => {
  const input = { appTabId: 1, draftLeagueId: "777", sourceLeagueId: "44050", teamId: 7, season: 2026, appOrigins: APP_ORIGINS };
  assert.equal(selectRecoveryWorkspace([], input).code, "RECOVERY_ROOM_NOT_FOUND");
  const room = { id: 4, url: "https://fantasy.espn.com/football/draft?leagueId=777&teamId=7&seasonId=2026" };
  assert.equal(selectRecoveryWorkspace([room, { ...room, id: 5 }], input).code, "RECOVERY_ROOM_AMBIGUOUS");
  assert.equal(selectRecoveryWorkspace([room], { ...input, draftLeagueId: "not-a-number" }).code, "RECOVERY_TARGET_INVALID");
});
