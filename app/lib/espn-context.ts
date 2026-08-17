export type EspnRoomContext = {
  leagueId?: string | null;
  tabId?: number | null;
  teamId?: number | null;
  inDraftRoom?: boolean;
};

/**
 * ESPN tabs report independently. A context from a different tab must never
 * make the currently selected league look actionable.
 */
export function contextMatchesActiveLeague(context: EspnRoomContext | undefined, activeLeagueId: string) {
  if (!context?.leagueId) return false;
  return String(context.leagueId) === String(activeLeagueId);
}

/**
 * A league can be open in more than one ESPN tab (especially while testing
 * mocks). Draft state is actionable only when it originated from the exact
 * tab that supplied the imported league settings.
 */
export function contextMatchesActiveDraftTab(
  context: EspnRoomContext | undefined,
  activeLeagueId: string,
  activeTabId: number | null,
) {
  return contextMatchesActiveLeague(context, activeLeagueId)
    && Number.isInteger(activeTabId)
    && Number(context?.tabId) === activeTabId;
}

/**
 * The ESPN waiting-room link can open the live room in a new browser tab.
 * Background routing proves uniqueness; the app independently rechecks the
 * imported league, team, live-room state, and replacement tab identity.
 */
export function contextCanRebindDraftTab(
  context: EspnRoomContext | undefined,
  activeLeagueId: string,
  activeTeamId: number | null,
) {
  return contextMatchesActiveLeague(context, activeLeagueId)
    && Number.isInteger(activeTeamId)
    && Number(context?.teamId) === activeTeamId
    && context?.inDraftRoom === true
    && Number.isInteger(context?.tabId);
}
