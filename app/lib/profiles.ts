import type { DraftPick, DraftPlayer, LeagueSettings, StrategyId } from "./draft-engine";

export type DraftProfile = {
  league: LeagueSettings;
  espnPlayers: DraftPlayer[];
  picks: DraftPick[];
  settingsConfirmed: boolean;
  strategy: StrategyId;
  savedAt: string;
};

export type DraftProfiles = Record<string, DraftProfile>;

export function upsertDraftProfile(profiles: DraftProfiles, profile: DraftProfile): DraftProfiles {
  return { ...profiles, [String(profile.league.id)]: profile };
}

export function profileForEspnRoom(profiles: DraftProfiles, leagueId: string | number | null | undefined) {
  if (leagueId === null || leagueId === undefined) return undefined;
  return profiles[String(leagueId)];
}
