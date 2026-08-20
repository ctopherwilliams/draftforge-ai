import type { DraftAuditSleeperCandidate } from "./draft-audit.ts";

export const MAX_AUTHENTICATED_SLEEPER_EVIDENCE = 64;

export function mergeAuthenticatedSleeperEvidence(input: {
  current: DraftAuditSleeperCandidate[];
  observed: DraftAuditSleeperCandidate[];
  ownPicks: { playerId: number; overall: number; amount: number }[];
  currentPick: number;
}) {
  const byPlayer = new Map(input.current.map((candidate) => [candidate.playerId, candidate]));
  const observedPick = Math.max(1, Math.trunc(Number(input.currentPick || 1)));
  for (const candidate of input.observed) {
    const prior = byPlayer.get(candidate.playerId);
    byPlayer.set(candidate.playerId, {
      ...prior,
      ...candidate,
      firstSeenPick: prior?.firstSeenPick ?? observedPick,
      lastSeenPick: Math.max(Number(prior?.lastSeenPick || 0), observedPick),
      acquired: prior?.acquired || false,
      acquisitionPick: prior?.acquisitionPick ?? null,
      acquisitionAmount: prior?.acquisitionAmount ?? 0,
    });
  }
  const picksByPlayer = new Map(input.ownPicks.map((pick) => [pick.playerId, pick]));
  for (const [playerId, candidate] of byPlayer) {
    const pick = picksByPlayer.get(playerId);
    if (!pick) continue;
    byPlayer.set(playerId, {
      ...candidate,
      acquired: true,
      acquisitionPick: Math.max(1, Math.trunc(Number(pick.overall || 1))),
      acquisitionAmount: Math.max(0, Math.trunc(Number(pick.amount || 0))),
    });
  }
  return [...byPlayer.values()]
    .sort((left, right) => Number(right.acquired) - Number(left.acquired)
      || right.score - left.score
      || Number(left.firstSeenPick || 0) - Number(right.firstSeenPick || 0)
      || left.playerId - right.playerId)
    .slice(0, MAX_AUTHENTICATED_SLEEPER_EVIDENCE);
}
