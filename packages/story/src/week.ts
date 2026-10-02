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

/** Fantasy seasons end by NFL week 18. Later weeks never hold league matchups. */
export const LAST_FANTASY_WEEK = 18;

/**
 * Highest week whose fantasy scores are settled, or 0 when none are. Earlier weeks are always
 * over. The current week counts only when it has been played and Monday night is done.
 */
export function lastSettledWeek(input: {
  seasonType: string;
  nflWeek: number;
  currentWeekPlayed: boolean;
  canSettleCurrent: boolean;
}): number {
  if (input.seasonType === "post") return LAST_FANTASY_WEEK;
  if (input.seasonType !== "regular") return 0;
  const week = input.canSettleCurrent && input.currentWeekPlayed ? input.nflWeek : input.nflWeek - 1;
  return Math.max(0, Math.min(week, LAST_FANTASY_WEEK));
}
