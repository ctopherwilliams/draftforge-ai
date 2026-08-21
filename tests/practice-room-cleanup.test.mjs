import assert from "node:assert/strict";
import test from "node:test";
import {
  canRetryPracticeRoomCleanup,
  MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS,
  resolvePracticeRoomCleanupRequest,
} from "../app/lib/practice-room-cleanup.ts";

function snapshot(overrides = {}) {
  return {
    league: { id: "777", teamId: 7, season: 2026 },
    binding: { tabId: 44 },
    safety: { autoDraft: false },
    ...overrides,
  };
}

test("final audit creates one exact generated-practice cleanup request", () => {
  const result = resolvePracticeRoomCleanupRequest({
    sourceLeagueId: "44050",
    snapshot: snapshot(),
    evaluation: { finalReady: true, parity: true },
    finalizedKey: "",
  });
  assert.deepEqual(result, {
    key: "44050:777:7:44",
    payload: {
      draftLeagueId: "777",
      sourceLeagueId: "44050",
      teamId: 7,
      season: 2026,
      completedAuditProof: {
        leagueId: "777",
        teamId: 7,
        tabId: 44,
        finalReady: true,
        parity: true,
        autoDraftOff: true,
      },
    },
  });
});

test("cleanup request is one-shot for an already finalized room", () => {
  assert.equal(resolvePracticeRoomCleanupRequest({
    sourceLeagueId: "44050",
    snapshot: snapshot(),
    evaluation: { finalReady: true, parity: true },
    finalizedKey: "44050:777:7:44",
  }), null);
});

test("cleanup stays fail closed for a real league, incomplete audit, or active automation", () => {
  const base = { snapshot: snapshot(), evaluation: { finalReady: true, parity: true }, finalizedKey: "" };
  assert.equal(resolvePracticeRoomCleanupRequest({ ...base, sourceLeagueId: "777" }), null);
  assert.equal(resolvePracticeRoomCleanupRequest({ ...base, sourceLeagueId: "44050", evaluation: { finalReady: false, parity: true } }), null);
  assert.equal(resolvePracticeRoomCleanupRequest({ ...base, sourceLeagueId: "44050", snapshot: snapshot({ safety: { autoDraft: true } }) }), null);
});

test("automatic final cleanup retries are bounded", () => {
  assert.equal(MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS, 3);
  assert.equal(canRetryPracticeRoomCleanup(1), true);
  assert.equal(canRetryPracticeRoomCleanup(2), true);
  assert.equal(canRetryPracticeRoomCleanup(3), false);
  assert.equal(canRetryPracticeRoomCleanup(Number.NaN), false);
});
