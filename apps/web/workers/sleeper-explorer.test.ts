/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import {
  EXAMPLE_SLEEPER_USERNAME,
  EXAMPLE_SLEEPER_USER_ID,
  SleeperRequestError,
  V1_LEAGUE_ID,
  V1_LEAGUE_NAME,
  createFixtureClient,
  fixturePlayers,
  v1FixtureLeague,
  v1FixtureMatchups,
  v1FixtureRosters,
  v1FixtureState,
  v1FixtureUsers,
  type SleeperClient,
  type SleeperLeague,
  type SleeperLeagueUser,
  type SleeperMatchup,
  type SleeperRoster,
  type SleeperUser,
} from "@cutman/sleeper";
import { describe, expect, it } from "vitest";
import { getDashboardOrNull } from "../app/lib/dashboard.ts";
import {
  createMemoryExplorerOriginQuota,
  explorerOriginQuotaHourKey,
  type ExplorerOriginQuotaRow,
} from "../app/lib/explorer-origin-quota.server.ts";
import {
  BOARD_TTL_MS,
  ORIGIN_QUOTA_PER_HOUR,
  USER_TTL_MS,
  createMemoryExplorerCache,
  explorerDepsFromEnv,
  lookupExplorerBoard,
  lookupExplorerUser,
  resolveExplorerUserLeagues,
  type ExplorerCache,
  type ExplorerDeps,
  type ExplorerUserLeaguesDecision,
  type ExplorerUserLeaguesDecisionInput,
} from "../app/lib/sleeper-explorer.server.ts";
import {
  assembleExplorerBoard,
  assembleRosters,
  assembleScoreboard,
  assembleStandings,
  describeExplorerError,
  isRealPlayerId,
  isValidExplorerLeagueId,
  isValidExplorerUsername,
  parseExplorerUsernameForm,
  sleeperAvatarUrl,
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
    originQuota: overrides.originQuota ?? createMemoryExplorerOriginQuota(),
  };
}

const HOUR_MS = 60 * 60 * 1000;
const FIXED_NOW = 1_700_000_000_000;

function makeQuota(store = new Map<string, ExplorerOriginQuotaRow>()) {
  return {
    store,
    originQuota: createMemoryExplorerOriginQuota(store),
    used(clerkUserId: string, now: number): number {
      const row = store.get(clerkUserId);
      if (!row || row.hourKey !== explorerOriginQuotaHourKey(now)) return 0;
      return row.used;
    },
    seed(clerkUserId: string, now: number, used: number): void {
      store.set(clerkUserId, { hourKey: explorerOriginQuotaHourKey(now), used });
    },
  };
}

function cacheRejectingGets(base: ExplorerCache, reject: (key: string) => boolean): ExplorerCache {
  return {
    async getJson(key) {
      if (reject(key)) throw new Error("explorer cache get failed");
      return base.getJson(key);
    },
    putJson(key, value, options) {
      return base.putJson(key, value, options);
    },
  };
}

async function seedFreshNflState(cache: ExplorerCache, now: number): Promise<void> {
  await cache.putJson("explore:nfl-state", { fetchedAt: now, payload: v1FixtureState });
}

const HANDLE_SWAP_USERNAME = "handle_swap";
const HANDLE_SWAP_USER_A: SleeperUser = {
  user_id: "user-a",
  username: HANDLE_SWAP_USERNAME,
  display_name: "User A",
};
const HANDLE_SWAP_USER_B: SleeperUser = {
  user_id: "user-b",
  username: HANDLE_SWAP_USERNAME,
  display_name: "User B",
};
const HANDLE_SWAP_LEAGUES_A: SleeperLeague[] = [
  { league_id: "100", name: "League A", season: v1FixtureState.league_season, sport: "nfl" },
];
const HANDLE_SWAP_LEAGUES_B: SleeperLeague[] = [
  { league_id: "200", name: "League B", season: v1FixtureState.league_season, sport: "nfl" },
];

function leaguesCacheKey(userId: string, season = v1FixtureState.league_season): string {
  return `explore:leagues:${userId}:${season}`;
}

async function seedStaleUserFreshLeagues(
  cache: ExplorerCache,
  now: number,
  user: SleeperUser,
  leagues: SleeperLeague[],
): Promise<void> {
  await cache.putJson(`explore:user:${user.username}`, {
    fetchedAt: now - USER_TTL_MS - 1,
    payload: user,
  });
  await cache.putJson(leaguesCacheKey(user.user_id), {
    fetchedAt: now,
    payload: leagues,
  });
}

function leaguesCacheRead(payload: SleeperLeague[], fresh: boolean) {
  return { payload, fetchedAt: FIXED_NOW, fresh };
}

describe("resolveExplorerUserLeagues", () => {
  const cases: Array<{
    name: string;
    input: ExplorerUserLeaguesDecisionInput;
    expected: ExplorerUserLeaguesDecision;
  }> = [
    {
      name: "reuses a fresh same-user leagues cache without an extra quota charge",
      input: {
        user: HANDLE_SWAP_USER_A,
        cachedUserId: HANDLE_SWAP_USER_A.user_id,
        leagues: undefined,
        leaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_A, true),
        leaguesCachedUserId: HANDLE_SWAP_USER_A.user_id,
        resolvedUserLeaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_A, true),
        expectLeaguesOrigin: false,
      },
      expected: {
        leagues: HANDLE_SWAP_LEAGUES_A,
        leaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_A, true),
        leaguesCachedUserId: HANDLE_SWAP_USER_A.user_id,
        needsExtraQuota: false,
        denyStaleFallback: false,
      },
    },
    {
      name: "remaps a stale username to a new id and charges extra when that cache is not fresh",
      input: {
        user: HANDLE_SWAP_USER_B,
        cachedUserId: HANDLE_SWAP_USER_A.user_id,
        leagues: undefined,
        leaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_A, true),
        leaguesCachedUserId: HANDLE_SWAP_USER_A.user_id,
        resolvedUserLeaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_B, false),
        expectLeaguesOrigin: false,
      },
      expected: {
        leagues: undefined,
        leaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_B, false),
        leaguesCachedUserId: HANDLE_SWAP_USER_B.user_id,
        needsExtraQuota: true,
        denyStaleFallback: true,
      },
    },
    {
      name: "remaps a stale username onto a fresh cache for the new user id",
      input: {
        user: HANDLE_SWAP_USER_B,
        cachedUserId: HANDLE_SWAP_USER_A.user_id,
        leagues: undefined,
        leaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_A, true),
        leaguesCachedUserId: HANDLE_SWAP_USER_A.user_id,
        resolvedUserLeaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_B, true),
        expectLeaguesOrigin: false,
      },
      expected: {
        leagues: HANDLE_SWAP_LEAGUES_B,
        leaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_B, true),
        leaguesCachedUserId: HANDLE_SWAP_USER_B.user_id,
        needsExtraQuota: false,
        denyStaleFallback: true,
      },
    },
    {
      name: "loads leagues for a newly resolved user id without an extra quota charge",
      input: {
        user: HANDLE_SWAP_USER_A,
        cachedUserId: undefined,
        leagues: undefined,
        leaguesCached: null,
        leaguesCachedUserId: undefined,
        resolvedUserLeaguesCached: null,
        expectLeaguesOrigin: true,
      },
      expected: {
        leagues: undefined,
        leaguesCached: null,
        leaguesCachedUserId: HANDLE_SWAP_USER_A.user_id,
        needsExtraQuota: false,
        denyStaleFallback: false,
      },
    },
    {
      name: "allows stale fallback for the same user when extra quota is not needed",
      input: {
        user: HANDLE_SWAP_USER_A,
        cachedUserId: HANDLE_SWAP_USER_A.user_id,
        leagues: undefined,
        leaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_A, false),
        leaguesCachedUserId: HANDLE_SWAP_USER_A.user_id,
        resolvedUserLeaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_A, false),
        expectLeaguesOrigin: true,
      },
      expected: {
        leagues: undefined,
        leaguesCached: leaguesCacheRead(HANDLE_SWAP_LEAGUES_A, false),
        leaguesCachedUserId: HANDLE_SWAP_USER_A.user_id,
        needsExtraQuota: false,
        denyStaleFallback: false,
      },
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(resolveExplorerUserLeagues(input)).toEqual(expected);
    });
  }
});

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

describe("parseExplorerUsernameForm", () => {
  it("returns the submitted raw username with the invalid_username error", () => {
    const submittedUsername = "  Bad User/<script>  ";
    const result = parseExplorerUsernameForm(submittedUsername);
    expect(result).toEqual({
      ok: false,
      error: describeExplorerError("invalid_username"),
      submittedUsername,
    });
    if (result.ok) throw new Error("expected invalid username");
    expect(result.error).not.toContain(submittedUsername);
    expect(result).not.toHaveProperty("leagueId");
    expect(result).not.toHaveProperty("sleeperLeagueId");
  });

  it("normalizes a valid handle for lookup and omits submittedUsername", () => {
    expect(parseExplorerUsernameForm("  JCAdenag  ")).toEqual({
      ok: true,
      username: "jcadenag",
    });
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

describe("sleeperAvatarUrl", () => {
  it("returns null when the avatar identifier is missing", () => {
    expect(sleeperAvatarUrl(null)).toBeNull();
    expect(sleeperAvatarUrl(undefined)).toBeNull();
    expect(sleeperAvatarUrl("")).toBeNull();
  });

  it("keeps an ordinary identifier in the thumbs URL unchanged", () => {
    expect(sleeperAvatarUrl("abc123def")).toBe("https://sleepercdn.com/avatars/thumbs/abc123def");
  });

  it("percent-encodes slash, spaces, and query/hash characters before interpolation", () => {
    expect(sleeperAvatarUrl("ab/cd")).toBe("https://sleepercdn.com/avatars/thumbs/ab%2Fcd");
    expect(sleeperAvatarUrl("ab cd")).toBe("https://sleepercdn.com/avatars/thumbs/ab%20cd");
    expect(sleeperAvatarUrl("id?x=1#frag")).toBe("https://sleepercdn.com/avatars/thumbs/id%3Fx%3D1%23frag");
  });
});

describe("isRealPlayerId", () => {
  it("rejects null, undefined, empty string, and Sleeper placeholder 0", () => {
    expect(isRealPlayerId(null)).toBe(false);
    expect(isRealPlayerId(undefined)).toBe(false);
    expect(isRealPlayerId("")).toBe(false);
    expect(isRealPlayerId("0")).toBe(false);
  });

  it("keeps legitimate Sleeper player and defense ids", () => {
    expect(isRealPlayerId("4046")).toBe(true);
    expect(isRealPlayerId("PHI")).toBe(true);
    expect(isRealPlayerId("10")).toBe(true);
  });
});

describe("assembleStandings / assembleScoreboard / assembleRosters", () => {
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

  it("ranks 5-0-2 above 5-1-0 because each tie is half a win", () => {
    const users: SleeperLeagueUser[] = [
      { user_id: "u-a", username: "a", display_name: "Alex", metadata: { team_name: "Tied twice" } },
      { user_id: "u-b", username: "b", display_name: "Mina", metadata: { team_name: "One loss" } },
    ];
    const rosters: SleeperRoster[] = [
      { roster_id: 1, owner_id: "u-b", settings: { wins: 5, losses: 1, ties: 0, fpts: 900 } },
      { roster_id: 2, owner_id: "u-a", settings: { wins: 5, losses: 0, ties: 2, fpts: 100 } },
    ];
    const standings = assembleStandings(rosters, users);
    expect(standings.map((row) => row.rosterId)).toEqual([2, 1]);
    expect(standings[0]).toMatchObject({
      teamName: "Tied twice",
      wins: 5,
      losses: 0,
      ties: 2,
      pointsFor: 100,
    });
    expect(standings[1]).toMatchObject({
      teamName: "One loss",
      wins: 5,
      losses: 1,
      ties: 0,
      pointsFor: 900,
    });
  });

  it("breaks equal record-score with pointsFor, then rosterId", () => {
    const users: SleeperLeagueUser[] = [];
    const rosters: SleeperRoster[] = [
      { roster_id: 3, owner_id: null, settings: { wins: 4, losses: 1, ties: 2, fpts: 200 } },
      { roster_id: 1, owner_id: null, settings: { wins: 5, losses: 2, ties: 0, fpts: 200 } },
      { roster_id: 2, owner_id: null, settings: { wins: 5, losses: 2, ties: 0, fpts: 300 } },
    ];
    const standings = assembleStandings(rosters, users);
    expect(standings.map((row) => row.rosterId)).toEqual([2, 1, 3]);
    expect(standings.map((row) => ({ wins: row.wins, ties: row.ties, pointsFor: row.pointsFor }))).toEqual([
      { wins: 5, ties: 0, pointsFor: 300 },
      { wins: 5, ties: 0, pointsFor: 200 },
      { wins: 4, ties: 2, pointsFor: 200 },
    ]);
  });

  it("adds fpts_decimal at hundredths and sorts by the precise pointsFor", () => {
    const users: SleeperLeagueUser[] = [];
    const rosters: SleeperRoster[] = [
      { roster_id: 2, owner_id: null, settings: { wins: 3, fpts: 100 } },
      { roster_id: 1, owner_id: null, settings: { wins: 3, fpts: 100, fpts_decimal: 45 } },
      { roster_id: 3, owner_id: null, settings: { wins: 3, fpts: 100, fpts_decimal: 0 } },
      { roster_id: 4, owner_id: null, settings: { wins: 3 } },
      { roster_id: 5, owner_id: null, settings: { wins: 3, fpts: -5, fpts_decimal: -67 } },
    ];
    const standings = assembleStandings(rosters, users);
    expect(standings.map((row) => ({ rosterId: row.rosterId, pointsFor: row.pointsFor }))).toEqual([
      { rosterId: 1, pointsFor: 100 + 45 / 100 },
      { rosterId: 2, pointsFor: 100 },
      { rosterId: 3, pointsFor: 100 },
      { rosterId: 4, pointsFor: 0 },
      { rosterId: 5, pointsFor: -5 + -67 / 100 },
    ]);
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

  it("keeps null and undefined matchup_id byes as separate single-side rosters", () => {
    const users: SleeperLeagueUser[] = [
      { user_id: "u-a", username: "a", display_name: "Alex", metadata: { team_name: "A" } },
      { user_id: "u-b", username: "b", display_name: "Mina", metadata: { team_name: "B" } },
      { user_id: "u-c", username: "c", display_name: "Devin", metadata: { team_name: "C" } },
      { user_id: "u-d", username: "d", display_name: "Riley", metadata: { team_name: "D" } },
      { user_id: "u-e", username: "e", display_name: "Sam", metadata: { team_name: "E" } },
      { user_id: "u-f", username: "f", display_name: "Jules", metadata: { team_name: "F" } },
    ];
    const rosters: SleeperRoster[] = [
      { roster_id: 1, owner_id: "u-a" },
      { roster_id: 2, owner_id: "u-b" },
      { roster_id: 3, owner_id: "u-c" },
      { roster_id: 4, owner_id: "u-d" },
      { roster_id: 5, owner_id: "u-e" },
      { roster_id: 6, owner_id: "u-f" },
    ];
    const matchups: SleeperMatchup[] = [
      { roster_id: 1, matchup_id: 1, points: 10, starters: ["4046"] },
      { roster_id: 2, matchup_id: 1, points: 8, starters: ["4881"] },
      { roster_id: 3, matchup_id: null, points: 12, starters: ["5849"] },
      { roster_id: 4, matchup_id: null, points: 9, starters: ["4988"] },
      { roster_id: 5, matchup_id: undefined, points: 7, starters: ["6794"] } as unknown as SleeperMatchup,
      { roster_id: 6, matchup_id: undefined, points: 5, starters: ["4035"] } as unknown as SleeperMatchup,
    ];
    const games = assembleScoreboard(rosters, users, matchups, fixturePlayers);
    expect(games).toHaveLength(5);
    expect(games[0]?.matchupId).toBe(1);
    expect(games[0]?.sides.map((side) => side.teamName)).toEqual(["A", "B"]);
    const byes = games.slice(1);
    expect(byes.every((game) => game.matchupId === null)).toBe(true);
    expect(byes.map((game) => game.sides.map((side) => side.rosterId))).toEqual([[3], [4], [5], [6]]);
  });

  it("skips Sleeper empty-slot sentinel 0 without shifting later roster positions", () => {
    const users: SleeperLeagueUser[] = [
      { user_id: "u-a", username: "a", display_name: "Alex", metadata: { team_name: "A" } },
    ];
    const rosters: SleeperRoster[] = [{ roster_id: 1, owner_id: "u-a" }];
    const matchups: SleeperMatchup[] = [
      { roster_id: 1, matchup_id: 1, points: 10, starters: ["4046", "0", "4881"] },
    ];
    const games = assembleScoreboard(rosters, users, matchups, fixturePlayers, ["QB", "RB", "WR"]);
    const starters = games[0]?.sides[0]?.starters ?? [];
    expect(starters.map((player) => player.playerId)).toEqual(["4046", "4881"]);
    expect(starters[1]).toMatchObject({ playerId: "4881", position: "WR" });
  });

  it("never renders placeholder 0, empty, or null ids in starters, bench, or reserve", () => {
    const users: SleeperLeagueUser[] = [
      { user_id: "u-a", username: "a", display_name: "Alex", metadata: { team_name: "A" } },
    ];
    const placeholderIds = ["0", "", null, undefined] as unknown as string[];
    const rosters: SleeperRoster[] = [
      {
        roster_id: 1,
        owner_id: "u-a",
        starters: ["4046", ...placeholderIds, "4881"],
        reserve: [...placeholderIds, "4984"],
        players: ["4046", ...placeholderIds, "4881", "4984", "6794", "PHI"],
      },
    ];
    const views = assembleRosters(rosters, users, [], fixturePlayers, ["QB", "RB", "WR"]);
    const roster = views[0];
    expect(roster).toBeDefined();
    const groups = {
      starters: roster?.starters.map((player) => player.playerId) ?? [],
      bench: roster?.bench.map((player) => player.playerId) ?? [],
      reserve: roster?.reserve.map((player) => player.playerId) ?? [],
    };
    for (const ids of Object.values(groups)) {
      expect(ids).not.toContain("0");
      expect(ids).not.toContain("");
      expect(ids).not.toContain(null);
      expect(ids).not.toContain(undefined);
    }
    expect(groups.starters).toEqual(["4046", "4881"]);
    expect(groups.reserve).toEqual(["4984"]);
    expect(groups.bench).toEqual(["6794", "PHI"]);
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
    const deps = makeDeps({ quotaPerHour: 2 });
    const first = await lookupExplorerUser(deps, { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: "clerk_1" });
    expect(first.kind).toBe("ok");
    const second = await lookupExplorerUser(deps, { username: "mina", clerkUserId: "clerk_1" });
    expect(second.kind).toBe("quota_exceeded");
  });

  it("returns quota_exceeded for a stale negative user cache when origin quota is spent", async () => {
    const cache = createMemoryExplorerCache();
    const { originQuota } = makeQuota();
    const now = 1_700_000_000_000;
    const staleAt = now - USER_TTL_MS - 1;
    const miss = await lookupExplorerUser(makeDeps({ cache, originQuota, now: () => staleAt }), {
      username: "nobody_here",
      clerkUserId: "clerk_1",
    });
    expect(miss).toEqual({ kind: "not_found", username: "nobody_here" });

    const first = await lookupExplorerUser(makeDeps({ cache, originQuota, now: () => now, quotaPerHour: 2 }), {
      username: EXAMPLE_SLEEPER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(first.kind).toBe("ok");

    const { client, calls } = countingClient();
    const stale = await lookupExplorerUser(
      makeDeps({ sleeper: client, cache, originQuota, now: () => now, quotaPerHour: 2 }),
      { username: "nobody_here", clerkUserId: "clerk_1" },
    );
    expect(stale).toEqual({ kind: "quota_exceeded" });
    expect(calls.getUser).toBe(0);
  });

  const FAKE_EXPLORER_USERNAME = "ghost_user";
  const FAKE_EXPLORER_USER_ID = "0000000000000000099";
  const malformedUserCacheEntries = [
    { name: "missing fetchedAt", entry: { payload: null } },
    { name: "non-finite fetchedAt", entry: { fetchedAt: Number.NaN, payload: null } },
    { name: "undefined payload", entry: { fetchedAt: FIXED_NOW, payload: undefined } },
  ];

  it.each(malformedUserCacheEntries)(
    "treats a user cache with $name as a miss and continues to origin",
    async ({ entry }) => {
      const cache = createMemoryExplorerCache();
      await seedFreshNflState(cache, FIXED_NOW);
      await cache.putJson(`explore:user:${FAKE_EXPLORER_USERNAME}`, entry);
      const { client, calls } = countingClient();
      const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache, now: () => FIXED_NOW }), {
        username: FAKE_EXPLORER_USERNAME,
        clerkUserId: "clerk_1",
      });
      expect(result).toEqual({ kind: "not_found", username: FAKE_EXPLORER_USERNAME });
      expect(calls.getUser).toBe(1);
      expect(calls.getUserLeagues).toBe(0);
    },
  );

  it.each(malformedUserCacheEntries)(
    "treats a user cache with $name as a miss and returns quota_exceeded when origin quota is spent",
    async ({ entry }) => {
      const { originQuota, seed, used } = makeQuota();
      seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR);
      const cache = createMemoryExplorerCache();
      await seedFreshNflState(cache, FIXED_NOW);
      await cache.putJson(`explore:user:${FAKE_EXPLORER_USERNAME}`, entry);
      const { client, calls } = countingClient();
      const result = await lookupExplorerUser(
        makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
        { username: FAKE_EXPLORER_USERNAME, clerkUserId: "clerk_1" },
      );
      expect(result).toEqual({ kind: "quota_exceeded" });
      expect(calls.getUser).toBe(0);
      expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
    },
  );

  it("serves a fresh user cache with payload null as not_found without calling origin", async () => {
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    await cache.putJson(`explore:user:${FAKE_EXPLORER_USERNAME}`, {
      fetchedAt: FIXED_NOW,
      payload: null,
    });
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache, now: () => FIXED_NOW }), {
      username: FAKE_EXPLORER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "not_found", username: FAKE_EXPLORER_USERNAME });
    expect(calls.getUser).toBe(0);
    expect(calls.getUserLeagues).toBe(0);
  });

  it("treats a malformed leagues envelope as a miss and does not throw on stale fallback", async () => {
    const { originQuota, seed } = makeQuota();
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR);
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    await cache.putJson(`explore:user:${FAKE_EXPLORER_USERNAME}`, {
      fetchedAt: FIXED_NOW - USER_TTL_MS - 1,
      payload: {
        user_id: FAKE_EXPLORER_USER_ID,
        username: FAKE_EXPLORER_USERNAME,
        display_name: "Ghost",
      },
    });
    await cache.putJson(leaguesCacheKey(FAKE_EXPLORER_USER_ID), {
      fetchedAt: FIXED_NOW,
      payload: undefined,
    });
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(
      makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
      { username: FAKE_EXPLORER_USERNAME, clerkUserId: "clerk_1" },
    );
    expect(result).toEqual({ kind: "quota_exceeded" });
    expect(calls.getUser).toBe(0);
    expect(calls.getUserLeagues).toBe(0);
  });

  it("treats invalid JSON in the user cache as a miss and continues to origin", async () => {
    const store = new Map<string, string>();
    const cache = createMemoryExplorerCache(store);
    store.set(`explore:user:${EXAMPLE_SLEEPER_USERNAME}`, "{not-json");
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache }), {
      username: EXAMPLE_SLEEPER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    expect(calls.getUser).toBe(1);
    expect(calls.getUserLeagues).toBe(1);
  });

  it("treats a rejected user cache get as a miss and continues to origin", async () => {
    const cache = cacheRejectingGets(createMemoryExplorerCache(), (key) => key.startsWith("explore:user:"));
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache }), {
      username: EXAMPLE_SLEEPER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    expect(calls.getUser).toBe(1);
  });

  it("ignores leftover explore:quota KV entries once originQuota is spent", async () => {
    const { originQuota, seed, used } = makeQuota();
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR);
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    await cache.putJson(`explore:quota:clerk_1:${Math.floor(FIXED_NOW / HOUR_MS)}`, { count: 0 });
    const result = await lookupExplorerUser(makeDeps({ cache, originQuota, now: () => FIXED_NOW }), {
      username: EXAMPLE_SLEEPER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "quota_exceeded" });
    expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
  });

  it("charges two origin calls for a cold user and leagues lookup", async () => {
    const { originQuota, used } = makeQuota();
    const cache = createMemoryExplorerCache();
    const result = await lookupExplorerUser(makeDeps({ cache, originQuota, now: () => FIXED_NOW }), {
      username: EXAMPLE_SLEEPER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    expect(used("clerk_1", FIXED_NOW)).toBe(2);
  });

  it("charges only the leagues fetch when the user cache is already fresh", async () => {
    const { originQuota, used } = makeQuota();
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    await cache.putJson(`explore:user:${EXAMPLE_SLEEPER_USERNAME}`, {
      fetchedAt: FIXED_NOW,
      payload: {
        user_id: EXAMPLE_SLEEPER_USER_ID,
        username: EXAMPLE_SLEEPER_USERNAME,
        display_name: EXAMPLE_SLEEPER_USERNAME,
      },
    });
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(
      makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
      {
        username: EXAMPLE_SLEEPER_USERNAME,
        clerkUserId: "clerk_1",
      },
    );
    expect(result.kind).toBe("ok");
    expect(calls.getUser).toBe(0);
    expect(calls.getUserLeagues).toBe(1);
    expect(used("clerk_1", FIXED_NOW)).toBe(1);
  });

  it("rejects a user lookup before origin when remaining quota is below the planned charge", async () => {
    const { originQuota, used } = makeQuota();
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(
      makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW, quotaPerHour: 1 }),
      { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: "clerk_1" },
    );
    expect(result).toEqual({ kind: "quota_exceeded" });
    expect(calls.getNflState).toBe(0);
    expect(calls.getUser).toBe(0);
    expect(calls.getUserLeagues).toBe(0);
    expect(used("clerk_1", FIXED_NOW)).toBe(0);
  });

  it("succeeds a user lookup when remaining quota exactly matches the planned charge", async () => {
    const { originQuota, seed, used } = makeQuota();
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR - 2);
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    const { client, calls } = countingClient();
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }), {
      username: EXAMPLE_SLEEPER_USERNAME,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    expect(calls.getUser).toBe(1);
    expect(calls.getUserLeagues).toBe(1);
    expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
  });

  it("returns rate_limited when a stale negative user cache meets a 429", async () => {
    const cache = createMemoryExplorerCache();
    let now = 1_700_000_000_000;
    const first = await lookupExplorerUser(makeDeps({ cache, now: () => now }), {
      username: "nobody_here",
      clerkUserId: "clerk_1",
    });
    expect(first).toEqual({ kind: "not_found", username: "nobody_here" });

    now += USER_TTL_MS + 1;
    const sleeper = createFixtureClient();
    const blocked: SleeperClient = {
      ...sleeper,
      async getUser() {
        throw new SleeperRequestError("/user/nobody_here", 429);
      },
    };
    const { client, calls } = countingClient(blocked);
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache, now: () => now }), {
      username: "nobody_here",
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "rate_limited" });
    expect(calls.getUser).toBe(1);
  });

  it("returns unavailable when a stale negative user cache meets an origin failure", async () => {
    const cache = createMemoryExplorerCache();
    let now = 1_700_000_000_000;
    const first = await lookupExplorerUser(makeDeps({ cache, now: () => now }), {
      username: "nobody_here",
      clerkUserId: "clerk_1",
    });
    expect(first).toEqual({ kind: "not_found", username: "nobody_here" });

    now += USER_TTL_MS + 1;
    const sleeper = createFixtureClient();
    const blocked: SleeperClient = {
      ...sleeper,
      async getUser() {
        throw new Error("origin down");
      },
    };
    const { client, calls } = countingClient(blocked);
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache, now: () => now }), {
      username: "nobody_here",
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "unavailable" });
    expect(calls.getUser).toBe(1);
  });

  it("refetches leagues for user B when a stale username cache for A remaps, and leaves A's id-keyed leagues intact", async () => {
    const now = 1_700_000_000_000;
    const cache = createMemoryExplorerCache();
    await seedStaleUserFreshLeagues(cache, now, HANDLE_SWAP_USER_A, HANDLE_SWAP_LEAGUES_A);

    const requestedLeagueUserIds: string[] = [];
    const base = createFixtureClient();
    const remapped: SleeperClient = {
      ...base,
      async getUser(usernameOrId) {
        if (usernameOrId === HANDLE_SWAP_USERNAME) return HANDLE_SWAP_USER_B;
        return base.getUser(usernameOrId);
      },
      async getUserLeagues(userId, season) {
        requestedLeagueUserIds.push(userId);
        if (userId === HANDLE_SWAP_USER_B.user_id) return HANDLE_SWAP_LEAGUES_B;
        if (userId === HANDLE_SWAP_USER_A.user_id) return HANDLE_SWAP_LEAGUES_A;
        return base.getUserLeagues(userId, season);
      },
    };
    const { client, calls } = countingClient(remapped);
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache, now: () => now }), {
      username: HANDLE_SWAP_USERNAME,
      clerkUserId: "clerk_1",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.user.userId).toBe(HANDLE_SWAP_USER_B.user_id);
    expect(result.leagues.map((league) => league.sleeperLeagueId)).toEqual(["200"]);
    expect(result.leagues.map((league) => league.sleeperLeagueId)).not.toContain("100");
    expect(calls.getUser).toBe(1);
    expect(calls.getUserLeagues).toBe(1);
    expect(requestedLeagueUserIds).toEqual([HANDLE_SWAP_USER_B.user_id]);

    expect(await cache.getJson(leaguesCacheKey(HANDLE_SWAP_USER_A.user_id))).toMatchObject({
      payload: HANDLE_SWAP_LEAGUES_A,
    });
    expect(await cache.getJson(leaguesCacheKey(HANDLE_SWAP_USER_B.user_id))).toMatchObject({
      payload: HANDLE_SWAP_LEAGUES_B,
    });
    expect(await cache.getJson(`explore:user:${HANDLE_SWAP_USERNAME}`)).toMatchObject({
      payload: HANDLE_SWAP_USER_B,
    });
  });

  it("reuses fresh leagues when a stale username still resolves to the same user id", async () => {
    const now = 1_700_000_000_000;
    const cache = createMemoryExplorerCache();
    await seedStaleUserFreshLeagues(cache, now, HANDLE_SWAP_USER_A, HANDLE_SWAP_LEAGUES_A);

    const base = createFixtureClient();
    const sameUser: SleeperClient = {
      ...base,
      async getUser(usernameOrId) {
        if (usernameOrId === HANDLE_SWAP_USERNAME) return HANDLE_SWAP_USER_A;
        return base.getUser(usernameOrId);
      },
      async getUserLeagues(userId, season) {
        if (userId === HANDLE_SWAP_USER_A.user_id) return HANDLE_SWAP_LEAGUES_A;
        return base.getUserLeagues(userId, season);
      },
    };
    const { client, calls } = countingClient(sameUser);
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache, now: () => now }), {
      username: HANDLE_SWAP_USERNAME,
      clerkUserId: "clerk_1",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.user.userId).toBe(HANDLE_SWAP_USER_A.user_id);
    expect(result.leagues.map((league) => league.sleeperLeagueId)).toEqual(["100"]);
    expect(calls.getUser).toBe(1);
    expect(calls.getUserLeagues).toBe(0);
  });

  it("does not fall back to user A's leagues when fetching user B's leagues fails", async () => {
    const now = 1_700_000_000_000;
    const cache = createMemoryExplorerCache();
    await seedStaleUserFreshLeagues(cache, now, HANDLE_SWAP_USER_A, HANDLE_SWAP_LEAGUES_A);

    const requestedLeagueUserIds: string[] = [];
    const base = createFixtureClient();
    const remapped: SleeperClient = {
      ...base,
      async getUser(usernameOrId) {
        if (usernameOrId === HANDLE_SWAP_USERNAME) return HANDLE_SWAP_USER_B;
        return base.getUser(usernameOrId);
      },
      async getUserLeagues(userId, season) {
        requestedLeagueUserIds.push(userId);
        if (userId === HANDLE_SWAP_USER_B.user_id) {
          throw new SleeperRequestError("/user/user-b/leagues", 429);
        }
        return base.getUserLeagues(userId, season);
      },
    };
    const { client, calls } = countingClient(remapped);
    const result = await lookupExplorerUser(makeDeps({ sleeper: client, cache, now: () => now }), {
      username: HANDLE_SWAP_USERNAME,
      clerkUserId: "clerk_1",
    });

    expect(result).toEqual({ kind: "rate_limited" });
    expect(calls.getUser).toBe(1);
    expect(calls.getUserLeagues).toBe(1);
    expect(requestedLeagueUserIds).toEqual([HANDLE_SWAP_USER_B.user_id]);
    expect(await cache.getJson(leaguesCacheKey(HANDLE_SWAP_USER_A.user_id))).toMatchObject({
      payload: HANDLE_SWAP_LEAGUES_A,
    });
    expect(await cache.getJson(leaguesCacheKey(HANDLE_SWAP_USER_B.user_id))).toBeNull();
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

  it("treats invalid JSON in the board cache as a miss and continues to origin", async () => {
    const store = new Map<string, string>();
    const cache = createMemoryExplorerCache(store);
    await seedFreshNflState(cache, FIXED_NOW);
    store.set(`explore:board:${V1_LEAGUE_ID}:1`, "{not-json");
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(makeDeps({ sleeper: client, cache, now: () => FIXED_NOW }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    expect(calls.getLeague).toBe(1);
    expect(calls.getLeagueUsers).toBe(1);
    expect(calls.getRosters).toBe(1);
    expect(calls.getMatchups).toBe(1);
  });

  it("treats a rejected board cache get as a miss and continues to origin", async () => {
    const cache = cacheRejectingGets(createMemoryExplorerCache(), (key) => key.startsWith("explore:board:"));
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(makeDeps({ sleeper: client, cache }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    expect(calls.getLeague).toBe(1);
  });

  it("ignores leftover explore:quota KV entries on a board lookup once originQuota is spent", async () => {
    const { originQuota, seed, used } = makeQuota();
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR);
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    await cache.putJson(`explore:quota:clerk_1:${Math.floor(FIXED_NOW / HOUR_MS)}`, { count: 0 });
    const result = await lookupExplorerBoard(makeDeps({ cache, originQuota, now: () => FIXED_NOW }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "quota_exceeded" });
    expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
  });

  it("consumes 5 quota on a board cache miss", async () => {
    const { originQuota, used } = makeQuota();
    const cache = createMemoryExplorerCache();
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(
      makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
      {
        sleeperLeagueId: V1_LEAGUE_ID,
        clerkUserId: "clerk_1",
      },
    );
    expect(result.kind).toBe("ok");
    expect(calls.getLeague).toBe(1);
    expect(calls.getLeagueUsers).toBe(1);
    expect(calls.getRosters).toBe(1);
    expect(calls.getMatchups).toBe(1);
    expect(calls.getPlayers).toBe(1);
    expect(used("clerk_1", FIXED_NOW)).toBe(5);
  });

  it("rejects a board miss before any origin call when remaining quota is below 5", async () => {
    const { originQuota, seed, used } = makeQuota();
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR - 4);
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(result).toEqual({ kind: "quota_exceeded" });
    expect(calls.getNflState).toBe(0);
    expect(calls.getLeague).toBe(0);
    expect(calls.getLeagueUsers).toBe(0);
    expect(calls.getRosters).toBe(0);
    expect(calls.getMatchups).toBe(0);
    expect(calls.getPlayers).toBe(0);
    expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR - 4);
  });

  it("succeeds a board miss when remaining quota is exactly 5", async () => {
    const { originQuota, seed, used } = makeQuota();
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR - 5);
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(result.kind).toBe("ok");
    expect(calls.getLeague).toBe(1);
    expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
  });

  it("does not charge quota for a cached board", async () => {
    const { originQuota, used } = makeQuota();
    const cache = createMemoryExplorerCache();
    const { client, calls } = countingClient();
    const first = await lookupExplorerBoard(makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(first.kind).toBe("ok");
    expect(used("clerk_1", FIXED_NOW)).toBe(5);

    const second = await lookupExplorerBoard(
      makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
      {
        sleeperLeagueId: V1_LEAGUE_ID,
        clerkUserId: "clerk_1",
      },
    );
    expect(second.kind).toBe("ok");
    expect(calls.getLeague).toBe(1);
    expect(calls.getLeagueUsers).toBe(1);
    expect(calls.getRosters).toBe(1);
    expect(calls.getMatchups).toBe(1);
    expect(used("clerk_1", FIXED_NOW)).toBe(5);
  });

  it("serves a cached board when the hour quota is already spent", async () => {
    const { originQuota, seed, used } = makeQuota();
    const cache = createMemoryExplorerCache();
    const first = await lookupExplorerBoard(makeDeps({ cache, originQuota, now: () => FIXED_NOW }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: "clerk_1",
    });
    expect(first.kind).toBe("ok");
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR);
    const { client, calls } = countingClient();
    const second = await lookupExplorerBoard(
      makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
      {
        sleeperLeagueId: V1_LEAGUE_ID,
        clerkUserId: "clerk_1",
      },
    );
    expect(second.kind).toBe("ok");
    expect(calls.getLeague).toBe(0);
    expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
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

  const FAKE_BOARD_LEAGUE_ID = "1";
  const fakeCachedLeague: SleeperLeague = {
    league_id: FAKE_BOARD_LEAGUE_ID,
    name: "Cached Fake League",
    season: "2026",
    sport: "nfl",
  };

  const malformedBoardCacheEntries = [
    { name: "missing fetchedAt", entry: { payload: { league: fakeCachedLeague } } },
    { name: "non-finite fetchedAt", entry: { fetchedAt: Number.NaN, payload: { league: fakeCachedLeague } } },
    { name: "undefined payload", entry: { fetchedAt: FIXED_NOW, payload: undefined } },
  ];

  it.each(malformedBoardCacheEntries)(
    "treats a board cache with $name as a miss and continues to origin",
    async ({ entry }) => {
      const cache = createMemoryExplorerCache();
      await seedFreshNflState(cache, FIXED_NOW);
      await cache.putJson(`explore:board:${FAKE_BOARD_LEAGUE_ID}:1`, entry);
      const { client, calls } = countingClient();
      const result = await lookupExplorerBoard(
        makeDeps({ sleeper: client, cache, now: () => FIXED_NOW }),
        { sleeperLeagueId: FAKE_BOARD_LEAGUE_ID, clerkUserId: "clerk_1" },
      );
      expect(result).toEqual({ kind: "not_found" });
      expect(calls.getLeague).toBe(1);
      expect(calls.getLeagueUsers).toBe(0);
      expect(calls.getRosters).toBe(0);
      expect(calls.getMatchups).toBe(0);
    },
  );

  it.each(malformedBoardCacheEntries)(
    "treats a board cache with $name as a miss and returns quota_exceeded when origin quota is spent",
    async ({ entry }) => {
      const { originQuota, seed, used } = makeQuota();
      seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR);
      const cache = createMemoryExplorerCache();
      await seedFreshNflState(cache, FIXED_NOW);
      await cache.putJson(`explore:board:${FAKE_BOARD_LEAGUE_ID}:1`, entry);
      const { client, calls } = countingClient();
      const result = await lookupExplorerBoard(
        makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
        { sleeperLeagueId: FAKE_BOARD_LEAGUE_ID, clerkUserId: "clerk_1" },
      );
      expect(result).toEqual({ kind: "quota_exceeded" });
      expect(calls.getLeague).toBe(0);
      expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
    },
  );

  it("returns not_found for a fresh cache with payload without league instead of throwing", async () => {
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    await cache.putJson(`explore:board:${FAKE_BOARD_LEAGUE_ID}:1`, {
      fetchedAt: FIXED_NOW,
      payload: {},
    });
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(
      makeDeps({ sleeper: client, cache, now: () => FIXED_NOW }),
      { sleeperLeagueId: FAKE_BOARD_LEAGUE_ID, clerkUserId: "clerk_1" },
    );
    expect(result).toEqual({ kind: "not_found" });
    expect(calls.getLeague).toBe(0);
    expect(calls.getLeagueUsers).toBe(0);
    expect(calls.getRosters).toBe(0);
    expect(calls.getMatchups).toBe(0);
  });

  it("returns quota_exceeded for a stale malformed cache with no payload when quota is spent", async () => {
    const { originQuota, seed, used } = makeQuota();
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR);
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    await cache.putJson(`explore:board:${FAKE_BOARD_LEAGUE_ID}:1`, {
      fetchedAt: FIXED_NOW - BOARD_TTL_MS - 1,
    });
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(
      makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
      { sleeperLeagueId: FAKE_BOARD_LEAGUE_ID, clerkUserId: "clerk_1" },
    );
    expect(result).toEqual({ kind: "quota_exceeded" });
    expect(calls.getLeague).toBe(0);
    expect(used("clerk_1", FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
  });

  it("assembles a stale cache that has a league but missing users/rosters/matchups", async () => {
    const { originQuota, seed } = makeQuota();
    seed("clerk_1", FIXED_NOW, ORIGIN_QUOTA_PER_HOUR);
    const cache = createMemoryExplorerCache();
    await seedFreshNflState(cache, FIXED_NOW);
    await cache.putJson(`explore:board:${FAKE_BOARD_LEAGUE_ID}:1`, {
      fetchedAt: FIXED_NOW - BOARD_TTL_MS - 1,
      payload: { league: fakeCachedLeague },
    });
    const { client, calls } = countingClient();
    const result = await lookupExplorerBoard(
      makeDeps({ sleeper: client, cache, originQuota, now: () => FIXED_NOW }),
      { sleeperLeagueId: FAKE_BOARD_LEAGUE_ID, clerkUserId: "clerk_1" },
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.stale).toBe(true);
    expect(result.board.league).toMatchObject({
      sleeperLeagueId: FAKE_BOARD_LEAGUE_ID,
      name: "Cached Fake League",
    });
    expect(result.board.standings).toEqual([]);
    expect(result.board.matchups).toEqual([]);
    expect(result.board.rosters).toEqual([]);
    expect(calls.getLeague).toBe(0);
    expect(calls.getLeagueUsers).toBe(0);
    expect(calls.getRosters).toBe(0);
    expect(calls.getMatchups).toBe(0);
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

describe("createMemoryExplorerCache", () => {
  it("returns null for invalid JSON without throwing", async () => {
    const store = new Map<string, string>();
    const cache = createMemoryExplorerCache(store);
    await cache.putJson("good", { ok: true });
    store.set("bad", "{not-json");
    expect(await cache.getJson("good")).toEqual({ ok: true });
    await expect(cache.getJson("bad")).resolves.toBeNull();
  });
});

describe("explorerDepsFromEnv KV isolation", () => {
  it("writes explorer cache to EXPLORER_CACHE and the player map to PLAYERS", async () => {
    const deps = explorerDepsFromEnv(env);
    const marker = `explore:isolation:${crypto.randomUUID()}`;
    await deps.cache.putJson(marker, { ok: true });
    expect(await env.EXPLORER_CACHE.get(marker, "json")).toEqual({ ok: true });
    expect(await env.PLAYERS.get(marker)).toBeNull();

    await env.PLAYERS.delete("players:nfl");
    await env.PLAYERS.delete("players:nfl:fetched_at");
    await env.EXPLORER_CACHE.delete("players:nfl");
    await env.EXPLORER_CACHE.delete("players:nfl:fetched_at");
    await deps.getPlayers();
    expect(await env.PLAYERS.get("players:nfl")).not.toBeNull();
    expect(await env.PLAYERS.get("players:nfl:fetched_at")).not.toBeNull();
    expect(await env.EXPLORER_CACHE.get("players:nfl")).toBeNull();
    expect(await env.EXPLORER_CACHE.get("players:nfl:fetched_at")).toBeNull();
  });
});
