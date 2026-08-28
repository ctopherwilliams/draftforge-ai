#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_FILE_BYTES = 256 * 1024;

export function normalizeAvailabilityOrigin(value) {
  const url = new URL(String(value || "http://127.0.0.1:3000"));
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password
    || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw new Error("AVAILABILITY_ORIGIN_MUST_BE_LOOPBACK_HTTP");
  }
  return url.origin;
}

export function parseAvailabilityStageArguments(argv) {
  const values = new Map();
  const allowed = new Set(["--artifact", "--policy", "--origin"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) throw new Error("UNKNOWN_ARGUMENT");
    if (!argv[index + 1]) throw new Error("ARGUMENT_VALUE_REQUIRED");
    if (values.has(argument)) throw new Error("DUPLICATE_ARGUMENT");
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  if (!values.get("--artifact") || !values.get("--policy")) throw new Error("ARTIFACT_AND_POLICY_REQUIRED");
  return {
    artifactPath: resolve(String(values.get("--artifact"))),
    policyPath: resolve(String(values.get("--policy"))),
    origin: normalizeAvailabilityOrigin(values.get("--origin")),
  };
}

async function readBoundedJsonFile(path, code, { readFileImpl = readFile, statImpl = stat } = {}) {
  let metadata;
  try {
    metadata = await statImpl(path);
  } catch {
    throw new Error(`${code}_READ_FAILED`);
  }
  if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 2 || metadata.size > MAX_FILE_BYTES) {
    throw new Error(`${code}_SIZE_INVALID`);
  }
  let text;
  try {
    text = await readFileImpl(path, "utf8");
  } catch {
    throw new Error(`${code}_READ_FAILED`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${code}_JSON_INVALID`);
  }
}

export async function stageAvailabilityFromFiles(options, dependencies = {}) {
  const artifact = await readBoundedJsonFile(options.artifactPath, "ARTIFACT", dependencies);
  const policy = await readBoundedJsonFile(options.policyPath, "POLICY", dependencies);
  let response;
  try {
    response = await (dependencies.fetchImpl || fetch)(`${normalizeAvailabilityOrigin(options.origin)}/api/availability`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ artifact, policy }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("AVAILABILITY_STAGE_TRANSPORT_FAILED");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("AVAILABILITY_STAGE_RESPONSE_INVALID");
  }
  if (!response.ok || result?.ok !== true || result?.code !== "AVAILABILITY_STAGE_RECORDED") {
    throw new Error("AVAILABILITY_STAGE_REJECTED");
  }
  const strictTimestamp = (value) => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
  if (!/^sha256:[a-f0-9]{64}$/.test(String(result.digest || ""))
    || !strictTimestamp(result.stagedAt) || !strictTimestamp(result.artifactGeneratedAt)
    || !strictTimestamp(result.freshUntil) || !Number.isSafeInteger(result.unresolvedCount)
    || result.unresolvedCount < 0 || result.unresolvedCount > 512) {
    throw new Error("AVAILABILITY_STAGE_RESPONSE_INVALID");
  }
  return {
    ok: true,
    code: result.code,
    digest: result.digest,
    stagedAt: result.stagedAt,
    artifactGeneratedAt: result.artifactGeneratedAt,
    freshUntil: result.freshUntil,
    unresolvedCount: result.unresolvedCount,
  };
}

async function main() {
  let options;
  try {
    options = parseAvailabilityStageArguments(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error instanceof Error ? error.message : "USAGE",
      usage: "npm run availability:stage -- --artifact <local-json> --policy <local-json>",
    }));
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(await stageAvailabilityFromFiles(options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof Error ? error.message : "AVAILABILITY_STAGE_FAILED" }));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
