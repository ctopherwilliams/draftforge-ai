import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const RELEASE_ARTIFACT_LEASE_SCHEMA = "draftforge.release-artifact-lease/v1";
export const RELEASE_ARTIFACT_RECLAIM_CLAIM_SCHEMA = "draftforge.release-artifact-reclaim-claim/v1";
const LEASE_OPERATIONS = new Set(["build", "start"]);
export const RELEASE_ARTIFACT_LEASE_INITIALIZATION_GRACE_MS = 30_000;
export const RELEASE_ARTIFACT_RECLAIM_CLAIM_GRACE_MS = 1_000;
export const RELEASE_ARTIFACT_RECLAIM_ELECTION_WINDOW_MS = 50;
const RELEASE_ARTIFACT_RECLAIM_ELECTION_SETTLE_MS = 5;
const MAX_RELEASE_ARTIFACT_RECLAIM_CANDIDATES = 64;
const UUID_PATTERN = /^[a-f0-9-]{36}$/;
const sleepSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function leaseError(code, owner) {
  const error = new Error(code);
  error.code = code;
  if (owner) error.owner = owner;
  return error;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validOwner(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.schemaVersion === RELEASE_ARTIFACT_LEASE_SCHEMA
    && LEASE_OPERATIONS.has(value.operation)
    && typeof value.token === "string"
    && UUID_PATTERN.test(value.token)
    && Number.isInteger(value.pid)
    && value.pid > 0
    && (value.childPid === null || (Number.isInteger(value.childPid) && value.childPid > 0))
    && Number.isFinite(Date.parse(String(value.acquiredAt || "")));
}

function ownerPath(leasePath) {
  return path.join(leasePath, "owner.json");
}

function readOwner(leasePath) {
  try {
    const value = JSON.parse(readFileSync(ownerPath(leasePath), "utf8"));
    return validOwner(value) ? value : null;
  } catch {
    return null;
  }
}

function reclaimGeneration(existing, stat) {
  return existing
    ? `owner-${existing.token}`
    : `inode-${String(stat.dev)}-${String(stat.ino)}`;
}

function readSmallJson(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4_096) return null;
    const raw = readFileSync(filePath, "utf8");
    return { stat, raw, value: JSON.parse(raw) };
  } catch {
    return null;
  }
}

function validReclaimClaim(value, generation) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.schemaVersion === RELEASE_ARTIFACT_RECLAIM_CLAIM_SCHEMA
    && value.kind === "reclaim-claim"
    && value.generation === generation
    && UUID_PATTERN.test(String(value.token || ""))
    && Number.isInteger(value.pid)
    && value.pid > 0
    && Number.isFinite(Date.parse(String(value.acquiredAt || "")));
}

function validRecoveryCandidate(value, generation) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.schemaVersion === RELEASE_ARTIFACT_RECLAIM_CLAIM_SCHEMA
    && value.kind === "recovery-candidate"
    && value.generation === generation
    && UUID_PATTERN.test(String(value.token || ""))
    && Number.isInteger(value.pid)
    && value.pid > 0
    && Number.isSafeInteger(value.epoch)
    && value.epoch >= 0
    && Number.isFinite(Date.parse(String(value.acquiredAt || "")));
}

function leaseGenerationMatches(leasePath, existing, expectedStat) {
  try {
    const currentStat = lstatSync(leasePath);
    const current = readOwner(leasePath);
    return currentStat.dev === expectedStat.dev
      && currentStat.ino === expectedStat.ino
      && (existing ? current?.token === existing.token : current === null);
  } catch {
    return false;
  }
}

function fileSnapshotMatches(filePath, snapshot) {
  const current = readSmallJson(filePath);
  return Boolean(current
    && current.stat.dev === snapshot.stat.dev
    && current.stat.ino === snapshot.stat.ino
    && current.raw === snapshot.raw);
}

function blockingSleep(milliseconds) {
  if (milliseconds > 0) Atomics.wait(sleepSignal, 0, 0, Math.ceil(milliseconds));
}

function recoveryCandidatePrefix(generation) {
  return `.reclaim-recovery-${generation}-`;
}

function recoveryCandidates(leasePath, generation) {
  let names;
  try {
    names = readdirSync(leasePath).filter((name) => (
      name.startsWith(recoveryCandidatePrefix(generation)) && name.endsWith(".json")
    ));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (names.length > MAX_RELEASE_ARTIFACT_RECLAIM_CANDIDATES) {
    throw leaseError("RELEASE_ARTIFACT_LEASE_CONTENTION");
  }
  return names.flatMap((name) => {
    const candidatePath = path.join(leasePath, name);
    const snapshot = readSmallJson(candidatePath);
    if (!snapshot || !validRecoveryCandidate(snapshot.value, generation)) return [];
    const fileEpoch = Math.floor(
      snapshot.stat.mtimeMs / RELEASE_ARTIFACT_RECLAIM_ELECTION_WINDOW_MS,
    );
    if (fileEpoch !== snapshot.value.epoch) return [];
    return [{ ...snapshot.value, path: candidatePath }];
  });
}

function recoverStaleReclaimClaim({
  leasePath,
  claimPath,
  generation,
  existing,
  existingStat,
  pid,
  acquiredAt,
  processAliveImpl,
}) {
  const claimSnapshot = readSmallJson(claimPath);
  if (!claimSnapshot
    || !leaseGenerationMatches(leasePath, existing, existingStat)) {
    return { retry: true };
  }
  const claim = validReclaimClaim(claimSnapshot.value, generation)
    ? claimSnapshot.value
    : null;
  if (claim && processAliveImpl(claim.pid)) {
    throw leaseError("RELEASE_ARTIFACT_LEASE_CONTENTION", existing || undefined);
  }
  const claimAgeMs = Date.now() - (claim
    ? Date.parse(claim.acquiredAt)
    : claimSnapshot.stat.mtimeMs);
  if (claimAgeMs < RELEASE_ARTIFACT_RECLAIM_CLAIM_GRACE_MS) {
    // A valid dead claimant can be recovered by this same invocation after a
    // bounded wait. An unversioned/malformed fresh claim has no trustworthy PID
    // and therefore remains fail-closed until a later invocation observes it
    // past the grace period.
    if (!claim) {
      throw leaseError("RELEASE_ARTIFACT_LEASE_INITIALIZING", existing || undefined);
    }
    blockingSleep(Math.min(
      RELEASE_ARTIFACT_RECLAIM_CLAIM_GRACE_MS,
      Math.max(0, RELEASE_ARTIFACT_RECLAIM_CLAIM_GRACE_MS - claimAgeMs + 1),
    ));
    if (!leaseGenerationMatches(leasePath, existing, existingStat)
      || !fileSnapshotMatches(claimPath, claimSnapshot)) {
      return { retry: true };
    }
    if (processAliveImpl(claim.pid)) {
      throw leaseError("RELEASE_ARTIFACT_LEASE_CONTENTION", existing || undefined);
    }
  }

  for (let electionAttempt = 0; electionAttempt < 3; electionAttempt += 1) {
    if (!leaseGenerationMatches(leasePath, existing, existingStat)
      || !fileSnapshotMatches(claimPath, claimSnapshot)) {
      return { retry: true };
    }
    let now = Date.now();
    let epoch = Math.floor(now / RELEASE_ARTIFACT_RECLAIM_ELECTION_WINDOW_MS);
    let epochEnd = (epoch + 1) * RELEASE_ARTIFACT_RECLAIM_ELECTION_WINDOW_MS;
    if (epochEnd - now <= RELEASE_ARTIFACT_RECLAIM_ELECTION_SETTLE_MS) {
      blockingSleep(epochEnd - now + 1);
      now = Date.now();
      epoch = Math.floor(now / RELEASE_ARTIFACT_RECLAIM_ELECTION_WINDOW_MS);
      epochEnd = (epoch + 1) * RELEASE_ARTIFACT_RECLAIM_ELECTION_WINDOW_MS;
    }

    const priorLiveCandidate = recoveryCandidates(leasePath, generation).find((candidate) => (
      candidate.epoch < epoch && processAliveImpl(candidate.pid)
    ));
    if (priorLiveCandidate) {
      throw leaseError("RELEASE_ARTIFACT_LEASE_CONTENTION", existing || undefined);
    }

    const token = randomUUID();
    const candidatePath = path.join(
      leasePath,
      `${recoveryCandidatePrefix(generation)}${token}.json`,
    );
    const candidate = {
      schemaVersion: RELEASE_ARTIFACT_RECLAIM_CLAIM_SCHEMA,
      kind: "recovery-candidate",
      generation,
      token,
      pid,
      epoch,
      acquiredAt,
    };
    try {
      writeFileSync(candidatePath, `${JSON.stringify(candidate)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (error?.code === "ENOENT") return { retry: true };
      throw error;
    }

    const written = readSmallJson(candidatePath);
    const writtenEpoch = written
      ? Math.floor(written.stat.mtimeMs / RELEASE_ARTIFACT_RECLAIM_ELECTION_WINDOW_MS)
      : -1;
    if (writtenEpoch !== epoch) {
      removeReclaimClaimIfOwned(candidatePath, token);
      continue;
    }
    blockingSleep(epochEnd + RELEASE_ARTIFACT_RECLAIM_ELECTION_SETTLE_MS - Date.now());
    if (!leaseGenerationMatches(leasePath, existing, existingStat)
      || !fileSnapshotMatches(claimPath, claimSnapshot)) {
      removeReclaimClaimIfOwned(candidatePath, token);
      return { retry: true };
    }
    const eligible = recoveryCandidates(leasePath, generation)
      .filter((candidateRecord) => (
        candidateRecord.epoch === epoch && processAliveImpl(candidateRecord.pid)
      ))
      .sort((left, right) => left.token < right.token ? -1 : left.token > right.token ? 1 : 0);
    if (!eligible.length || eligible[0].token !== token) {
      removeReclaimClaimIfOwned(candidatePath, token);
      throw leaseError("RELEASE_ARTIFACT_LEASE_CONTENTION", existing || undefined);
    }
    return { retry: false, candidatePath, token };
  }
  throw leaseError("RELEASE_ARTIFACT_LEASE_CONTENTION", existing || undefined);
}

function removeReclaimClaimIfOwned(claimPath, token) {
  try {
    const claim = JSON.parse(readFileSync(claimPath, "utf8"));
    if (claim?.token === token) rmSync(claimPath, { force: true });
  } catch {
    // The claimed generation may already have been renamed or removed. Never
    // remove an unreadable claim because it may belong to another process.
  }
}

function ownerIsAlive(owner, processAliveImpl) {
  return Boolean(owner && (
    processAliveImpl(owner.pid)
    || (owner.childPid !== null && processAliveImpl(owner.childPid))
  ));
}

function safeLeasePath(value) {
  const exact = path.resolve(value);
  if (exact === path.parse(exact).root || !path.basename(exact)) {
    throw leaseError("RELEASE_ARTIFACT_LEASE_PATH_INVALID");
  }
  return exact;
}

function replaceOwner(leasePath, owner) {
  const temporary = path.join(leasePath, `owner.${owner.token}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, ownerPath(leasePath));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function defaultReleaseArtifactLeasePath(projectRoot = process.cwd()) {
  return path.join(path.resolve(projectRoot), ".draftforge", "release-artifact.lock");
}

export function acquireReleaseArtifactLease({
  projectRoot = process.cwd(),
  leasePath = defaultReleaseArtifactLeasePath(projectRoot),
  operation,
  acquiredAt = new Date().toISOString(),
  pid = process.pid,
  processAliveImpl = processIsAlive,
  afterReclaimClaimCreatedImpl = () => {},
} = {}) {
  if (!LEASE_OPERATIONS.has(operation)
    || !Number.isInteger(pid) || pid <= 0
    || !Number.isFinite(Date.parse(acquiredAt))) {
    throw leaseError("RELEASE_ARTIFACT_LEASE_ARGUMENT_INVALID");
  }
  const exactLeasePath = safeLeasePath(leasePath);
  mkdirSync(path.dirname(exactLeasePath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      mkdirSync(exactLeasePath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readOwner(exactLeasePath);
      if (existing && ownerIsAlive(existing, processAliveImpl)) {
        throw leaseError("RELEASE_ARTIFACT_IN_USE", existing);
      }
      let existingStat;
      let ageMs = 0;
      try {
        existingStat = lstatSync(exactLeasePath);
        ageMs = Date.now() - (existing
          ? Date.parse(existing.acquiredAt)
          : existingStat.mtimeMs);
      } catch {
        continue;
      }
      // There is an unavoidable spawn -> child-PID attachment window. If the
      // wrapper is killed in that window, its otherwise valid owner record is
      // temporarily dead even though the newly spawned build/server may still
      // be alive. Never reclaim either a complete or incomplete fresh lease.
      if (ageMs < RELEASE_ARTIFACT_LEASE_INITIALIZATION_GRACE_MS) {
        throw leaseError("RELEASE_ARTIFACT_LEASE_INITIALIZING", existing || undefined);
      }

      // Claim this exact lease generation before renaming it. A plain
      // read-owner -> rename sequence is unsafe: a delayed stale reclaimer can
      // otherwise rename and delete a replacement lease created in between.
      // The generation-scoped O_EXCL marker elects one reclaimer, while the
      // post-claim inode/owner check prevents an old contender from acting on
      // a new lease directory.
      const claimToken = randomUUID();
      const generation = reclaimGeneration(existing, existingStat);
      const claimPath = path.join(
        exactLeasePath,
        `.reclaim-${generation}.json`,
      );
      let claimCreated = false;
      let recoveryCandidate = null;
      try {
        writeFileSync(claimPath, `${JSON.stringify({
          schemaVersion: RELEASE_ARTIFACT_RECLAIM_CLAIM_SCHEMA,
          kind: "reclaim-claim",
          generation,
          token: claimToken,
          pid,
          acquiredAt,
        })}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        claimCreated = true;
      } catch (claimError) {
        if (claimError?.code === "ENOENT") continue;
        if (claimError?.code === "EEXIST") {
          recoveryCandidate = recoverStaleReclaimClaim({
            leasePath: exactLeasePath,
            claimPath,
            generation,
            existing,
            existingStat,
            pid,
            acquiredAt,
            processAliveImpl,
          });
          if (recoveryCandidate.retry) continue;
        } else {
          throw claimError;
        }
      }
      // Test injection models abrupt process death at the exact point where
      // the exclusive claim is durable. A thrown error intentionally bypasses
      // cleanup, exactly as a killed process would.
      if (claimCreated) afterReclaimClaimCreatedImpl({ claimPath, generation, token: claimToken });

      let generationRenamed = false;
      try {
        let currentStat;
        try {
          currentStat = lstatSync(exactLeasePath);
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        const current = readOwner(exactLeasePath);
        const sameDirectory = currentStat.dev === existingStat.dev
          && currentStat.ino === existingStat.ino;
        const sameOwner = existing
          ? current?.token === existing.token
          : current === null;
        if (!sameDirectory || !sameOwner) continue;
        if (current && ownerIsAlive(current, processAliveImpl)) {
          throw leaseError("RELEASE_ARTIFACT_IN_USE", current);
        }

        const stalePath = `${exactLeasePath}.stale-${process.pid}-${claimToken}`;
        try {
          renameSync(exactLeasePath, stalePath);
          generationRenamed = true;
        } catch (renameError) {
          if (renameError?.code === "ENOENT") continue;
          throw renameError;
        }
        rmSync(stalePath, { recursive: true, force: true });
      } finally {
        if (!generationRenamed) {
          if (claimCreated) removeReclaimClaimIfOwned(claimPath, claimToken);
          if (recoveryCandidate) {
            removeReclaimClaimIfOwned(recoveryCandidate.candidatePath, recoveryCandidate.token);
          }
        }
      }
      continue;
    }

    const owner = Object.freeze({
      schemaVersion: RELEASE_ARTIFACT_LEASE_SCHEMA,
      token: randomUUID(),
      operation,
      pid,
      childPid: null,
      acquiredAt,
    });
    try {
      writeFileSync(ownerPath(exactLeasePath), `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      rmSync(exactLeasePath, { recursive: true, force: true });
      throw error;
    }
    return Object.freeze({ path: exactLeasePath, owner });
  }
  throw leaseError("RELEASE_ARTIFACT_LEASE_CONTENTION");
}

export function attachReleaseArtifactLeaseChild(lease, childPid) {
  if (!lease?.owner || !Number.isInteger(childPid) || childPid <= 0) {
    throw leaseError("RELEASE_ARTIFACT_LEASE_CHILD_INVALID");
  }
  const current = readOwner(lease.path);
  if (!current || current.token !== lease.owner.token) {
    throw leaseError("RELEASE_ARTIFACT_LEASE_OWNERSHIP_LOST");
  }
  const owner = Object.freeze({ ...current, childPid });
  replaceOwner(lease.path, owner);
  return Object.freeze({ path: lease.path, owner });
}

export function releaseReleaseArtifactLease(lease) {
  if (!lease?.owner || !lease?.path) return false;
  const current = readOwner(lease.path);
  if (!current || current.token !== lease.owner.token) {
    throw leaseError("RELEASE_ARTIFACT_LEASE_OWNERSHIP_LOST");
  }
  const releasedPath = `${lease.path}.released-${process.pid}-${lease.owner.token}`;
  renameSync(lease.path, releasedPath);
  rmSync(releasedPath, { recursive: true, force: true });
  return true;
}
