import type { DraftAuditSnapshot } from "./draft-audit.ts";

export const MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS = 3;

export function canRetryPracticeRoomCleanup(attempts: number) {
  return Number.isInteger(attempts)
    && attempts >= 0
    && attempts < MAX_AUTOMATIC_PRACTICE_CLEANUP_ATTEMPTS;
}

export type PracticeRoomCleanupRequest = {
  key: string;
  payload: {
    draftLeagueId: string;
    sourceLeagueId: string;
    teamId: number;
    season: number;
    completedAuditProof: {
      leagueId: string;
      teamId: number;
      tabId: number;
      finalReady: true;
      parity: true;
      autoDraftOff: true;
    };
  };
};

export function resolvePracticeRoomCleanupRequest(input: {
  sourceLeagueId: string;
  snapshot: DraftAuditSnapshot;
  evaluation?: { finalReady?: boolean; parity?: boolean };
  finalizedKey: string;
}): PracticeRoomCleanupRequest | null {
  const sourceLeagueId = String(input.sourceLeagueId || "");
  const draftLeagueId = String(input.snapshot.league.id || "");
  const key = `${sourceLeagueId}:${draftLeagueId}:${input.snapshot.league.teamId}:${input.snapshot.binding.tabId}`;
  if (!/^\d+$/.test(sourceLeagueId)
    || !/^\d+$/.test(draftLeagueId)
    || sourceLeagueId === draftLeagueId
    || input.evaluation?.finalReady !== true
    || input.evaluation?.parity !== true
    || input.snapshot.safety.autoDraft !== false
    || input.finalizedKey === key) return null;

  return {
    key,
    payload: {
      draftLeagueId,
      sourceLeagueId,
      teamId: input.snapshot.league.teamId,
      season: input.snapshot.league.season,
      completedAuditProof: {
        leagueId: draftLeagueId,
        teamId: input.snapshot.league.teamId,
        tabId: input.snapshot.binding.tabId,
        finalReady: true,
        parity: true,
        autoDraftOff: true,
      },
    },
  };
}
