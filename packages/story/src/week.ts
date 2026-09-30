import type { SleeperMatchup } from "@cutman/sleeper";

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

/** A week has real scores when every roster has finite points and the slate is not all zeros. */
export function isPlayedWeek(matchups: SleeperMatchup[]): boolean {
  if (matchups.length === 0) return false;
  let sawPositivePlayerPoints = false;
  for (const matchup of matchups) {
    if (!hasFinitePoints(matchup.points)) return false;
    const table = matchup.players_points;
    if (!table) continue;
    for (const value of Object.values(table)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        sawPositivePlayerPoints = true;
      }
    }
  }
  const everyPointsZero = matchups.every((matchup) => matchup.points === 0);
  if (everyPointsZero && !sawPositivePlayerPoints) return false;
  return true;
}

/**
 * Recap the NFL week when it has been played. Otherwise recap the previous week.
 * Week 1 with no scores yet has nothing to recap.
 */
export function selectRecapWeek(input: { nflWeek: number; currentWeekPlayed: boolean }): number | null {
  if (input.currentWeekPlayed) return input.nflWeek;
  if (input.nflWeek > 1) return input.nflWeek - 1;
  return null;
}
