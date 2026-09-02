import { fixtureMatchupsFinal, fixtureMatchupsInProgress, fixtureMatchupsNoPlayerPoints, fixturePlayers, fixtureRosters, fixtureTransactions, fixtureUsersUnverified, fixtureUsersVerified } from "@league-brain/sleeper";
import { describe, expect, it } from "vitest";
import { diffSnapshots, factsIfChanged } from "./diff.ts";
import { runRecapAttempt } from "./recap.ts";
import { shouldAttemptTuesdayRecap, shouldPoll } from "./schedule.ts";
import { hashSnapshot, type LeagueSnapshot } from "./snapshot.ts";
import { formatVerifyToken, verifySleeperTeamName } from "./verify.ts";
import { isWeekFinal } from "./week.ts";

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

describe("sleeper team name verify", () => {
  it("passes when FF-XXXX is appended to metadata.team_name", () => {
    const result = verifySleeperTeamName(fixtureUsersVerified, "james", "A7K2");
    expect(result).toEqual({
      ok: true,
      sleeperUserId: "u-james",
      teamName: `Purdy Please ${formatVerifyToken("A7K2")}`,
    });
  });

  it("fails when the token is missing from the team name", () => {
    const result = verifySleeperTeamName(fixtureUsersUnverified, "james", "A7K2");
    expect(result).toEqual({ ok: false, reason: "missing_token" });
  });

  it("fails when the username is not in the league", () => {
    const result = verifySleeperTeamName(fixtureUsersVerified, "not-james", "A7K2");
    expect(result).toEqual({ ok: false, reason: "not_found" });
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
      facts: [{ kind: "trade" as const, transactionId: "tx-trade-1", copy: "James traded CeeDee." }],
      generate: async () => {
        generated.push("once");
        return { subject: "Week 3: CeeDee changes hands", body: "James fleeced the chat." };
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
  it("polls every 3 ET hours and recaps Tuesday 9/13/19", () => {
    expect(shouldPoll({ hour: 0, weekday: 2, weekdayLabel: "Tue" })).toBe(true);
    expect(shouldPoll({ hour: 2, weekday: 2, weekdayLabel: "Tue" })).toBe(false);
    expect(shouldAttemptTuesdayRecap({ hour: 9, weekday: 2, weekdayLabel: "Tue" })).toBe(true);
    expect(shouldAttemptTuesdayRecap({ hour: 13, weekday: 2, weekdayLabel: "Tue" })).toBe(true);
    expect(shouldAttemptTuesdayRecap({ hour: 19, weekday: 2, weekdayLabel: "Tue" })).toBe(true);
    expect(shouldAttemptTuesdayRecap({ hour: 9, weekday: 3, weekdayLabel: "Wed" })).toBe(false);
    expect(shouldAttemptTuesdayRecap({ hour: 10, weekday: 2, weekdayLabel: "Tue" })).toBe(false);
  });
});
