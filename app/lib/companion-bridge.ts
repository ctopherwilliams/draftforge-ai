export const COMPANION_BRIDGE_PROTOCOL_VERSION = 2 as const;
export const COMPANION_APP_SOURCE = "draftforge-web-v2";
export const COMPANION_EXTENSION_SOURCE = "draftforge-extension-v2";

const CHROME_EXTENSION_RUNTIME_ID = /^[a-p]{32}$/;

export type CompanionRuntimeElection = Readonly<{
  ok: boolean;
  runtimeId: string;
  code: "COMPANION_RUNTIME_ELECTED" | "COMPANION_RUNTIME_CURRENT" | "COMPANION_RUNTIME_ID_INVALID" | "MULTIPLE_COMPANION_RUNTIMES";
}>;

export function electCompanionRuntime(
  currentRuntimeId: string,
  candidateRuntimeId: unknown,
): CompanionRuntimeElection {
  const candidate = String(candidateRuntimeId || "");
  if (!CHROME_EXTENSION_RUNTIME_ID.test(candidate)) {
    return { ok: false, runtimeId: "", code: "COMPANION_RUNTIME_ID_INVALID" };
  }
  if (!currentRuntimeId) {
    return { ok: true, runtimeId: candidate, code: "COMPANION_RUNTIME_ELECTED" };
  }
  if (candidate === currentRuntimeId) {
    return { ok: true, runtimeId: currentRuntimeId, code: "COMPANION_RUNTIME_CURRENT" };
  }
  return { ok: false, runtimeId: "", code: "MULTIPLE_COMPANION_RUNTIMES" };
}

export function companionBridgeEnvelopeMatches(
  value: unknown,
  expectedRuntimeId: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return envelope.source === COMPANION_EXTENSION_SOURCE
    && envelope.bridgeProtocolVersion === COMPANION_BRIDGE_PROTOCOL_VERSION
    && String(envelope.extensionRuntimeId || "") === expectedRuntimeId;
}
