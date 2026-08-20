import assert from "node:assert/strict";
import test from "node:test";
import {
  createRateLimitedSourceFetcher,
  fetchSourcePayloadsSequentially,
  fetchTradyrRedraftPages,
  normalizeIntelligenceRequest,
} from "../app/lib/intelligence-sources.ts";
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
  const ppr12Superflex = intelligenceSnapshotCacheKey("PPR", 12, 2026, 2);
  assert.equal(rememberCompleteFreshIntelligenceSnapshot(cache, ppr12, completeSnapshot, evaluatedAt), true);
  assert.equal(readCompleteFreshIntelligenceSnapshot(cache, ppr12, evaluatedAt), completeSnapshot);
  assert.equal(readCompleteFreshIntelligenceSnapshot(cache, ppr10, evaluatedAt), null);
  assert.equal(readCompleteFreshIntelligenceSnapshot(cache, ppr12Superflex, evaluatedAt), null);

  const staleAt = "2026-09-15T08:00:00.000Z";
  assert.equal(readCompleteFreshIntelligenceSnapshot(cache, ppr12, staleAt), null);
  assert.equal(cache.has(ppr12), false);
  assert.equal(rememberCompleteFreshIntelligenceSnapshot(cache, ppr12, completeSnapshot.slice(0, 3), evaluatedAt), false);
});

test("intelligence profiles keep one-QB and OP source snapshots isolated", () => {
  assert.equal(normalizeIntelligenceRequest({ scoring: "PPR", teams: 12, season: 2026 }).qbs, 1);
  assert.equal(normalizeIntelligenceRequest({ scoring: "PPR", teams: 12, season: 2026, qbs: 2 }).qbs, 2);
  assert.notEqual(
    intelligenceSnapshotCacheKey("PPR", 12, 2026, 1),
    intelligenceSnapshotCacheKey("PPR", 12, 2026, 2),
  );
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

test("Tradyr redraft pagination expands the same source deterministically and stays bounded", async () => {
  const urls = [];
  const pages = new Map([
    [0, Array.from({ length: 50 }, (_, index) => ({ slug: `player-${index}`, name: `Player ${index}`, position: "WR", rank: index + 1 }))],
    [50, Array.from({ length: 50 }, (_, index) => ({ slug: `player-${index + 50}`, name: `Player ${index + 50}`, position: "RB", rank: index + 51 }))],
    [100, Array.from({ length: 20 }, (_, index) => ({ slug: `player-${index + 100}`, name: `Player ${index + 100}`, position: "TE", rank: index + 101 }))],
  ]);
  const result = await fetchTradyrRedraftPages(async (url) => {
    urls.push(url);
    const offset = Number(new URL(url).searchParams.get("offset"));
    return { data: pages.get(offset) || [], meta: { total: 120, generatedAt: "2026-08-19T00:00:00.000Z" } };
  });

  assert.equal(result.players.length, 120);
  assert.equal(result.expectedTotal, 120);
  assert.equal(result.generatedAt, "2026-08-19T00:00:00.000Z");
  assert.deepEqual(urls.map((url) => Number(new URL(url).searchParams.get("offset"))), [0, 50, 100]);
  assert.ok(urls.every((url) => new URL(url).searchParams.get("numQbs") === "1"));
});

test("Tradyr retries one transient page timeout without changing pagination order", async () => {
  const offsets = [];
  let firstAttempt = true;
  const result = await fetchTradyrRedraftPages(async (url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    offsets.push(offset);
    if (offset === 0 && firstAttempt) {
      firstAttempt = false;
      throw new Error("This operation was aborted");
    }
    return {
      data: Array.from({ length: 10 }, (_, index) => ({
        slug: `player-${index}`,
        name: `Player ${index}`,
        position: "WR",
        rank: index + 1,
      })),
      meta: { total: 10, generatedAt: "2026-08-19T00:00:00.000Z" },
    };
  }, 0);

  assert.deepEqual(offsets, [0, 0]);
  assert.equal(result.players.length, 10);
});

test("Tradyr requests a two-QB board for ESPN QB-plus-OP leagues", async () => {
  const urls = [];
  await fetchTradyrRedraftPages(async (url) => {
    urls.push(url);
    return { data: [], meta: { total: 0, generatedAt: "2026-08-20T00:00:00.000Z" } };
  }, 0, 2);

  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get("numQbs"), "2");
});
