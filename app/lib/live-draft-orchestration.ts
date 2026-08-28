import type { DraftPick } from "./draft-engine";

export const MIN_SNAKE_MONITOR_LEAD_MS = 5_000;

export type AuthoritativePickFeedCursor = {
  sequence: number;
  eventCount: number;
  fingerprint: string;
};

export type PickFeedRuntimeHealth = {
  observedAt: string | null;
  lagging: boolean;
  fresh: boolean;
};

export function inferAuctionSaleCountFromBudgets(
  budgets: Array<{ teamName?: string; remaining?: number; maxOffer?: number }> | undefined,
  league: { size: number; rosterSize: number },
) {
  if (!Array.isArray(budgets) || budgets.length !== league.size) return undefined;
  const normalizedTeams = budgets.map((budget) => String(budget.teamName || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (normalizedTeams.some((team) => !team) || new Set(normalizedTeams).size !== league.size) return null;
  let sales = 0;
  for (const budget of budgets) {
    const remaining = Number(budget.remaining);
    const maxOffer = Number(budget.maxOffer);
    if (!Number.isSafeInteger(remaining) || remaining < 0
      || !Number.isSafeInteger(maxOffer) || maxOffer < 0 || maxOffer > remaining) return null;
    if (maxOffer === 0) {
      // ESPN's $0/$0 practice sentinel cannot independently distinguish a
      // complete roster from stale/exhausted budget state. Fail closed.
      if (remaining === 0) return null;
      sales += league.rosterSize;
      continue;
    }
    const openSlots = remaining - maxOffer + 1;
    if (!Number.isSafeInteger(openSlots) || openSlots < 0 || openSlots > league.rosterSize) return null;
    sales += league.rosterSize - openSlots;
  }
  return sales;
}

export type SnakePlanIdentity = {
  leagueId: string;
  teamId: number;
  tabId: number;
  expectedPick: number;
  playerId: number;
  sourceSnapshotId: string;
  availabilityDigest: string;
  submitTargetSeconds: number;
};

export type SnakePlanTiming = {
  decidedAt: string;
  submitNotBeforeAt: string;
  submitTargetSeconds: number;
};

export type DraftActionResultSummary = {
  ok?: unknown;
  code?: unknown;
  action?: { operation?: unknown } | null;
};

/**
 * A superseded bid is a terminal acknowledgement for the click that already
 * happened, but not for the live auction decision. Signal one fresh decision
 * cycle without treating uncertain or failed clicks as safe to retry.
 */
export function shouldReevaluateSupersededBid(result: DraftActionResultSummary) {
  return result?.ok === true
    && result?.code === "BID_SUPERSEDED"
    && result?.action?.operation === "BID";
}

function validFeedPick(pick: DraftPick) {
  return Number.isInteger(Number(pick.overall))
    && Number(pick.overall) > 0
    && Number.isInteger(Number(pick.playerId))
    && ![0, -1].includes(Number(pick.playerId))
    && Number.isInteger(Number(pick.teamId))
    && Number(pick.teamId) > 0;
}

function parseAuthoritativePickFeed(picks: DraftPick[]) {
  if (!Array.isArray(picks)) return { valid: false, cursor: null } as const;
  if (!picks.length) return { valid: true, cursor: null } as const;
  if (!picks.every(validFeedPick)) return { valid: false, cursor: null } as const;
  const events = picks
    .map((pick) => ({
      sequence: Math.trunc(Number(pick.overall)),
      playerId: Math.trunc(Number(pick.playerId)),
      teamId: Math.trunc(Number(pick.teamId)),
      amount: Math.max(0, Math.trunc(Number(pick.amount || 0))),
    }))
    .sort((left, right) => left.sequence - right.sequence || left.playerId - right.playerId);
  const playerIds = new Set<number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1 || playerIds.has(event.playerId)) {
      return { valid: false, cursor: null } as const;
    }
    playerIds.add(event.playerId);
  }
  const cursor: AuthoritativePickFeedCursor = {
    sequence: events.at(-1)?.sequence || 0,
    eventCount: events.length,
    fingerprint: events.map((event) => (
      `${event.sequence}:${event.playerId}:${event.teamId}:${event.amount}`
    )).join("|"),
  };
  return { valid: true, cursor } as const;
}

/**
 * Build a monotonic cursor from ESPN's reconciled pick/sale ledger. A timer or
 * context heartbeat is deliberately not part of the cursor: only an actual
 * sequence/identity observation can make the feed fresh again.
 */
export function authoritativePickFeedCursor(picks: DraftPick[]): AuthoritativePickFeedCursor | null {
  const parsed = parseAuthoritativePickFeed(picks);
  return parsed.valid ? parsed.cursor : null;
}

export function advanceAuthoritativePickFeed(
  previous: AuthoritativePickFeedCursor | null,
  picks: DraftPick[],
) {
  const parsed = parseAuthoritativePickFeed(picks);
  if (!parsed.valid) {
    return { accepted: false, advanced: false, cursor: previous } as const;
  }
  const candidate = parsed.cursor;
  if (!candidate) {
    return {
      accepted: previous === null && picks.length === 0,
      advanced: false,
      cursor: previous,
    } as const;
  }
  if (!previous) return { accepted: true, advanced: true, cursor: candidate } as const;
  if (candidate.sequence < previous.sequence) {
    return { accepted: false, advanced: false, cursor: previous } as const;
  }
  if (candidate.sequence === previous.sequence && candidate.eventCount < previous.eventCount) {
    return { accepted: false, advanced: false, cursor: previous } as const;
  }
  if (candidate.sequence === previous.sequence && candidate.fingerprint === previous.fingerprint) {
    return { accepted: true, advanced: false, cursor: previous } as const;
  }
  // ESPN's ledger is append-only. A response that rewrites, removes, or skips
  // an already accepted event cannot renew feed health even if its final
  // sequence appears newer.
  if (!candidate.fingerprint.startsWith(`${previous.fingerprint}|`)) {
    return { accepted: false, advanced: false, cursor: previous } as const;
  }
  return { accepted: true, advanced: true, cursor: candidate } as const;
}

export function authoritativePickFeedHealth(
  previous: AuthoritativePickFeedCursor | null,
  picks: DraftPick[],
  context: {
    currentPick?: number | null;
    auctionSales?: Array<{ sequence?: number }>;
    budgetInferredSaleCount?: number | null;
  },
  draftType: "SNAKE" | "AUCTION",
) {
  const observation = advanceAuthoritativePickFeed(previous, picks);
  const cursor = observation.cursor;
  const observedSequence = cursor?.sequence ?? 0;
  const observedEvents = cursor?.eventCount ?? 0;
  if (draftType === "SNAKE") {
    // currentPick is the active event. Only completed picks before it must be
    // present, so pick 1 with an empty ledger is healthy.
    const currentPick = Number(context.currentPick);
    const expectedCompleted = Number.isInteger(currentPick) && currentPick > 0
      ? currentPick - 1
      : 0;
    const lagging = observedSequence < expectedCompleted;
    return {
      ...observation,
      lagging,
    } as const;
  }
  const sales = Array.isArray(context.auctionSales) ? context.auctionSales : [];
  const visibleCompleted = sales.reduce((maximum, sale, index) => (
    Math.max(maximum, Number.isInteger(Number(sale.sequence)) ? Number(sale.sequence) : index + 1)
  ), 0);
  const hasBudgetCount = Object.hasOwn(context, "budgetInferredSaleCount");
  const budgetCount = context.budgetInferredSaleCount;
  const budgetEvidenceInvalid = hasBudgetCount
    && (!Number.isSafeInteger(budgetCount) || Number(budgetCount) < 0);
  const independentlyObservedCompleted = Number.isSafeInteger(budgetCount) && Number(budgetCount) >= 0
    ? Number(budgetCount)
    : 0;
  const lagging = budgetEvidenceInvalid
    || Math.max(observedSequence, observedEvents) < Math.max(visibleCompleted, independentlyObservedCompleted);
  return {
    ...observation,
    lagging,
  } as const;
}

export function nextPickFeedRuntimeHealth(
  previous: PickFeedRuntimeHealth,
  observedAt: string,
  observation: { accepted: boolean; lagging: boolean },
): PickFeedRuntimeHealth {
  if (!observation.accepted) {
    return { observedAt: previous.observedAt, lagging: true, fresh: false };
  }
  return {
    observedAt,
    lagging: observation.lagging,
    fresh: !observation.lagging,
  };
}

function safeIdentityPart(value: string | number) {
  return encodeURIComponent(String(value).trim());
}

export function snakePlanKey(identity: SnakePlanIdentity) {
  if (!String(identity.leagueId).trim()
    || !Number.isInteger(identity.teamId) || identity.teamId <= 0
    || !Number.isInteger(identity.tabId) || identity.tabId <= 0
    || !Number.isInteger(identity.expectedPick) || identity.expectedPick <= 0
    || !Number.isInteger(identity.playerId) || identity.playerId === 0
    || !String(identity.sourceSnapshotId).trim()
    || !String(identity.availabilityDigest).trim()
    || !Number.isInteger(identity.submitTargetSeconds) || identity.submitTargetSeconds < 0) {
    throw new Error("INVALID_SNAKE_PLAN_IDENTITY");
  }
  return [
    identity.leagueId,
    identity.teamId,
    identity.tabId,
    identity.expectedPick,
    identity.playerId,
    identity.sourceSnapshotId,
    identity.availabilityDigest,
    identity.submitTargetSeconds,
  ].map(safeIdentityPart).join(":");
}

export function buildSnakePlanTiming(
  now: number,
  remainingSeconds: number,
  submitTargetSeconds: number,
): SnakePlanTiming {
  if (!Number.isFinite(now)
    || !Number.isFinite(remainingSeconds) || remainingSeconds < 0
    || !Number.isInteger(submitTargetSeconds) || submitTargetSeconds < 0) {
    throw new Error("INVALID_SNAKE_PLAN_TIMING");
  }
  const decidedAt = new Date(now).toISOString();
  const millisecondsUntilTarget = Math.max(0, (remainingSeconds - submitTargetSeconds) * 1_000);
  return {
    decidedAt,
    submitNotBeforeAt: new Date(now + millisecondsUntilTarget).toISOString(),
    submitTargetSeconds,
  };
}

export function snakePlanReadyToSubmit(
  plan: Pick<SnakePlanTiming, "decidedAt" | "submitNotBeforeAt" | "submitTargetSeconds">,
  now: number,
  remainingSeconds: number,
  minimumAnnouncementLeadMs = MIN_SNAKE_MONITOR_LEAD_MS,
) {
  const decidedAt = Date.parse(plan.decidedAt);
  const submitNotBeforeAt = Date.parse(plan.submitNotBeforeAt);
  if (!Number.isFinite(now)
    || !Number.isFinite(remainingSeconds)
    || !Number.isFinite(decidedAt)
    || !Number.isFinite(submitNotBeforeAt)
    || !Number.isInteger(plan.submitTargetSeconds)
    || !Number.isFinite(minimumAnnouncementLeadMs)
    || minimumAnnouncementLeadMs < 0) return false;
  return remainingSeconds <= plan.submitTargetSeconds
    && now >= submitNotBeforeAt
    && now - decidedAt >= minimumAnnouncementLeadMs;
}
