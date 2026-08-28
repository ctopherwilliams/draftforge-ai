import {
  evaluateAvailabilityGate,
  parseAvailabilityArtifact,
  parseAvailabilityPolicy,
  type AvailabilityArtifact,
  type AvailabilityPolicy,
} from "../../lib/availability-veto.ts";
import {
  clearPersistedAvailabilityStage,
  loadPersistedAvailabilityStage,
  persistAvailabilityStage,
} from "../../lib/availability-stage-store.ts";

const LOCAL_ORIGINS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
const MAX_STAGE_BODY_BYTES = 256 * 1024;

type StagedAvailability = Readonly<{
  stagedAt: string;
  artifact: AvailabilityArtifact;
  policy: AvailabilityPolicy;
}>;

let stagedAvailability: StagedAvailability | null = null;
let availabilityMutationTail: Promise<void> = Promise.resolve();
let nextAvailabilityPostSequence = 0;
let latestAppliedAvailabilityPostSequence = 0;

function serializeAvailabilityMutation<T>(operation: () => Promise<T>): Promise<T> {
  const scheduled = availabilityMutationTail.then(operation, operation);
  availabilityMutationTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

function beginAvailabilityPost() {
  nextAvailabilityPostSequence += 1;
  return nextAvailabilityPostSequence;
}

async function serializeAvailabilityPostMutation<T>(
  postSequence: number,
  operation: () => Promise<T>,
): Promise<{ applied: true; value: T } | { applied: false }> {
  return serializeAvailabilityMutation(async () => {
    // Request arrival order, rather than body-read or fsync completion order,
    // determines which staging attempt owns the final authorization state.
    // A slow older request may still receive its own validation response, but
    // it can never erase or replace a newer request that already committed.
    if (postSequence < latestAppliedAvailabilityPostSequence) return { applied: false };
    latestAppliedAvailabilityPostSequence = postSequence;
    return { applied: true, value: await operation() };
  });
}

function persistenceEnabled() {
  return process.env.DRAFTFORGE_PERSIST_AVAILABILITY_STAGE === "1";
}

export function resetAvailabilityStageMemoryForTesting() {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("TEST_CONTEXT_REQUIRED");
  stagedAvailability = null;
  availabilityMutationTail = Promise.resolve();
  nextAvailabilityPostSequence = 0;
  latestAppliedAvailabilityPostSequence = 0;
}

function isLoopbackRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function requestOriginAllowed(origin: string | null) {
  return origin === null || LOCAL_ORIGINS.has(origin);
}

function headers(origin: string | null) {
  return {
    ...(origin && LOCAL_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function response(origin: string | null, body: unknown, status = 200) {
  return Response.json(body, { status, headers: headers(origin) });
}

async function failClosed(
  origin: string | null,
  code: string,
  status: number,
  postSequence: number,
  details: unknown = undefined,
) {
  await serializeAvailabilityPostMutation(postSequence, async () => {
    stagedAvailability = null;
    if (persistenceEnabled()) await clearPersistedAvailabilityStage().catch(() => {});
  });
  return response(origin, { ok: false, code, ...(details === undefined ? {} : { details }) }, status);
}

async function currentStagedState(evaluatedAt: string) {
  return serializeAvailabilityMutation(async () => {
    let recovery: "MEMORY" | "RECOVERED" | "MISSING" | "INVALID" = stagedAvailability ? "MEMORY" : "MISSING";
    if (!stagedAvailability && persistenceEnabled()) {
      const recovered = await loadPersistedAvailabilityStage();
      if (!recovered.ok) {
        if (recovered.code === "AVAILABILITY_STAGE_PERSISTED_INVALID") {
          await clearPersistedAvailabilityStage().catch(() => {});
          recovery = "INVALID";
        }
      } else {
        stagedAvailability = Object.freeze({
          stagedAt: recovered.value.stagedAt,
          artifact: recovered.value.artifact,
          policy: recovered.value.policy,
        });
        recovery = "RECOVERED";
      }
    }
    if (!stagedAvailability) return { recovery, state: null };
    const state = stagedPublicState(stagedAvailability, evaluatedAt);
    if (state.status !== "READY") {
      stagedAvailability = null;
      if (persistenceEnabled()) await clearPersistedAvailabilityStage().catch(() => {});
    }
    return { recovery, state };
  });
}

function strictStageBody(value: unknown): value is { policy: unknown; artifact: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "artifact" && keys[1] === "policy";
}

async function readBoundedJson(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STAGE_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  }
  if (!request.body) throw new Error("INVALID_JSON");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_STAGE_BODY_BYTES) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message === "BODY_TOO_LARGE") throw error;
    throw new Error("INVALID_JSON");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function stagedPublicState(staged: StagedAvailability, evaluatedAt: string) {
  const evaluation = evaluateAvailabilityGate({
    artifact: staged.artifact,
    policy: staged.policy,
    players: [],
    actionablePlayerIds: [],
    evaluatedAt,
  });
  return {
    stagedAt: staged.stagedAt,
    artifactGeneratedAt: staged.artifact.generatedAt,
    freshUntil: evaluation.freshUntil,
    digest: evaluation.digest,
    status: evaluation.status,
    blockingReasons: evaluation.blockingReasons,
    unresolvedCount: evaluation.unresolved.length,
    policy: staged.policy,
    artifact: staged.artifact,
  };
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  if (!isLoopbackRequest(request) || !requestOriginAllowed(origin)) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }
  return new Response(null, { status: 204, headers: headers(origin) });
}

export async function GET(request: Request) {
  const origin = request.headers.get("origin");
  if (!isLoopbackRequest(request) || !requestOriginAllowed(origin)) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }
  if (new URL(request.url).search) return response(origin, { ok: false, code: "QUERY_NOT_SUPPORTED" }, 400);
  const { recovery, state } = await currentStagedState(new Date().toISOString());
  if (!state) {
    return response(origin, {
      ok: false,
      code: recovery === "INVALID" ? "AVAILABILITY_STAGE_RECOVERY_INVALID" : "AVAILABILITY_STAGE_MISSING",
    }, recovery === "INVALID" ? 409 : 404);
  }
  return response(origin, {
    ok: state.status === "READY",
    code: state.status === "READY" ? "AVAILABILITY_STAGE_READY" : "AVAILABILITY_STAGE_BLOCKED",
    ...state,
  }, state.status === "READY" ? 200 : 409);
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!isLoopbackRequest(request) || !requestOriginAllowed(origin)) {
    return response(origin, { ok: false, code: "ORIGIN_FORBIDDEN" }, 403);
  }
  const postSequence = beginAvailabilityPost();
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return await failClosed(origin, "CONTENT_TYPE_REQUIRED", 415, postSequence);

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    return await failClosed(origin, error instanceof Error && error.message === "BODY_TOO_LARGE" ? "STAGE_BODY_TOO_LARGE" : "INVALID_JSON", 400, postSequence);
  }
  if (!strictStageBody(body)) return await failClosed(origin, "STAGE_BODY_INVALID", 400, postSequence);

  const policyResult = parseAvailabilityPolicy(body.policy);
  const artifactResult = parseAvailabilityArtifact(body.artifact);
  if (!policyResult.ok || !artifactResult.ok) {
    return await failClosed(origin, "AVAILABILITY_STAGE_INVALID", 422, postSequence, [
      ...policyResult.errors,
      ...artifactResult.errors,
    ]);
  }
  const stagedAt = new Date().toISOString();
  const evaluation = evaluateAvailabilityGate({
    artifact: artifactResult.value,
    policy: policyResult.value,
    players: [],
    actionablePlayerIds: [],
    evaluatedAt: stagedAt,
  });
  if (!evaluation.armingAllowed) {
    return await failClosed(origin, "AVAILABILITY_STAGE_NOT_FRESH", 422, postSequence, evaluation.blockingReasons);
  }
  const nextStage = Object.freeze({ stagedAt, artifact: artifactResult.value, policy: policyResult.value });
  let staged;
  try {
    staged = await serializeAvailabilityPostMutation(postSequence, async () => {
      if (persistenceEnabled()) {
        await persistAvailabilityStage(nextStage);
      }
      stagedAvailability = nextStage;
    });
  } catch {
    return await failClosed(origin, "AVAILABILITY_STAGE_PERSIST_FAILED", 500, postSequence);
  }
  if (!staged.applied) {
    return response(origin, { ok: false, code: "AVAILABILITY_STAGE_SUPERSEDED" }, 409);
  }
  return response(origin, {
    ok: true,
    code: "AVAILABILITY_STAGE_RECORDED",
    digest: evaluation.digest,
    stagedAt,
    artifactGeneratedAt: artifactResult.value.generatedAt,
    freshUntil: evaluation.freshUntil,
    unresolvedCount: evaluation.unresolved.length,
  });
}
