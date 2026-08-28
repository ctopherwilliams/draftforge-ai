import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RELEASE_INTEGRITY_SCHEMA_VERSION = 2;
export const RELEASE_MANIFEST_PATH = "/api/release-integrity";
export const RELEASE_MANIFEST_FILENAME = "draftforge-release-integrity.json";
export const SOURCE_TREE_DOMAIN = "draftforge-source-tree-v1";
export const CLIENT_ASSET_TREE_DOMAIN = "draftforge-client-assets-v1";
export const SERVER_ASSET_TREE_DOMAIN = "draftforge-server-assets-v1";
export const EXTENSION_TREE_DOMAIN = "draftforge-extension-tree-v1";
export const SYMLINK_FILE_DOMAIN = "draftforge-symlink-file-v1";
export const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;
export const MAX_RELEASE_ASSET_COUNT = 1_024;
export const MAX_RELEASE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_RELEASE_TOTAL_ASSET_BYTES = 32 * 1024 * 1024;
export const RELEASE_ASSET_FETCH_CONCURRENCY = 8;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const EXTENSION_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelativePath(path) {
  const normalized = String(path || "").split(sep).join("/");
  if (!normalized
    || normalized.includes("\0")
    || normalized.includes("\\")
    || normalized.startsWith("/")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`RELEASE_INTEGRITY_PATH_INVALID:${normalized}`);
  }
  return normalized;
}

function pathEscapesRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function fileBytes(filePath, root, domain) {
  const stat = lstatSync(filePath);
  if (!stat.isSymbolicLink()) {
    if (!stat.isFile()) throw new Error(`RELEASE_INTEGRITY_NOT_A_FILE:${filePath}`);
    return readFileSync(filePath);
  }

  // A browser fetch can prove only the served target bytes, not the local link
  // identity. Refuse client links instead of publishing an envelope hash that
  // no HTTP verifier could reproduce.
  if (domain === CLIENT_ASSET_TREE_DOMAIN) {
    throw new Error(`RELEASE_INTEGRITY_CLIENT_SYMLINK_UNSUPPORTED:${filePath}`);
  }

  // A link's text alone does not bind the bytes the runtime will execute. Hash
  // a domain-separated envelope containing both the exact link identity and
  // the resolved regular-file bytes, and reject links that escape the certified
  // tree or chain through another link.
  const targetIdentity = readlinkSync(filePath);
  const targetPath = resolve(dirname(filePath), targetIdentity);
  if (pathEscapesRoot(root, targetPath)) {
    throw new Error(`RELEASE_INTEGRITY_SYMLINK_ESCAPES_ROOT:${filePath}`);
  }
  const targetStat = lstatSync(targetPath);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`RELEASE_INTEGRITY_SYMLINK_CHAIN_UNSUPPORTED:${filePath}`);
  }
  if (!targetStat.isFile()) {
    throw new Error(`RELEASE_INTEGRITY_SYMLINK_TARGET_NOT_A_FILE:${filePath}`);
  }
  const identityBytes = Buffer.from(targetIdentity, "utf8");
  const targetBytes = readFileSync(targetPath);
  return Buffer.concat([
    Buffer.from(`${SYMLINK_FILE_DOMAIN}\n${identityBytes.length}:`, "utf8"),
    identityBytes,
    Buffer.from(`\n${targetBytes.length}:`, "utf8"),
    targetBytes,
  ]);
}

/**
 * The tree digest is intentionally non-circular: each sorted record contributes
 * UTF-8 path length, path, byte length, and SHA-256(bytes). Generated manifests
 * and build output are never members of the tracked-source tree.
 */
export function computeIntegrityTree(records, domain) {
  const normalized = records.map((record) => ({
    path: normalizeRelativePath(record.path),
    bytes: Number(record.bytes),
    sha256: String(record.sha256 || "").toLowerCase(),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const seen = new Set();
  let canonical = `${domain}\n`;
  let totalBytes = 0;
  for (const record of normalized) {
    if (seen.has(record.path)
      || !Number.isSafeInteger(record.bytes)
      || record.bytes < 0
      || !HASH_PATTERN.test(record.sha256)) {
      throw new Error(`RELEASE_INTEGRITY_RECORD_INVALID:${record.path}`);
    }
    seen.add(record.path);
    totalBytes += record.bytes;
    canonical += `${Buffer.byteLength(record.path, "utf8")}:${record.path}\0${record.bytes}:${record.sha256}\n`;
  }
  return {
    domain,
    sha256: sha256(Buffer.from(canonical, "utf8")),
    fileCount: normalized.length,
    totalBytes,
    files: normalized,
  };
}

export function computeFileTreeIntegrity(root, paths, domain) {
  const absoluteRoot = resolve(root);
  const records = paths.map((path) => {
    const normalized = normalizeRelativePath(path);
    const absolute = resolve(absoluteRoot, normalized);
    const rel = relative(absoluteRoot, absolute);
    if (!rel || rel.startsWith(`..${sep}`) || rel === "..") {
      throw new Error(`RELEASE_INTEGRITY_PATH_ESCAPES_ROOT:${normalized}`);
    }
    const bytes = fileBytes(absolute, absoluteRoot, domain);
    return { path: normalized, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return computeIntegrityTree(records, domain);
}

export function gitTrackedPaths(repoRoot = process.cwd()) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: resolve(repoRoot),
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.toString("utf8").split("\0").filter(Boolean).map(normalizeRelativePath).sort();
}

export function computeTrackedSourceIntegrity(repoRoot = process.cwd()) {
  return computeFileTreeIntegrity(repoRoot, gitTrackedPaths(repoRoot), SOURCE_TREE_DOMAIN);
}

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(normalizeRelativePath(relative(root, absolute)));
  }
  return files;
}

export function clientRuntimeAssetPaths(clientRoot) {
  return walkFiles(resolve(clientRoot)).filter((path) => {
    if (path === RELEASE_MANIFEST_FILENAME
      || path === "_headers"
      || path === "vinext-client-entry-manifest.json") return false;
    return !path.split("/").some((part) => part.startsWith("."));
  });
}

export function clientInternalRuntimeAssetPaths(clientRoot) {
  const exactClientRoot = resolve(clientRoot);
  const served = new Set(clientRuntimeAssetPaths(exactClientRoot));
  return walkFiles(exactClientRoot).filter((path) => (
    path !== RELEASE_MANIFEST_FILENAME && !served.has(path)
  ));
}

export function serverRuntimeAssetPaths(serverRoot) {
  return walkFiles(resolve(serverRoot));
}

export function computeServerRuntimeIntegrity(clientRoot, serverRoot) {
  const exactClientRoot = resolve(clientRoot);
  const exactServerRoot = resolve(serverRoot);
  const records = [
    ...serverRuntimeAssetPaths(exactServerRoot).map((path) => {
      const bytes = fileBytes(resolve(exactServerRoot, path), exactServerRoot, SERVER_ASSET_TREE_DOMAIN);
      return { path: `server/${path}`, bytes: bytes.length, sha256: sha256(bytes) };
    }),
    ...clientInternalRuntimeAssetPaths(exactClientRoot).map((path) => {
      const bytes = fileBytes(resolve(exactClientRoot, path), exactClientRoot, SERVER_ASSET_TREE_DOMAIN);
      return { path: `client/${path}`, bytes: bytes.length, sha256: sha256(bytes) };
    }),
  ];
  return computeIntegrityTree(records, SERVER_ASSET_TREE_DOMAIN);
}

function assertRuntimeAssetTreeBounds(tree) {
  if (!tree.fileCount || tree.fileCount > MAX_RELEASE_ASSET_COUNT
    || tree.totalBytes > MAX_RELEASE_TOTAL_ASSET_BYTES
    || tree.files.some((asset) => asset.bytes > MAX_RELEASE_ASSET_BYTES)) {
    throw new Error("RELEASE_INTEGRITY_ASSET_BOUNDS_INVALID");
  }
}

export function buildServedReleaseManifest({
  repoRoot = process.cwd(),
  clientRoot,
  serverRoot = resolve(clientRoot, "../server"),
  revision,
}) {
  const exactRevision = String(revision || "").trim().toLowerCase();
  if (!REVISION_PATTERN.test(exactRevision)) throw new Error("RELEASE_INTEGRITY_REVISION_INVALID");
  const sourceTree = computeTrackedSourceIntegrity(repoRoot);
  const clientAssetTree = computeFileTreeIntegrity(
    clientRoot,
    clientRuntimeAssetPaths(clientRoot),
    CLIENT_ASSET_TREE_DOMAIN,
  );
  const serverAssetTree = computeServerRuntimeIntegrity(clientRoot, serverRoot);
  assertRuntimeAssetTreeBounds(clientAssetTree);
  assertRuntimeAssetTreeBounds(serverAssetTree);
  return {
    schemaVersion: RELEASE_INTEGRITY_SCHEMA_VERSION,
    revision: exactRevision,
    sourceTree: {
      domain: sourceTree.domain,
      sha256: sourceTree.sha256,
      fileCount: sourceTree.fileCount,
    },
    clientAssets: {
      domain: clientAssetTree.domain,
      sha256: clientAssetTree.sha256,
      fileCount: clientAssetTree.fileCount,
      totalBytes: clientAssetTree.totalBytes,
      files: clientAssetTree.files.map((asset) => ({
        path: `/${asset.path}`,
        bytes: asset.bytes,
        sha256: asset.sha256,
      })),
    },
    // Server paths are not web resources, so only the domain-separated exact
    // tree summary is published. Local doctor/start verification recomputes the
    // complete dist/server tree plus Vinext's non-public dist/client metadata.
    serverAssets: {
      domain: serverAssetTree.domain,
      sha256: serverAssetTree.sha256,
      fileCount: serverAssetTree.fileCount,
      totalBytes: serverAssetTree.totalBytes,
    },
  };
}

export function writeServedReleaseManifest({
  repoRoot = process.cwd(),
  clientRoot,
  serverRoot = resolve(clientRoot, "../server"),
  revision,
}) {
  const manifest = buildServedReleaseManifest({ repoRoot, clientRoot, serverRoot, revision });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_RELEASE_MANIFEST_BYTES) throw new Error("RELEASE_INTEGRITY_MANIFEST_TOO_LARGE");
  const output = resolve(clientRoot, RELEASE_MANIFEST_FILENAME);
  const staging = mkdtempSync(join(resolve(clientRoot), ".draftforge-release-manifest-"));
  const staged = join(staging, RELEASE_MANIFEST_FILENAME);
  try {
    writeFileSync(staged, bytes, { mode: 0o644 });
    renameSync(staged, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { manifest, output, bytes: bytes.length };
}

function validatedAssetPath(path) {
  const value = String(path || "");
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("\0")
    || value.includes("?") || value.includes("#") || value.split("/").some((part) => part === "..")) {
    throw new Error("RELEASE_INTEGRITY_ASSET_PATH_INVALID");
  }
  return normalizeRelativePath(value.slice(1));
}

export function validateServedReleaseManifest(value) {
  if (!value || typeof value !== "object") throw new Error("RELEASE_INTEGRITY_MANIFEST_INVALID");
  const manifest = value;
  if (manifest.schemaVersion !== RELEASE_INTEGRITY_SCHEMA_VERSION
    || !REVISION_PATTERN.test(String(manifest.revision || ""))
    || manifest.sourceTree?.domain !== SOURCE_TREE_DOMAIN
    || !HASH_PATTERN.test(String(manifest.sourceTree?.sha256 || ""))
    || !Number.isSafeInteger(manifest.sourceTree?.fileCount)
    || manifest.sourceTree.fileCount <= 0
    || manifest.clientAssets?.domain !== CLIENT_ASSET_TREE_DOMAIN
    || !HASH_PATTERN.test(String(manifest.clientAssets?.sha256 || ""))
    || !Number.isSafeInteger(manifest.clientAssets?.fileCount)
    || !Number.isSafeInteger(manifest.clientAssets?.totalBytes)
    || !Array.isArray(manifest.clientAssets?.files)
    || manifest.clientAssets.fileCount !== manifest.clientAssets.files.length
    || manifest.clientAssets.fileCount <= 0
    || manifest.clientAssets.fileCount > MAX_RELEASE_ASSET_COUNT
    || manifest.clientAssets.totalBytes < 0
    || manifest.clientAssets.totalBytes > MAX_RELEASE_TOTAL_ASSET_BYTES
    || manifest.serverAssets?.domain !== SERVER_ASSET_TREE_DOMAIN
    || !HASH_PATTERN.test(String(manifest.serverAssets?.sha256 || ""))
    || !Number.isSafeInteger(manifest.serverAssets?.fileCount)
    || manifest.serverAssets.fileCount <= 0
    || manifest.serverAssets.fileCount > MAX_RELEASE_ASSET_COUNT
    || !Number.isSafeInteger(manifest.serverAssets?.totalBytes)
    || manifest.serverAssets.totalBytes < 0
    || manifest.serverAssets.totalBytes > MAX_RELEASE_TOTAL_ASSET_BYTES) {
    throw new Error("RELEASE_INTEGRITY_MANIFEST_INVALID");
  }
  const records = manifest.clientAssets.files.map((asset) => ({
    path: validatedAssetPath(asset?.path),
    bytes: Number(asset?.bytes),
    sha256: String(asset?.sha256 || "").toLowerCase(),
  }));
  if (records.some((asset) => !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > MAX_RELEASE_ASSET_BYTES)) {
    throw new Error("RELEASE_INTEGRITY_ASSET_BOUNDS_INVALID");
  }
  const tree = computeIntegrityTree(records, CLIENT_ASSET_TREE_DOMAIN);
  if (tree.sha256 !== manifest.clientAssets.sha256
    || tree.fileCount !== manifest.clientAssets.fileCount
    || tree.totalBytes !== manifest.clientAssets.totalBytes) {
    throw new Error("RELEASE_INTEGRITY_ASSET_SET_MISMATCH");
  }
  return manifest;
}

/**
 * Re-verify the exact on-disk production artifact immediately before it is
 * started. This closes the gap between a successful live doctor check and a
 * later `npm start`: neither a modified client byte, an extra client asset, nor
 * source-tree drift may inherit the prior certification.
 */
export function verifyLocalServedRelease({
  repoRoot = process.cwd(),
  clientRoot,
  serverRoot = resolve(clientRoot, "../server"),
  expectedRevision,
  expectedSourceTree,
}) {
  const exactClientRoot = resolve(clientRoot);
  const manifestPath = resolve(exactClientRoot, RELEASE_MANIFEST_FILENAME);
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > MAX_RELEASE_MANIFEST_BYTES) {
    throw new Error("RELEASE_INTEGRITY_MANIFEST_INVALID");
  }
  const manifestBytes = readFileSync(manifestPath);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("RELEASE_INTEGRITY_MANIFEST_JSON_INVALID");
  }
  const manifest = validateServedReleaseManifest(parsed);
  const revision = String(expectedRevision || manifest.revision).trim().toLowerCase();
  if (!REVISION_PATTERN.test(revision) || manifest.revision !== revision) {
    throw new Error("RELEASE_INTEGRITY_REVISION_MISMATCH");
  }

  const sourceTree = expectedSourceTree || computeTrackedSourceIntegrity(repoRoot);
  if (manifest.sourceTree.sha256 !== sourceTree.sha256
    || manifest.sourceTree.fileCount !== sourceTree.fileCount) {
    throw new Error("RELEASE_INTEGRITY_SOURCE_TREE_MISMATCH");
  }

  const assetTree = computeFileTreeIntegrity(
    exactClientRoot,
    clientRuntimeAssetPaths(exactClientRoot),
    CLIENT_ASSET_TREE_DOMAIN,
  );
  const declaredFiles = manifest.clientAssets.files.map((asset) => ({
    path: validatedAssetPath(asset.path),
    bytes: asset.bytes,
    sha256: asset.sha256,
  }));
  const sameFiles = assetTree.files.length === declaredFiles.length
    && assetTree.files.every((asset, index) => {
      const declared = declaredFiles[index];
      return declared?.path === asset.path
        && declared.bytes === asset.bytes
        && declared.sha256 === asset.sha256;
    });
  if (!sameFiles
    || assetTree.sha256 !== manifest.clientAssets.sha256
    || assetTree.fileCount !== manifest.clientAssets.fileCount
    || assetTree.totalBytes !== manifest.clientAssets.totalBytes) {
    throw new Error("RELEASE_INTEGRITY_LOCAL_ASSET_MISMATCH");
  }

  const exactServerRoot = resolve(serverRoot);
  const serverAssetTree = computeServerRuntimeIntegrity(exactClientRoot, exactServerRoot);
  try {
    assertRuntimeAssetTreeBounds(serverAssetTree);
  } catch {
    throw new Error("RELEASE_INTEGRITY_LOCAL_SERVER_ASSET_MISMATCH");
  }
  if (serverAssetTree.sha256 !== manifest.serverAssets.sha256
    || serverAssetTree.fileCount !== manifest.serverAssets.fileCount
    || serverAssetTree.totalBytes !== manifest.serverAssets.totalBytes) {
    throw new Error("RELEASE_INTEGRITY_LOCAL_SERVER_ASSET_MISMATCH");
  }

  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    sourceTree,
    assetTree,
    serverAssetTree,
  };
}

async function boundedResponseBytes(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("RELEASE_INTEGRITY_RESPONSE_TOO_LARGE");
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("RELEASE_INTEGRITY_RESPONSE_TOO_LARGE");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("RELEASE_INTEGRITY_RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function assertExactFetchResponse(response, expectedUrl) {
  if (!response?.ok) throw new Error(`RELEASE_INTEGRITY_HTTP_${response?.status || 0}`);
  if (response.redirected) throw new Error("RELEASE_INTEGRITY_REDIRECT_REJECTED");
  if (response.url) {
    const actual = new URL(response.url);
    const expected = new URL(expectedUrl);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
      throw new Error("RELEASE_INTEGRITY_RESPONSE_IDENTITY_MISMATCH");
    }
  }
}

export function dashboardRuntimeAssetPaths(html, origin) {
  const candidates = [
    ...String(html || "").matchAll(/<script[^>]+src=["']([^"']+)["']/gi),
    ...String(html || "").matchAll(/<link[^>]+href=["']([^"']+)["']/gi),
  ].map((match) => match[1]);
  return [...new Set(candidates.map((candidate) => {
    const url = new URL(candidate, origin);
    return url.origin === new URL(origin).origin && url.pathname.startsWith("/_next/") ? url.pathname : null;
  }).filter(Boolean))].sort();
}

export async function fetchAndVerifyServedRelease({
  origin,
  expectedRevision,
  expectedSourceTree,
  requiredRuntimeAssetPaths = [],
  fetchImpl = fetch,
}) {
  const base = String(origin || "").replace(/\/$/, "");
  const manifestUrl = `${base}${RELEASE_MANIFEST_PATH}`;
  const manifestResponse = await fetchImpl(manifestUrl, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
  });
  assertExactFetchResponse(manifestResponse, manifestUrl);
  const manifestBytes = await boundedResponseBytes(manifestResponse, MAX_RELEASE_MANIFEST_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error("RELEASE_INTEGRITY_MANIFEST_JSON_INVALID");
  }
  const manifest = validateServedReleaseManifest(parsed);
  if (manifest.revision !== expectedRevision) throw new Error("RELEASE_INTEGRITY_REVISION_MISMATCH");
  if (manifest.sourceTree.sha256 !== expectedSourceTree.sha256
    || manifest.sourceTree.fileCount !== expectedSourceTree.fileCount) {
    throw new Error("RELEASE_INTEGRITY_SOURCE_TREE_MISMATCH");
  }
  const declared = new Set(manifest.clientAssets.files.map((asset) => asset.path));
  if (requiredRuntimeAssetPaths.some((path) => !declared.has(path))) {
    throw new Error("RELEASE_INTEGRITY_RUNTIME_ASSET_UNDECLARED");
  }
  let nextAssetIndex = 0;
  const verifyNextAsset = async () => {
    while (nextAssetIndex < manifest.clientAssets.files.length) {
      const asset = manifest.clientAssets.files[nextAssetIndex];
      nextAssetIndex += 1;
      const assetUrl = `${base}${asset.path}`;
      const response = await fetchImpl(assetUrl, {
        headers: { Accept: "*/*", "Cache-Control": "no-cache" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      assertExactFetchResponse(response, assetUrl);
      const bytes = await boundedResponseBytes(response, Math.min(MAX_RELEASE_ASSET_BYTES, asset.bytes + 1));
      if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) {
        throw new Error(`RELEASE_INTEGRITY_ASSET_MISMATCH:${asset.path}`);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(RELEASE_ASSET_FETCH_CONCURRENCY, manifest.clientAssets.files.length) },
    () => verifyNextAsset(),
  ));
  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    assetCount: manifest.clientAssets.fileCount,
    totalAssetBytes: manifest.clientAssets.totalBytes,
    serverAssetSetSha256: manifest.serverAssets.sha256,
    serverAssetCount: manifest.serverAssets.fileCount,
    totalServerAssetBytes: manifest.serverAssets.totalBytes,
  };
}

export function extensionSourcePaths(extensionDir) {
  const entries = readdirSync(resolve(extensionDir), { withFileTypes: true });
  const unsupported = entries.find((entry) => !entry.name.startsWith(".") && !entry.isFile());
  if (unsupported) throw new Error(`EXTENSION_SOURCE_ENTRY_INVALID:${unsupported.name}`);
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => normalizeRelativePath(entry.name))
    .sort();
}

export function computeExtensionDirectoryIntegrity(extensionDir) {
  return computeFileTreeIntegrity(extensionDir, extensionSourcePaths(extensionDir), EXTENSION_TREE_DOMAIN);
}

export function computeExtensionZipIntegrity(zipPath, unzipExecutable = "/usr/bin/unzip") {
  const exactZip = resolve(zipPath);
  const listing = execFileSync(unzipExecutable, ["-Z1", exactZip], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean);
  const paths = listing.map(normalizeRelativePath);
  if (!paths.length || new Set(paths).size !== paths.length || paths.some((path) => path.endsWith("/"))) {
    throw new Error("EXTENSION_ZIP_ENTRIES_INVALID");
  }
  const records = paths.map((path) => {
    const bytes = execFileSync(unzipExecutable, ["-p", exactZip, path], {
      encoding: "buffer",
      maxBuffer: MAX_RELEASE_ASSET_BYTES,
    });
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    ...computeIntegrityTree(records, EXTENSION_TREE_DOMAIN),
    packageSha256: sha256(readFileSync(exactZip)),
  };
}

export function validateDraftDayReleaseConfig(value) {
  if (!value || typeof value !== "object"
    || value.schemaVersion !== 2
    || !EXTENSION_VERSION_PATTERN.test(String(value.extensionVersion || ""))
    || !HASH_PATTERN.test(String(value.extensionPackageSha256 || ""))
    || !HASH_PATTERN.test(String(value.extensionSourceSha256 || ""))
    || !Number.isSafeInteger(value.extensionSourceFileCount)
    || value.extensionSourceFileCount <= 0) {
    throw new Error("DRAFT_DAY_RELEASE_CONFIG_INVALID");
  }
  return value;
}

export function verifyExtensionReleaseArtifacts({ extensionDir, zipPath, releaseConfig }) {
  const expected = validateDraftDayReleaseConfig(releaseConfig);
  const directory = computeExtensionDirectoryIntegrity(extensionDir);
  const archive = computeExtensionZipIntegrity(zipPath);
  const sameFiles = directory.fileCount === archive.fileCount
    && directory.files.every((file, index) => {
      const zipped = archive.files[index];
      return zipped?.path === file.path && zipped.bytes === file.bytes && zipped.sha256 === file.sha256;
    });
  return {
    directory,
    archive,
    checks: {
      directoryPackageBytesMatch: sameFiles && directory.sha256 === archive.sha256,
      releasePackageSha256Match: archive.packageSha256 === expected.extensionPackageSha256,
      releaseSourceSha256Match: directory.sha256 === expected.extensionSourceSha256
        && archive.sha256 === expected.extensionSourceSha256,
      releaseSourceFileCountMatch: directory.fileCount === expected.extensionSourceFileCount
        && archive.fileCount === expected.extensionSourceFileCount,
    },
  };
}
