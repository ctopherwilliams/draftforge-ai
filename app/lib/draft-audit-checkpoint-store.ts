import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  evaluateDraftAuditSnapshot,
  isDraftAuditSnapshot,
  type DraftAuditSnapshot,
} from "./draft-audit.ts";

export const DRAFT_AUDIT_CHECKPOINT_SCHEMA = "draftforge.audit-checkpoint/v1" as const;
export const MAX_DRAFT_AUDIT_CHECKPOINTS = 4;
export const MAX_DRAFT_AUDIT_CHECKPOINT_ENTRY_BYTES = 508 * 1024;
export const MAX_DRAFT_AUDIT_CHECKPOINT_BYTES = 2 * 1024 * 1024;
export const MAX_DRAFT_AUDIT_CHECKPOINT_QUARANTINES = 2;
export const MAX_DRAFT_AUDIT_CHECKPOINT_ARCHIVES = 16;
export const DRAFT_AUDIT_CHECKPOINT_RETIRE_CONFIRMATION = "ARCHIVE_EXACT_INTERRUPTED_DRAFT";
const DEVELOPMENT_RELEASE_REVISION = "0".repeat(40);
const RELEASE_REVISION = /^[a-f0-9]{40}$/;
const CHECKPOINT_DIGEST = /^sha256:[a-f0-9]{64}$/;

export type PersistedDraftAuditCheckpointEntry = Readonly<{
  digest: string;
  snapshot: DraftAuditSnapshot;
}>;

export type PersistedDraftAuditCheckpoint = Readonly<{
  schemaVersion: typeof DRAFT_AUDIT_CHECKPOINT_SCHEMA;
  releaseRevision: string;
  writtenAt: string;
  snapshots: readonly PersistedDraftAuditCheckpointEntry[];
}>;

export type DraftAuditCheckpointLoadResult = Readonly<
  | { ok: true; code: "DRAFT_AUDIT_CHECKPOINT_RECOVERED"; value: PersistedDraftAuditCheckpoint }
  | {
    ok: false;
    code:
      | "DRAFT_AUDIT_CHECKPOINT_NOT_FOUND"
      | "DRAFT_AUDIT_CHECKPOINT_INVALID"
      | "DRAFT_AUDIT_CHECKPOINT_RELEASE_MISMATCH";
    value: null;
  }
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function isStrictUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function exactReleaseRevision(value: unknown) {
  return typeof value === "string" && RELEASE_REVISION.test(value);
}

function checkpointKey(snapshot: DraftAuditSnapshot) {
  return `${snapshot.league.id}:${snapshot.league.teamId}`;
}

function serializedSnapshot(snapshot: DraftAuditSnapshot) {
  return JSON.stringify(snapshot);
}

function digestSerializedSnapshot(serialized: string) {
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

export function draftAuditCheckpointDigest(snapshot: DraftAuditSnapshot) {
  return digestSerializedSnapshot(serializedSnapshot(snapshot));
}

/**
 * Recovery durability identity. Only heartbeat/presentation fields with no
 * authority are removed. Any unknown or newly added field remains in the
 * digest and therefore becomes durability-critical by default.
 */
export function draftAuditCheckpointCriticalDigest(snapshot: DraftAuditSnapshot) {
  const value = { ...snapshot } as unknown as Record<string, unknown>;
  delete value.capturedAt;
  const runtimeSource = value.runtime as Record<string, unknown> | undefined;
  if (runtimeSource) {
    const runtime = { ...runtimeSource };
    delete runtime.capturedAt;
    value.runtime = runtime;
  }
  const safetySource = value.safety as Record<string, unknown> | undefined;
  if (safetySource) {
    const safety = { ...safetySource };
    delete safety.actionState;
    value.safety = safety;
  }
  const liveControlSource = value.liveControl as Record<string, unknown> | undefined;
  const freshnessSource = liveControlSource?.freshness as Record<string, unknown> | undefined;
  const liveControl = liveControlSource ? { ...liveControlSource } : undefined;
  const freshness = freshnessSource ? { ...freshnessSource } : undefined;
  if (freshness) {
    delete freshness.espnContextAt;
    delete freshness.pickFeedAt;
    delete freshness.pickFeedObservedAt;
    delete freshness.lastActionAt;
    if (liveControl) liveControl.freshness = freshness;
  }
  if (liveControl) value.liveControl = liveControl;
  delete value.operator;
  delete value.leagueBoard;
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export type DraftAuditCheckpointDurabilityState = Readonly<{
  criticalDigest: string;
  persistedAt: number;
}>;

export function draftAuditCheckpointPersistenceRequired(
  previous: DraftAuditCheckpointDurabilityState | undefined,
  snapshot: DraftAuditSnapshot,
  now: number,
  heartbeatMs = 5_000,
) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) {
    throw new Error("DRAFT_AUDIT_CHECKPOINT_HEARTBEAT_INVALID");
  }
  const criticalDigest = draftAuditCheckpointCriticalDigest(snapshot);
  return {
    criticalDigest,
    required: !previous
      || previous.criticalDigest !== criticalDigest
      || now - previous.persistedAt >= heartbeatMs,
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as Readonly<T>;
}

function hasIrreversibleHistory(snapshot: DraftAuditSnapshot) {
  const control = snapshot.liveControl;
  return Boolean(control && (
    control.pendingActionCount > 0
    || control.decision !== null
    || control.rosterAttributions.length > 0
    || control.unattributedRosterCount > 0
    || control.historicalAutopickDetected
    || control.uncontrolledRosterAdditionDetected
    || control.events.some((event) => event.kind === "ACTION_LIFECYCLE" || event.kind === "ROSTER_ATTRIBUTION")
  ));
}

function activeIrreversibleCheckpoint(snapshot: DraftAuditSnapshot) {
  return hasIrreversibleHistory(snapshot) && !evaluateDraftAuditSnapshot(snapshot).complete;
}

type MaterializedDraftAuditSnapshot = Readonly<{
  snapshot: DraftAuditSnapshot;
  serialized: string;
  bytes: number;
  digest: string;
}>;

function materializeDraftAuditSnapshot(snapshot: DraftAuditSnapshot): MaterializedDraftAuditSnapshot {
  if (!isDraftAuditSnapshot(snapshot)) throw new Error("DRAFT_AUDIT_CHECKPOINT_SNAPSHOT_INVALID");
  const serialized = serializedSnapshot(snapshot);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_DRAFT_AUDIT_CHECKPOINT_ENTRY_BYTES) {
    throw new Error("DRAFT_AUDIT_CHECKPOINT_ENTRY_TOO_LARGE");
  }
  return {
    snapshot,
    serialized,
    bytes,
    digest: digestSerializedSnapshot(serialized),
  };
}

function boundedSnapshotEntries(snapshots: Iterable<DraftAuditSnapshot>) {
  const latest = new Map<string, MaterializedDraftAuditSnapshot>();
  for (const snapshot of snapshots) {
    const materialized = materializeDraftAuditSnapshot(snapshot);
    const key = checkpointKey(snapshot);
    const previous = latest.get(key);
    if (!previous || Date.parse(snapshot.capturedAt) >= Date.parse(previous.snapshot.capturedAt)) {
      latest.set(key, materialized);
    }
  }
  const ordered = [...latest.values()].sort(
    (left, right) => Date.parse(right.snapshot.capturedAt) - Date.parse(left.snapshot.capturedAt),
  );
  const protectedSnapshots = ordered.filter(({ snapshot }) => activeIrreversibleCheckpoint(snapshot));
  if (protectedSnapshots.length > MAX_DRAFT_AUDIT_CHECKPOINTS) {
    throw new Error("DRAFT_AUDIT_CHECKPOINT_ACTIVE_CAPACITY_EXCEEDED");
  }
  const protectedKeys = new Set(protectedSnapshots.map(({ snapshot }) => checkpointKey(snapshot)));
  return [
    ...protectedSnapshots,
    ...ordered.filter(({ snapshot }) => !protectedKeys.has(checkpointKey(snapshot))),
  ].slice(0, MAX_DRAFT_AUDIT_CHECKPOINTS);
}

export function defaultDraftAuditCheckpointPath(projectRoot = process.cwd()) {
  const testSuffix = process.env.NODE_TEST_CONTEXT ? `-${process.pid}.test` : "";
  return path.join(path.resolve(projectRoot), ".draftforge", `draft-audit-checkpoint${testSuffix}.json`);
}

export function currentDraftAuditCheckpointReleaseRevision() {
  const configured = String(process.env.DRAFTFORGE_RELEASE_REVISION || "").trim().toLowerCase();
  return RELEASE_REVISION.test(configured) ? configured : DEVELOPMENT_RELEASE_REVISION;
}

export function parsePersistedDraftAuditCheckpoint(
  value: unknown,
  expectedReleaseRevision = currentDraftAuditCheckpointReleaseRevision(),
): DraftAuditCheckpointLoadResult {
  if (!exactReleaseRevision(expectedReleaseRevision)) {
    return Object.freeze({ ok: false, code: "DRAFT_AUDIT_CHECKPOINT_INVALID", value: null });
  }
  if (!isPlainObject(value)
    || !exactKeys(value, ["schemaVersion", "releaseRevision", "writtenAt", "snapshots"])
    || value.schemaVersion !== DRAFT_AUDIT_CHECKPOINT_SCHEMA
    || !exactReleaseRevision(value.releaseRevision)
    || !isStrictUtcTimestamp(value.writtenAt)
    || !Array.isArray(value.snapshots)
    || value.snapshots.length < 1
    || value.snapshots.length > MAX_DRAFT_AUDIT_CHECKPOINTS) {
    return Object.freeze({ ok: false, code: "DRAFT_AUDIT_CHECKPOINT_INVALID", value: null });
  }
  if (value.releaseRevision !== expectedReleaseRevision) {
    return Object.freeze({ ok: false, code: "DRAFT_AUDIT_CHECKPOINT_RELEASE_MISMATCH", value: null });
  }
  const entries: PersistedDraftAuditCheckpointEntry[] = [];
  for (const candidate of value.snapshots) {
    if (!isPlainObject(candidate)
      || !exactKeys(candidate, ["digest", "snapshot"])
      || typeof candidate.digest !== "string"
      || !CHECKPOINT_DIGEST.test(candidate.digest)
      || !isDraftAuditSnapshot(candidate.snapshot)
      || Buffer.byteLength(serializedSnapshot(candidate.snapshot), "utf8") > MAX_DRAFT_AUDIT_CHECKPOINT_ENTRY_BYTES
      || draftAuditCheckpointDigest(candidate.snapshot) !== candidate.digest) {
      return Object.freeze({ ok: false, code: "DRAFT_AUDIT_CHECKPOINT_INVALID", value: null });
    }
    entries.push({ digest: candidate.digest, snapshot: candidate.snapshot });
  }
  const keys = entries.map(({ snapshot }) => checkpointKey(snapshot));
  if (new Set(keys).size !== keys.length) {
    return Object.freeze({ ok: false, code: "DRAFT_AUDIT_CHECKPOINT_INVALID", value: null });
  }
  return Object.freeze({
    ok: true,
    code: "DRAFT_AUDIT_CHECKPOINT_RECOVERED",
    value: deepFreeze({
      schemaVersion: DRAFT_AUDIT_CHECKPOINT_SCHEMA,
      releaseRevision: value.releaseRevision,
      writtenAt: value.writtenAt,
      snapshots: entries,
    }),
  });
}

export async function loadPersistedDraftAuditCheckpoint(
  checkpointPath = defaultDraftAuditCheckpointPath(),
  expectedReleaseRevision = currentDraftAuditCheckpointReleaseRevision(),
): Promise<DraftAuditCheckpointLoadResult> {
  await scavengeDraftAuditCheckpointTemps(checkpointPath).catch(() => {});
  let handle;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
    handle = await open(checkpointPath, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile()
      || metadata.size < 2
      || metadata.size > MAX_DRAFT_AUDIT_CHECKPOINT_BYTES
      || (metadata.mode & 0o777) !== 0o600) {
      return Object.freeze({ ok: false, code: "DRAFT_AUDIT_CHECKPOINT_INVALID", value: null });
    }
    const raw = await handle.readFile("utf8");
    return parsePersistedDraftAuditCheckpoint(JSON.parse(raw) as unknown, expectedReleaseRevision);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return Object.freeze({ ok: false, code: "DRAFT_AUDIT_CHECKPOINT_NOT_FOUND", value: null });
    }
    return Object.freeze({ ok: false, code: "DRAFT_AUDIT_CHECKPOINT_INVALID", value: null });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export async function scavengeDraftAuditCheckpointTemps(
  checkpointPath = defaultDraftAuditCheckpointPath(),
  activePid = process.pid,
) {
  const directory = path.dirname(checkpointPath);
  const base = path.basename(checkpointPath).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${base}\\.([1-9]\\d*)\\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.tmp$`);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (ownerPid === activePid || processIsAlive(ownerPid)) continue;
    try {
      await unlink(path.join(directory, name));
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

export async function persistDraftAuditCheckpoint(
  snapshots: Iterable<DraftAuditSnapshot>,
  checkpointPath = defaultDraftAuditCheckpointPath(),
  writtenAt = new Date().toISOString(),
  releaseRevision = currentDraftAuditCheckpointReleaseRevision(),
) {
  if (!isStrictUtcTimestamp(writtenAt)) throw new Error("DRAFT_AUDIT_CHECKPOINT_TIME_INVALID");
  if (!exactReleaseRevision(releaseRevision)) throw new Error("DRAFT_AUDIT_CHECKPOINT_RELEASE_INVALID");
  const bounded = boundedSnapshotEntries(snapshots);
  if (!bounded.length) throw new Error("DRAFT_AUDIT_CHECKPOINT_EMPTY");
  const candidate = deepFreeze({
    schemaVersion: DRAFT_AUDIT_CHECKPOINT_SCHEMA,
    releaseRevision,
    writtenAt,
    snapshots: bounded.map(({ digest, snapshot }) => ({ digest, snapshot })),
  });
  const serializedEntries = bounded.map(({ digest, serialized: snapshot }) => (
    `{"digest":${JSON.stringify(digest)},"snapshot":${snapshot}}`
  )).join(",");
  const serialized = `{"schemaVersion":${JSON.stringify(DRAFT_AUDIT_CHECKPOINT_SCHEMA)},"releaseRevision":${JSON.stringify(releaseRevision)},"writtenAt":${JSON.stringify(writtenAt)},"snapshots":[${serializedEntries}]}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_DRAFT_AUDIT_CHECKPOINT_BYTES) {
    throw new Error("DRAFT_AUDIT_CHECKPOINT_TOO_LARGE");
  }

  const directory = path.dirname(checkpointPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("DRAFT_AUDIT_CHECKPOINT_DIRECTORY_INVALID");
  }
  await chmod(directory, 0o700);
  const temporaryPath = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let renamed = false;
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, checkpointPath);
    renamed = true;
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
  return candidate;
}

export async function quarantinePersistedDraftAuditCheckpoint(
  checkpointPath = defaultDraftAuditCheckpointPath(),
) {
  const directory = path.dirname(checkpointPath);
  const base = path.basename(checkpointPath);
  try {
    const metadata = await lstat(checkpointPath);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) return null;
    const quarantinePath = path.join(
      directory,
      `${base}.invalid-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`,
    );
    await rename(checkpointPath, quarantinePath);
    const candidates = (await readdir(directory))
      .filter((name) => name.startsWith(`${base}.invalid-`))
      .sort()
      .reverse();
    await Promise.all(candidates.slice(MAX_DRAFT_AUDIT_CHECKPOINT_QUARANTINES).map((name) => (
      unlink(path.join(directory, name)).catch(() => {})
    )));
    return quarantinePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function clearPersistedDraftAuditCheckpoint(
  checkpointPath = defaultDraftAuditCheckpointPath(),
) {
  try {
    await unlink(checkpointPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

export async function retirePersistedDraftAuditCheckpoint({
  leagueId,
  teamId,
  expectedDigest,
  confirmation,
  checkpointPath = defaultDraftAuditCheckpointPath(),
  retiredAt = new Date().toISOString(),
  releaseRevision = currentDraftAuditCheckpointReleaseRevision(),
}: {
  leagueId: string;
  teamId: number;
  expectedDigest: string;
  confirmation: string;
  checkpointPath?: string;
  retiredAt?: string;
  releaseRevision?: string;
}) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(leagueId) || !Number.isSafeInteger(teamId) || teamId <= 0
    || !CHECKPOINT_DIGEST.test(expectedDigest)
    || confirmation !== DRAFT_AUDIT_CHECKPOINT_RETIRE_CONFIRMATION
    || !isStrictUtcTimestamp(retiredAt)) {
    throw new Error("DRAFT_AUDIT_CHECKPOINT_RETIRE_AUTHORIZATION_INVALID");
  }
  const loaded = await loadPersistedDraftAuditCheckpoint(checkpointPath, releaseRevision);
  if (!loaded.ok) throw new Error(loaded.code);
  const target = loaded.value.snapshots.find(({ snapshot }) => (
    snapshot.league.id === leagueId && snapshot.league.teamId === teamId
  ));
  if (!target) throw new Error("DRAFT_AUDIT_CHECKPOINT_RETIRE_TARGET_NOT_FOUND");
  if (target.digest !== expectedDigest) throw new Error("DRAFT_AUDIT_CHECKPOINT_RETIRE_DIGEST_MISMATCH");

  const directory = path.dirname(checkpointPath);
  const archiveDirectory = path.join(directory, "draft-audit-archive");
  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  const archiveMetadata = await lstat(archiveDirectory);
  if (!archiveMetadata.isDirectory() || archiveMetadata.isSymbolicLink()) {
    throw new Error("DRAFT_AUDIT_CHECKPOINT_ARCHIVE_DIRECTORY_INVALID");
  }
  await chmod(archiveDirectory, 0o700);
  const archiveName = `${leagueId}-${teamId}-${retiredAt.replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`;
  const archivePath = path.join(archiveDirectory, archiveName);
  const archive = `${JSON.stringify({
    schemaVersion: "draftforge.audit-checkpoint-archive/v1",
    releaseRevision,
    retiredAt,
    reason: "OPERATOR_CONFIRMED_INTERRUPTED_DRAFT_RETIREMENT",
    digest: target.digest,
    snapshot: target.snapshot,
  })}\n`;
  const archiveHandle = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await archiveHandle.writeFile(archive, "utf8");
    await archiveHandle.sync();
  } finally {
    await archiveHandle.close();
  }
  const archiveDirectoryHandle = await open(archiveDirectory, constants.O_RDONLY);
  try { await archiveDirectoryHandle.sync(); } finally { await archiveDirectoryHandle.close(); }

  const remaining = loaded.value.snapshots
    .filter((entry) => entry !== target)
    .map(({ snapshot }) => snapshot);
  if (remaining.length) {
    await persistDraftAuditCheckpoint(remaining, checkpointPath, retiredAt, releaseRevision);
  } else {
    await clearPersistedDraftAuditCheckpoint(checkpointPath);
  }
  const archives = (await readdir(archiveDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse();
  await Promise.all(archives.slice(MAX_DRAFT_AUDIT_CHECKPOINT_ARCHIVES).map((name) => (
    unlink(path.join(archiveDirectory, name)).catch(() => {})
  )));
  return Object.freeze({
    ok: true,
    code: "DRAFT_AUDIT_CHECKPOINT_RETIRED",
    leagueId,
    teamId,
    digest: target.digest,
    archivePath,
    remaining: remaining.length,
  });
}
