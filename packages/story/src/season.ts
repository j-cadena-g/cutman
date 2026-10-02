import type { PlayerMap, SleeperLeagueUser, SleeperMatchup, SleeperRoster } from "@cutman/sleeper";
import { ONE_SCORE_MARGIN } from "./diff.ts";
import { playerLabel, teamLabel } from "./labels.ts";
import { hasFinitePoints } from "./week.ts";

/** A settled week's matchups as Sleeper reported them. */
export type FinalWeek = { week: number; matchups: SleeperMatchup[] };

export type SeasonRules = {
  /** First playoff week. It and later weeks stay out of the standings. */
  playoffWeekStart?: number | null;
  /** The league also scores every team against that week's median. */
  medianWins?: boolean;
};

export type SeasonLabels = {
  users: SleeperLeagueUser[];
  rosters: SleeperRoster[];
  players: PlayerMap;
};

type Result = "W" | "L" | "T";

export type Game = {
  week: number;
  rosterId: number;
  opponentId: number;
  points: number;
  opponentPoints: number;
  result: Result;
};

export type TeamRecord = {
  rosterId: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Head-to-head results in week order. Median results are not streaks. */
  results: Result[];
};

export type SeasonLedger = {
  rules: SeasonRules;
  /** Last regular-season week counted in the standings. */
  throughWeek: number | null;
  /** Standing order: win percentage, then points for. */
  standings: TeamRecord[];
  /** Every head-to-head game from both sides, playoffs included. */
  games: Game[];
  weeks: FinalWeek[];
};

type ScoredMatchup = SleeperMatchup & { points: number };

/** Head-to-head pairs: two rosters sharing a matchup_id. Byes and odd groups are skipped. */
export function matchupPairs(matchups: SleeperMatchup[]): Array<[SleeperMatchup, SleeperMatchup]> {
  const grouped = new Map<number, SleeperMatchup[]>();
  for (const matchup of matchups) {
    if (matchup.matchup_id == null) continue;
    const list = grouped.get(matchup.matchup_id) ?? [];
    list.push(matchup);
    grouped.set(matchup.matchup_id, list);
  }
  const pairs: Array<[SleeperMatchup, SleeperMatchup]> = [];
  for (const [, list] of [...grouped.entries()].sort((left, right) => left[0] - right[0])) {
    const [left, right] = list;
    if (list.length === 2 && left && right) pairs.push([left, right]);
  }
  return pairs;
}

function scoredPairs(matchups: SleeperMatchup[]): Array<[ScoredMatchup, ScoredMatchup]> {
  return matchupPairs(matchups).filter(
    (pair): pair is [ScoredMatchup, ScoredMatchup] => hasFinitePoints(pair[0].points) && hasFinitePoints(pair[1].points),
  );
}

function resultFor(points: number, opponentPoints: number): Result {
  if (points > opponentPoints) return "W";
  if (points < opponentPoints) return "L";
  return "T";
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function isRegularSeason(week: number, rules: SeasonRules): boolean {
  return rules.playoffWeekStart == null || week < rules.playoffWeekStart;
}

function winShare(record: TeamRecord): number {
  const played = record.wins + record.losses + record.ties;
  return played === 0 ? 0 : (record.wins + record.ties / 2) / played;
}

export function buildSeasonLedger(weeks: FinalWeek[], rules: SeasonRules = {}): SeasonLedger {
  const sorted = [...weeks].sort((left, right) => left.week - right.week);
  const records = new Map<number, TeamRecord>();
  const games: Game[] = [];
  let throughWeek: number | null = null;

  const recordFor = (rosterId: number): TeamRecord => {
    let record = records.get(rosterId);
    if (!record) {
      record = { rosterId, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, results: [] };
      records.set(rosterId, record);
    }
    return record;
  };
  const tally = (record: TeamRecord, result: Result) => {
    if (result === "W") record.wins += 1;
    else if (result === "L") record.losses += 1;
    else record.ties += 1;
  };

  for (const { week, matchups } of sorted) {
    const pairs = scoredPairs(matchups);
    const regular = isRegularSeason(week, rules);
    for (const [left, right] of pairs) {
      for (const [side, other] of [
        [left, right],
        [right, left],
      ] as const) {
        const result = resultFor(side.points, other.points);
        games.push({
          week,
          rosterId: side.roster_id,
          opponentId: other.roster_id,
          points: side.points,
          opponentPoints: other.points,
          result,
        });
        if (!regular) continue;
        const record = recordFor(side.roster_id);
        tally(record, result);
        record.results.push(result);
        record.pointsFor += side.points;
        record.pointsAgainst += other.points;
      }
    }
    if (!regular || pairs.length === 0) continue;
    throughWeek = week;
    if (rules.medianWins) {
      const scored = pairs.flat();
      const line = median(scored.map((matchup) => matchup.points));
      for (const matchup of scored) tally(recordFor(matchup.roster_id), resultFor(matchup.points, line));
    }
  }

  const standings = [...records.values()].sort(
    (left, right) =>
      winShare(right) - winShare(left) || right.pointsFor - left.pointsFor || left.rosterId - right.rosterId,
  );
  return { rules, throughWeek, standings, games, weeks: sorted };
}

function points(value: number): string {
  return String(Number(value.toFixed(2)));
}

function recordLabel(record: TeamRecord): string {
  return record.ties > 0
    ? `${record.wins}-${record.losses}-${record.ties}`
    : `${record.wins}-${record.losses}`;
}

export function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function currentStreak(results: Result[]): { result: Result; length: number } | null {
  const last = results[results.length - 1];
  if (!last || last === "T") return null;
  let length = 0;
  for (let index = results.length - 1; index >= 0 && results[index] === last; index -= 1) length += 1;
  return { result: last, length };
}

function standingsLines(ledger: SeasonLedger, team: (rosterId: number) => string): string[] {
  const { standings, throughWeek } = ledger;
  if (throughWeek == null || standings.length === 0) return [];
  const lines = [
    `Standings through week ${throughWeek}: ${standings
      .map((record, index) => `${index + 1}. ${team(record.rosterId)} ${recordLabel(record)} (${points(record.pointsFor)} PF)`)
      .join(", ")}.`,
  ];

  const gamesPlayed = Math.max(...standings.map((record) => record.results.length));
  const unbeaten = standings.filter((record) => record.losses === 0 && record.ties === 0 && record.wins > 0);
  const winless = standings.filter((record) => record.wins === 0 && record.ties === 0 && record.losses > 0);
  const called = new Set<number>();
  if (gamesPlayed >= 2 && unbeaten.length === 1 && unbeaten[0]) {
    lines.push(`${team(unbeaten[0].rosterId)} is the only unbeaten team (${recordLabel(unbeaten[0])}).`);
    called.add(unbeaten[0].rosterId);
  }
  if (gamesPlayed >= 2 && winless.length === 1 && winless[0]) {
    lines.push(`${team(winless[0].rosterId)} is the only winless team (${recordLabel(winless[0])}).`);
    called.add(winless[0].rosterId);
  }

  const streaks = standings
    .filter((record) => !called.has(record.rosterId))
    .map((record) => ({ record, streak: currentStreak(record.results) }))
    .filter((entry): entry is { record: TeamRecord; streak: { result: Result; length: number } } =>
      entry.streak != null && entry.streak.length >= 2,
    )
    .sort((left, right) => right.streak.length - left.streak.length || left.record.rosterId - right.record.rosterId)
    .slice(0, 4);
  for (const { record, streak } of streaks) {
    lines.push(`${team(record.rosterId)} has ${streak.result === "W" ? "won" : "lost"} ${streak.length} straight.`);
  }

  if (gamesPlayed >= 3) {
    const byPoints = [...standings].sort(
      (left, right) => right.pointsFor - left.pointsFor || left.rosterId - right.rosterId,
    );
    const pointsRank = new Map(byPoints.map((record, index) => [record.rosterId, index + 1]));
    const unlucky: string[] = [];
    const lucky: string[] = [];
    standings.forEach((record, index) => {
      const rank = pointsRank.get(record.rosterId) ?? index + 1;
      const label = `${team(record.rosterId)} is ${recordLabel(record)}`;
      if (rank <= index + 1 - 3) {
        unlucky.push(`${label} despite the ${ordinal(rank)}-most points (${points(record.pointsFor)} PF).`);
      } else if (rank >= index + 1 + 3) {
        lucky.push(`${label} with only the ${ordinal(rank)}-most points (${points(record.pointsFor)} PF).`);
      }
    });
    lines.push(...unlucky.slice(0, 2), ...lucky.slice(0, 2));
  }

  const regularGames = ledger.games.filter((game) => isRegularSeason(game.week, ledger.rules));
  if (gamesPlayed >= 2 && regularGames.length > 0) {
    const high = regularGames.reduce((best, game) => (game.points > best.points ? game : best));
    const low = regularGames.reduce((worst, game) => (game.points < worst.points ? game : worst));
    lines.push(`Season high score: ${team(high.rosterId)} ${points(high.points)} in week ${high.week}.`);
    lines.push(`Season low score: ${team(low.rosterId)} ${points(low.points)} in week ${low.week}.`);
  }
  return lines;
}

function meetingCopy(game: Game, team: (rosterId: number) => string): string {
  const winner = game.result === "L" ? game.opponentId : game.rosterId;
  const loser = winner === game.rosterId ? game.opponentId : game.rosterId;
  const high = Math.max(game.points, game.opponentPoints);
  const low = Math.min(game.points, game.opponentPoints);
  if (game.result === "T") {
    return `${team(game.rosterId)} and ${team(game.opponentId)} tied ${points(high)}-${points(low)} in week ${game.week}`;
  }
  return `${team(winner)} beat ${team(loser)} ${points(high)}-${points(low)} in week ${game.week}`;
}

function rematchLines(
  ledger: SeasonLedger,
  focus: SeasonFocus,
  team: (rosterId: number) => string,
): string[] {
  const lines: string[] = [];
  for (const [left, right] of matchupPairs(focus.matchups)) {
    const meetings = ledger.games.filter(
      (game) => game.week < focus.week && game.rosterId === left.roster_id && game.opponentId === right.roster_id,
    );
    if (meetings.length === 0) continue;
    lines.push(`Rematch: ${meetings.map((game) => meetingCopy(game, team)).join("; ")}.`);
  }
  return lines;
}

function liveMatchupLines(ledger: SeasonLedger, focus: SeasonFocus, team: (rosterId: number) => string): string[] {
  if (ledger.throughWeek == null) return [];
  const place = new Map(ledger.standings.map((record, index) => [record.rosterId, { record, rank: index + 1 }]));
  const lines: string[] = [];
  for (const [left, right] of matchupPairs(focus.matchups)) {
    const a = place.get(left.roster_id);
    const b = place.get(right.roster_id);
    if (!a || !b) continue;
    lines.push(
      `Week ${focus.week} matchup: ${team(left.roster_id)} (${recordLabel(a.record)}, ${ordinal(a.rank)}) vs ${team(right.roster_id)} (${recordLabel(b.record)}, ${ordinal(b.rank)}).`,
    );
  }
  return lines;
}

function settledWeekLines(
  ledger: SeasonLedger,
  focus: SeasonFocus,
  labels: SeasonLabels,
  team: (rosterId: number) => string,
): string[] {
  const weekGames = ledger.games.filter((game) => game.week === focus.week);
  if (weekGames.length === 0) return [];
  const lines: string[] = [];
  const high = weekGames.reduce((best, game) => (game.points > best.points ? game : best));
  const low = weekGames.reduce((worst, game) => (game.points < worst.points ? game : worst));
  lines.push(`Week ${focus.week} high score: ${team(high.rosterId)} ${points(high.points)}.`);
  lines.push(`Week ${focus.week} low score: ${team(low.rosterId)} ${points(low.points)}.`);

  const wins = weekGames.filter((game) => game.result === "W");
  if (wins.length > 0) {
    const margin = (game: Game) => game.points - game.opponentPoints;
    const blowout = wins.reduce((best, game) => (margin(game) > margin(best) ? game : best));
    const closest = wins.reduce((best, game) => (margin(game) < margin(best) ? game : best));
    lines.push(
      `Week ${focus.week} biggest blowout: ${team(blowout.rosterId)} beat ${team(blowout.opponentId)} by ${points(margin(blowout))}.`,
    );
    if (closest !== blowout) {
      lines.push(
        `Week ${focus.week} closest game: ${team(closest.rosterId)} beat ${team(closest.opponentId)} by ${points(margin(closest))}.`,
      );
    }
  }

  const earlier = ledger.games.filter(
    (game) => game.week < focus.week && isRegularSeason(game.week, ledger.rules),
  );
  if (isRegularSeason(focus.week, ledger.rules) && earlier.length > 0 && earlier.every((game) => game.points < high.points)) {
    lines.push(`${team(high.rosterId)} put up ${points(high.points)}, the highest score of the season so far.`);
  }

  let top: { playerId: string; rosterId: number; points: number } | null = null;
  for (const matchup of focus.matchups) {
    for (const playerId of matchup.starters ?? []) {
      const scored = matchup.players_points?.[playerId];
      if (typeof scored !== "number" || !Number.isFinite(scored)) continue;
      if (!top || scored > top.points) top = { playerId, rosterId: matchup.roster_id, points: scored };
    }
  }
  if (top) {
    lines.push(
      `Week ${focus.week} top starter: ${playerLabel(top.playerId, labels.players)} (${team(top.rosterId)}) ${points(top.points)}.`,
    );
  }

  if (isRegularSeason(focus.week, ledger.rules)) {
    const entering = buildSeasonLedger(
      ledger.weeks.filter((week) => week.week < focus.week),
      ledger.rules,
    );
    if (entering.throughWeek != null && (entering.standings[0]?.results.length ?? 0) >= 2) {
      const rank = new Map(entering.standings.map((record, index) => [record.rosterId, index + 1]));
      for (const game of wins) {
        const winnerRank = rank.get(game.rosterId);
        const loserRank = rank.get(game.opponentId);
        if (winnerRank == null || loserRank == null || winnerRank - loserRank < 3) continue;
        lines.push(
          `Upset: ${team(game.rosterId)} (${ordinal(winnerRank)} entering the week) beat ${team(game.opponentId)} (${ordinal(loserRank)}).`,
        );
      }
    }
  }
  return lines;
}

export type SeasonFocus = {
  week: number;
  matchups: SleeperMatchup[];
  /** True once the week's scores are final and counted in the ledger. */
  settled: boolean;
};

/**
 * Season context for a prompt. Every line is computed from settled weeks, so the model can
 * quote it without inventing numbers. `focus` adds the matchups the beat or recap is about.
 */
export function seasonLines(ledger: SeasonLedger, labels: SeasonLabels, focus?: SeasonFocus): string[] {
  const team = (rosterId: number) => teamLabel(labels.users, labels.rosters, rosterId);
  const lines = standingsLines(ledger, team);
  if (!focus) return lines;
  if (focus.settled) {
    lines.push(...settledWeekLines(ledger, focus, labels, team));
  } else {
    lines.push(...liveMatchupLines(ledger, focus, team));
  }
  lines.push(...rematchLines(ledger, focus, team));
  return lines;
}

/**
 * One standings summary for the bible when the ledger first fills with several settled weeks at
 * once: a league set up mid-season, or an existing league the first time the ledger runs.
 */
export function previouslyOnEntry(ledger: SeasonLedger, labels: SeasonLabels): string | null {
  const first = ledger.standings[0];
  const last = ledger.standings[ledger.standings.length - 1];
  if (ledger.throughWeek == null || !first || !last || first === last) return null;
  const team = (rosterId: number) => teamLabel(labels.users, labels.rosters, rosterId);
  return `Previously, through week ${ledger.throughWeek}: ${team(first.rosterId)} led at ${recordLabel(first)} and ${team(last.rosterId)} sat at ${recordLabel(last)}.`;
}

/** Bible entries for a week's one-score finals. Written once, when the week first settles. */
export function closeGameEntries(week: FinalWeek, labels: SeasonLabels): string[] {
  const team = (rosterId: number) => teamLabel(labels.users, labels.rosters, rosterId);
  return scoredPairs(week.matchups)
    .filter(([left, right]) => Math.abs(left.points - right.points) <= ONE_SCORE_MARGIN)
    .map(([left, right]) => {
      const [winner, loser] = left.points >= right.points ? [left, right] : [right, left];
      if (winner.points === loser.points) {
        return `Week ${week.week}: ${team(left.roster_id)} and ${team(right.roster_id)} tied ${points(left.points)}-${points(right.points)}.`;
      }
      return `Week ${week.week}: ${team(winner.roster_id)} beat ${team(loser.roster_id)} ${points(winner.points)}-${points(loser.points)}, a one-score game.`;
    });
}
