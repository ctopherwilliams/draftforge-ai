export const DEFAULT_DRAFT_AUDIT_POST_TIMEOUT_MS = 1_250;
export const DEFAULT_DRAFT_AUDIT_ACK_TTL_MS = 12_000;
export const DEFAULT_DRAFT_AUDIT_ABORT_SETTLEMENT_GRACE_MS = 100;

export type DraftAuditPublisherBinding = {
  commandCenterSessionId: string;
  liveControlSessionId: string;
  leagueId: string;
  teamId: number;
  tabId: number;
};

export type DraftAuditRecordedPublication = {
  digest: string;
  capturedAt: string;
  binding: DraftAuditPublisherBinding;
  decisionId: string | null;
};

export type DraftAuditPublishResult = {
  ok: boolean;
  status: number;
  code: string;
  controlCode?: string;
  recordedPublication?: DraftAuditRecordedPublication | null;
  payload?: unknown;
};

export type DraftAuditPublication<T> = {
  digest: string;
  capturedAt: string;
  snapshot: T;
  binding: DraftAuditPublisherBinding;
  decisionId: string | null;
  /**
   * Stable identity for the safety-relevant decision state. Clock-only and
   * presentation-only snapshots may share this key; any safety/control change
   * must produce a different key. Older callers fall back to decisionId.
   */
  authorizationKey?: string | null;
};

export type DraftAuditPublisherAck = {
  digest: string;
  bindingKey: string;
  decisionId: string | null;
  authorizationKey: string | null;
  recordedAt: number;
  generation: number;
};

export type DraftAuditPublishFailure = {
  code: string;
  controlCode?: string;
  status: number;
  permanent: boolean;
};

export type DraftAuditPublisher<T> = {
  bind(binding: DraftAuditPublisherBinding): boolean;
  clear(reason?: string): void;
  enqueue(publication: DraftAuditPublication<T>): boolean;
  flush(): Promise<void>;
  isAuthorized(binding: DraftAuditPublisherBinding, requiredDecisionId?: string | null, now?: number): boolean;
  waitUntilAuthorized(binding: DraftAuditPublisherBinding, requiredDecisionId: string, timeoutMs: number): Promise<boolean>;
  getAck(): DraftAuditPublisherAck | null;
};

type DraftAuditPublisherOptions<T> = {
  post(publication: DraftAuditPublication<T>, signal: AbortSignal): Promise<DraftAuditPublishResult>;
  timeoutMs?: number;
  abortSettlementGraceMs?: number;
  ackTtlMs?: number;
  retryDelaysMs?: number[];
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  onRecorded?: (publication: DraftAuditPublication<T>, result: DraftAuditPublishResult) => void;
  onAuthorizationLost?: (failure: DraftAuditPublishFailure) => void;
};

function safeIdentifier(value: unknown) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value);
}

/**
 * Compact deterministic identity for the exact JSON snapshot stored by the
 * audit route. This is an acknowledgement identity, not a ranking input.
 */
function draftAuditPublicationDigestFromSerialized(serialized: string) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x5bd1e995);
  }
  return `draft-audit-v1:${serialized.length.toString(16)}:${(left >>> 0).toString(16).padStart(8, "0")}:${(right >>> 0).toString(16).padStart(8, "0")}`;
}

export function materializeDraftAuditPublication(snapshot: unknown) {
  const serialized = JSON.stringify(snapshot);
  return Object.freeze({
    serialized,
    digest: draftAuditPublicationDigestFromSerialized(serialized),
  });
}

export function draftAuditPublicationDigest(snapshot: unknown) {
  return materializeDraftAuditPublication(snapshot).digest;
}

export function draftAuditPublisherBindingKey(binding: DraftAuditPublisherBinding) {
  if (!binding || typeof binding !== "object"
    || !safeIdentifier(binding.commandCenterSessionId)
    || !safeIdentifier(binding.liveControlSessionId)
    || !safeIdentifier(binding.leagueId)
    || !Number.isSafeInteger(binding.teamId)
    || binding.teamId <= 0
    || !Number.isSafeInteger(binding.tabId)
    || binding.tabId <= 0) return null;
  return [
    binding.commandCenterSessionId,
    binding.liveControlSessionId,
    binding.leagueId,
    binding.teamId,
    binding.tabId,
  ].join("|");
}

function validPublication<T>(publication: DraftAuditPublication<T>) {
  const authorizationKey = publication.authorizationKey === undefined
    ? publication.decisionId
    : publication.authorizationKey;
  return typeof publication.digest === "string"
    && publication.digest.length >= 8
    && publication.digest.length <= 1_000_000
    && Number.isFinite(Date.parse(publication.capturedAt))
    && (publication.decisionId === null || safeIdentifier(publication.decisionId))
    && (authorizationKey === null || safeIdentifier(authorizationKey))
    && ((publication.decisionId === null) === (authorizationKey === null))
    && draftAuditPublisherBindingKey(publication.binding) !== null;
}

function normalizedAuthorizationKey<T>(publication: DraftAuditPublication<T>) {
  return publication.authorizationKey === undefined
    ? publication.decisionId
    : publication.authorizationKey;
}

function exactRecordedPublication<T>(
  publication: DraftAuditPublication<T>,
  result: DraftAuditPublishResult,
) {
  const recorded = result.recordedPublication;
  return Boolean(recorded
    && recorded.digest === publication.digest
    && recorded.capturedAt === publication.capturedAt
    && recorded.decisionId === publication.decisionId
    && draftAuditPublisherBindingKey(recorded.binding) === draftAuditPublisherBindingKey(publication.binding));
}

async function postWithDeadline<T>(
  post: DraftAuditPublisherOptions<T>["post"],
  publication: DraftAuditPublication<T>,
  timeoutMs: number,
  abortSettlementGraceMs: number,
  controller: AbortController,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settlementTimeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let transportSettled = false;
  let transportRequest: Promise<DraftAuditPublishResult>;
  try {
    transportRequest = Promise.resolve(post(publication, controller.signal));
  } catch {
    transportRequest = Promise.resolve({ ok: false, status: 0, code: "DRAFT_AUDIT_POST_FAILED" });
  }
  const transport = transportRequest
    .catch((error) => ({
      ok: false,
      status: 0,
      code: error instanceof Error && error.name === "AbortError"
        ? "DRAFT_AUDIT_POST_TIMEOUT"
        : "DRAFT_AUDIT_POST_FAILED",
    } satisfies DraftAuditPublishResult))
    .finally(() => {
      transportSettled = true;
    });
  let resolveDeadline: ((result: DraftAuditPublishResult) => void) | null = null;
  const handleAbort = () => {
    if (!timedOut) resolveDeadline?.({ ok: false, status: 0, code: "DRAFT_AUDIT_POST_ABORTED" });
  };
  const deadline = new Promise<DraftAuditPublishResult>((resolve) => {
    resolveDeadline = resolve;
    controller.signal.addEventListener("abort", handleAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      resolve({ ok: false, status: 0, code: "DRAFT_AUDIT_POST_TIMEOUT" });
      controller.abort("DRAFT_AUDIT_POST_TIMEOUT");
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([transport, deadline]);
    if (!transportSettled && controller.signal.aborted) {
      await Promise.race([
        transport.then(() => undefined),
        new Promise<void>((resolve) => {
          settlementTimeout = setTimeout(resolve, abortSettlementGraceMs);
        }),
      ]);
    }
    return { result, transportSettled };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (settlementTimeout !== undefined) clearTimeout(settlementTimeout);
    controller.signal.removeEventListener("abort", handleAbort);
  }
}

/**
 * Single-flight, latest-only audit publisher for telemetry, while the first
 * exact decision snapshot is protected long enough to receive a server ack.
 * Later clock-only snapshots with the same authorization key cannot starve or
 * invalidate that ack. A safety/control change uses a new key and fences it.
 */
export function createDraftAuditPublisher<T>(options: DraftAuditPublisherOptions<T>): DraftAuditPublisher<T> {
  const timeoutMs = Math.max(100, Math.trunc(options.timeoutMs ?? DEFAULT_DRAFT_AUDIT_POST_TIMEOUT_MS));
  const abortSettlementGraceMs = Math.max(
    10,
    Math.min(1_000, Math.trunc(options.abortSettlementGraceMs ?? DEFAULT_DRAFT_AUDIT_ABORT_SETTLEMENT_GRACE_MS)),
  );
  const ackTtlMs = Math.max(timeoutMs, Math.trunc(options.ackTtlMs ?? DEFAULT_DRAFT_AUDIT_ACK_TTL_MS));
  const retryDelaysMs = (options.retryDelaysMs ?? [125, 250])
    .map((delay) => Math.max(0, Math.trunc(delay)))
    .slice(0, 4);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  let binding: DraftAuditPublisherBinding | null = null;
  let bindingKey: string | null = null;
  let generation = 0;
  let ack: DraftAuditPublisherAck | null = null;
  type QueuedPublication = DraftAuditPublication<T> & {
    generation: number;
    authorizationKey: string | null;
  };
  let latest: QueuedPublication | null = null;
  let activePublication: QueuedPublication | null = null;
  let draining: Promise<void> | null = null;
  let activeController: AbortController | null = null;
  let permanentlyBlocked = false;
  // An abort-ignoring transport leaves delivery indeterminate. This poison is
  // deliberately not reset by bind/clear: only a new publisher instance (page
  // reload) may recover after the old transport failed to prove quiescence.
  let transportUnsettled = false;
  let authorizationEpoch = 0;

  const loseAuthorization = (result: DraftAuditPublishResult, permanent: boolean) => {
    authorizationEpoch += 1;
    ack = null;
    if (permanent) permanentlyBlocked = true;
    options.onAuthorizationLost?.({
      code: result.code || `HTTP_${result.status}`,
      ...(result.controlCode ? { controlCode: result.controlCode } : {}),
      status: result.status,
      permanent,
    });
  };

  const drain = async () => {
    while (latest && binding && bindingKey && !permanentlyBlocked && !transportUnsettled) {
      let candidate = latest;
      let attempt = 0;
      while (candidate && binding && bindingKey && !permanentlyBlocked && !transportUnsettled) {
        if (candidate.generation !== generation
          || draftAuditPublisherBindingKey(candidate.binding) !== bindingKey) break;
        const requestController = new AbortController();
        activePublication = candidate;
        activeController = requestController;
        const outcome = await postWithDeadline(
          options.post,
          candidate,
          timeoutMs,
          abortSettlementGraceMs,
          requestController,
        );
        if (activeController === requestController) activeController = null;
        if (activePublication?.digest === candidate.digest) activePublication = null;
        if (!outcome.transportSettled) {
          transportUnsettled = true;
          loseAuthorization({
            ok: false,
            status: 0,
            code: "DRAFT_AUDIT_POST_ABORT_UNSETTLED",
          }, true);
          latest = null;
          break;
        }
        const result = outcome.result;
        if (candidate.generation !== generation || !binding || !bindingKey) break;

        if (result.ok
          && result.code === "DRAFT_AUDIT_RECORDED"
          && exactRecordedPublication(candidate, result)) {
          const newer = latest && latest.digest !== candidate.digest ? latest : null;
          const sameProtectedDecision = Boolean(newer
            && candidate.authorizationKey
            && newer.authorizationKey === candidate.authorizationKey
            && newer.decisionId === candidate.decisionId);
          // Ordinary telemetry is latest-only. For an exact decision, however,
          // a clock-only successor shares the authorization key, so this exact
          // recorded snapshot is valid authorization while telemetry catches up.
          if (newer && !sameProtectedDecision) {
            candidate = newer;
            attempt = 0;
            continue;
          }
          ack = {
            digest: candidate.digest,
            bindingKey,
            decisionId: candidate.decisionId,
            authorizationKey: candidate.authorizationKey,
            recordedAt: now(),
            generation,
          };
          options.onRecorded?.(candidate, result);
          if (!newer) {
            if (latest?.digest === candidate.digest) latest = null;
            break;
          }
          candidate = newer;
          attempt = 0;
          continue;
        }

        if (result.ok && result.code === "DRAFT_AUDIT_RECORDED") {
          loseAuthorization({
            ok: false,
            status: 409,
            code: "DRAFT_AUDIT_ACK_MISMATCH",
          }, true);
          latest = null;
          break;
        }

        const permanent = result.status === 409;
        loseAuthorization(result, permanent);
        if (permanent) {
          latest = null;
          break;
        }
        // Never spend a retry on obsolete state. The newest queued snapshot is
        // the only one that can restore publisher authorization.
        if (latest && latest.digest !== candidate.digest) {
          candidate = latest;
          attempt = 0;
          continue;
        }
        if (attempt >= retryDelaysMs.length) {
          if (latest?.digest === candidate.digest) latest = null;
          break;
        }
        await sleep(retryDelaysMs[attempt]);
        attempt += 1;
        candidate = latest;
      }
    }
  };

  const startDrain = () => {
    if (draining || transportUnsettled) return;
    draining = drain().finally(() => {
      draining = null;
      if (latest && binding && !permanentlyBlocked && !transportUnsettled) startDrain();
    });
  };

  return {
    bind(nextBinding) {
      const nextKey = draftAuditPublisherBindingKey(nextBinding);
      if (!nextKey) throw new Error("INVALID_DRAFT_AUDIT_PUBLISHER_BINDING");
      if (nextKey === bindingKey) return false;
      generation += 1;
      authorizationEpoch += 1;
      activeController?.abort("DRAFT_AUDIT_PUBLISHER_REBOUND");
      activeController = null;
      activePublication = null;
      binding = { ...nextBinding };
      bindingKey = nextKey;
      ack = null;
      latest = null;
      permanentlyBlocked = transportUnsettled;
      return true;
    },
    clear() {
      generation += 1;
      authorizationEpoch += 1;
      activeController?.abort("DRAFT_AUDIT_PUBLISHER_CLEARED");
      activeController = null;
      activePublication = null;
      binding = null;
      bindingKey = null;
      ack = null;
      latest = null;
      permanentlyBlocked = transportUnsettled;
    },
    enqueue(publication) {
      const publicationKey = draftAuditPublisherBindingKey(publication.binding);
      if (!validPublication(publication)
        || !binding
        || !bindingKey
        || publicationKey !== bindingKey
        || permanentlyBlocked
        || transportUnsettled) return false;
      if (ack?.digest === publication.digest || latest?.digest === publication.digest) return true;
      const authorizationKey = normalizedAuthorizationKey(publication);
      const existingProtectedKeys = [
        ack?.authorizationKey,
        activePublication?.authorizationKey,
        latest?.authorizationKey,
      ].filter((key): key is string => Boolean(key));
      const supersedesProtectedDecision = existingProtectedKeys.some((key) => key !== authorizationKey);
      if (supersedesProtectedDecision) {
        authorizationEpoch += 1;
        ack = null;
      }
      latest = { ...publication, generation, authorizationKey };
      startDrain();
      return true;
    },
    async flush() {
      while (draining) await draining;
    },
    isAuthorized(expectedBinding, requiredDecisionId = null, checkedAt = now()) {
      const expectedKey = draftAuditPublisherBindingKey(expectedBinding);
      if (!expectedKey
        || expectedKey !== bindingKey
        || permanentlyBlocked
        || transportUnsettled
        || !ack
        || ack.bindingKey !== expectedKey
        || ack.generation !== generation
        || !Number.isFinite(checkedAt)
        || checkedAt < ack.recordedAt
        || checkedAt - ack.recordedAt > ackTtlMs) return false;
      if (requiredDecisionId === null) return latest?.generation !== generation;
      if (ack.decisionId !== requiredDecisionId || !ack.authorizationKey) return false;
      return latest?.generation !== generation
        || (latest.decisionId === requiredDecisionId && latest.authorizationKey === ack.authorizationKey);
    },
    async waitUntilAuthorized(expectedBinding, requiredDecisionId, waitMs) {
      const expectedKey = draftAuditPublisherBindingKey(expectedBinding);
      if (!expectedKey || !safeIdentifier(requiredDecisionId)) return false;
      const startingAuthorizationEpoch = authorizationEpoch;
      const deadline = now() + Math.max(0, Math.min(3_000, Math.trunc(waitMs)));
      while (now() <= deadline) {
        if (authorizationEpoch !== startingAuthorizationEpoch) return false;
        if (this.isAuthorized(expectedBinding, requiredDecisionId)) return true;
        if (expectedKey !== bindingKey || permanentlyBlocked) return false;
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(15, remaining));
      }
      return this.isAuthorized(expectedBinding, requiredDecisionId);
    },
    getAck() {
      return ack ? { ...ack } : null;
    },
  };
}
