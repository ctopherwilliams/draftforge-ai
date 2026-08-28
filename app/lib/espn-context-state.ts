export type EspnRosterEntry = { playerId?: number | null; name?: string | null; amount?: number };
export type EspnAuctionSale = { playerId?: number | null; playerName?: string | null; teamName?: string | null; amount?: number; sequence?: number };
export type EspnAuctionBudget = { teamName: string; remaining: number; maxOffer: number };
export type EspnSnakePick = { playerName: string; teamName: string; round: number; roundPick: number };
export type EspnNominationIdentity = { playerId: number; playerName: string; intent: "TARGET" | "DRAIN" };

export type EspnContext = {
  producerSessionId?: string;
  producerRevision?: number;
  contextCapturedAt?: string;
  onClock?: boolean;
  inDraftRoom?: boolean;
  auctionActive?: boolean;
  auctionTransactionMode?: "OFFER" | "NOMINATION" | null;
  auctionTransactionReady?: boolean;
  leagueId?: string;
  season?: number;
  tabId?: number;
  teamId?: number;
  nominatedPlayer?: string;
  nominatedPlayerId?: number | null;
  currentBid?: number;
  maxLegalBid?: number;
  leadingBid?: boolean;
  ownNominationIntent?: "TARGET" | "DRAIN" | null;
  ownNominationPlayerId?: number | null;
  currentPick?: number | null;
  remainingSeconds?: number | null;
  availablePlayerIds?: number[];
  availablePlayerNames?: string[];
  ownRoster?: EspnRosterEntry[];
  soundMuted?: boolean;
  autopickActive?: boolean;
  playerPoolReady?: boolean;
  auctionOfferReady?: boolean;
  auctionNominationReady?: boolean;
  actionSurfaceReady?: boolean;
  snakeClockSource?: "ACTIVE_OWN_PICK" | "TEAM_LABEL" | null;
  snakeClockOwnMarker?: boolean;
  snakeClockTeam?: string | null;
  ownDraftTeam?: string | null;
  snakePicks?: EspnSnakePick[];
  auctionBudgets?: EspnAuctionBudget[];
  auctionSales?: EspnAuctionSale[];
  auctionSettlementPending?: boolean;
  auctionSettlementExpired?: boolean;
  auctionSettlementCode?: "AUCTION_SETTLEMENT_CURRENT" | "AUCTION_SETTLEMENT_PENDING" | "AUCTION_SETTLEMENT_EXPIRED" | "AUCTION_SETTLEMENT_AMBIGUOUS";
};

function normalizedPlayerName(value: string | null | undefined) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveEspnNominatedPlayer<T extends { id: number; name: string }>(
  players: T[],
  context: Pick<EspnContext, "nominatedPlayer" | "nominatedPlayerId">,
) {
  if (context.nominatedPlayerId !== null && context.nominatedPlayerId !== undefined) {
    const nominatedPlayerId = Number(context.nominatedPlayerId);
    if (!Number.isInteger(nominatedPlayerId) || nominatedPlayerId === 0 || nominatedPlayerId === -1) {
      return undefined;
    }
    return players.find((player) => player.id === nominatedPlayerId);
  }
  const nominatedPlayerName = normalizedPlayerName(context.nominatedPlayer);
  return nominatedPlayerName
    ? players.find((player) => normalizedPlayerName(player.name) === nominatedPlayerName)
    : undefined;
}

export function resolveOwnNominationIntent(
  context: Pick<EspnContext, "ownNominationIntent" | "ownNominationPlayerId">,
  nominated: { id: number; name: string } | undefined,
  pending: EspnNominationIdentity | null,
) {
  if (!nominated) return null;
  const contextIntent = ["TARGET", "DRAIN"].includes(String(context.ownNominationIntent || ""))
    ? context.ownNominationIntent as "TARGET" | "DRAIN"
    : null;
  if (contextIntent && Number(context.ownNominationPlayerId) === nominated.id) return contextIntent;
  if (pending
    && pending.playerId === nominated.id
    && normalizedPlayerName(pending.playerName) === normalizedPlayerName(nominated.name)) return pending.intent;
  return null;
}

export function resolveLiveBoardDisplayRank<
  T extends { name: string; pos?: string },
>(player: T | undefined, players: T[]) {
  if (!player) return undefined;
  const name = normalizedPlayerName(player.name);
  const position = String(player.pos || "").trim().toUpperCase();
  const index = players.findIndex((candidate) => (
    normalizedPlayerName(candidate.name) === name
    && String(candidate.pos || "").trim().toUpperCase() === position
  ));
  return index >= 0 ? index + 1 : undefined;
}

function reuseArray<T>(current: T[] | undefined, next: T[] | undefined, equal: (left: T, right: T) => boolean) {
  if (!current || !next || current.length !== next.length) return next;
  return current.every((item, index) => equal(item, next[index])) ? current : next;
}

function sameScalar(left: string | number, right: string | number) {
  return left === right;
}

export function stabilizeEspnContext(current: EspnContext, next: EspnContext): EspnContext {
  const stabilized: EspnContext = { ...next };
  if ("availablePlayerIds" in next) stabilized.availablePlayerIds = reuseArray(current.availablePlayerIds, next.availablePlayerIds, sameScalar);
  if ("availablePlayerNames" in next) stabilized.availablePlayerNames = reuseArray(current.availablePlayerNames, next.availablePlayerNames, sameScalar);
  if ("ownRoster" in next) stabilized.ownRoster = reuseArray(current.ownRoster, next.ownRoster, (left, right) => (
      Number(left.playerId || 0) === Number(right.playerId || 0)
      && String(left.name || "") === String(right.name || "")
      && Number(left.amount || 0) === Number(right.amount || 0)
    ));
  if ("snakePicks" in next) stabilized.snakePicks = reuseArray(current.snakePicks, next.snakePicks, (left, right) => (
      left.playerName === right.playerName
      && left.teamName === right.teamName
      && left.round === right.round
      && left.roundPick === right.roundPick
    ));
  if ("auctionBudgets" in next) stabilized.auctionBudgets = reuseArray(current.auctionBudgets, next.auctionBudgets, (left, right) => (
      left.teamName === right.teamName
      && left.remaining === right.remaining
      && left.maxOffer === right.maxOffer
    ));
  if ("auctionSales" in next) stabilized.auctionSales = reuseArray(current.auctionSales, next.auctionSales, (left, right) => (
      Number(left.playerId || 0) === Number(right.playerId || 0)
      && String(left.playerName || "") === String(right.playerName || "")
      && String(left.teamName || "") === String(right.teamName || "")
      && Number(left.amount || 0) === Number(right.amount || 0)
      && Number(left.sequence || 0) === Number(right.sequence || 0)
    ));
  const currentKeys = Object.keys(current) as (keyof EspnContext)[];
  const nextKeys = Object.keys(stabilized) as (keyof EspnContext)[];
  return currentKeys.length === nextKeys.length
    && nextKeys.every((key) => current[key] === stabilized[key])
      ? current
      : stabilized;
}
