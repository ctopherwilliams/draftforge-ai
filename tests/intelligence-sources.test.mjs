import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimitedSourceFetcher, fetchSourcePayloadsSequentially } from "../app/lib/intelligence-sources.ts";
import {
  intelligenceSnapshotCacheKey,
  isCompleteFreshIntelligenceSnapshot,
  preserveCompleteFreshIntelligenceSnapshot,
  readCompleteFreshIntelligenceSnapshot,
  rememberCompleteFreshIntelligenceSnapshot,
} from "../app/lib/consensus.ts";

function source(id, overrides = {}) {
  return {
    id,
    name: id,
    kind: id === "ffc" || id === "mfl" ? "market" : id === "tradyr" ? "composite" : "model",
    weight: .2,
    status: "ok",
    updatedAt: "2026-08-15T07:00:00.000Z",
    retrievedAt: "2026-08-15T07:00:00.000Z",
    attribution: id,
    players: [{ name: `${id} player`, team: "TST", pos: "RB", rank: 1 }],
    ...overrides,
  };
}

const evaluatedAt = "2026-08-15T08:00:00.000Z";
const completeSnapshot = [source("ffc"), source("mfl"), source("tradyr"), source("gng")];

test("a decision-time intelligence snapshot requires every distinct fresh source", () => {
  assert.equal(isCompleteFreshIntelligenceSnapshot(completeSnapshot, evaluatedAt), true);
  assert.equal(isCompleteFreshIntelligenceSnapshot(completeSnapshot.slice(0, 3), evaluatedAt), false);
  assert.equal(isCompleteFreshIntelligenceSnapshot([
    source("ffc"), source("mfl"), source("tradyr"), source("tradyr"),
  ], evaluatedAt), false);
  assert.equal(isCompleteFreshIntelligenceSnapshot([
    source("ffc"), source("mfl", { status: "error", players: [] }), source("tradyr"), source("gng"),
  ], evaluatedAt), false);
});

test("a degraded HTTP 200 refresh cannot replace the last complete snapshot", () => {
  const degraded = completeSnapshot.map((item) => item.id === "mfl" ? source("mfl", { status: "error", players: [] }) : item);
  assert.equal(preserveCompleteFreshIntelligenceSnapshot(completeSnapshot, degraded, evaluatedAt), completeSnapshot);
  const refreshed = completeSnapshot.map((item) => ({ ...item, retrievedAt: "2026-08-15T08:00:00.000Z" }));
  assert.equal(preserveCompleteFreshIntelligenceSnapshot(completeSnapshot, refreshed, evaluatedAt), refreshed);
});

test("complete source snapshots bridge only identical fresh league settings", () => {
  const cache = new Map();
  const ppr12 = intelligenceSnapshotCacheKey("PPR", 12, 2026);
  const ppr10 = intelligenceSnapshotCacheKey("PPR", 10, 2026);
  assert.equal(rememberCompleteFreshIntelligenceSnapshot(cache, ppr12, completeSnapshot, evaluatedAt), true);
  assert.equal(readCompleteFreshIntelligenceSnapshot(cache, ppr12, evaluatedAt), completeSnapshot);
  assert.equal(readCompleteFreshIntelligenceSnapshot(cache, ppr10, evaluatedAt), null);

  const staleAt = "2026-09-15T08:00:00.000Z";
  assert.equal(readCompleteFreshIntelligenceSnapshot(cache, ppr12, staleAt), null);
  assert.equal(cache.has(ppr12), false);
  assert.equal(rememberCompleteFreshIntelligenceSnapshot(cache, ppr12, completeSnapshot.slice(0, 3), evaluatedAt), false);
});

test("rate-limited source payloads never overlap and preserve request order", async () => {
  let active = 0;
  let maximumActive = 0;
  const completed = [];
  const request = (id, delay) => async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    completed.push(id);
    active -= 1;
    return { id };
  };

  const payloads = await fetchSourcePayloadsSequentially([
    request("players", 5),
    request("adp", 1),
    request("aav", 1),
  ]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(completed, ["players", "adp", "aav"]);
  assert.deepEqual(payloads, [{ id: "players" }, { id: "adp" }, { id: "aav" }]);
});

test("the shared source queue serializes concurrent profiles and retries one HTTP 429", async () => {
  let active = 0;
  let maximumActive = 0;
  let firstAttempt = true;
  const attempts = [];
  const fetchQueued = createRateLimitedSourceFetcher(async (url) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    attempts.push(url);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (url === "first" && firstAttempt) {
      firstAttempt = false;
      throw new Error("HTTP 429");
    }
    return url;
  }, 1, 2);

  const results = await Promise.all([fetchQueued("first"), fetchQueued("second")]);

  assert.equal(maximumActive, 1);
  assert.deepEqual(attempts, ["first", "first", "second"]);
  assert.deepEqual(results, ["first", "second"]);
});
