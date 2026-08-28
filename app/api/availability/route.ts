import {
  evaluateAvailabilityGate,
  parseAvailabilityArtifact,
  parseAvailabilityPolicy,
  type AvailabilityArtifact,
  type AvailabilityPolicy,
} from "../../lib/availability-veto.ts";

const LOCAL_ORIGINS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
const MAX_STAGE_BODY_BYTES = 256 * 1024;

type StagedAvailability = Readonly<{
  stagedAt: string;
  artifact: AvailabilityArtifact;
  policy: AvailabilityPolicy;
}>;

let stagedAvailability: StagedAvailability | null = null;

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

function failClosed(origin: string | null, code: string, status: number, details: unknown = undefined) {
  stagedAvailability = null;
  return response(origin, { ok: false, code, ...(details === undefined ? {} : { details }) }, status);
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
  if (!stagedAvailability) return response(origin, { ok: false, code: "AVAILABILITY_STAGE_MISSING" }, 404);
  const state = stagedPublicState(stagedAvailability, new Date().toISOString());
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
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return failClosed(origin, "CONTENT_TYPE_REQUIRED", 415);

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    return failClosed(origin, error instanceof Error && error.message === "BODY_TOO_LARGE" ? "STAGE_BODY_TOO_LARGE" : "INVALID_JSON", 400);
  }
  if (!strictStageBody(body)) return failClosed(origin, "STAGE_BODY_INVALID", 400);

  const policyResult = parseAvailabilityPolicy(body.policy);
  const artifactResult = parseAvailabilityArtifact(body.artifact);
  if (!policyResult.ok || !artifactResult.ok) {
    return failClosed(origin, "AVAILABILITY_STAGE_INVALID", 422, [
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
    return failClosed(origin, "AVAILABILITY_STAGE_NOT_FRESH", 422, evaluation.blockingReasons);
  }
  stagedAvailability = Object.freeze({ stagedAt, artifact: artifactResult.value, policy: policyResult.value });
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

