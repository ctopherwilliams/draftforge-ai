import type { DraftActionTelemetryEvent } from "./draft-audit.ts";
import type { DraftPlayer, Recommendation } from "./draft-engine.ts";
import type { EspnAuctionSale } from "./espn-context-state.ts";

export const MAX_SALARY_CAP_EVIDENCE_SALES = 256;

export type SalaryCapDecisionObservation = {
  playerId: number;
  position: string;
  sourceAuction: number;
  fairValue: number;
  targetBid: number;
  maxApprovedBid: number;
  highestObservedBid: number;
  nominationIntent: "TARGET" | "DRAIN" | null;
};

export type SalaryCapEvidenceSale = SalaryCapDecisionObservation & {
  sequence: number;
  closingPrice: number;
  outcome: "WON" | "BID_LOST" | "PASSED" | "DRAINED";
  submittedBidCount: number;
  highestSubmittedBid: number;
};

export function observeSalaryCapDecision(
  current: SalaryCapDecisionObservation | undefined,
  player: Recommendation,
  currentBid: number,
  nominationIntent: "TARGET" | "DRAIN" | null,
): SalaryCapDecisionObservation {
  return {
    playerId: player.id,
    position: player.pos,
    sourceAuction: Number(player.auction || current?.sourceAuction || 1),
    fairValue: Number(player.fairValue || current?.fairValue || 1),
    targetBid: Number(player.targetBid || current?.targetBid || 0),
    maxApprovedBid: Number(player.maxBid ?? current?.maxApprovedBid ?? 0),
    highestObservedBid: Math.max(Number(current?.highestObservedBid || 0), Number(currentBid || 0)),
    nominationIntent: nominationIntent || current?.nominationIntent || null,
  };
}

export function buildSalaryCapEvidence(input: {
  sales: EspnAuctionSale[];
  playerById: Map<number, DraftPlayer>;
  ownPlayerIds: Set<number>;
  actions: DraftActionTelemetryEvent[];
  observations: Map<number, SalaryCapDecisionObservation>;
}): SalaryCapEvidenceSale[] {
  const seen = new Set<number>();
  return input.sales.flatMap((sale, index) => {
    const playerId = Number(sale.playerId || 0);
    const closingPrice = Math.max(0, Math.trunc(Number(sale.amount || 0)));
    const player = input.playerById.get(playerId);
    if (!Number.isInteger(playerId) || playerId === 0 || !player || closingPrice < 1 || seen.has(playerId)) return [];
    seen.add(playerId);
    const observation = input.observations.get(playerId);
    const bids = input.actions.filter((event) => (
      event.operation === "BID"
      && event.ok
      && Number(event.playerId) === playerId
      && Number(event.amount || 0) > 0
    ));
    const highestSubmittedBid = bids.reduce((highest, event) => Math.max(highest, Number(event.amount || 0)), 0);
    const nominationIntent = observation?.nominationIntent
      || input.actions.findLast((event) => event.operation === "NOMINATE" && event.ok && Number(event.playerId) === playerId)?.nominationIntent
      || null;
    const outcome: SalaryCapEvidenceSale["outcome"] = input.ownPlayerIds.has(playerId)
      ? "WON"
      : nominationIntent === "DRAIN"
        ? "DRAINED"
        : bids.length
          ? "BID_LOST"
          : "PASSED";
    return [{
      sequence: Math.max(1, Math.trunc(Number(sale.sequence || index + 1))),
      playerId,
      position: player.pos,
      closingPrice,
      sourceAuction: Number(observation?.sourceAuction ?? player.auction ?? 1),
      fairValue: Number(observation?.fairValue ?? 0),
      targetBid: Math.max(0, Math.trunc(Number(observation?.targetBid || 0))),
      maxApprovedBid: Math.max(0, Math.trunc(Number(observation?.maxApprovedBid || 0))),
      highestObservedBid: Math.max(closingPrice, Math.trunc(Number(observation?.highestObservedBid || 0))),
      nominationIntent,
      outcome,
      submittedBidCount: bids.length,
      highestSubmittedBid,
    }];
  }).slice(-MAX_SALARY_CAP_EVIDENCE_SALES);
}
