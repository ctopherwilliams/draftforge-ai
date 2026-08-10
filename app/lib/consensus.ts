import type { DraftPlayer } from "./draft-engine";

export type IntelligencePlayer = {
  name: string;
  team: string;
  pos: string;
  rank?: number;
  adp?: number;
  auction?: number;
  projectedPpg?: number;
  sourceScore?: number;
};

export type IntelligenceSource = {
  id: "ffc" | "mfl" | "tradyr" | "gng";
  name: string;
  kind: "market" | "model" | "composite";
  weight: number;
  status: "ok" | "error";
  updatedAt: string | null;
  attribution: string;
  players: IntelligencePlayer[];
  sampleSize?: number;
  error?: string;
};

export type ConsensusPlayer = DraftPlayer & {
  consensusRank: number;
  consensusScore: number;
  consensusConfidence: number;
  rankSpread: number;
  sourceCount: number;
  sourceRanks: Record<string, number>;
};

const SOURCE_WEIGHTS: Record<string, number> = { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 };

export function normalizePlayerName(value: string) {
  return value.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = left[i - 1] === right[j - 1] ? diagonal : Math.min(diagonal, above, previous[j - 1]) + 1;
      diagonal = above;
    }
  }
  return previous[right.length];
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function findSignal(player: DraftPlayer, source: IntelligenceSource) {
  const key = normalizePlayerName(player.name);
  return source.players.find((candidate) => {
    const positionMatches = !candidate.pos || candidate.pos === player.pos || candidate.pos === "FLEX";
    if (!positionMatches) return false;
    const candidateKey = normalizePlayerName(candidate.name);
    if (candidateKey === key) return true;
    const teamMatches = !candidate.team || !player.team || candidate.team === player.team;
    return teamMatches && editDistance(candidateKey, key) <= 1;
  });
}

export function mergeConsensus(espnPlayers: DraftPlayer[], sources: IntelligenceSource[]): ConsensusPlayer[] {
  const healthySources = sources.filter((source) => source.status === "ok" && source.players.length);
  const enriched = espnPlayers.map((player) => {
    const sourceRanks: Record<string, number> = { espn: Number(player.rank || player.adp || 999) };
    const adps = [{ value: player.adp, weight: SOURCE_WEIGHTS.espn }];
    const auctions = [{ value: player.auction, weight: SOURCE_WEIGHTS.espn }];
    let weightedPercentile = SOURCE_WEIGHTS.espn * Math.max(0, 1 - (sourceRanks.espn - 1) / Math.max(espnPlayers.length - 1, 1));
    let totalWeight = SOURCE_WEIGHTS.espn;

    for (const source of healthySources) {
      const signal = findSignal(player, source);
      if (!signal) continue;
      const rank = Number(signal.rank || signal.adp || 999);
      if (rank < 999) {
        sourceRanks[source.id] = rank;
        const maxRank = Math.max(source.players.length, 2);
        weightedPercentile += source.weight * Math.max(0, 1 - (rank - 1) / (maxRank - 1));
        totalWeight += source.weight;
      }
      if (signal.adp && signal.adp < 999) adps.push({ value: signal.adp, weight: source.weight });
      if (signal.auction && signal.auction > 0) auctions.push({ value: signal.auction, weight: source.weight });
    }

    const ranks = Object.values(sourceRanks);
    const rankSpread = standardDeviation(ranks);
    const consensusScore = totalWeight ? weightedPercentile / totalWeight * 100 : 0;
    const sourceCount = ranks.length;
    const coverage = sourceCount / 5;
    const consensusConfidence = Math.round(Math.max(35, Math.min(98, 52 + coverage * 38 - Math.min(20, rankSpread * .65))));
    const weightedAdp = adps.reduce((sum, item) => sum + item.value * item.weight, 0) / adps.reduce((sum, item) => sum + item.weight, 0);
    const weightedAuction = auctions.reduce((sum, item) => sum + item.value * item.weight, 0) / auctions.reduce((sum, item) => sum + item.weight, 0);
    return { ...player, adp: weightedAdp, auction: weightedAuction, consensusRank: 999, consensusScore, consensusConfidence, rankSpread, sourceCount, sourceRanks };
  });

  const order = [...enriched].sort((a, b) => b.consensusScore - a.consensusScore);
  const ranks = new Map(order.map((player, index) => [player.id, index + 1]));
  return enriched.map((player) => ({ ...player, consensusRank: ranks.get(player.id) || 999 }));
}
