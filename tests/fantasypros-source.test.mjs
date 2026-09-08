import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeIntelligenceSource } from "../app/lib/intelligence-sources.ts";
import {
  FANTASYPROS_MAX_HTML_BYTES,
  fetchFantasyPros,
  fetchFantasyProsHtml,
  parseFantasyProsHtml,
} from "../app/lib/fantasypros-source.ts";

const NOW = Date.parse("2026-09-08T01:30:00Z");
const DAY = 86_400_000;
function fixture() {
  const ids = Array.from({ length: 12 }, (_, index) => index + 1);
  return {
    ecr: {
      sport: "NFL", ranking_type_name: "draft", year: "2026", week: "0",
      position_id: "ALL", scoring: "PPR", filters: ids.join(","),
      total_experts: ids.length, last_updated_ts: (NOW - 60_000) / 1000,
      count: 28, accessed: "2099-01-01 00:00:00",
      experts_available: { included: ids },
      players: Array.from({ length: 28 }, (_, index) => ({
        player_id: 1000 + index, player_name: `Player ${index + 1}`,
        player_position_id: ["QB", "RB", "WR", "TE"][index % 4],
        player_team_id: "BUF", rank_ecr: index + 1,
        auction: 70, projectedPpg: 24, rank_ave: "1.34",
      })),
    },
    groups: {
      sport: "NFL", season: "2026", type: "draft", position: "ALL", scoring: "PPR",
      expert_data: ids.map((id) => ({ id, last_updated: (NOW - id * 60_000) / 1000 })),
    },
  };
}
function html({ ecr, groups } = fixture()) {
  return `<html><script>\nvar ecrData = ${JSON.stringify(ecr)};\nvar expertGroupsData = ${JSON.stringify(groups)};\n</script></html>`;
}
const parse = (data = fixture()) => parseFantasyProsHtml(html(data), "PPR", 2026, NOW);

test("valid board returns rank-only rows and oldest selected expert time, never accessed", () => {
  const result = parse();
  assert.equal(result.players.length, 28);
  assert.equal(result.sampleSize, 12);
  assert.equal(result.updatedAt, new Date(NOW - 12 * 60_000).toISOString());
  assert.deepEqual(result.players[0], { name: "Player 1", team: "BUF", pos: "QB", rank: 1 });
});

test("old or missing unselected expert timestamps do not contaminate the selected board", () => {
  const data = fixture();
  data.groups.expert_data.push({ id: 500, last_updated: 1 }, { id: 501 });
  assert.equal(parse(data).sampleSize, 12);
});

function ambiguousPair(data, team = "NYJ") {
  data.ecr.players[0].player_name = "Isaiah Williams Jr.";
  data.ecr.players[0].player_position_id = "WR";
  data.ecr.players[0].player_team_id = team;
  data.ecr.players[1].player_name = "Isaiah Williams";
  data.ecr.players[1].player_position_id = "WR";
  data.ecr.players[1].player_team_id = "FA";
}

test("all distinct-team, distinct-ID members of a normalized-identity collision are excluded without reranking", () => {
  const data = fixture();
  ambiguousPair(data);
  const result = parse(data);
  assert.equal(result.players.length, 26);
  assert.ok(result.players.every((player) => !player.name.includes("Isaiah Williams")));
  assert.equal(result.players[0].rank, 3);
  assert.deepEqual(result.excludedAmbiguousIdentities, [{ identity: "isaiahwilliams|WR", playerIds: [1000, 1001], teams: ["NYJ", "FA"] }]);
  const canonical = canonicalizeIntelligenceSource({ id: "fantasypros", name: "FantasyPros", kind: "composite", weight: .20, status: "ok", attribution: "FantasyPros", ...result });
  assert.equal(canonical.status, "ok", canonical.error);
  assert.equal(canonical.coverage.players, 26);
  assert.deepEqual(canonical.coverage.corePositions, ["QB", "RB", "TE", "WR"]);
});

test("three-way distinct-team identity collision excludes every member", () => {
  const data = fixture();
  ambiguousPair(data);
  Object.assign(data.ecr.players[2], { player_name: "Isaiah Williams", player_position_id: "WR", player_team_id: "BUF" });
  const result = parse(data);
  assert.equal(result.players.length, 25);
  assert.ok(result.players.every((player) => !player.name.includes("Isaiah Williams")));
  assert.deepEqual(result.excludedAmbiguousIdentities[0].playerIds, [1000, 1001, 1002]);
});

test("same-team, normalized same-team and missing-team duplicate identities remain fatal", () => {
  for (const team of ["FA", " fa ", ""]) {
    const data = fixture();
    ambiguousPair(data, team);
    assert.throws(() => parse(data), /DUPLICATE_PLAYER_IDENTITY/);
  }
  const data = fixture();
  ambiguousPair(data);
  Object.assign(data.ecr.players[2], { player_name: "Isaiah Williams", player_position_id: "WR", player_team_id: "NYJ" });
  assert.throws(() => parse(data), /DUPLICATE_PLAYER_IDENTITY/);
});

test("ambiguous-looking rows never bypass duplicate provider-ID or rank rejection", () => {
  for (const [field, code] of [["player_id", /PLAYER_ID_INVALID_OR_DUPLICATE/], ["rank_ecr", /PLAYER_RANK_INVALID_OR_DUPLICATE/]]) {
    const data = fixture();
    ambiguousPair(data);
    data.ecr.players[1][field] = data.ecr.players[0][field];
    assert.throws(() => parse(data), code);
  }
});

test("ambiguity exclusion cannot leave a source below minimum coverage", () => {
  const data = fixture();
  ambiguousPair(data);
  data.ecr.players.length = data.ecr.count = 25;
  assert.throws(() => parse(data), /UNAMBIGUOUS_PLAYER_COUNT_TOO_SMALL/);
});

test("same player name at different positions is not an ambiguous identity", () => {
  const data = fixture();
  data.ecr.players[0].player_name = data.ecr.players[1].player_name;
  assert.equal(parse(data).players.length, 28);
  assert.deepEqual(parse(data).excludedAmbiguousIdentities, []);
});

test("board timestamp is also conservative if older than the selected experts", () => {
  const data = fixture();
  data.ecr.last_updated_ts = (NOW - DAY) / 1000;
  assert.equal(parse(data).updatedAt, new Date(NOW - DAY).toISOString());
});

for (const [label, mutate, code] of [
  ["stale board", (d) => d.ecr.last_updated_ts = (NOW - 15 * DAY) / 1000, /BOARD_TIMESTAMP_STALE/],
  ["one stale selected expert", (d) => d.groups.expert_data[5].last_updated = (NOW - 15 * DAY) / 1000, /EXPERT_TIMESTAMP_STALE/],
  ["future board", (d) => d.ecr.last_updated_ts = (NOW + 301_000) / 1000, /BOARD_TIMESTAMP_FUTURE/],
  ["one future selected expert", (d) => d.groups.expert_data[5].last_updated = (NOW + 301_000) / 1000, /EXPERT_TIMESTAMP_FUTURE/],
  ["missing board date", (d) => delete d.ecr.last_updated_ts, /BOARD_TIMESTAMP_INVALID/],
  ["missing expert date", (d) => delete d.groups.expert_data[5].last_updated, /EXPERT_TIMESTAMP_INVALID/],
  ["non-numeric board date", (d) => d.ecr.last_updated_ts = "yesterday", /BOARD_TIMESTAMP_INVALID/],
  ["duplicate selected IDs", (d) => d.ecr.filters = "1,1,3,4,5,6,7,8,9,10,11,12", /SELECTED_EXPERTS_INVALID/],
  ["duplicate expert IDs", (d) => d.groups.expert_data.push(d.groups.expert_data[0]), /EXPERT_ID_INVALID_OR_DUPLICATE/],
  ["unknown selected expert", (d) => d.groups.expert_data.pop(), /SELECTED_EXPERT_MISSING/],
  ["no selected experts", (d) => delete d.ecr.filters, /SELECTED_EXPERTS_INVALID/],
  ["too few experts", (d) => { d.ecr.filters = "1,2"; d.ecr.total_experts = 2; }, /SELECTED_EXPERTS_INVALID/],
  ["expert count mismatch", (d) => d.ecr.total_experts = 13, /SELECTED_EXPERTS_INVALID/],
  ["included cohort mismatch", (d) => d.ecr.experts_available.included[0] = 900, /INCLUDED_EXPERTS_MISMATCH/],
  ["duplicate included expert", (d) => d.ecr.experts_available.included[0] = 2, /INCLUDED_EXPERTS_MISMATCH/],
  ["missing expert metadata", (d) => delete d.groups.expert_data, /EXPERT_DATA_INVALID/],
  ["wrong ECR year", (d) => d.ecr.year = "2025", /PROFILE_MISMATCH/],
  ["wrong expert year", (d) => d.groups.season = "2025", /PROFILE_MISMATCH/],
  ["wrong ECR scoring", (d) => d.ecr.scoring = "HALF", /PROFILE_MISMATCH/],
  ["wrong expert scoring", (d) => d.groups.scoring = "STD", /PROFILE_MISMATCH/],
  ["nonzero ECR week", (d) => d.ecr.week = "1", /PROFILE_MISMATCH/],
  ["missing ECR week", (d) => delete d.ecr.week, /PROFILE_MISMATCH/],
  ["nonzero expert week", (d) => d.groups.week = "1", /PROFILE_MISMATCH/],
  ["wrong ECR sport", (d) => d.ecr.sport = "MLB", /PROFILE_MISMATCH/],
  ["wrong expert sport", (d) => d.groups.sport = "MLB", /PROFILE_MISMATCH/],
  ["weekly ECR", (d) => d.ecr.ranking_type_name = "weekly", /PROFILE_MISMATCH/],
  ["dynasty expert data", (d) => d.groups.type = "dynasty", /PROFILE_MISMATCH/],
  ["positional ECR", (d) => d.ecr.position_id = "QB", /PROFILE_MISMATCH/],
  ["positional expert data", (d) => d.groups.position = "QB", /PROFILE_MISMATCH/],
  ["missing players", (d) => delete d.ecr.players, /PLAYER_COUNT_INVALID/],
  ["mismatched row count", (d) => d.ecr.count = 29, /PLAYER_COUNT_INVALID/],
  ["undersized board", (d) => { d.ecr.players.length = 24; d.ecr.count = 24; }, /PLAYER_COUNT_INVALID/],
  ["duplicate player ID", (d) => d.ecr.players[1].player_id = d.ecr.players[0].player_id, /PLAYER_ID_INVALID_OR_DUPLICATE/],
  ["duplicate rank", (d) => d.ecr.players[1].rank_ecr = 1, /PLAYER_RANK_INVALID_OR_DUPLICATE/],
  ["missing rank", (d) => delete d.ecr.players[0].rank_ecr, /PLAYER_RANK_INVALID_OR_DUPLICATE/],
  ["invalid position", (d) => d.ecr.players[0].player_position_id = "<script>", /PLAYER_INVALID/],
]) {
  test(`fails closed: ${label}`, () => {
    const data = fixture();
    mutate(data);
    assert.throws(() => parse(data), code);
  });
}

test("freshness thresholds are inclusive", () => {
  const data = fixture();
  data.ecr.last_updated_ts = (NOW + 300_000) / 1000;
  data.groups.expert_data[0].last_updated = (NOW - 14 * DAY) / 1000;
  assert.equal(parse(data).updatedAt, new Date(NOW - 14 * DAY).toISOString());
});

test("all supported scoring profiles require matching provider declarations", () => {
  for (const [scoring, code] of [["Standard", "STD"], ["Half PPR", "HALF"], ["PPR", "PPR"]]) {
    const data = fixture();
    data.ecr.scoring = code;
    data.groups.scoring = code;
    assert.equal(parseFantasyProsHtml(html(data), scoring, 2026, NOW).players.length, 28);
  }
  assert.throws(() => parseFantasyProsHtml(html(), "Superflex", 2026, NOW), /SCORING_UNSUPPORTED/);
  assert.throws(() => parseFantasyProsHtml(html(), "__proto__", 2026, NOW), /SCORING_UNSUPPORTED/);
  assert.throws(() => parseFantasyProsHtml(html(), "PPR", NaN, NOW), /SEASON_INVALID/);
});

test("HTML and embedded JavaScript are inert; only literal JSON assignments are parsed", () => {
  delete globalThis.__fantasyProsExecuted;
  const data = fixture();
  data.ecr.players[0].player_name = 'Quoted \\" } ; globalThis.__fantasyProsExecuted = true; {';
  const page = html(data) + "<script>globalThis.__fantasyProsExecuted = true;</script>";
  assert.equal(parseFantasyProsHtml(page, "PPR", 2026, NOW).players[0].name, data.ecr.players[0].player_name);
  assert.equal(globalThis.__fantasyProsExecuted, undefined);
  const malicious = html().replace(/var ecrData = [^\n]+/, "var ecrData = (() => { globalThis.__fantasyProsExecuted = true; return {}; })();");
  assert.throws(() => parseFantasyProsHtml(malicious, "PPR", 2026, NOW), /JSON_INVALID/);
  assert.equal(globalThis.__fantasyProsExecuted, undefined);
});

test("missing, truncated, duplicate and malformed assignments fail closed", () => {
  for (const page of ["<html>captcha</html>", html().replace("var ecrData", "var otherData"),
    html().replace('"sport":"NFL"', '"sport":undefined'), html().slice(0, 500),
    html() + "\nvar ecrData = {};", html().replace(";\nvar expertGroupsData", " + malicious();\nvar expertGroupsData")]) {
    assert.throws(() => parseFantasyProsHtml(page, "PPR", 2026, NOW), /FANTASYPROS_/);
  }
});

test("parser bounds bytes, JSON length and nesting", () => {
  assert.throws(() => parseFantasyProsHtml("é".repeat(FANTASYPROS_MAX_HTML_BYTES / 2 + 1), "PPR", 2026, NOW), /HTML_TOO_LARGE/);
  const data = fixture();
  data.ecr.padding = "x".repeat(2 * 1024 * 1024);
  assert.throws(() => parse(data), /JSON_UNTERMINATED_OR_TOO_LARGE/);
  const nested = 'var ecrData = {"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '};';
  assert.throws(() => parseFantasyProsHtml(nested, "PPR", 2026, NOW), /JSON_DEPTH_EXCEEDED/);
});

const response = (body = html(), headers = {}) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
test("bounded HTML fetch accepts normal and split multibyte body data", async () => {
  let init;
  assert.equal(await fetchFantasyProsHtml("https://example.test", async (_, options) => { init = options; return response(); }), html());
  assert.equal(init.redirect, "error");
  const bytes = new TextEncoder().encode("é");
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.equal(await fetchFantasyProsHtml("https://example.test", async () => response(stream)), "é");
});

test("bounded fetch rejects bad status, content type, missing body and excessive declared size", async () => {
  for (const [result, error] of [
    [new Response("denied", { status: 403 }), /HTTP_403/],
    [response("{}", { "content-type": "application/json" }), /CONTENT_TYPE_INVALID/],
    [response(null), /BODY_MISSING/],
    [response("x", { "content-length": String(FANTASYPROS_MAX_HTML_BYTES + 1) }), /HTML_TOO_LARGE/],
  ]) await assert.rejects(fetchFantasyProsHtml("https://example.test", async () => result), error);
});

test("streamed response size is enforced even without or with a lying Content-Length", async () => {
  for (const headers of [{}, { "content-length": "1" }]) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(fetchFantasyProsHtml("https://example.test", async () => response(stream, headers)), /HTML_TOO_LARGE/);
    assert.equal(cancelled, true);
  }
});

test("deadline bounds both stalled headers and stalled body reads", async () => {
  await assert.rejects(fetchFantasyProsHtml("https://example.test", () => new Promise(() => {}), 10), /FETCH_TIMEOUT/);
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(fetchFantasyProsHtml("https://example.test", async () => response(stream), 10), /FETCH_TIMEOUT/);
  assert.equal(cancelled, true);
});

test("a transport returning headers after timeout still has its body cancelled", async () => {
  let resolve;
  let cancelled = false;
  const pending = new Promise((done) => { resolve = done; });
  await assert.rejects(fetchFantasyProsHtml("https://example.test", () => pending, 10), /FETCH_TIMEOUT/);
  resolve(response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, true);
});

test("excessive tiny chunks cannot create unbounded per-chunk allocation", async () => {
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(0)); } });
  await assert.rejects(fetchFantasyProsHtml("https://example.test", async () => response(stream)), /BODY_CHUNK_LIMIT_EXCEEDED/);
});

test("source wrapper uses verified public scoring URLs and fails closed without a network request for unknown scoring", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    const data = fixture();
    data.ecr.last_updated_ts = Math.floor(Date.now() / 1000);
    for (const expert of data.groups.expert_data) expert.last_updated = data.ecr.last_updated_ts - expert.id;
    const code = url.includes("half-point") ? "HALF" : url.includes("/ppr-") ? "PPR" : "STD";
    data.ecr.scoring = data.groups.scoring = code;
    return response(html(data));
  });
  for (const scoring of ["Standard", "Half PPR", "PPR"]) {
    const source = await fetchFantasyPros(scoring, 2026);
    assert.equal(source.status, "ok", source.error);
    assert.equal(source.id, "fantasypros");
    assert.equal(source.kind, "composite");
    assert.equal(source.weight, .20);
    assert.equal(source.attribution, "FantasyPros Expert Consensus Rankings");
    assert.ok(source.retrievedAt);
  }
  assert.deepEqual(urls, ["consensus-cheatsheets.php", "half-point-ppr-cheatsheets.php", "ppr-cheatsheets.php"].map((path) => `https://www.fantasypros.com/nfl/rankings/${path}`));
  const invalid = await fetchFantasyPros("unknown", 2026);
  assert.equal(invalid.status, "error");
  assert.equal(invalid.updatedAt, null);
  assert.deepEqual(invalid.players, []);
  assert.equal(urls.length, 3);
});
