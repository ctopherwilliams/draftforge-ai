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

export const MAX_PERSISTED_DRAFT_PROFILES = 4;

type DraftProfileStorage = {
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

function savedAt(profile: DraftProfile) {
  const value = Date.parse(profile.savedAt);
  return Number.isFinite(value) ? value : 0;
}

function isPracticeDraft(profile: DraftProfile) {
  return /^practice draft for\b/i.test(String(profile.league.name || "").trim());
}

export function compactDraftProfiles(
  profiles: DraftProfiles,
  pinnedLeagueId?: string | number | null,
  maxProfiles = MAX_PERSISTED_DRAFT_PROFILES,
): DraftProfiles {
  const ordered = Object.values(profiles).sort((left, right) => savedAt(right) - savedAt(left));
  const pinned = pinnedLeagueId === null || pinnedLeagueId === undefined
    ? undefined
    : profiles[String(pinnedLeagueId)];
  const preferred = [
    pinned,
    ordered[0],
    ...ordered.filter((profile) => !isPracticeDraft(profile)),
    ...ordered.filter(isPracticeDraft),
  ].filter((profile): profile is DraftProfile => Boolean(profile));
  const compacted: DraftProfiles = {};
  for (const profile of preferred) {
    const key = String(profile.league.id);
    if (compacted[key]) continue;
    compacted[key] = profile;
    if (Object.keys(compacted).length >= Math.max(1, maxProfiles)) break;
  }
  return compacted;
}

export function persistDraftProfiles(
  storage: DraftProfileStorage,
  key: string,
  profiles: DraftProfiles,
) {
  const compacted = compactDraftProfiles(profiles);
  try {
    storage.setItem(key, JSON.stringify(compacted));
  } catch {
    // A prior unbounded cache or unrelated origin data can already consume the
    // quota. Replace only DraftForge's own cache with the newest profile and
    // never let a best-effort local snapshot crash the live draft cockpit.
    const newestOnly = compactDraftProfiles(compacted, undefined, 1);
    try {
      storage.removeItem(key);
      storage.setItem(key, JSON.stringify(newestOnly));
    } catch {
      // Exact ESPN re-import remains authoritative if persistence is unavailable.
    }
  }
  return compacted;
}

export function upsertDraftProfile(profiles: DraftProfiles, profile: DraftProfile): DraftProfiles {
  return compactDraftProfiles({ ...profiles, [String(profile.league.id)]: profile }, profile.league.id);
}

export function profileForEspnRoom(profiles: DraftProfiles, leagueId: string | number | null | undefined) {
  if (leagueId === null || leagueId === undefined) return undefined;
  return profiles[String(leagueId)];
}
