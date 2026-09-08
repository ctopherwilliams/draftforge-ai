export type AvailabilityStageReadStatus = "ready" | "missing" | "invalid" | "unavailable";
export type AvailabilityStage = { artifact: unknown; policy: unknown; stagedAt: string };

export function classifyAvailabilityStageRead(status: number, body: unknown): {
  status: AvailabilityStageReadStatus;
  stage: AvailabilityStage | null;
} {
  const staged = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if ((status === 200 || status === 409) && staged?.artifact && staged.policy) {
    // Artifact/policy schema and freshness validation remain the veto gate's job.
    return { status: "ready", stage: {
      artifact: staged.artifact, policy: staged.policy, stagedAt: String(staged.stagedAt || ""),
    } };
  }
  if (status === 404 && staged?.code === "AVAILABILITY_STAGE_MISSING") {
    return { status: "missing", stage: null };
  }
  return { status: status >= 500 ? "unavailable" : "invalid", stage: null };
}

export function availabilityStageReadLabel(status: AvailabilityStageReadStatus, hasStage: boolean) {
  if (status === "missing") return " · stage missing";
  if (status === "invalid") return " · stage invalid";
  if (status === "unavailable") return hasStage
    ? " · cached (live read degraded)"
    : " · live read unavailable";
  return "";
}
