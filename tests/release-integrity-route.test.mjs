import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GET,
  serveReleaseIntegrityManifest,
} from "../app/draftforge-release-integrity.json/route.ts";
import {
  MAX_SERVED_RELEASE_MANIFEST_BYTES,
  readServedReleaseManifest,
} from "../app/lib/release-integrity-response.ts";
import { MAX_RELEASE_MANIFEST_BYTES } from "../scripts/release-integrity-lib.mjs";

test("route and release verifier enforce the same manifest byte ceiling", () => {
  assert.equal(MAX_SERVED_RELEASE_MANIFEST_BYTES, MAX_RELEASE_MANIFEST_BYTES);
});

test("release integrity route serves the exact bounded post-build manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-release-route-"));
  const manifestPath = join(root, "draftforge-release-integrity.json");
  try {
    const exact = Buffer.from('{"schemaVersion":2,"revision":"exact"}\n');
    await writeFile(manifestPath, exact);
    const bytes = await readServedReleaseManifest({ manifestPath });
    assert.deepEqual(Buffer.from(bytes), exact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release integrity reader fails closed for missing, malformed, empty, and oversized artifacts", async () => {
  await assert.rejects(
    () => readServedReleaseManifest({ manifestPath: "/definitely/missing/draftforge-release-integrity.json" }),
  );
  await assert.rejects(
    () => readServedReleaseManifest({ readFileImpl: async () => new Uint8Array() }),
    /MANIFEST_EMPTY/,
  );
  await assert.rejects(
    () => readServedReleaseManifest({ readFileImpl: async () => Buffer.from("not-json") }),
    /INVALID_JSON/,
  );
  await assert.rejects(
    () => readServedReleaseManifest({ readFileImpl: async () => Uint8Array.from([0xff]) }),
    /INVALID_JSON/,
  );
  await assert.rejects(
    () => readServedReleaseManifest({ readFileImpl: async () => Buffer.from("[]") }),
    /INVALID_JSON/,
  );
  await assert.rejects(
    () => readServedReleaseManifest({
      readFileImpl: async () => Buffer.alloc(MAX_SERVED_RELEASE_MANIFEST_BYTES + 1, 32),
    }),
    /TOO_LARGE/,
  );
});

test("release integrity route preserves exact bytes and hardened response headers", async () => {
  const exact = Buffer.from('{"schemaVersion":2}\n');
  const response = await serveReleaseIntegrityManifest(
    new Request("http://127.0.0.1:3000/draftforge-release-integrity.json"),
    async () => new Uint8Array(exact),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("content-length"), String(exact.byteLength));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), exact);
});

test("release integrity route rejects query ambiguity and sanitizes artifact failures", async () => {
  const ambiguous = await GET(new Request("http://127.0.0.1:3000/draftforge-release-integrity.json?cache=old"));
  assert.equal(ambiguous.status, 400);
  assert.deepEqual(await ambiguous.json(), {
    ok: false,
    code: "RELEASE_INTEGRITY_QUERY_NOT_SUPPORTED",
  });

  const unavailable = await serveReleaseIntegrityManifest(
    new Request("http://127.0.0.1:3000/draftforge-release-integrity.json"),
    async () => { throw new Error("sensitive local path"); },
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    ok: false,
    code: "RELEASE_INTEGRITY_MANIFEST_UNAVAILABLE",
  });
});
