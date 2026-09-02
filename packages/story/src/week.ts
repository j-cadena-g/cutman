import type { SleeperMatchup } from "@league-brain/sleeper";

export function hasFinitePoints(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isWeekFinal(matchups: SleeperMatchup[]): boolean {
  if (matchups.length === 0) return false;
  return matchups.every((matchup) => hasFinitePoints(matchup.points));
}

export function hasPlayerPoints(matchup: SleeperMatchup): boolean {
  return matchup.players_points != null && Object.keys(matchup.players_points).length > 0;
}
