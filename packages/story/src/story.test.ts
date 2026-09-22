import {
  fixtureMatchupsFinal,
  fixtureMatchupsInProgress,
  fixtureMatchupsNoPlayerPoints,
  fixturePlayers,
  fixtureRosters,
  fixtureTransactions,
  fixtureUsersVerified,
  type SleeperLeagueUser,
  type SleeperMatchup,
  type SleeperRoster,
  type SleeperTransaction,
} from "@cutman/sleeper";
import { describe, expect, it } from "vitest";
import { diffSnapshots, factsIfChanged } from "./diff.ts";
import { runRecapAttempt } from "./recap.ts";
import { shouldAttemptTuesdayRecap, shouldPoll } from "./schedule.ts";
import { hashSnapshot, type LeagueSnapshot } from "./snapshot.ts";
import { isPlayedWeek, isWeekFinal, selectRecapWeek } from "./week.ts";

function snapshot(overrides: Partial<LeagueSnapshot> = {}): LeagueSnapshot {
  return {
    leagueId: "lg-group-chat",
    week: 3,
    users: fixtureUsersVerified,
    rosters: fixtureRosters,
    matchups: fixtureMatchupsFinal,
    transactions: fixtureTransactions,
    ...overrides,
  };
}

describe("snapshot diff idempotency", () => {
  it("emits no facts when the payload hash is unchanged", async () => {
    const first = snapshot();
    const second = snapshot();
    const hashA = await hashSnapshot(first);
    const hashB = await hashSnapshot(second);
    expect(hashA).toBe(hashB);
    const facts = await factsIfChanged(hashA, hashB, first, second, fixturePlayers);
    expect(facts).toEqual([]);
  });

  it("emits trade and bench-shame facts when the week moves", () => {
    const facts = diffSnapshots(null, snapshot(), fixturePlayers);
    expect(facts.some((fact) => fact.kind === "trade")).toBe(true);
    expect(facts.some((fact) => fact.kind === "bench_shame")).toBe(true);
    const shame = facts.find((fact) => fact.kind === "bench_shame" && fact.rosterId === 1);
    expect(shame?.copy).toContain("CeeDee Lamb");
  });

  it("skips bench-shame when players_points is missing", () => {
    const facts = diffSnapshots(
      null,
      snapshot({ matchups: fixtureMatchupsNoPlayerPoints }),
      fixturePlayers,
    );
    expect(facts.some((fact) => fact.kind === "bench_shame")).toBe(false);
  });
});

function zeroPointMatchups(matchups: SleeperMatchup[]): SleeperMatchup[] {
  return matchups.map((matchup) => ({
    ...matchup,
    points: 0,
    players_points: Object.fromEntries(Object.keys(matchup.players_points ?? {}).map((id) => [id, 0])),
  }));
}

describe("played week selection", () => {
  it("recaps the current week when that slate is already played", () => {
    expect(isPlayedWeek(fixtureMatchupsFinal)).toBe(true);
    expect(selectRecapWeek({ nflWeek: 3, currentWeekPlayed: true })).toBe(3);
  });

  it("rolls an all-zero week back one, and week 1 has no recap yet", () => {
    const unplayed = zeroPointMatchups(fixtureMatchupsFinal);
    expect(isPlayedWeek(unplayed)).toBe(false);
    expect(selectRecapWeek({ nflWeek: 4, currentWeekPlayed: false })).toBe(3);
    expect(selectRecapWeek({ nflWeek: 1, currentWeekPlayed: false })).toBeNull();
  });

  it("treats a null points value as unplayed", () => {
    const matchups = fixtureMatchupsFinal.map((matchup, index) =>
      index === 0 ? { ...matchup, points: null } : matchup,
    );
    expect(isPlayedWeek(matchups)).toBe(false);
  });

  it("treats one positive player score as played even when roster totals are zero", () => {
    const matchups = zeroPointMatchups(fixtureMatchupsFinal);
    const first = matchups[0];
    if (!first) throw new Error("expected a matchup");
    matchups[0] = {
      ...first,
      players_points: { ...(first.players_points ?? {}), "4046": 0.1 },
    };
    expect(isPlayedWeek(matchups)).toBe(true);
  });
});

const tradeUsers: SleeperLeagueUser[] = [
  { user_id: "u-alex", username: "alex", display_name: "Alex", metadata: { team_name: "Purdy Please" } },
  { user_id: "u-mina", username: "mina", display_name: "Mina", metadata: { team_name: "Zero RB Forever" } },
];

const tradeRosters: SleeperRoster[] = [
  { roster_id: 1, owner_id: "u-alex" },
  { roster_id: 2, owner_id: "u-mina" },
];

function tradeSnapshot(transaction: SleeperTransaction): LeagueSnapshot {
  return {
    leagueId: "lg-group-chat",
    week: 3,
    users: tradeUsers,
    rosters: tradeRosters,
    matchups: [],
    transactions: [transaction],
  };
}

describe("trade copy and bench shame", () => {
  it("names adds, drops, picks, and FAAB on a trade", () => {
    const facts = diffSnapshots(
      null,
      tradeSnapshot({
        type: "trade",
        transaction_id: "tx-full",
        status: "complete",
        roster_ids: [1, 2],
        adds: { "4984": 1 },
        drops: { "9226": 1 },
        draft_picks: [{ season: "2027", round: 2, roster_id: 1, previous_owner_id: 2, owner_id: 1 }],
        waiver_budget: [{ sender: 1, receiver: 2, amount: 15 }],
      }),
      fixturePlayers,
    );
    const trade = facts.find((fact) => fact.kind === "trade");
    expect(trade?.copy).toContain("Purdy Please and Zero RB Forever completed a trade.");
    expect(trade?.copy).toContain("Received CeeDee Lamb.");
    expect(trade?.copy).toContain("Sent A.J. Brown.");
    expect(trade?.copy).toContain("Picks: 2027 round 2 from Zero RB Forever to Purdy Please.");
    expect(trade?.copy).toContain("FAAB: Purdy Please sent 15 to Zero RB Forever.");
  });

  it("keeps the pick clause on a pick-only trade", () => {
    const facts = diffSnapshots(
      null,
      tradeSnapshot({
        type: "trade",
        transaction_id: "tx-picks",
        status: "complete",
        roster_ids: [1, 2],
        adds: {},
        drops: {},
        draft_picks: [{ season: "2027", round: 1, roster_id: 2, previous_owner_id: 1, owner_id: 2 }],
        waiver_budget: [],
      }),
      fixturePlayers,
    );
    const trade = facts.find((fact) => fact.kind === "trade");
    expect(trade?.copy).toContain("Picks: 2027 round 1 from Purdy Please to Zero RB Forever.");
    expect(trade?.copy.endsWith("completed a trade.")).toBe(false);
  });

  it("does not emit the same bench-shame pair when only the points change", () => {
    const first = snapshot();
    const second = snapshot({
      matchups: fixtureMatchupsFinal.map((matchup) => ({
        ...matchup,
        points: typeof matchup.points === "number" ? matchup.points + 1 : matchup.points,
        players_points: matchup.players_points
          ? Object.fromEntries(Object.entries(matchup.players_points).map(([id, pts]) => [id, pts + 1]))
          : matchup.players_points,
      })),
    });
    const facts = diffSnapshots(first, second, fixturePlayers);
    expect(facts.some((fact) => fact.kind === "bench_shame")).toBe(false);
  });

  it("emits a new bench-shame fact when the best bench player changes", () => {
    const first = snapshot();
    const second = snapshot({
      matchups: fixtureMatchupsFinal.map((matchup) => {
        if (matchup.roster_id !== 1 || !matchup.players || !matchup.players_points) return matchup;
        return {
          ...matchup,
          players: [...matchup.players, "4881"],
          players_points: { ...matchup.players_points, "4881": 40 },
        };
      }),
    });
    const facts = diffSnapshots(first, second, fixturePlayers);
    const shame = facts.filter((fact) => fact.kind === "bench_shame");
    expect(shame).toHaveLength(1);
    expect(shame[0]?.copy).toContain("Lamar Jackson");
  });
});

describe("week final + Tuesday recap", () => {
  it("treats a week as final only when every matchup has finite numeric points", () => {
    expect(isWeekFinal(fixtureMatchupsFinal)).toBe(true);
    expect(isWeekFinal(fixtureMatchupsInProgress)).toBe(false);
    expect(isWeekFinal([])).toBe(false);
  });

  it("skips recap generation when the week is not final", async () => {
    const result = await runRecapAttempt({
      week: 3,
      matchups: fixtureMatchupsInProgress,
      existingRecap: null,
      facts: [],
      generate: async () => ({ subject: "Should not send", body: "Nope" }),
      archive: async () => {
        throw new Error("should not archive");
      },
      email: async () => {
        throw new Error("should not email");
      },
    });
    expect(result.status).toBe("skipped_not_final");
  });

  it("archives then emails once; a second run does not publish another recap", async () => {
    let archived = 0;
    let emailed = 0;
    const generated: string[] = [];
    const ports = {
      week: 3,
      matchups: fixtureMatchupsFinal,
      existingRecap: null as { subject: string; body: string } | null,
      facts: [{ kind: "trade" as const, transactionId: "tx-trade-1", copy: "Alex traded CeeDee." }],
      generate: async () => {
        generated.push("once");
        return { subject: "Week 3: CeeDee changes hands", body: "Alex fleeced the chat." };
      },
      archive: async (recap: { subject: string; body: string }) => {
        archived += 1;
        ports.existingRecap = recap;
      },
      email: async () => {
        emailed += 1;
      },
    };

    const first = await runRecapAttempt(ports);
    const second = await runRecapAttempt(ports);

    expect(first.status).toBe("published");
    expect(second.status).toBe("skipped_already");
    expect(archived).toBe(1);
    expect(emailed).toBe(1);
    expect(generated).toHaveLength(1);
  });

  it("publishes nothing when the model throws", async () => {
    let archived = 0;
    let emailed = 0;
    const result = await runRecapAttempt({
      week: 3,
      matchups: fixtureMatchupsFinal,
      existingRecap: null,
      facts: [],
      generate: async () => {
        throw new Error("gemma down");
      },
      archive: async () => {
        archived += 1;
      },
      email: async () => {
        emailed += 1;
      },
    });
    expect(result).toEqual({ status: "model_error", error: "gemma down" });
    expect(archived).toBe(0);
    expect(emailed).toBe(0);
  });

  it("never emails a blank recap", async () => {
    let emailed = 0;
    const result = await runRecapAttempt({
      week: 3,
      matchups: fixtureMatchupsFinal,
      existingRecap: null,
      facts: [],
      generate: async () => ({ subject: "  ", body: "" }),
      archive: async () => {
        throw new Error("should not archive blank");
      },
      email: async () => {
        emailed += 1;
      },
    });
    expect(result.status).toBe("blank");
    expect(emailed).toBe(0);
  });
});

describe("ET cron windows", () => {
  it("polls every 3 ET hours and recaps Tuesday 9:00 only", () => {
    expect(shouldPoll({ hour: 0, weekday: 2, weekdayLabel: "Tue" })).toBe(true);
    expect(shouldPoll({ hour: 2, weekday: 2, weekdayLabel: "Tue" })).toBe(false);
    expect(shouldAttemptTuesdayRecap({ hour: 9, weekday: 2, weekdayLabel: "Tue" })).toBe(true);
    expect(shouldAttemptTuesdayRecap({ hour: 13, weekday: 2, weekdayLabel: "Tue" })).toBe(false);
    expect(shouldAttemptTuesdayRecap({ hour: 19, weekday: 2, weekdayLabel: "Tue" })).toBe(false);
    expect(shouldAttemptTuesdayRecap({ hour: 9, weekday: 3, weekdayLabel: "Wed" })).toBe(false);
    expect(shouldAttemptTuesdayRecap({ hour: 10, weekday: 2, weekdayLabel: "Tue" })).toBe(false);
  });
});
