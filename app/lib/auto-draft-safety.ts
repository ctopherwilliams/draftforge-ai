import { contextMatchesActiveDraftTab } from "./espn-context.ts";
import type { EspnContext } from "./espn-context-state.ts";

type AutoDraftArmState = {
  checklistReady: boolean;
  extensionConnected: boolean;
  context: EspnContext | undefined;
  leagueId: string;
  teamId: number | null;
  tabId: number | null;
};

export function canArmAutoDraft({
  checklistReady,
  extensionConnected,
  context,
  leagueId,
  teamId,
  tabId,
}: AutoDraftArmState) {
  return checklistReady
    && extensionConnected
    && Number.isInteger(teamId)
    && Number(teamId) > 0
    && context?.inDraftRoom === true
    && Number(context.teamId) === Number(teamId)
    && contextMatchesActiveDraftTab(context, leagueId, tabId);
}
