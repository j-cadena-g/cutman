import {
  EXAMPLE_SLEEPER_USERNAME,
  SleeperRequestError,
  V1_LEAGUE_ID,
  V1_LEAGUE_NAME,
  createFixtureClient,
  fixturePlayers,
  v1FixtureLeague,
  v1FixtureMatchups,
  v1FixtureRosters,
  v1FixtureUsers,
  type SleeperClient,
  type SleeperLeagueUser,
  type SleeperMatchup,
  type SleeperRoster,
} from "@cutman/sleeper";
import { describe, expect, it } from "vitest";
import { getDashboardOrNull } from "../app/lib/dashboard.ts";
import {
  BOARD_TTL_MS,
  USER_TTL_MS,
  createMemoryExplorerCache,
  lookupExplorerBoard,
  lookupExplorerUser,
  type ExplorerCache,
  type ExplorerDeps,
} from "../app/lib/sleeper-explorer.server.ts";
import {
  assembleExplorerBoard,
  assembleScoreboard,
  assembleStandings,
  describeExplorerError,
  isValidExplorerLeagueId,
  isValidExplorerUsername,
} from "../app/lib/sleeper-explorer.ts";

function countingClient(base: SleeperClient = createFixtureClient()) {
  const calls = {
    getNflState: 0,
    getUser: 0,
    getUserLeagues: 0,
    getLeague: 0,
    getLeagueUsers: 0,
    getRosters: 0,
    getMatchups: 0,
    getTransactions: 0,
    getPlayers: 0,
  };
  const client: SleeperClient = {
    async getNflState() {
      calls.getNflState += 1;
      return base.getNflState();
    },
    async getUser(usernameOrId) {
      calls.getUser += 1;
      return base.getUser(usernameOrId);
    },
    async getUserLeagues(userId, season) {
      calls.getUserLeagues += 1;
      return base.getUserLeagues(userId, season);
    },
    async getLeague(leagueId) {
      calls.getLeague += 1;
      return base.getLeague(leagueId);
    },
    async getLeagueUsers(leagueId) {
      calls.getLeagueUsers += 1;
      return base.getLeagueUsers(leagueId);
    },
    async getRosters(leagueId) {
      calls.getRosters += 1;
      return base.getRosters(leagueId);
    },
    async getMatchups(leagueId, week) {
      calls.getMatchups += 1;
      return base.getMatchups(leagueId, week);
    },
    async getTransactions(leagueId, week) {
      calls.getTransactions += 1;
      return base.getTransactions(leagueId, week);
    },
    async getPlayers() {
      calls.getPlayers += 1;
      return base.getPlayers();
    },
  };
  return { client, calls };
}

function countingCache(store = new Map<string, string>()): { cache: ExplorerCache; calls: { putJson: number } } {
  const base = createMemoryExplorerCache(store);
  const calls = { putJson: 0 };
  const cache: ExplorerCache = {
    getJson: (key) => base.getJson(key),
    async putJson(key, value, options) {
      calls.putJson += 1;
      return base.putJson(key, value, options);
    },
  };
  return { cache, calls };
}

function makeDeps(overrides: Partial<ExplorerDeps> & { sleeper?: SleeperClient } = {}): ExplorerDeps {
  const sleeper = overrides.sleeper ?? createFixtureClient();
  return {
    sleeper,
    cache: overrides.cache ?? createMemoryExplorerCache(),
    getPlayers: overrides.getPlayers ?? (async () => sleeper.getPlayers()),
    now: overrides.now ?? (() => 1_700_000_000_000),
    quotaPerHour: overrides.quotaPerHour,
  };
}

describe("isValidExplorerUsername", () => {
  it("accepts 1–32 lowercase letters, digits, underscores, and hyphens", () => {
    expect(isValidExplorerUsername("jcadenag")).toBe(true);
    expect(isValidExplorerUsername("a_b-c9")).toBe(true);
    expect(isValidExplorerUsername("a".repeat(32))).toBe(true);
  });

  it("rejects empty, overlong, spaced, or punctuated handles", () => {
    expect(isValidExplorerUsername("")).toBe(false);
    expect(isValidExplorerUsername("a".repeat(33))).toBe(false);
    expect(isValidExplorerUsername("Has Space")).toBe(false);
    expect(isValidExplorerUsername("semi;colon")).toBe(false);
  });
});

describe("describeExplorerError", () => {
  it("states the accepted username format for invalid_username", () => {
    expect(describeExplorerError("invalid_username")).toBe(
      "Enter a Sleeper username of 1–32 letters, digits, underscores, or hyphens.",
    );
  });
});

describe("isValidExplorerLeagueId", () => {
  it("accepts numeric snowflakes of 1–32 digits", () => {
    expect(isValidExplorerLeagueId("1")).toBe(true);
    expect(isValidExplorerLeagueId("1180000000000000000")).toBe(true);
    expect(isValidExplorerLeagueId("0".repeat(32))).toBe(true);
  });

  it("rejects empty, alphabetic, slashed, spaced, or overlong ids", () => {
    expect(isValidExplorerLeagueId("")).toBe(false);
    expect(isValidExplorerLeagueId("abc")).toBe(false);
    expect(isValidExplorerLeagueId("12/34")).toBe(false);
    expect(isValidExplorerLeagueId("1 2")).toBe(false);
    expect(isValidExplorerLeagueId("0".repeat(33))).toBe(false);
  });
});

describe("assembleStandings / assembleScoreboard", () => {
  it("joins roster_id to owner display names, sorts by wins then PF, and marks abandoned seats", () => {
    const users: SleeperLeagueUser[] = [
      { user_id: "u-a", username: "a", display_name: "Alex", metadata: { team_name: "Purdy Please" } },
      { user_id: "u-b", username: "b", display_name: "Mina", metadata: { team_name: "Zero RB" } },
    ];
    const rosters: SleeperRoster[] = [
      { roster_id: 2, owner_id: "u-b", settings: { wins: 1, losses: 0, fpts: 200 } },
      { roster_id: 1, owner_id: "u-a", settings: { wins: 2, losses: 0, fpts: 90 } },
      { roster_id: 3, owner_id: null, settings: { wins: 2, losses: 0, fpts: 110 } },
    ];
    const standings = assembleStandings(rosters, users);
    expect(standings.map((row) => row.rosterId)).toEqual([3, 1, 2]);
    expect(standings[0]).toMatchObject({ teamName: "Abandoned roster", abandoned: true, pointsFor: 110 });
    expect(standings[1]).toMatchObject({ teamName: "Purdy Please", displayName: "Alex", wins: 2 });
  });

  it("pairs matchup rows by matchup_id and keeps byes as a single side", () => {
    const users: SleeperLeagueUser[] = [
      { user_id: "u-a", username: "a", display_name: "Alex", metadata: { team_name: "A" } },
      { user_id: "u-b", username: "b", display_name: "Mina", metadata: { team_name: "B" } },
      { user_id: "u-c", username: "c", display_name: "Devin", metadata: { team_name: "C" } },
    ];
    const rosters: SleeperRoster[] = [
      { roster_id: 1, owner_id: "u-a" },
      { roster_id: 2, owner_id: "u-b" },
      { roster_id: 3, owner_id: "u-c" },
    ];
    const matchups: SleeperMatchup[] = [
      { roster_id: 1, matchup_id: 1, points: 10, starters: ["4046"] },
      { roster_id: 2, matchup_id: 1, points: 8, starters: ["4881"] },
      { roster_id: 3, matchup_id: null, points: 12, starters: ["5849"] },
    ];
    const games = assembleScoreboard(rosters, users, matchups, fixturePlayers);
    expect(games).toHaveLength(2);
    expect(games[0]?.matchupId).toBe(1);
    expect(games[0]?.sides.map((side) => side.teamName)).toEqual(["A", "B"]);
    expect(games[1]?.matchupId).toBeNull();
    expect(games[1]?.sides).toHaveLength(1);
    expect(games[1]?.sides[0]?.starters[0]?.name).toBe("Jalen Hurts");
  });

  it("resolves starter names from the player map on a fixture board", () => {
    const board = assembleExplorerBoard({
      league: v1FixtureLeague,
      week: 1,
      users: v1FixtureUsers,
      rosters: v1FixtureRosters,
      matchups: v1FixtureMatchups,
      players: fixturePlayers,
    });
    expect(board.league.name).toBe(V1_LEAGUE_NAME);
    const first = board.rosters.find((roster) => roster.rosterId === 1);
    expect(first?.starters.map((player) => player.name)).toContain("Patrick Mahomes");
    expect(first?.starters.map((player) => player.name)).toContain("PHI");
  });
});

describe("lookupExplorerUser", () => {
  it("returns invalid_username for a blank handle without calling Sleeper", async () => {
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(makeDeps({ sleeper: client }), {
      username: "   ",
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "invalid_username" });
    expect(calls.getUser).toBe(0);
    expect(calls.getNflState).toBe(0);
  });

  it("returns invalid_username for a 40-char handle without writing cache or calling Sleeper", async () => {
    const { client, calls } = countingClient();
    const wrapped = countingCache();
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache: wrapped.cache }), {
      username: "a".repeat(40),
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "invalid_username" });
    expect(wrapped.calls.putJson).toBe(0);
    expect(calls.getUser).toBe(0);
  });

  it("returns invalid_username for a handle with spaces and a slash", async () => {
    const result = await lookupExplorerUser(makeDeps(), {
      username: "bad user/name",
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "invalid_username" });
  });

  it("returns the fixture profile and this season's leagues without calling getLeagueUsers", async () => {
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(makeDeps({ sleeper: client }), {
      username: `  ${EXAMPLE_SLEEPER_USERNAME.toUpperCase()}  `,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.user.username).toBe(EXAMPLE_SLEEPER_USERNAME);
    expect(result.leagues.map((league) => league.sleeperLeagueId)).toContain(V1_LEAGUE_ID);
    expect(calls.getLeagueUsers).toBe(0);
    expect(calls.getUser).toBe(1);
    expect(calls.getUserLeagues).toBe(1);
    expect("db" in makeDeps()).toBe(false);
  });

  it("returns not_found for an unknown username", async () => {
    const result = await lookupExplorerUser(makeDeps(), { username: "nobody_here", clerkUserId: "clerk_1" });
    expect(result).toEqual({ kind: "not_found", username: "nobody_here" });
  });

  it("skips Sleeper on a fresh cache hit", async () => {
    const { client, calls } = countingClient();
    const deps = makeDeps({ sleeper: client });
    await lookupExplorerUser(deps, { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: "clerk_1" });
    await lookupExplorerUser(deps, { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: "clerk_1" });
    expect(calls.getUser).toBe(1);
    expect(calls.getUserLeagues).toBe(1);
    expect(calls.getNflState).toBe(1);
  });

  it("serves stale cache when Sleeper returns 429 after TTL", async () => {
    const cache = createMemoryExplorerCache();
    let now = 1_700_000_000_000;
    const live = countingClient();
    const deps = makeDeps({ sleeper: live.client, cache, now: () => now });
    const first = await lookupExplorerUser(deps, { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: "clerk_1" });
    expect(first.kind).toBe("ok");

    now += USER_TTL_MS + 1;
    const blocked: SleeperClient = {
      ...live.client,
      async getUser() {
        throw new SleeperRequestError("/user/example_user", 429);
      },
    };
    const stale = await lookupExplorerUser(makeDeps({ sleeper: blocked, cache, now: () => now }), {
      username: EXAMPLE_SLEEPER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(stale.kind).toBe("ok");
    if (stale.kind !== "ok") return;
    expect(stale.stale).toBe(true);
    expect(stale.user.username).toBe(EXAMPLE_SLEEPER_USERNAME);
  });

  it("returns rate_limited when Sleeper 429s with an empty cache", async () => {
    const sleeper = createFixtureClient();
    const blocked: SleeperClient = {
      ...sleeper,
      async getUser() {
        throw new SleeperRequestError("/user/x", 429);
      },
    };
    const result = await lookupExplorerUser(makeDeps({ sleeper: blocked }), {
      username: EXAMPLE_SLEEPER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("rate_limited");
  });

  it("returns quota_exceeded after the per-user origin budget is spent", async () => {
    const deps = makeDeps({ quotaPerHour: 1 });
    const first = await lookupExplorerUser(deps, { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: "clerk_1" });
    expect(first.kind).toBe("ok");
    const second = await lookupExplorerUser(deps, { username: "mina", clerkUserId: "clerk_1" });
    expect(second.kind).toBe("quota_exceeded");
  });
});

describe("lookupExplorerBoard", () => {
  it("returns not_found for a garbage league id without writing cache or calling Sleeper", async () => {
    const { client, calls } = countingClient();
    const wrapped = countingCache();
    const result = await lookupExplorerBoard(makeDeps({ sleeper: client, cache: wrapped.cache }), {
      sleeperLeagueId: "not-a-league/../x",
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "not_found" });
    expect(wrapped.calls.putJson).toBe(0);
    expect(calls.getLeague).toBe(0);
    expect(calls.getNflState).toBe(0);
    expect(calls.getLeagueUsers).toBe(0);
    expect(calls.getRosters).toBe(0);
    expect(calls.getMatchups).toBe(0);
    expect(calls.getUser).toBe(0);
    expect(calls.getUserLeagues).toBe(0);
    expect(calls.getTransactions).toBe(0);
    expect(calls.getPlayers).toBe(0);
  });

  it("joins matchups to managers and player names for the fixture league", async () => {
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(makeDeps({ sleeper: client }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.board.league.name).toBe(V1_LEAGUE_NAME);
    expect(result.board.matchups.length).toBeGreaterThan(0);
    const firstGame = result.board.matchups.find((matchup) => matchup.matchupId === 1);
    expect(firstGame?.sides).toHaveLength(2);
    expect(firstGame?.sides[0]?.starters.some((player) => player.name === "Patrick Mahomes")).toBe(true);
    expect(calls.getUserLeagues).toBe(0);
    expect(calls.getTransactions).toBe(0);
  });

  it("returns not_found for an unknown league id", async () => {
    const result = await lookupExplorerBoard(makeDeps(), {
      sleeperLeagueId: "missing-league",
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("not_found");
  });

  it("skips Sleeper league fetches on a fresh board cache hit", async () => {
    const { client, calls } = countingClient();
    const deps = makeDeps({ sleeper: client });
    await lookupExplorerBoard(deps, { sleeperLeagueId: V1_LEAGUE_ID, clerkUserId: "clerk_1" });
    await lookupExplorerBoard(deps, { sleeperLeagueId: V1_LEAGUE_ID, clerkUserId: "clerk_1" });
    expect(calls.getLeague).toBe(1);
    expect(calls.getLeagueUsers).toBe(1);
    expect(calls.getRosters).toBe(1);
    expect(calls.getMatchups).toBe(1);
  });

  it("serves a stale board when origin fails after TTL", async () => {
    const cache = createMemoryExplorerCache();
    let now = 1_700_000_000_000;
    const live = createFixtureClient();
    const first = await lookupExplorerBoard(makeDeps({ sleeper: live, cache, now: () => now }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(first.kind).toBe("ok");
    now += BOARD_TTL_MS + 1;
    const blocked: SleeperClient = {
      ...live,
      async getLeague() {
        throw new SleeperRequestError("/league/x", 429);
      },
    };
    const stale = await lookupExplorerBoard(makeDeps({ sleeper: blocked, cache, now: () => now }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(stale.kind).toBe("ok");
    if (stale.kind !== "ok") return;
    expect(stale.stale).toBe(true);
  });

  it("returns rate_limited when getPlayers 429s on a fresh cached board", async () => {
    const cache = createMemoryExplorerCache();
    const first = await lookupExplorerBoard(makeDeps({ cache }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(first.kind).toBe("ok");

    const result = await lookupExplorerBoard(
      makeDeps({
        cache,
        getPlayers: async () => {
          throw new SleeperRequestError("/players/nfl", 429);
        },
      }),
      { sleeperLeagueId: V1_LEAGUE_ID, clerkUserId: "clerk_1" },
    );
    expect(result).toEqual({ kind: "rate_limited" });
  });

  it("returns unavailable when getPlayers rejects on a fresh cached board", async () => {
    const cache = createMemoryExplorerCache();
    const first = await lookupExplorerBoard(makeDeps({ cache }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(first.kind).toBe("ok");

    const result = await lookupExplorerBoard(
      makeDeps({
        cache,
        getPlayers: async () => {
          throw new Error("players unavailable");
        },
      }),
      { sleeperLeagueId: V1_LEAGUE_ID, clerkUserId: "clerk_1" },
    );
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("caches board data when getPlayers 429s on origin fetch, then skips league refetches", async () => {
    const { client, calls } = countingClient();
    const cache = createMemoryExplorerCache();
    const getPlayers = async () => {
      throw new SleeperRequestError("/players/nfl", 429);
    };
    const first = await lookupExplorerBoard(makeDeps({ sleeper: client, cache, getPlayers }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(first).toEqual({ kind: "rate_limited" });
    expect(calls.getLeague).toBe(1);
    expect(calls.getLeagueUsers).toBe(1);
    expect(calls.getRosters).toBe(1);
    expect(calls.getMatchups).toBe(1);

    const second = await lookupExplorerBoard(makeDeps({ sleeper: client, cache, getPlayers }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(second).toEqual({ kind: "rate_limited" });
    expect(calls.getLeague).toBe(1);
    expect(calls.getLeagueUsers).toBe(1);
    expect(calls.getRosters).toBe(1);
    expect(calls.getMatchups).toBe(1);
  });

  it("caches board data when getPlayers rejects on origin fetch, then skips league refetches", async () => {
    const { client, calls } = countingClient();
    const cache = createMemoryExplorerCache();
    const getPlayers = async () => {
      throw new Error("players unavailable");
    };
    const first = await lookupExplorerBoard(makeDeps({ sleeper: client, cache, getPlayers }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(first).toEqual({ kind: "unavailable" });
    expect(calls.getLeague).toBe(1);
    expect(calls.getLeagueUsers).toBe(1);
    expect(calls.getRosters).toBe(1);
    expect(calls.getMatchups).toBe(1);

    const second = await lookupExplorerBoard(makeDeps({ sleeper: client, cache, getPlayers }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(second).toEqual({ kind: "unavailable" });
    expect(calls.getLeague).toBe(1);
    expect(calls.getLeagueUsers).toBe(1);
    expect(calls.getRosters).toBe(1);
    expect(calls.getMatchups).toBe(1);
  });
});

describe("story dashboard isolation", () => {
  it("still reads LeagueBrain only — getDashboardOrNull never takes a Sleeper client", async () => {
    const dashboard = await getDashboardOrNull({
      getDashboard: async () => ({
        leagueId: "pilot_league",
        sleeperLeagueId: V1_LEAGUE_ID,
        name: V1_LEAGUE_NAME,
        tone: "playful",
        week: 1,
        lastHash: null,
        bible: [],
        timeline: [],
        recaps: [],
      }),
    });
    expect(dashboard?.name).toBe(V1_LEAGUE_NAME);
    expect(dashboard).not.toHaveProperty("sleeper");
  });
});
