import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GET, OPTIONS, POST, resetAvailabilityStageMemoryForTesting } from "../app/api/availability/route.ts";
import { clearPersistedAvailabilityStage } from "../app/lib/availability-stage-store.ts";
import {
  normalizeAvailabilityOrigin,
  parseAvailabilityStageArguments,
  stageAvailabilityFromFiles,
} from "../scripts/stage-availability.mjs";

const policyPath = new URL("../config/availability-veto.policy.example.json", import.meta.url);
const policy = JSON.parse(await readFile(policyPath, "utf8"));

function timestamp(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function currentArtifact(overrides = {}) {
  const retrievedAt = timestamp(-60_000);
  const classification = "season_ending_injury";
  return {
    schemaVersion: "draftforge.availability/v1",
    generatedAt: timestamp(-30_000),
    scanReceipt: {
      completedAt: timestamp(-40_000),
      feeds: [
        { id: "authenticated_espn_player_news", url: "https://fantasy.espn.com/football/players/news", retrievedAt: timestamp(-50_000), status: "ok" },
        { id: "official_nfl_news", url: "https://www.nfl.com/news/", retrievedAt: timestamp(-50_000), status: "ok" },
      ],
    },
    records: [{
      identity: { espnPlayerId: 901, normalizedName: "stagingexample", team: "BUF", position: "WR" },
      classification,
      reasonCode: classification,
      eventAt: timestamp(-120_000),
      retrievedAt,
      evidence: [{
        kind: "official_nfl",
        url: "https://www.nfl.com/news/staging-example-status",
        domain: "www.nfl.com",
        publishedAt: timestamp(-120_000),
        supportsClassification: classification,
      }],
    }],
    ...overrides,
  };
}

function post(body, overrides = {}) {
  return POST(new Request("http://127.0.0.1:3000/api/availability", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      ...(overrides.headers || {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

function delayedPost(body) {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const encoded = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const request = new Request("http://127.0.0.1:3000/api/availability", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: new ReadableStream({
      async start(controller) {
        await ready;
        controller.enqueue(encoded);
        controller.close();
      },
    }),
    duplex: "half",
  });
  return { request, release };
}

test("availability staging starts fail-closed and permits only exact loopback requests", async () => {
  const missing = await GET(new Request("http://127.0.0.1:3000/api/availability"));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "AVAILABILITY_STAGE_MISSING");

  const deniedOrigin = await POST(new Request("http://127.0.0.1:3000/api/availability", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ policy, artifact: currentArtifact() }),
  }));
  assert.equal(deniedOrigin.status, 403);

  const deniedLan = await GET(new Request("http://192.168.1.22:3000/api/availability"));
  assert.equal(deniedLan.status, 403);

  const deniedQuery = await GET(new Request("http://127.0.0.1:3000/api/availability?path=/tmp/private"));
  assert.equal(deniedQuery.status, 400);

  const preflight = await OPTIONS(new Request("http://localhost:3000/api/availability", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:3000" },
  }));
  assert.equal(preflight.status, 204);
});

test("POST stages only validated sanitized state and GET returns the deterministic current digest", async () => {
  const previousPersistence = process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE;
  process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE = "1";
  try {
  const artifact = currentArtifact();
  const recorded = await post({ artifact, policy });
  assert.equal(recorded.status, 200);
  const result = await recorded.json();
  assert.equal(result.code, "AVAILABILITY_STAGE_RECORDED");
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.artifactGeneratedAt, artifact.generatedAt);
  assert.equal(Object.hasOwn(result, "artifact"), false);
  assert.equal(Object.hasOwn(result, "policy"), false);

  const read = await GET(new Request("http://localhost:3000/api/availability", {
    headers: { origin: "http://localhost:3000" },
  }));
  assert.equal(read.status, 200);
  const staged = await read.json();
  assert.equal(staged.code, "AVAILABILITY_STAGE_READY");
  assert.equal(staged.digest, result.digest);
  assert.deepEqual(staged.policy, policy);
  assert.deepEqual(staged.artifact, artifact);
  assert.equal(staged.unresolvedCount, 1);
  const serialized = JSON.stringify(staged).toLowerCase();
  for (const forbidden of ["cookie", "memberid", "password", "opponent", "transcript"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const replay = await post({ policy, artifact });
  assert.equal((await replay.json()).digest, result.digest);

  resetAvailabilityStageMemoryForTesting();
  const recovered = await GET(new Request("http://127.0.0.1:3000/api/availability"));
  assert.equal(recovered.status, 200);
  const recoveredStage = await recovered.json();
  assert.equal(recoveredStage.code, "AVAILABILITY_STAGE_READY");
  assert.equal(recoveredStage.digest, result.digest);
  assert.deepEqual(recoveredStage.artifact, artifact);
  } finally {
    resetAvailabilityStageMemoryForTesting();
    await clearPersistedAvailabilityStage();
    if (previousPersistence === undefined) delete process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE;
    else process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE = previousPersistence;
  }
});

test("newer valid staging wins when an older valid request finishes parsing later", async () => {
  const previousPersistence = process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE;
  process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE = "1";
  resetAvailabilityStageMemoryForTesting();
  await clearPersistedAvailabilityStage();
  try {
    const olderArtifact = currentArtifact({ records: [] });
    const newerArtifact = currentArtifact({
      generatedAt: timestamp(-20_000),
      records: [],
    });
    const delayed = delayedPost({ policy, artifact: olderArtifact });
    const olderResponse = POST(delayed.request);
    const newerResponse = await post({ policy, artifact: newerArtifact });
    assert.equal(newerResponse.status, 200);

    delayed.release();
    const superseded = await olderResponse;
    assert.equal(superseded.status, 409);
    assert.equal((await superseded.json()).code, "AVAILABILITY_STAGE_SUPERSEDED");

    const current = await GET(new Request("http://127.0.0.1:3000/api/availability"));
    assert.deepEqual((await current.json()).artifact, newerArtifact);
    resetAvailabilityStageMemoryForTesting();
    const recovered = await GET(new Request("http://127.0.0.1:3000/api/availability"));
    assert.deepEqual((await recovered.json()).artifact, newerArtifact, "disk and memory retain the same newest request");
  } finally {
    resetAvailabilityStageMemoryForTesting();
    await clearPersistedAvailabilityStage();
    if (previousPersistence === undefined) delete process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE;
    else process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE = previousPersistence;
  }
});

test("an older malformed request cannot clear a newer valid staged authorization", async () => {
  resetAvailabilityStageMemoryForTesting();
  const delayed = delayedPost("{not-json");
  const olderResponse = POST(delayed.request);
  const artifact = currentArtifact({ records: [] });
  const recorded = await post({ policy, artifact });
  assert.equal(recorded.status, 200);

  delayed.release();
  const rejected = await olderResponse;
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "INVALID_JSON");

  const current = await GET(new Request("http://127.0.0.1:3000/api/availability"));
  assert.equal(current.status, 200);
  assert.deepEqual((await current.json()).artifact, artifact);
  resetAvailabilityStageMemoryForTesting();
});

test("invalid, stale, oversized, or non-JSON staging attempts clear prior authorization without echoing input", async () => {
  assert.equal((await post({ policy, artifact: currentArtifact() })).status, 200);
  const malicious = currentArtifact();
  malicious.records[0].modelTranscript = "private executable content";
  const rejected = await post({ policy, artifact: malicious });
  assert.equal(rejected.status, 422);
  const rejection = await rejected.json();
  assert.equal(rejection.code, "AVAILABILITY_STAGE_INVALID");
  assert.equal(JSON.stringify(rejection).includes("private executable content"), false);
  assert.equal((await GET(new Request("http://127.0.0.1:3000/api/availability"))).status, 404);

  const stale = currentArtifact({ generatedAt: timestamp(-31 * 60_000), records: [] });
  const staleResponse = await post({ policy, artifact: stale });
  assert.equal(staleResponse.status, 422);
  assert.equal((await staleResponse.json()).code, "AVAILABILITY_STAGE_NOT_FRESH");

  const invalidJson = await post("{not-json");
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).code, "INVALID_JSON");

  const oversized = await POST(new Request("http://127.0.0.1:3000/api/availability", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(256 * 1024 + 1) },
    body: "{}",
  }));
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).code, "STAGE_BODY_TOO_LARGE");
});

test("the CLI accepts only explicit local files and exact loopback HTTP", () => {
  assert.equal(normalizeAvailabilityOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => normalizeAvailabilityOrigin("https://127.0.0.1:3000"), /MUST_BE_LOOPBACK/);
  assert.throws(() => normalizeAvailabilityOrigin("http://192.168.1.2:3000"), /MUST_BE_LOOPBACK/);
  assert.throws(() => normalizeAvailabilityOrigin("http://localhost:3000/private"), /MUST_BE_LOOPBACK/);
  assert.throws(() => parseAvailabilityStageArguments(["--artifact", "one.json"]), /ARTIFACT_AND_POLICY_REQUIRED/);
  assert.throws(() => parseAvailabilityStageArguments(["--artifact", "one.json", "--policy", "two.json", "--secret", "x"]), /UNKNOWN_ARGUMENT/);
});

test("the CLI posts file contents but returns and logs only sanitized staging metadata", async () => {
  const artifactPath = new URL("../fixtures/availability-veto/fresh-hard-veto.example.json", import.meta.url);
  let requestBody = null;
  const result = await stageAvailabilityFromFiles({
    artifactPath,
    policyPath,
    origin: "http://127.0.0.1:3000",
  }, {
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:3000/api/availability");
      assert.equal(init.method, "POST");
      requestBody = JSON.parse(init.body);
      return Response.json({
        ok: true,
        code: "AVAILABILITY_STAGE_RECORDED",
        digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        stagedAt: "2026-08-28T00:00:00.000Z",
        artifactGeneratedAt: "2026-08-27T23:50:00.000Z",
        freshUntil: "2026-08-28T00:20:00.000Z",
        unresolvedCount: 0,
      });
    },
  });
  assert.deepEqual(Object.keys(requestBody).sort(), ["artifact", "policy"]);
  assert.deepEqual(Object.keys(result).sort(), [
    "artifactGeneratedAt", "code", "digest", "freshUntil", "ok", "stagedAt", "unresolvedCount",
  ]);
  assert.equal(Object.hasOwn(result, "artifact"), false);
  assert.equal(Object.hasOwn(result, "policy"), false);
});

test("the CLI never propagates untrusted response prose into operator output", async () => {
  const artifactPath = new URL("../fixtures/availability-veto/fresh-hard-veto.example.json", import.meta.url);
  await assert.rejects(() => stageAvailabilityFromFiles({
    artifactPath,
    policyPath,
    origin: "http://127.0.0.1:3000",
  }, {
    fetchImpl: async () => Response.json({
      ok: false,
      code: "PRIVATE_COOKIE_AND_LOCAL_PATH_WOULD_BE_HERE",
    }, { status: 422 }),
  }), { message: "AVAILABILITY_STAGE_REJECTED" });
});
