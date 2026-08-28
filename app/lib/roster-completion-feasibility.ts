import {
  openStarterSlots,
  positionLimitFor,
  type DraftPlayer,
  type LeagueSettings,
  type Position,
} from "./draft-engine.ts";
import type { AvailabilityGateEvaluation } from "./availability-veto.ts";

const DRAFTABLE_POSITIONS = ["K", "DST", "QB", "TE", "RB", "WR"] as const satisfies readonly Position[];

export type RosterCompletionFeasibility = Readonly<{
  feasible: boolean;
  code:
    | "ROSTER_COMPLETION_FEASIBLE"
    | "ROSTER_IDENTITY_INCOMPLETE"
    | "ROSTER_OVERFULL"
    | "POSITION_CAP_EXCEEDED"
    | "MANDATORY_SLOTS_EXCEED_ROSTER"
    | "PLAYER_POOL_DEPLETED"
    | "MANDATORY_STARTERS_UNFILLABLE";
  remainingRosterSlots: number;
  openStarterSlots: number;
}>;

function specialistBoundedLimit(league: LeagueSettings, position: Position) {
  const configured = positionLimitFor(league, position);
  return ["K", "DST"].includes(position) ? Math.min(1, configured) : configured;
}

export function evaluateRosterCompletionFeasibility(input: {
  league: LeagueSettings;
  currentRosterCount: number;
  rosterPositions: readonly Position[];
  availablePlayers: readonly DraftPlayer[];
  vetoedPlayerIds: readonly number[];
}): RosterCompletionFeasibility {
  const currentRosterCount = Number(input.currentRosterCount);
  const remainingRosterSlots = Math.max(0, Number(input.league.rosterSize) - currentRosterCount);
  const currentPositions = [...input.rosterPositions];
  const currentOpenStarters = openStarterSlots(input.league, currentPositions);
  const result = (feasible: boolean, code: RosterCompletionFeasibility["code"]): RosterCompletionFeasibility => Object.freeze({
    feasible,
    code,
    remainingRosterSlots,
    openStarterSlots: currentOpenStarters,
  });

  if (!Number.isInteger(currentRosterCount)
    || currentRosterCount < 0
    || currentPositions.length !== currentRosterCount) {
    return result(false, "ROSTER_IDENTITY_INCOMPLETE");
  }
  if (currentRosterCount > input.league.rosterSize) return result(false, "ROSTER_OVERFULL");
  if (currentOpenStarters > remainingRosterSlots) return result(false, "MANDATORY_SLOTS_EXCEED_ROSTER");

  const rosterCounts = new Map<Position, number>();
  for (const position of currentPositions) {
    rosterCounts.set(position, Number(rosterCounts.get(position) || 0) + 1);
  }
  if (DRAFTABLE_POSITIONS.some((position) => (
    Number(rosterCounts.get(position) || 0) > specialistBoundedLimit(input.league, position)
  ))) return result(false, "POSITION_CAP_EXCEEDED");

  if (remainingRosterSlots === 0) {
    return result(currentOpenStarters === 0, currentOpenStarters === 0
      ? "ROSTER_COMPLETION_FEASIBLE"
      : "MANDATORY_STARTERS_UNFILLABLE");
  }

  const vetoed = new Set(input.vetoedPlayerIds.map(Number));
  const uniquePlayerIds = new Set<number>();
  const availableCounts = new Map<Position, number>();
  for (const player of input.availablePlayers) {
    if (!Number.isSafeInteger(player.id)
      || uniquePlayerIds.has(player.id)
      || vetoed.has(player.id)
      || player.unavailable === true
      || !DRAFTABLE_POSITIONS.includes(player.pos as typeof DRAFTABLE_POSITIONS[number])) continue;
    uniquePlayerIds.add(player.id);
    availableCounts.set(player.pos, Number(availableCounts.get(player.pos) || 0) + 1);
  }

  const maximumAdditions = DRAFTABLE_POSITIONS.map((position) => {
    const capRoom = specialistBoundedLimit(input.league, position) - Number(rosterCounts.get(position) || 0);
    return Math.max(0, Math.min(Number(availableCounts.get(position) || 0), capRoom));
  });
  if (maximumAdditions.reduce((sum, count) => sum + count, 0) < remainingRosterSlots) {
    return result(false, "PLAYER_POOL_DEPLETED");
  }

  const additions = Array.from({ length: DRAFTABLE_POSITIONS.length }, () => 0);
  const remainingCapacity = maximumAdditions.map((_, index) => (
    maximumAdditions.slice(index).reduce((sum, count) => sum + count, 0)
  ));
  function search(positionIndex: number, slotsLeft: number): boolean {
    if (slotsLeft === 0) {
      const completedPositions = [...currentPositions];
      for (let index = 0; index < DRAFTABLE_POSITIONS.length; index += 1) {
        completedPositions.push(...Array.from({ length: additions[index] }, () => DRAFTABLE_POSITIONS[index]));
      }
      return openStarterSlots(input.league, completedPositions) === 0;
    }
    if (positionIndex >= DRAFTABLE_POSITIONS.length
      || remainingCapacity[positionIndex] < slotsLeft) return false;
    const maximum = Math.min(maximumAdditions[positionIndex], slotsLeft);
    for (let count = maximum; count >= 0; count -= 1) {
      additions[positionIndex] = count;
      if (search(positionIndex + 1, slotsLeft - count)) return true;
    }
    additions[positionIndex] = 0;
    return false;
  }

  const feasible = search(0, remainingRosterSlots);
  return result(feasible, feasible ? "ROSTER_COMPLETION_FEASIBLE" : "MANDATORY_STARTERS_UNFILLABLE");
}

export function enforceAvailabilityRosterFeasibility(
  evaluation: AvailabilityGateEvaluation,
  feasibility: RosterCompletionFeasibility,
): AvailabilityGateEvaluation {
  if (!evaluation.armingAllowed || feasibility.feasible) return evaluation;
  return Object.freeze({
    ...evaluation,
    armingAllowed: false,
    status: "BLOCKED",
    blockingReasons: Object.freeze([
      ...new Set([...evaluation.blockingReasons, "AVAILABILITY_ROSTER_INFEASIBLE"]),
    ]),
  });
}
