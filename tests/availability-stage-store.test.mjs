import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AVAILABILITY_STAGE_SCHEMA,
  clearPersistedAvailabilityStage,
  loadPersistedAvailabilityStage,
  parsePersistedAvailabilityStage,
  persistAvailabilityStage,
} from "../app/lib/availability-stage-store.ts";

const now = Date.now();
const iso = (offset = 0) => new Date(now + offset).toISOString();
const policy = {
  schemaVersion: "draftforge.availability-policy/v1",
  maxAgeMinutes: 30,
  officialDomains: ["nfl.com"],
  reputableDomains: ["espn.com"],
};
const artifact = {
  schemaVersion: "draftforge.availability/v1",
  generatedAt: iso(-10_000),
  scanReceipt: {
    completedAt: iso(-20_000),
    feeds: [
      { id: "authenticated_espn_player_news", url: "https://fantasy.espn.com/football/playernews", retrievedAt: iso(-20_000), status: "ok" },
      { id: "official_nfl_news", url: "https://www.nfl.com/news/", retrievedAt: iso(-20_000), status: "ok" },
    ],
  },
  records: [],
};

test("availability stage persistence is atomic, private, bounded, and exactly replayable", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "draftforge-availability-store-"));
  const stagePath = path.join(root, "state", "availability.json");
  context.after(async () => clearPersistedAvailabilityStage(stagePath));

  const persisted = await persistAvailabilityStage({ stagedAt: iso(), artifact, policy }, stagePath);
  assert.equal(persisted.schemaVersion, AVAILABILITY_STAGE_SCHEMA);
  assert.equal((await stat(stagePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(stagePath))).mode & 0o777, 0o700);
  assert.equal((await readFile(stagePath, "utf8")).includes("espn_s2"), false);

  const recovered = await loadPersistedAvailabilityStage(stagePath);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.value, persisted);
  assert.equal(Object.isFrozen(recovered.value), true);
  assert.equal(Object.isFrozen(recovered.value.artifact), true);
});

test("malformed, expanded, missing, and oversized persisted stages fail closed", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "draftforge-availability-invalid-"));
  const stagePath = path.join(root, "availability.json");
  context.after(async () => clearPersistedAvailabilityStage(stagePath));

  const expanded = parsePersistedAvailabilityStage({
    schemaVersion: AVAILABILITY_STAGE_SCHEMA,
    stagedAt: iso(),
    artifact,
    policy,
    cookie: "forbidden",
  });
  assert.equal(expanded.ok, false);
  assert.equal(expanded.code, "AVAILABILITY_STAGE_PERSISTED_INVALID");

  assert.equal((await loadPersistedAvailabilityStage(stagePath)).code, "AVAILABILITY_STAGE_NOT_FOUND");
  await writeFile(stagePath, "{broken-json", { mode: 0o600 });
  assert.equal((await loadPersistedAvailabilityStage(stagePath)).code, "AVAILABILITY_STAGE_PERSISTED_INVALID");
  await writeFile(stagePath, "x".repeat(256 * 1024 + 1));
  await chmod(stagePath, 0o600);
  assert.equal((await loadPersistedAvailabilityStage(stagePath)).code, "AVAILABILITY_STAGE_PERSISTED_INVALID");
});
