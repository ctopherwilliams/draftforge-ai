import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  parseAvailabilityArtifact,
  parseAvailabilityPolicy,
  type AvailabilityArtifact,
  type AvailabilityPolicy,
} from "./availability-veto.ts";

export const AVAILABILITY_STAGE_SCHEMA = "draftforge.availability-stage/v1" as const;
export const MAX_PERSISTED_AVAILABILITY_STAGE_BYTES = 256 * 1024;

export type PersistedAvailabilityStage = Readonly<{
  schemaVersion: typeof AVAILABILITY_STAGE_SCHEMA;
  stagedAt: string;
  artifact: AvailabilityArtifact;
  policy: AvailabilityPolicy;
}>;

export type AvailabilityStageLoadResult = Readonly<
  | { ok: true; value: PersistedAvailabilityStage; code: "AVAILABILITY_STAGE_RECOVERED" }
  | {
    ok: false;
    value: null;
    code: "AVAILABILITY_STAGE_NOT_FOUND" | "AVAILABILITY_STAGE_PERSISTED_INVALID";
  }
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as Readonly<T>;
}

export function defaultAvailabilityStagePath(projectRoot = process.cwd()) {
  const testSuffix = process.env.NODE_TEST_CONTEXT ? `-${process.pid}.test` : "";
  return path.join(path.resolve(projectRoot), ".draftforge", `availability-stage${testSuffix}.json`);
}

export function parsePersistedAvailabilityStage(value: unknown): AvailabilityStageLoadResult {
  if (!isPlainObject(value)
    || Object.keys(value).sort().join("|") !== "artifact|policy|schemaVersion|stagedAt"
    || value.schemaVersion !== AVAILABILITY_STAGE_SCHEMA
    || !isStrictIsoTimestamp(value.stagedAt)) {
    return Object.freeze({ ok: false, value: null, code: "AVAILABILITY_STAGE_PERSISTED_INVALID" });
  }
  const artifact = parseAvailabilityArtifact(value.artifact);
  const policy = parseAvailabilityPolicy(value.policy);
  if (!artifact.ok || !policy.ok) {
    return Object.freeze({ ok: false, value: null, code: "AVAILABILITY_STAGE_PERSISTED_INVALID" });
  }
  return Object.freeze({
    ok: true,
    code: "AVAILABILITY_STAGE_RECOVERED",
    value: deepFreeze({
      schemaVersion: AVAILABILITY_STAGE_SCHEMA,
      stagedAt: value.stagedAt,
      artifact: artifact.value,
      policy: policy.value,
    }),
  });
}

export async function loadPersistedAvailabilityStage(
  stagePath = defaultAvailabilityStagePath(),
): Promise<AvailabilityStageLoadResult> {
  try {
    const metadata = await stat(stagePath);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_PERSISTED_AVAILABILITY_STAGE_BYTES) {
      return Object.freeze({ ok: false, value: null, code: "AVAILABILITY_STAGE_PERSISTED_INVALID" });
    }
    const raw = await readFile(stagePath, "utf8");
    return parsePersistedAvailabilityStage(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return Object.freeze({ ok: false, value: null, code: "AVAILABILITY_STAGE_NOT_FOUND" });
    }
    return Object.freeze({ ok: false, value: null, code: "AVAILABILITY_STAGE_PERSISTED_INVALID" });
  }
}

export async function persistAvailabilityStage(
  value: Omit<PersistedAvailabilityStage, "schemaVersion">,
  stagePath = defaultAvailabilityStagePath(),
) {
  const parsed = parsePersistedAvailabilityStage({
    schemaVersion: AVAILABILITY_STAGE_SCHEMA,
    ...value,
  });
  if (!parsed.ok) throw new Error(parsed.code);

  const serialized = `${JSON.stringify(parsed.value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_AVAILABILITY_STAGE_BYTES) {
    throw new Error("AVAILABILITY_STAGE_PERSISTED_TOO_LARGE");
  }

  const directory = path.dirname(stagePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${stagePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, stagePath);
    await chmod(stagePath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return parsed.value;
}

export async function clearPersistedAvailabilityStage(stagePath = defaultAvailabilityStagePath()) {
  try {
    await unlink(stagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}
