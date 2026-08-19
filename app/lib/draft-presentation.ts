export type DraftPresentationInput = {
  draftType: "SNAKE" | "AUCTION";
  focusPlayer?: { name: string; maxBid: number };
  auctionNominationPlayerName?: string;
  ownNominationIntent?: "TARGET" | "DRAIN" | null;
  nominated: boolean;
  leadingBid: boolean;
  nextBid: number;
  auctionCanBid: boolean;
  actionWindowOpen: boolean;
  bidWindowOpen: boolean;
  sourceCoverageReady: boolean;
  settingsConfirmed: boolean;
  extensionConnected: boolean;
  autopickActive: boolean;
  inDraftRoom: boolean;
};

export type DraftPresentation = {
  commandLabel: string;
  safetyLabel: string;
  stateLabel: "ACTION READY" | "LOCKED" | "PREPARED";
  stateTone: "ready" | "blocked" | "waiting";
};

export type LiveOperatorStatusInput = {
  actionState: string;
  draftType: "SNAKE" | "AUCTION";
  commandLabel: string;
  nominatedPlayerName?: string;
  currentBid?: number;
};

export type ActionSurfaceStatusInput = {
  actionWindowOpen: boolean;
  onClock: boolean;
  inDraftRoom: boolean;
  remainingSeconds?: number;
  minimumActionWindow: number;
};

export function resolveActionSurfaceStatus(input: ActionSurfaceStatusInput) {
  if (input.actionWindowOpen) {
    return {
      header: "YOU'RE ON THE CLOCK",
      detail: `Verified ESPN action window · ${input.remainingSeconds}s`,
    };
  }
  if (input.onClock) {
    if (Number.isFinite(input.remainingSeconds) && Number(input.remainingSeconds) < input.minimumActionWindow) {
      return {
        header: "CLOCK TOO SHORT",
        detail: "ESPN clock below the safe action threshold — nothing will be sent",
      };
    }
    return {
      header: "REVALIDATING CLOCK",
      detail: "Revalidating ESPN action surface — nothing sent yet",
    };
  }
  return input.inDraftRoom
    ? { header: "ESPN LIVE", detail: "Exact ESPN draft room connected" }
    : { header: "DRAFT CONTROL ROOM", detail: "Open the exact ESPN draft room" };
}

export function resolveLiveOperatorStatus(input: LiveOperatorStatusInput) {
  if (input.draftType !== "AUCTION" || !input.nominatedPlayerName) return input.actionState;
  const offer = Number(input.currentBid);
  return `${input.commandLabel} · ${input.nominatedPlayerName}${offer > 0 ? ` at $${offer}` : ""}`;
}

export function buildDraftPresentation(input: DraftPresentationInput): DraftPresentation {
  const recommendationLocked = !input.settingsConfirmed || !input.extensionConnected;
  const commandLabel = input.autopickActive
    ? "STOPPED — ESPN AUTOPICK ACTIVE"
    : !input.sourceCoverageReady
      ? "LOCKED — REFRESH FIVE SOURCES"
      : recommendationLocked
        ? "LOCKED — COMPLETE CHECKLIST"
        : input.draftType === "SNAKE"
          ? input.actionWindowOpen && input.focusPlayer
            ? `DRAFT ${input.focusPlayer.name}`
            : input.focusPlayer
              ? `QUEUE ${input.focusPlayer.name}`
              : "WAIT FOR PLAYER POOL"
          : input.ownNominationIntent === "DRAIN"
            ? "PASS — DO NOT PRICE ENFORCE"
            : input.leadingBid
              ? "HOLD — YOU ARE LEADING"
              : input.nominated && input.focusPlayer && input.nextBid > input.focusPlayer.maxBid
                ? `PASS — CEILING $${input.focusPlayer.maxBid}`
                : input.auctionCanBid
                  ? `BID $${input.nextBid}`
                  : input.nominated
                    ? "WAIT — VERIFY NEXT BID WINDOW"
                    : input.auctionNominationPlayerName
                      ? `NOMINATE ${input.auctionNominationPlayerName}`
                      : input.focusPlayer
                        ? `TRACK ${input.focusPlayer.name}`
                        : "WAIT FOR NOMINATION";

  const safetyLabel = input.autopickActive
    ? "ESPN Autopick detected — actions stopped"
    : !input.sourceCoverageReady
      ? "Five-source coverage incomplete — actions locked"
      : input.actionWindowOpen || input.bidWindowOpen
        ? "Safe action window verified"
        : input.inDraftRoom
          ? "Connected — waiting for a safe action window"
          : "Open the exact ESPN draft room";

  const blocked = input.autopickActive || !input.sourceCoverageReady || recommendationLocked;
  const actionReady = !blocked && (input.actionWindowOpen || input.auctionCanBid);
  return {
    commandLabel,
    safetyLabel,
    stateLabel: actionReady ? "ACTION READY" : blocked ? "LOCKED" : "PREPARED",
    stateTone: actionReady ? "ready" : blocked ? "blocked" : "waiting",
  };
}
