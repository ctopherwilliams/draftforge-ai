import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeIntelligenceSource,
  clearIntelligenceSnapshotCache,
  createBoundedIntelligenceSnapshotCache,
  createRateLimitedSourceFetcher,
  fetchMfl,
  fetchSourcePayloadsSequentially,
  fetchTradyrRedraftPages,
  intelligenceSourceSnapshotId,
  intelligenceResourceUsage,
  MAX_INTELLIGENCE_SNAPSHOT_CACHE_ENTRIES,
  normalizeIntelligenceRequest,
  validateProviderTimestamp,
} from "../app/lib/intelligence-sources.ts";
import { GET as GET_INTELLIGENCE } from "../app/api/intelligence/route.ts";
import {
  intelligenceSnapshotCacheKey,
  isCompleteFreshIntelligenceSnapshot,
  isIntelligenceSourceFresh,
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

function providerRows(count = 28) {
  const positions = ["QB", "RB", "WR", "TE"];
  return Array.from({ length: count }, (_, index) => ({
    name: `Provider Player ${index + 1}`,
    team: `t${index % 8}`,
    pos: positions[index % positions.length],
    rank: index + 1,
    adp: index + 1.25,
  }));
}

function providerSource(overrides = {}) {
  return source("ffc", {
    players: providerRows(),
    weight: .15,
    ...overrides,
  });
}

test("a decision-time intelligence snapshot requires every distinct fresh source", () => {
  assert.equal(isCompleteFreshIntelligenceSnapshot(completeSnapshot, evaluatedAt), true);
  assert.equal(isCompleteFreshIntelligenceSnapshot(completeSnapshot.slice(0, 3), evaluatedAt), false);
  assert.equal(isCompleteFreshIntelligenceSnapshot([
    source("ffc"), source("mfl"), source("tradyr"), source("tradyr"),
  ], evaluatedAt), false);
  assert.equal(isCompleteFreshIntelligenceSnapshot([
    source("ffc"), source("mfl", { status: "error", players: [] }), source("tradyr"), source("gng"),
  ], evaluatedAt), false);
  assert.equal(isCompleteFreshIntelligenceSnapshot([
    source("ffc"), source("mfl", { updatedAt: null, retrievedAt: null, coverage: { players: 100, corePositions: ["QB", "RB", "WR", "TE"] } }), source("tradyr"), source("gng"),
  ], evaluatedAt), false, "missing timestamps must fail closed");
  assert.equal(isCompleteFreshIntelligenceSnapshot([
    source("ffc"), source("mfl", { coverage: { players: 1, corePositions: ["RB"] } }), source("tradyr"), source("gng"),
  ], evaluatedAt), false, "production coverage metadata must prove a meaningful multi-position board");
  assert.equal(isCompleteFreshIntelligenceSnapshot([
    source("ffc"), source("mfl", { updatedAt: "2026-08-15T09:00:00.000Z" }), source("tradyr"), source("gng"),
  ], evaluatedAt), false, "future-dated source truth must fail closed");
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

test("intelligence profiles accept only canonical ESPN integer and enum values", () => {
  assert.deepEqual(normalizeIntelligenceRequest({ scoring: "Half PPR", teams: "12", season: "2026", qbs: "2" }), {
    scoring: "Half PPR",
    teams: 12,
    season: 2026,
    qbs: 2,
  });
  for (const candidate of [
    { teams: 12.5 },
    { teams: "12.0" },
    { teams: 17 },
    { season: 2025 },
    { season: "2026e0" },
    { qbs: 0 },
    { qbs: 3 },
    { scoring: "ppr" },
  ]) {
    assert.throws(() => normalizeIntelligenceRequest(candidate), /INTELLIGENCE_PROFILE_/);
  }
});

test("source snapshot identities are deterministic, order independent, and content addressed", async () => {
  const input = {
    scoring: "PPR",
    teams: 12,
    season: 2026,
    qbs: 2,
    generatedAt: "2026-08-28T12:00:00.000Z",
    methodology: {
      weights: { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 },
      method: "freshness-gated weighted percentile consensus",
    },
    sources: completeSnapshot.map((item) => ({
      ...item,
      players: [
        { name: `${item.id} second`, team: "TWO", pos: "WR", rank: 2 },
        ...item.players,
      ],
    })),
  };
  const expected = await intelligenceSourceSnapshotId(input);
  const reordered = await intelligenceSourceSnapshotId({
    ...input,
    sources: [...input.sources].reverse().map((item) => ({
      ...item,
      players: [...item.players].reverse(),
    })),
  });
  assert.match(expected, /^sha256:[a-f0-9]{64}$/);
  assert.equal(reordered, expected, "provider and row ordering cannot change the snapshot identity");
  assert.notEqual(await intelligenceSourceSnapshotId({
    ...input,
    sources: input.sources.map((item) => item.id === "tradyr"
      ? { ...item, players: item.players.map((player, index) => index === 0 ? { ...player, rank: 3 } : player) }
      : item),
  }), expected, "one changed source signal must produce a new identity");
  assert.notEqual(await intelligenceSourceSnapshotId({
    ...input,
    generatedAt: "2026-08-28T12:00:01.000Z",
  }), expected, "a new server snapshot generation must produce a new identity");
  assert.notEqual(await intelligenceSourceSnapshotId({ ...input, qbs: 1 }), expected, "the ESPN QB profile is part of the identity");
});

test("bounded intelligence cache prunes expiry and retains the recently used warm profile", async () => {
  let now = 0;
  const cache = createBoundedIntelligenceSnapshotCache({ maxEntries: 2, now: () => now });
  const warmPromise = Promise.resolve({ profile: "legitimate" });
  cache.set("legitimate", { expiresAt: 100, promise: warmPromise });
  cache.set("other", { expiresAt: 100, promise: Promise.resolve({ profile: "other" }) });
  assert.equal(cache.get("legitimate")?.promise, warmPromise, "a warm hit refreshes LRU position");
  cache.set("new", { expiresAt: 100, promise: Promise.resolve({ profile: "new" }) });
  assert.equal(cache.get("other"), undefined, "the least-recently-used profile is evicted");
  assert.equal(cache.get("legitimate")?.promise, warmPromise, "the legitimate warm promise is not reloaded");
  assert.deepEqual(cache.stats(), { entries: 2, maxEntries: 2 });
  now = 100;
  assert.deepEqual(cache.stats(), { entries: 0, maxEntries: 2 }, "expired entries are eagerly pruned");
});

test("1000 adversarial fractional profile requests cannot consume cache, queue, or a warm cache entry", async () => {
  clearIntelligenceSnapshotCache();
  const local = createBoundedIntelligenceSnapshotCache({ maxEntries: MAX_INTELLIGENCE_SNAPSHOT_CACHE_ENTRIES });
  const warmPromise = Promise.resolve({ profile: "PPR:12:2026:2" });
  local.set("PPR:12:2026:2", { expiresAt: Date.now() + 60_000, promise: warmPromise });

  for (let index = 0; index < 1_000; index += 1) {
    const result = await GET_INTELLIGENCE(new Request(`http://localhost:3000/api/intelligence?scoring=PPR&teams=12.${index}&season=2026&qbs=2`));
    assert.equal(result.status, 400);
  }

  const usage = intelligenceResourceUsage();
  assert.deepEqual(usage.cache, { entries: 0, maxEntries: MAX_INTELLIGENCE_SNAPSHOT_CACHE_ENTRIES });
  assert.equal(usage.mflQueue.pending, 0);
  assert.equal(usage.mflQueue.active, 0);
  assert.equal(local.get("PPR:12:2026:2")?.promise, warmPromise, "adversarial misses do not evict or reload the warm profile");
});

test("provider timestamps are required, parseable, current, and not future-dated", () => {
  const reference = "2026-08-27T12:00:00.000Z";
  assert.equal(validateProviderTimestamp("2026-08-27T11:59:00.000Z", reference, "GNG"), "2026-08-27T11:59:00.000Z");
  assert.throws(() => validateProviderTimestamp(null, reference, "GNG"), /GNG_PROVIDER_TIMESTAMP_REQUIRED/);
  assert.throws(() => validateProviderTimestamp("nonsense", reference, "GNG"), /GNG_PROVIDER_TIMESTAMP_INVALID/);
  assert.throws(() => validateProviderTimestamp("2026-08-27T12:06:00.000Z", reference, "GNG"), /GNG_PROVIDER_TIMESTAMP_FUTURE/);
  assert.throws(() => validateProviderTimestamp("2026-08-01T00:00:00.000Z", reference, "GNG"), /GNG_PROVIDER_TIMESTAMP_STALE/);
});

test("live provider boundary filters malformed rows and derives coverage only from canonical rows", () => {
  const result = canonicalizeIntelligenceSource(providerSource({
    players: [
      ...providerRows(),
      { name: "", team: "BAD", pos: "RB", rank: 29 },
      { name: "No Position", team: "BAD", pos: "", rank: 30 },
      { name: "Bad Rank", team: "BAD", pos: "WR", rank: Number.NaN, adp: Number.POSITIVE_INFINITY },
      { name: "Bad Position", team: "BAD", pos: "P", rank: 31 },
    ],
  }));

  assert.equal(result.status, "ok");
  assert.equal(result.players.length, 28);
  assert.deepEqual(result.coverage, { players: 28, corePositions: ["QB", "RB", "TE", "WR"] });
  assert.ok(result.players.every((player) => player.name && player.pos && Number.isFinite(player.rank ?? player.adp)));
  assert.equal(result.players[0].team, "T0", "canonical rows normalize team codes deterministically");
});

test("duplicate normalized name and position rejects the whole provider, including duplicate pages", () => {
  const duplicateRows = providerRows();
  duplicateRows.push({
    name: "Provider Player 1 Jr.",
    team: "OTHER",
    pos: " qb ",
    rank: 99,
    adp: 99,
  });
  const result = canonicalizeIntelligenceSource(providerSource({ players: duplicateRows }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "FFC_DUPLICATE_PLAYER_IDENTITY");
  assert.deepEqual(result.players, []);
  assert.deepEqual(result.coverage, { players: 0, corePositions: [] });
});

test("raw coverage metadata cannot overstate or replace canonical provider coverage", () => {
  const mismatch = canonicalizeIntelligenceSource(providerSource({
    coverage: { players: 999, corePositions: ["QB", "RB", "WR", "TE"] },
  }));
  assert.equal(mismatch.status, "error");
  assert.equal(mismatch.error, "FFC_COVERAGE_METADATA_MISMATCH");
  assert.deepEqual(mismatch.coverage, { players: 0, corePositions: [] });

  const exact = canonicalizeIntelligenceSource(providerSource({
    coverage: { players: 28, corePositions: ["TE", "WR", "QB", "RB"] },
  }));
  assert.equal(exact.status, "ok");
  assert.deepEqual(exact.coverage, { players: 28, corePositions: ["QB", "RB", "TE", "WR"] });
});

test("provider boards fail closed below 25 unique rows or without every core position", () => {
  const tooSmall = canonicalizeIntelligenceSource(providerSource({ players: providerRows(24) }));
  assert.equal(tooSmall.status, "error");
  assert.equal(tooSmall.error, "FFC_CANONICAL_COVERAGE_TOO_SMALL");

  const noTightEnds = canonicalizeIntelligenceSource(providerSource({
    players: providerRows().map((player) => ({ ...player, pos: player.pos === "TE" ? "WR" : player.pos })),
  }));
  assert.equal(noTightEnds.status, "error");
  assert.equal(noTightEnds.error, "FFC_CORE_POSITION_COVERAGE_INCOMPLETE");
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

test("MFL keeps rolling-query retrieval separate from provider update time", async () => {
  const requests = [];
  const positions = ["QB", "RB", "WR", "TE"];
  const details = Array.from({ length: 28 }, (_, index) => ({
    id: String(index + 1),
    name: `Last${index}, First${index}`,
    position: positions[index % positions.length],
    team: `T${index % 8}`,
  }));
  const market = details.map((player, index) => ({
    id: player.id,
    rank: index + 1,
    averagePick: index + 1.5,
  }));
  const auctions = details.map((player, index) => ({ id: player.id, averageValue: 40 - index }));
  const payloads = {
    players: { players: { player: details } },
    adp: { adp: { player: market } },
    aav: { aav: { player: auctions } },
  };

  const raw = await fetchMfl(12, "PPR", 2026, async (label, url) => {
    requests.push({ label, url });
    return payloads[label];
  });
  const result = canonicalizeIntelligenceSource(raw);

  assert.equal(result.status, "ok");
  assert.equal(result.updatedAt, null, "retrieval must never masquerade as provider publication time");
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
  assert.equal(isIntelligenceSourceFresh(result), true, "a current explicit rolling-window receipt remains usable");
  assert.deepEqual(requests.map(({ label }) => label), ["players", "adp", "aav"]);
  assert.equal(new URL(requests[1].url).searchParams.get("DAYS"), "30");
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

test("the MFL-style source queue rejects excess admission before work and recovers its full capacity", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const fetchQueued = createRateLimitedSourceFetcher(async (url) => {
    started.push(url);
    await gate;
    return url;
  }, 0, 0, { maxPending: 2, queueName: "MFL" });

  const first = fetchQueued("first");
  const second = fetchQueued("second");
  await Promise.resolve();
  assert.deepEqual(fetchQueued.stats(), { pending: 2, active: 1, maxPending: 2 });
  await assert.rejects(fetchQueued("overflow"), /MFL_SOURCE_QUEUE_FULL/);
  assert.deepEqual(fetchQueued.stats(), { pending: 2, active: 1, maxPending: 2 });

  release();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(fetchQueued.stats(), { pending: 0, active: 0, maxPending: 2 });
});

test("Tradyr redraft pagination expands the same source deterministically and stays bounded", async () => {
  const urls = [];
  const authorizations = [];
  const pages = new Map([
    [0, Array.from({ length: 50 }, (_, index) => ({ slug: `player-${index}`, name: `Player ${index}`, position: "WR", rank: index + 1 }))],
    [50, Array.from({ length: 50 }, (_, index) => ({ slug: `player-${index + 50}`, name: `Player ${index + 50}`, position: "RB", rank: index + 51 }))],
    [100, Array.from({ length: 20 }, (_, index) => ({ slug: `player-${index + 100}`, name: `Player ${index + 100}`, position: "TE", rank: index + 101 }))],
  ]);
  const result = await fetchTradyrRedraftPages(async (url, init) => {
    urls.push(url);
    authorizations.push(init?.headers?.Authorization);
    const offset = Number(new URL(url).searchParams.get("offset"));
    return { data: pages.get(offset) || [], meta: { total: 120, offset, generatedAt: "2026-08-19T00:00:00.000Z", access: { limited: false } } };
  }, 0, 1, "test-key");

  assert.equal(result.players.length, 120);
  assert.equal(result.expectedTotal, 120);
  assert.equal(result.generatedAt, "2026-08-19T00:00:00.000Z");
  assert.deepEqual(urls.map((url) => Number(new URL(url).searchParams.get("offset"))), [0, 50, 100]);
  assert.ok(urls.every((url) => new URL(url).searchParams.get("numQbs") === "1"));
  assert.deepEqual(authorizations, ["Bearer test-key", "Bearer test-key", "Bearer test-key"]);
  assert.ok(urls.every((url) => !url.includes("test-key")), "the credential must never enter a URL");
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
    const count = offset === 0 ? 50 : 10;
    return {
      data: Array.from({ length: count }, (_, index) => ({
        slug: `player-${offset + index}`,
        name: `Player ${offset + index}`,
        position: "WR",
        rank: offset + index + 1,
      })),
      meta: { total: 60, offset, generatedAt: "2026-08-19T00:00:00.000Z" },
    };
  }, 0, 1, "test-key");

  assert.deepEqual(offsets, [0, 0, 50]);
  assert.equal(result.players.length, 60);
});

test("Tradyr requests a two-QB board for ESPN QB-plus-OP leagues", async () => {
  const urls = [];
  await fetchTradyrRedraftPages(async (url) => {
    urls.push(url);
    const offset = Number(new URL(url).searchParams.get("offset"));
    const count = offset === 0 ? 50 : 1;
    return {
      data: Array.from({ length: count }, (_, index) => ({
        slug: `player-${offset + index}`,
        name: `Player ${offset + index}`,
        position: "WR",
        rank: offset + index + 1,
      })),
      meta: { total: 51, offset, generatedAt: "2026-08-20T00:00:00.000Z" },
    };
  }, 0, 2, "test-key");

  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => new URL(url).searchParams.get("numQbs") === "2"));
});

test("Tradyr fails closed without a server-side API key", async () => {
  let called = false;
  await assert.rejects(
    fetchTradyrRedraftPages(async () => {
      called = true;
      return { data: [], meta: { total: 0 } };
    }, 0, 1, ""),
    /TRADYR_API_KEY_REQUIRED/,
  );
  assert.equal(called, false);
});

test("Tradyr rejects capped or ignored-offset responses even when HTTP succeeds", async () => {
  await assert.rejects(
    fetchTradyrRedraftPages(async () => ({
      data: [{ slug: "decoy", name: "Decoy", position: "WR", rank: 1 }],
      meta: { total: 192, offset: 0, access: { limited: true } },
    }), 0, 2, "test-key"),
    /TRADYR_ACCESS_LIMITED/,
  );
  await assert.rejects(
    fetchTradyrRedraftPages(async () => ({
      data: [{ slug: "player", name: "Player", position: "WR", rank: 1 }],
      meta: { total: 100, offset: 0, access: { limited: false, offsetIgnored: true } },
    }), 0, 2, "test-key"),
    /TRADYR_OFFSET_IGNORED/,
  );
  await assert.rejects(
    fetchTradyrRedraftPages(async () => ({
      data: Array.from({ length: 50 }, (_, index) => ({
        slug: `decoy-${index}`,
        name: `Decoy ${index}`,
        position: "WR",
        rank: index + 1,
      })),
      meta: { total: 50, offset: 0 },
    }), 0, 2, "bogus-key"),
    /TRADYR_FULL_ACCESS_UNPROVEN/,
  );
});

test("Tradyr rejects duplicate pages and incomplete pagination", async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    slug: `player-${index}`,
    name: `Player ${index}`,
    position: "WR",
    rank: index + 1,
  }));
  await assert.rejects(
    fetchTradyrRedraftPages(async (url) => ({
      data: firstPage,
      meta: { total: 100, offset: Number(new URL(url).searchParams.get("offset")), generatedAt: "2026-08-19T00:00:00.000Z", access: { limited: false } },
    }), 0, 1, "test-key"),
    /TRADYR_DUPLICATE_PAGE/,
  );
  await assert.rejects(
    fetchTradyrRedraftPages(async () => ({
      data: firstPage.slice(0, 20),
      meta: { total: 60, offset: 0, generatedAt: "2026-08-19T00:00:00.000Z", access: { limited: false } },
    }), 0, 1, "test-key"),
    /TRADYR_INCOMPLETE_PAGINATION/,
  );
});

test("Tradyr requires one stable provider generation across every page", async () => {
  await assert.rejects(
    fetchTradyrRedraftPages(async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const count = offset === 0 ? 50 : 10;
      return {
        data: Array.from({ length: count }, (_, index) => ({
          slug: `player-${offset + index}`,
          name: `Player ${offset + index}`,
          position: "WR",
          rank: offset + index + 1,
        })),
        meta: {
          total: 60,
          offset,
          generatedAt: offset === 0 ? "2026-08-19T00:00:00.000Z" : "2026-08-20T00:00:00.000Z",
        },
      };
    }, 0, 1, "test-key"),
    /TRADYR_GENERATED_AT_CHANGED/,
  );
  await assert.rejects(
    fetchTradyrRedraftPages(async () => ({
      data: Array.from({ length: 50 }, (_, index) => ({ slug: `player-${index}`, name: `Player ${index}`, position: "WR" })),
      meta: { total: 60, offset: 0 },
    }), 0, 1, "test-key"),
    /TRADYR_PROVIDER_TIMESTAMP_REQUIRED/,
  );
});
