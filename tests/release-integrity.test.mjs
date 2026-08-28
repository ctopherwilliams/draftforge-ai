import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CLIENT_ASSET_TREE_DOMAIN,
  EXTENSION_TREE_DOMAIN,
  MAX_RELEASE_ASSET_BYTES,
  RELEASE_MANIFEST_PATH,
  SERVER_ASSET_TREE_DOMAIN,
  buildServedReleaseManifest,
  computeExtensionDirectoryIntegrity,
  computeIntegrityTree,
  computeTrackedSourceIntegrity,
  dashboardRuntimeAssetPaths,
  fetchAndVerifyServedRelease,
  validateServedReleaseManifest,
  verifyExtensionReleaseArtifacts,
  verifyLocalServedRelease,
  writeServedReleaseManifest,
} from "../scripts/release-integrity-lib.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

test("integrity trees are deterministic and byte-sensitive", () => {
  const records = [
    { path: "b.js", bytes: 1, sha256: "b".repeat(64) },
    { path: "a.js", bytes: 2, sha256: "a".repeat(64) },
  ];
  const left = computeIntegrityTree(records, EXTENSION_TREE_DOMAIN);
  const right = computeIntegrityTree([...records].reverse(), EXTENSION_TREE_DOMAIN);
  assert.equal(left.sha256, right.sha256);
  assert.deepEqual(left.files.map((file) => file.path), ["a.js", "b.js"]);
  const changed = computeIntegrityTree([
    { ...records[0], sha256: "c".repeat(64) },
    records[1],
  ], EXTENSION_TREE_DOMAIN);
  assert.notEqual(left.sha256, changed.sha256);
  assert.throws(() => computeIntegrityTree([...records, records[0]], EXTENSION_TREE_DOMAIN), /RECORD_INVALID/);
});

test("served release verification fetches and hashes every declared runtime asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-release-test-"));
  const clientRoot = join(root, "client");
  const serverRoot = join(root, "server");
  try {
    await mkdir(join(clientRoot, "_next/static/chunks"), { recursive: true });
    await mkdir(join(serverRoot, "_next/static/chunks"), { recursive: true });
    await writeFile(join(clientRoot, "_next/static/chunks/app.js"), "console.log('exact');\n");
    await writeFile(join(clientRoot, "favicon.svg"), "<svg/>\n");
    await writeFile(join(serverRoot, "index.js"), "export default { fetch() {} };\n");
    await writeFile(join(serverRoot, "_next/static/chunks/route.js"), "export const route = true;\n");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const sourceTree = computeTrackedSourceIntegrity(repoRoot);
    const manifest = buildServedReleaseManifest({ repoRoot, clientRoot, serverRoot, revision });
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const files = new Map(await Promise.all(manifest.clientAssets.files.map(async (asset) => [
      asset.path,
      await readFile(join(clientRoot, asset.path.slice(1))),
    ])));
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      const body = path === RELEASE_MANIFEST_PATH ? manifestBytes : files.get(path);
      return body ? new Response(body, { status: 200, headers: { "content-length": String(body.length) } }) : new Response("missing", { status: 404 });
    };
    const verified = await fetchAndVerifyServedRelease({
      origin: "http://127.0.0.1:3000",
      expectedRevision: revision,
      expectedSourceTree: sourceTree,
      requiredRuntimeAssetPaths: ["/_next/static/chunks/app.js"],
      fetchImpl,
    });
    assert.equal(verified.assetCount, 2);
    assert.equal(verified.serverAssetCount, 2);

    const tamperedFetch = async (url, init) => {
      if (new URL(url).pathname === "/favicon.svg") return new Response("<bad/>\n", { status: 200 });
      return fetchImpl(url, init);
    };
    await assert.rejects(() => fetchAndVerifyServedRelease({
      origin: "http://127.0.0.1:3000",
      expectedRevision: revision,
      expectedSourceTree: sourceTree,
      fetchImpl: tamperedFetch,
    }), /ASSET_MISMATCH/);
    await assert.rejects(() => fetchAndVerifyServedRelease({
      origin: "http://127.0.0.1:3000",
      expectedRevision: revision,
      expectedSourceTree: sourceTree,
      requiredRuntimeAssetPaths: ["/_next/static/chunks/not-served.js"],
      fetchImpl,
    }), /RUNTIME_ASSET_UNDECLARED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local release verification rejects a built-byte mutation after certification", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-local-release-test-"));
  const clientRoot = join(root, "client");
  const serverRoot = join(root, "server");
  try {
    await mkdir(join(clientRoot, "_next/static/chunks"), { recursive: true });
    await mkdir(serverRoot, { recursive: true });
    const assetPath = join(clientRoot, "_next/static/chunks/app.js");
    await writeFile(assetPath, "console.log('certified');\n");
    await writeFile(join(serverRoot, "index.js"), "export const certified = true;\n");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    writeServedReleaseManifest({ repoRoot, clientRoot, serverRoot, revision });
    const exact = verifyLocalServedRelease({ repoRoot, clientRoot, serverRoot, expectedRevision: revision });
    assert.equal(exact.assetTree.fileCount, 1);

    await writeFile(assetPath, "console.log('mutated');\n");
    assert.throws(
      () => verifyLocalServedRelease({ repoRoot, clientRoot, serverRoot, expectedRevision: revision }),
      /LOCAL_ASSET_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local release verification rejects entry, nested, added, and removed server bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-server-release-test-"));
  const clientRoot = join(root, "client");
  const serverRoot = join(root, "server");
  try {
    await mkdir(clientRoot, { recursive: true });
    await mkdir(join(serverRoot, "_next/static/chunks"), { recursive: true });
    await writeFile(join(clientRoot, "app.js"), "console.log('client');\n");
    const entry = join(serverRoot, "index.js");
    const chunk = join(serverRoot, "_next/static/chunks/route.js");
    await writeFile(entry, "export const entry = true;\n");
    await writeFile(chunk, "export const route = true;\n");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    writeServedReleaseManifest({ repoRoot, clientRoot, serverRoot, revision });
    const verify = () => verifyLocalServedRelease({ repoRoot, clientRoot, serverRoot, expectedRevision: revision });
    assert.doesNotThrow(verify);

    await writeFile(entry, "export const entry = false;\n");
    assert.throws(verify, /LOCAL_SERVER_ASSET_MISMATCH/);
    await writeFile(entry, "export const entry = true;\n");

    await writeFile(chunk, "export const route = false;\n");
    assert.throws(verify, /LOCAL_SERVER_ASSET_MISMATCH/);
    await writeFile(chunk, "export const route = true;\n");

    const added = join(serverRoot, "unexpected.js");
    await writeFile(added, "unexpected\n");
    assert.throws(verify, /LOCAL_SERVER_ASSET_MISMATCH/);
    await rm(added);

    await rm(chunk);
    assert.throws(verify, /LOCAL_SERVER_ASSET_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local release verification binds symlink identity and target bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-symlink-release-test-"));
  const clientRoot = join(root, "client");
  const serverRoot = join(root, "server");
  try {
    await mkdir(clientRoot, { recursive: true });
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(clientRoot, "app.js"), "console.log('client');\n");
    const target = join(serverRoot, "target.js");
    await writeFile(target, "export const target = 'certified';\n");
    await symlink("target.js", join(serverRoot, "index.js"));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    writeServedReleaseManifest({ repoRoot, clientRoot, serverRoot, revision });
    const verify = () => verifyLocalServedRelease({
      repoRoot,
      clientRoot,
      serverRoot,
      expectedRevision: revision,
    });
    assert.doesNotThrow(verify);

    await writeFile(target, "export const target = 'mutated';\n");
    assert.throws(verify, /LOCAL_SERVER_ASSET_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked-source integrity binds a symlink's exact identity and ignored target bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-source-symlink-test-"));
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    await writeFile(join(root, ".gitignore"), "target-*.js\n");
    await writeFile(join(root, "target-one.js"), "export const target = 'same';\n");
    await writeFile(join(root, "target-two.js"), "export const target = 'same';\n");
    const entry = join(root, "entry.js");
    await symlink("target-one.js", entry);
    execFileSync("git", ["add", ".gitignore", "entry.js"], { cwd: root, stdio: "ignore" });
    const original = computeTrackedSourceIntegrity(root);

    await rm(entry);
    await symlink("target-two.js", entry);
    const retargeted = computeTrackedSourceIntegrity(root);
    assert.notEqual(retargeted.sha256, original.sha256, "link identity must affect source integrity");

    await writeFile(join(root, "target-two.js"), "export const target = 'mutated';\n");
    const targetMutated = computeTrackedSourceIntegrity(root);
    assert.notEqual(targetMutated.sha256, retargeted.sha256, "target bytes must affect source integrity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release certification rejects symlinks that escape the certified tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-symlink-escape-test-"));
  const clientRoot = join(root, "client");
  const serverRoot = join(root, "server");
  try {
    await mkdir(clientRoot, { recursive: true });
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(clientRoot, "app.js"), "console.log('client');\n");
    await writeFile(join(root, "outside.js"), "export const outside = true;\n");
    await symlink("../outside.js", join(serverRoot, "index.js"));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    assert.throws(
      () => writeServedReleaseManifest({ repoRoot, clientRoot, serverRoot, revision }),
      /SYMLINK_ESCAPES_ROOT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release certification rejects client symlinks whose identity cannot be verified over HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-client-symlink-test-"));
  const clientRoot = join(root, "client");
  const serverRoot = join(root, "server");
  try {
    await mkdir(clientRoot, { recursive: true });
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(clientRoot, "target.js"), "console.log('client');\n");
    await symlink("target.js", join(clientRoot, "app.js"));
    await writeFile(join(serverRoot, "index.js"), "export const server = true;\n");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    assert.throws(
      () => writeServedReleaseManifest({ repoRoot, clientRoot, serverRoot, revision }),
      /CLIENT_SYMLINK_UNSUPPORTED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("served manifest validation rejects oversized and internally inconsistent assets", () => {
  const files = [{ path: "asset.js", bytes: 1, sha256: "a".repeat(64) }];
  const tree = computeIntegrityTree(files, CLIENT_ASSET_TREE_DOMAIN);
  const serverTree = computeIntegrityTree([
    { path: "index.js", bytes: 1, sha256: "d".repeat(64) },
  ], SERVER_ASSET_TREE_DOMAIN);
  const manifest = {
    schemaVersion: 2,
    revision: "a".repeat(40),
    sourceTree: { domain: "draftforge-source-tree-v1", sha256: "b".repeat(64), fileCount: 1 },
    clientAssets: { ...tree, files: tree.files.map((file) => ({ ...file, path: `/${file.path}` })) },
    serverAssets: {
      domain: serverTree.domain,
      sha256: serverTree.sha256,
      fileCount: serverTree.fileCount,
      totalBytes: serverTree.totalBytes,
    },
  };
  assert.doesNotThrow(() => validateServedReleaseManifest(manifest));
  assert.throws(() => validateServedReleaseManifest({
    ...manifest,
    clientAssets: {
      ...manifest.clientAssets,
      files: [{ ...manifest.clientAssets.files[0], bytes: MAX_RELEASE_ASSET_BYTES + 1 }],
    },
  }), /ASSET_BOUNDS_INVALID/);
  assert.throws(() => validateServedReleaseManifest({
    ...manifest,
    clientAssets: { ...manifest.clientAssets, sha256: "c".repeat(64) },
  }), /ASSET_SET_MISMATCH/);
});

test("extension ZIP provenance proves exact file bytes and release-config binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "draftforge-extension-test-"));
  const extensionDir = join(root, "extension");
  const zipPath = join(root, "companion.zip");
  try {
    await mkdir(extensionDir);
    await writeFile(join(extensionDir, "background.js"), "export const exact = true;\n");
    await writeFile(join(extensionDir, "manifest.json"), "{\"manifest_version\":3}\n");
    execFileSync("/usr/bin/zip", ["-X", "-q", zipPath, "background.js", "manifest.json"], { cwd: extensionDir });
    const source = computeExtensionDirectoryIntegrity(extensionDir);
    const packageBytes = await readFile(zipPath);
    const releaseConfig = {
      schemaVersion: 2,
      extensionVersion: "1.2.3",
      extensionPackageSha256: (await import("node:crypto")).createHash("sha256").update(packageBytes).digest("hex"),
      extensionSourceSha256: source.sha256,
      extensionSourceFileCount: source.fileCount,
    };
    const exact = verifyExtensionReleaseArtifacts({ extensionDir, zipPath, releaseConfig });
    assert.deepEqual(exact.checks, {
      directoryPackageBytesMatch: true,
      releasePackageSha256Match: true,
      releaseSourceSha256Match: true,
      releaseSourceFileCountMatch: true,
    });
    await writeFile(join(extensionDir, "background.js"), "export const exact = false;\n");
    const drift = verifyExtensionReleaseArtifacts({ extensionDir, zipPath, releaseConfig });
    assert.equal(drift.checks.directoryPackageBytesMatch, false);
    assert.equal(drift.checks.releaseSourceSha256Match, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checked-in extension release exactly matches source, package, config, and manifest version", async () => {
  const extensionDir = join(repoRoot, "extension");
  const zipPath = join(repoRoot, "public", "draftforge-espn-companion.zip");
  const releaseConfig = JSON.parse(await readFile(
    join(repoRoot, "config", "draft-day-release.json"),
    "utf8",
  ));
  const extensionManifest = JSON.parse(await readFile(
    join(extensionDir, "manifest.json"),
    "utf8",
  ));
  const verified = verifyExtensionReleaseArtifacts({ extensionDir, zipPath, releaseConfig });

  assert.equal(
    extensionManifest.version,
    releaseConfig.extensionVersion,
    "extension manifest version must match the certified release config",
  );
  assert.deepEqual(verified.checks, {
    directoryPackageBytesMatch: true,
    releasePackageSha256Match: true,
    releaseSourceSha256Match: true,
    releaseSourceFileCountMatch: true,
  }, "checked-in extension source, ZIP bytes, and certified release config must be identical");
});

test("dashboard runtime asset discovery is same-origin and de-duplicated", () => {
  const html = '<script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/a.js"></script><link href="/_next/static/css/a.css" rel="stylesheet"><script src="https://evil.example/x.js"></script>';
  assert.deepEqual(dashboardRuntimeAssetPaths(html, "http://127.0.0.1:3000"), [
    "/_next/static/chunks/a.js",
    "/_next/static/css/a.css",
  ]);
});

test("operator documentation preserves the one-request read-only status contract", async () => {
  const operatorDocs = [
    "README.md",
    "AGENT_HANDOFF.md",
    "DRAFT_DAY_HANDOVER.md",
    "docs/live-control-release-gate.md",
    "docs/post-live-draft-hardening-20260828.md",
    "docs/real-draft-issues-20260827.md",
  ];
  const contents = await Promise.all(operatorDocs.map(async (path) => ({
    path,
    text: await readFile(join(repoRoot, path), "utf8"),
  })));
  for (const { path, text } of contents) {
    assert.doesNotMatch(
      text,
      /two bounded(?:,)?(?: parallel)? loopback GETs|two bounded parallel|exactly two bounded parallel loopback GETs/i,
      `${path} must not revive the retired two-request status design`,
    );
  }
  const contract = contents.map(({ text }) => text).join("\n");
  assert.match(contract, /exactly one bounded \(750 ms, 64 KiB\) loopback GET/i);
});
