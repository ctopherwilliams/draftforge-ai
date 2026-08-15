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
  retrievedAt?: string | null;
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
  marketScore: number;
  modelScore: number;
  modelMarketEdge: number;
  marketSourceCount: number;
  modelSourceCount: number;
  modelSpread: number;
};

const SOURCE_WEIGHTS: Record<string, number> = { espn: .30, gng: .20, tradyr: .20, ffc: .15, mfl: .15 };
const MAX_SOURCE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const REQUIRED_INTELLIGENCE_SOURCE_IDS: IntelligenceSource["id"][] = ["ffc", "mfl", "tradyr", "gng"];

type AuctionContext = Pick<LeagueSettings, "size" | "rosterSize" | "auctionBudget">;

export function isIntelligenceSourceFresh(source: IntelligenceSource, evaluatedAt: string | number | Date = Date.now()) {
  if (source.status !== "ok" || !source.players.length) return false;
  const timestamp = source.updatedAt || source.retrievedAt;
  if (!timestamp) return true;
  const age = new Date(evaluatedAt).getTime() - new Date(timestamp).getTime();
  return Number.isFinite(age) && age <= MAX_SOURCE_AGE_MS;
}

export function isCompleteFreshIntelligenceSnapshot(
  sources: IntelligenceSource[],
  evaluatedAt: string | number | Date = Date.now(),
) {
  if (sources.length !== REQUIRED_INTELLIGENCE_SOURCE_IDS.length) return false;
  const indexed = new Map(sources.map((source) => [source.id, source]));
  return indexed.size === REQUIRED_INTELLIGENCE_SOURCE_IDS.length
    && REQUIRED_INTELLIGENCE_SOURCE_IDS.every((id) => {
      const source = indexed.get(id);
      return Boolean(source && isIntelligenceSourceFresh(source, evaluatedAt));
    });
}

export function preserveCompleteFreshIntelligenceSnapshot(
  current: IntelligenceSource[],
  incoming: IntelligenceSource[],
  evaluatedAt: string | number | Date = Date.now(),
) {
  return isCompleteFreshIntelligenceSnapshot(incoming, evaluatedAt) ? incoming : current;
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

type IndexedSourcePlayer = {
  player: IntelligencePlayer;
  key: string;
};

type SourcePlayerIndex = {
  exact: Map<string, IntelligencePlayer>;
  candidates: IndexedSourcePlayer[];
};

const MATCHABLE_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];

function sourceSignalKey(position: string, name: string) {
  return `${position}:${name}`;
}

function buildSourcePlayerIndex(source: IntelligenceSource): SourcePlayerIndex {
  const exact = new Map<string, IntelligencePlayer>();
  const candidates = source.players.map((player) => ({ player, key: normalizePlayerName(player.name) }));
  for (const candidate of candidates) {
    const positions = !candidate.player.pos || candidate.player.pos === "FLEX"
      ? MATCHABLE_POSITIONS
      : [candidate.player.pos];
    for (const position of positions) {
      const key = sourceSignalKey(position, candidate.key);
      if (!exact.has(key)) exact.set(key, candidate.player);
    }
  }
  return { exact, candidates };
}

function findSignal(player: DraftPlayer, index: SourcePlayerIndex) {
  const key = normalizePlayerName(player.name);
  const exact = index.exact.get(sourceSignalKey(player.pos, key));
  if (exact) return exact;
  return index.candidates.find(({ player: candidate, key: candidateKey }) => {
    const positionMatches = !candidate.pos || candidate.pos === player.pos || candidate.pos === "FLEX";
    if (!positionMatches) return false;
    const teamMatches = !candidate.team || !player.team || candidate.team === player.team;
    return teamMatches && editDistance(candidateKey, key) <= 1;
  })?.player;
}

export function mergeConsensus(
  espnPlayers: DraftPlayer[],
  sources: IntelligenceSource[],
  league?: AuctionContext,
  options: { evaluatedAt?: string | number | Date } = {},
): ConsensusPlayer[] {
  const context = league || { size: 12, rosterSize: 16, auctionBudget: 200 };
  const evaluatedAt = options.evaluatedAt ?? Date.now();
  const healthySources = sources.filter((source) => isIntelligenceSourceFresh(source, evaluatedAt));
  const espnCurve = createAuctionCurve(espnPlayers, context);
  const sourceCurves = new Map(healthySources.map((source) => [source.id, createAuctionCurve(source.players, context)]));
  const sourceIndexes = new Map(healthySources.map((source) => [source.id, buildSourcePlayerIndex(source)]));
  const enriched = espnPlayers.map((player) => {
    const sourceRanks: Record<string, number> = { espn: Number(player.rank || player.adp || 999) };
    const sourceAuctions: Record<string, number> = { espn: espnCurve(player) };
    const adps = [{ value: player.adp, weight: SOURCE_WEIGHTS.espn }];
    const auctions = [{ value: sourceAuctions.espn, weight: SOURCE_WEIGHTS.espn }];
    const espnPercentile = Math.max(0, 1 - (sourceRanks.espn - 1) / Math.max(espnPlayers.length - 1, 1));
    let weightedPercentile = SOURCE_WEIGHTS.espn * espnPercentile;
    let totalWeight = SOURCE_WEIGHTS.espn;
    let marketPercentile = SOURCE_WEIGHTS.espn * espnPercentile;
    let marketWeight = SOURCE_WEIGHTS.espn;
    let marketSourceCount = 1;
    let modelPercentile = 0;
    let modelWeight = 0;
    const modelPercentiles: number[] = [];

    for (const source of healthySources) {
      const signal = findSignal(player, sourceIndexes.get(source.id)!);
      if (!signal) continue;
      const rank = Number(signal.rank || signal.adp || 999);
      if (rank < 999) {
        sourceRanks[source.id] = rank;
        const maxRank = Math.max(source.players.length, 2);
        const rankPercentile = Math.max(0, 1 - (rank - 1) / (maxRank - 1));
        weightedPercentile += source.weight * rankPercentile;
        totalWeight += source.weight;
        if (source.id === "ffc" || source.id === "mfl") {
          marketPercentile += source.weight * rankPercentile;
          marketWeight += source.weight;
          marketSourceCount += 1;
        } else {
          modelPercentile += source.weight * rankPercentile;
          modelWeight += source.weight;
          modelPercentiles.push(rankPercentile * 100);
        }
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
    const marketScore = marketWeight ? marketPercentile / marketWeight * 100 : 0;
    const modelScore = modelWeight ? modelPercentile / modelWeight * 100 : 0;
    const modelMarketEdge = modelWeight ? modelScore - marketScore : 0;
    const modelSourceCount = modelPercentiles.length;
    const modelSpread = standardDeviation(modelPercentiles);
    const weightedAdp = adps.reduce((sum, item) => sum + item.value * item.weight, 0) / adps.reduce((sum, item) => sum + item.weight, 0);
    const weightedAuction = auctions.reduce((sum, item) => sum + item.value * item.weight, 0) / auctions.reduce((sum, item) => sum + item.weight, 0);
    return {
      ...player,
      adp: weightedAdp,
      auction: weightedAuction,
      consensusRank: 999,
      consensusScore,
      consensusConfidence,
      rankSpread,
      sourceCount,
      sourceRanks,
      sourceAuctions,
      marketScore,
      modelScore,
      modelMarketEdge,
      marketSourceCount,
      modelSourceCount,
      modelSpread,
    };
  });

  const order = [...enriched].sort((a, b) => b.consensusScore - a.consensusScore);
  const ranks = new Map(order.map((player, index) => [player.id, index + 1]));
  return enriched.map((player) => ({ ...player, consensusRank: ranks.get(player.id) || 999 }));
}
