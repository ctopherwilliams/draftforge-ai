import type { DraftPlayer, LeagueSettings } from "./draft-engine";

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
  url?: string;
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
  sourceAuctions: Record<string, number>;
};

const SOURCE_WEIGHTS: Record<string, number> = { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 };
const MAX_SOURCE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type AuctionContext = Pick<LeagueSettings, "size" | "rosterSize" | "auctionBudget">;

export function isIntelligenceSourceFresh(source: IntelligenceSource) {
  if (source.status !== "ok" || !source.players.length) return false;
  if (!source.updatedAt) return true;
  const age = Date.now() - new Date(source.updatedAt).getTime();
  return Number.isFinite(age) && age <= MAX_SOURCE_AGE_MS;
}

function createAuctionCurve(players: IntelligencePlayer[], context: AuctionContext) {
  const rosterable = Math.max(1, Math.min(players.length, context.size * context.rosterSize));
  const totalDollars = Math.max(context.size * context.rosterSize, context.size * context.auctionBudget);
  const reserveDollars = context.size * context.rosterSize;
  const discretionaryDollars = Math.max(0, totalDollars - reserveDollars);
  const rankDenominator = Array.from({ length: rosterable }, (_, index) => ((rosterable - index) / rosterable) ** 3)
    .reduce((sum, value) => sum + value, 0) || 1;
  const nativeRows = [...players]
    .filter((player) => Number(player.auction) > 0 && Number(player.rank || player.adp || 999) <= rosterable)
    .sort((a, b) => Number(a.rank || a.adp || 999) - Number(b.rank || b.adp || 999))
    .slice(0, rosterable);
  const nativeExtras = nativeRows.reduce((sum, player) => sum + Math.max(0, Number(player.auction || 0) - 1), 0);
  const nativeScale = nativeExtras > 0 ? discretionaryDollars / nativeExtras : 0;

  return (player: IntelligencePlayer) => {
    const rank = Math.max(1, Number(player.rank || player.adp || rosterable));
    const rankScore = rank <= rosterable ? ((rosterable - rank + 1) / rosterable) ** 3 : 0;
    const rankValue = 1 + discretionaryDollars * rankScore / rankDenominator;
    if (!(Number(player.auction) > 0) || !nativeScale) return Math.max(1, rankValue);
    const nativeValue = 1 + Math.max(0, Number(player.auction) - 1) * nativeScale;
    // ESPN and MFL publish dollar markets; blend those league-normalized
    // anchors with the same source's rank curve instead of double-counting.
    return Math.max(1, nativeValue * .65 + rankValue * .35);
  };
}

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

export function mergeConsensus(espnPlayers: DraftPlayer[], sources: IntelligenceSource[], league?: AuctionContext): ConsensusPlayer[] {
  const context = league || { size: 12, rosterSize: 16, auctionBudget: 200 };
  const healthySources = sources.filter(isIntelligenceSourceFresh);
  const espnCurve = createAuctionCurve(espnPlayers, context);
  const sourceCurves = new Map(healthySources.map((source) => [source.id, createAuctionCurve(source.players, context)]));
  const enriched = espnPlayers.map((player) => {
    const sourceRanks: Record<string, number> = { espn: Number(player.rank || player.adp || 999) };
    const sourceAuctions: Record<string, number> = { espn: espnCurve(player) };
    const adps = [{ value: player.adp, weight: SOURCE_WEIGHTS.espn }];
    const auctions = [{ value: sourceAuctions.espn, weight: SOURCE_WEIGHTS.espn }];
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
      const sourceAuction = sourceCurves.get(source.id)?.(signal);
      if (sourceAuction && sourceAuction > 0) {
        sourceAuctions[source.id] = sourceAuction;
        auctions.push({ value: sourceAuction, weight: source.weight });
      }
    }

    const ranks = Object.values(sourceRanks);
    const rankSpread = standardDeviation(ranks);
    const consensusScore = totalWeight ? weightedPercentile / totalWeight * 100 : 0;
    const sourceCount = ranks.length;
    const coverage = sourceCount / 5;
    const consensusConfidence = Math.round(Math.max(35, Math.min(98, 52 + coverage * 38 - Math.min(20, rankSpread * .65))));
    const weightedAdp = adps.reduce((sum, item) => sum + item.value * item.weight, 0) / adps.reduce((sum, item) => sum + item.weight, 0);
    const weightedAuction = auctions.reduce((sum, item) => sum + item.value * item.weight, 0) / auctions.reduce((sum, item) => sum + item.weight, 0);
    return { ...player, adp: weightedAdp, auction: weightedAuction, consensusRank: 999, consensusScore, consensusConfidence, rankSpread, sourceCount, sourceRanks, sourceAuctions };
  });

  const order = [...enriched].sort((a, b) => b.consensusScore - a.consensusScore);
  const ranks = new Map(order.map((player, index) => [player.id, index + 1]));
  return enriched.map((player) => ({ ...player, consensusRank: ranks.get(player.id) || 999 }));
}
