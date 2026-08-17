export type EspnRosterEntry = { playerId?: number | null; name?: string | null; amount?: number };
export type EspnAuctionSale = { playerId?: number | null; playerName?: string | null; teamName?: string | null; amount?: number; sequence?: number };
export type EspnAuctionBudget = { teamName: string; remaining: number; maxOffer: number };
export type EspnSnakePick = { playerName: string; teamName: string; round: number; roundPick: number };

export type EspnContext = {
  onClock?: boolean;
  inDraftRoom?: boolean;
  auctionActive?: boolean;
  leagueId?: string;
  tabId?: number;
  teamId?: number;
  nominatedPlayer?: string;
  nominatedPlayerId?: number | null;
  currentBid?: number;
  maxLegalBid?: number;
  leadingBid?: boolean;
  currentPick?: number | null;
  remainingSeconds?: number | null;
  availablePlayerIds?: number[];
  availablePlayerNames?: string[];
  ownRoster?: EspnRosterEntry[];
  soundMuted?: boolean;
  autopickActive?: boolean;
  actionSurfaceReady?: boolean;
  snakeClockSource?: "ACTIVE_OWN_PICK" | "TEAM_LABEL" | null;
  snakeClockOwnMarker?: boolean;
  snakeClockTeam?: string | null;
  ownDraftTeam?: string | null;
  snakePicks?: EspnSnakePick[];
  auctionBudgets?: EspnAuctionBudget[];
  auctionSales?: EspnAuctionSale[];
};

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
