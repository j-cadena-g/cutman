import type { SleeperLeagueUser, SleeperMatchup, SleeperRoster } from "@cutman/sleeper";
import { describe, expect, it } from "vitest";
import { beatPrompt, recapPrompt } from "./prompts.ts";
import {
  buildSeasonLedger,
  closeGameEntries,
  previouslyOnEntry,
  seasonLines,
  type FinalWeek,
  type SeasonLabels,
} from "./season.ts";
import { lastSettledWeek } from "./week.ts";

const NAMES = ["Aces", "Bombers", "Cobras", "Dingos", "Eagles", "Foxes"];

const users: SleeperLeagueUser[] = NAMES.map((name, index) => ({
  user_id: `u${index + 1}`,
  username: name.toLowerCase(),
  display_name: name.toLowerCase(),
  metadata: { team_name: name },
}));
const rosters: SleeperRoster[] = NAMES.map((_name, index) => ({ roster_id: index + 1, owner_id: `u${index + 1}` }));
const labels: SeasonLabels = {
  users,
  rosters,
  players: { p2: { player_id: "p2", full_name: "Star Back" } },
};

/** Each game is [rosterA, pointsA, rosterB, pointsB]. Every roster starts one player worth a quarter of its score. */
function week(number: number, games: Array<[number, number | null, number, number | null]>): FinalWeek {
  const matchups: SleeperMatchup[] = games.flatMap(([a, pa, b, pb], index) =>
    [
      [a, pa],
      [b, pb],
    ].map(([roster, points]) => ({
      roster_id: roster as number,
      matchup_id: index + 1,
      points: points as number | null,
      starters: [`p${roster}`],
      players: [`p${roster}`],
      players_points: points == null ? null : { [`p${roster}`]: (points as number) / 4 },
    })),
  );
  return { week: number, matchups };
}

const week1 = week(1, [
  [1, 120, 2, 100],
  [3, 125, 4, 128],
  [5, 130, 6, 60],
]);
const week2 = week(2, [
  [1, 120, 3, 118],
  [2, 140, 5, 80],
  [4, 85, 6, 70],
]);
const week3 = week(3, [
  [1, 101, 4, 99],
  [2, 150, 6, 50],
  [3, 130, 5, 135],
]);

describe("season ledger", () => {
  it("orders standings by record, then points for", () => {
    const ledger = buildSeasonLedger([week3, week1, week2]);
    expect(ledger.throughWeek).toBe(3);
    expect(ledger.standings.map((record) => [record.rosterId, record.wins, record.losses, record.pointsFor])).toEqual([
      [1, 3, 0, 341],
      [2, 2, 1, 390],
      [5, 2, 1, 345],
      [4, 2, 1, 312],
      [3, 0, 3, 373],
      [6, 0, 3, 180],
    ]);
  });

  it("adds a win or loss against the weekly median when the league plays the median", () => {
    const ledger = buildSeasonLedger(
      [
        week(1, [
          [1, 100, 2, 90],
          [3, 80, 4, 70],
        ]),
      ],
      { medianWins: true },
    );
    expect(ledger.standings.map((record) => [record.rosterId, record.wins, record.losses])).toEqual([
      [1, 2, 0],
      [2, 1, 1],
      [3, 1, 1],
      [4, 0, 2],
    ]);
    // Streaks follow head-to-head results only.
    expect(ledger.standings.find((record) => record.rosterId === 2)?.results).toEqual(["L"]);
  });

  it("keeps playoff weeks out of the standings but remembers the games", () => {
    const ledger = buildSeasonLedger([week1, week2, week3], { playoffWeekStart: 3 });
    expect(ledger.throughWeek).toBe(2);
    expect(ledger.standings.find((record) => record.rosterId === 1)?.wins).toBe(2);
    expect(ledger.games.some((game) => game.week === 3)).toBe(true);
  });

  it("skips byes and unscored matchups", () => {
    const bye: SleeperMatchup = { roster_id: 7, matchup_id: null, points: 88 };
    const ledger = buildSeasonLedger([
      { week: 1, matchups: [...week(1, [[1, null, 2, null]]).matchups, bye] },
    ]);
    expect(ledger.throughWeek).toBeNull();
    expect(ledger.standings).toEqual([]);
  });
});

describe("season lines", () => {
  const ledger = buildSeasonLedger([week1, week2, week3]);

  it("states standings, streaks, luck, and season extremes", () => {
    expect(seasonLines(ledger, labels)).toEqual([
      "Standings through week 3: 1. Aces 3-0 (341 PF), 2. Bombers 2-1 (390 PF), 3. Eagles 2-1 (345 PF), 4. Dingos 2-1 (312 PF), 5. Cobras 0-3 (373 PF), 6. Foxes 0-3 (180 PF).",
      "Aces is the only unbeaten team (3-0).",
      "Cobras has lost 3 straight.",
      "Foxes has lost 3 straight.",
      "Bombers has won 2 straight.",
      "Cobras is 0-3 despite the 2nd-most points (373 PF).",
      "Aces is 3-0 with only the 4th-most points (341 PF).",
      "Season high score: Bombers 150 in week 3.",
      "Season low score: Foxes 50 in week 3.",
    ]);
  });

  it("calls out a settled week's highlights", () => {
    const lines = seasonLines(ledger, labels, { week: 3, matchups: week3.matchups, settled: true });
    expect(lines).toEqual(
      expect.arrayContaining([
        "Week 3 high score: Bombers 150.",
        "Week 3 low score: Foxes 50.",
        "Week 3 biggest blowout: Bombers beat Foxes by 100.",
        "Week 3 closest game: Aces beat Dingos by 2.",
        "Bombers put up 150, the highest score of the season so far.",
        "Week 3 top starter: Star Back (Bombers) 37.5.",
      ]),
    );
    expect(lines.some((line) => line.startsWith("Upset:"))).toBe(false);
  });

  it("frames a live week with records and earlier meetings", () => {
    const week4 = week(4, [
      [1, null, 2, null],
      [3, null, 4, null],
      [5, null, 6, null],
    ]);
    const lines = seasonLines(ledger, labels, { week: 4, matchups: week4.matchups, settled: false });
    expect(lines).toEqual(
      expect.arrayContaining([
        "Week 4 matchup: Aces (3-0, 1st) vs Bombers (2-1, 2nd).",
        "Rematch: Aces beat Bombers 120-100 in week 1.",
        "Rematch: Dingos beat Cobras 128-125 in week 1.",
      ]),
    );
    expect(lines.some((line) => line.startsWith("Week 4 high score"))).toBe(false);
  });

  it("names an upset against the standings entering the week", () => {
    const upsetLedger = buildSeasonLedger([
      week(1, [
        [1, 100, 2, 90],
        [3, 80, 4, 70],
      ]),
      week(2, [
        [1, 100, 3, 90],
        [2, 80, 4, 70],
      ]),
      week(3, [
        [4, 110, 1, 100],
        [2, 90, 3, 80],
      ]),
    ]);
    const lines = seasonLines(upsetLedger, labels, {
      week: 3,
      matchups: upsetLedger.weeks[2]?.matchups ?? [],
      settled: true,
    });
    expect(lines).toContain("Upset: Dingos (4th entering the week) beat Aces (1st).");
  });

  it("writes one previously-on entry from the standings", () => {
    expect(previouslyOnEntry(ledger, labels)).toBe(
      "Previously, through week 3: Aces led at 3-0 and Foxes sat at 0-3.",
    );
    expect(previouslyOnEntry(buildSeasonLedger([]), labels)).toBeNull();
  });
});

describe("close-game bible entries", () => {
  it("records one-score finals with the final score, and ties", () => {
    expect(closeGameEntries(week3, labels)).toEqual([
      "Week 3: Aces beat Dingos 101-99, a one-score game.",
      "Week 3: Eagles beat Cobras 135-130, a one-score game.",
    ]);
    expect(closeGameEntries(week(5, [[1, 90, 2, 90]]), labels)).toEqual(["Week 5: Aces and Bombers tied 90-90."]);
  });
});

describe("settled weeks", () => {
  it("counts the current week only once it is played and Monday night is done", () => {
    const base = { seasonType: "regular", nflWeek: 5 };
    expect(lastSettledWeek({ ...base, currentWeekPlayed: true, canSettleCurrent: true })).toBe(5);
    expect(lastSettledWeek({ ...base, currentWeekPlayed: true, canSettleCurrent: false })).toBe(4);
    expect(lastSettledWeek({ ...base, currentWeekPlayed: false, canSettleCurrent: true })).toBe(4);
  });

  it("settles nothing before the season and everything after it", () => {
    expect(lastSettledWeek({ seasonType: "pre", nflWeek: 3, currentWeekPlayed: true, canSettleCurrent: true })).toBe(0);
    expect(lastSettledWeek({ seasonType: "regular", nflWeek: 1, currentWeekPlayed: false, canSettleCurrent: false })).toBe(0);
    expect(lastSettledWeek({ seasonType: "post", nflWeek: 2, currentWeekPlayed: false, canSettleCurrent: false })).toBe(18);
  });
});

describe("season context in prompts", () => {
  const input = { tone: "playful" as const, leagueName: "The Group Chat", week: 4, bible: [], facts: [] };

  it("adds the season section only when there is season context", () => {
    expect(beatPrompt(input).user).not.toContain("Season so far");
    const withSeason = beatPrompt({ ...input, season: ["Aces has won 3 straight."] }).user;
    expect(withSeason).toContain("Season so far (settled; keep every number exactly as written):\n- Aces has won 3 straight.");
    expect(recapPrompt({ ...input, season: ["Aces has won 3 straight."] }).user).toContain("- Aces has won 3 straight.");
  });
});
