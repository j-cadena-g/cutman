import { describe, expect, it, vi } from "vitest";
import {
  COMING_SOON_LEAGUE_ID,
  COMING_SOON_LEAGUE_NAME,
  EXAMPLE_COMMISSIONER_CHALLENGE,
  EXAMPLE_COMMISSIONER_TEAM_NAME,
  EXAMPLE_COMMISSIONER_USER_ID,
  EXAMPLE_COMMISSIONER_USERNAME,
  EXAMPLE_SLEEPER_USERNAME,
  HttpSleeperClient,
  MUTABLE_SLEEPER_DISPLAY_NAME,
  MUTABLE_SLEEPER_PREVIOUS_USERNAME,
  MUTABLE_SLEEPER_USER_ID,
  MUTABLE_SLEEPER_USERNAME,
  REQUEST_TIMEOUT_MS,
  V1_LEAGUE_ID,
  V1_LEAGUE_NAME,
  comingSoonFixtureLeague,
  comingSoonFixtureUsers,
  createFixtureClient,
  fixtureTransactions,
  isSleeperRateLimited,
  mutableFixtureUser,
  SleeperRequestError,
  v1FixtureCommissioner,
  v1FixtureMatchups,
  v1FixtureRosters,
  v1FixtureUser,
  v1FixtureUsers,
} from "./index.ts";

describe("fixture sleeper client", () => {
  it("serves Example League and example_user without a live API", async () => {
    const client = createFixtureClient();
    const state = await client.getNflState();
    expect(state.league_season).toBe("2026");
    const user = await client.getUser(EXAMPLE_SLEEPER_USERNAME);
    expect(user).toEqual(v1FixtureUser);
    const leagues = await client.getUserLeagues(user!.user_id, state.league_season);
    expect(leagues.map((league) => league.league_id)).toContain(V1_LEAGUE_ID);
    const members = await client.getLeagueUsers(V1_LEAGUE_ID);
    expect(members).toHaveLength(10);
    expect(members.some((member) => member.user_id === v1FixtureUser.user_id)).toBe(true);
    const league = await client.getLeague(V1_LEAGUE_ID);
    expect(league?.name).toBe(V1_LEAGUE_NAME);
    expect(league?.status).toBe("in_season");
    expect(league?.total_rosters).toBe(10);
  });

  it("serves the current-season pilot league plus a Coming-soon league with its own roster", async () => {
    const client = createFixtureClient();
    const state = await client.getNflState();
    const user = await client.getUser(EXAMPLE_SLEEPER_USERNAME);
    const leagues = await client.getUserLeagues(user!.user_id, state.league_season);

    expect(state.league_season).toBe("2026");
    expect(leagues.map((league) => league.league_id)).toEqual([V1_LEAGUE_ID, COMING_SOON_LEAGUE_ID]);
    expect(leagues.every((league) => league.season === "2026")).toBe(true);

    const comingSoon = await client.getLeague(COMING_SOON_LEAGUE_ID);
    expect(comingSoon).toEqual(comingSoonFixtureLeague);
    expect(comingSoon?.name).toBe(COMING_SOON_LEAGUE_NAME);

    const comingSoonMembers = await client.getLeagueUsers(COMING_SOON_LEAGUE_ID);
    expect(comingSoonMembers).toEqual(comingSoonFixtureUsers);
    expect(comingSoonMembers).not.toEqual(v1FixtureUsers);
    expect(comingSoonMembers).toHaveLength(4);

    expect(await client.getRosters(COMING_SOON_LEAGUE_ID)).toEqual([]);
    expect(await client.getRosters(V1_LEAGUE_ID)).toEqual(v1FixtureRosters);
    expect(await client.getMatchups(COMING_SOON_LEAGUE_ID, 1)).toEqual([]);
    expect(await client.getMatchups(V1_LEAGUE_ID, 1)).toEqual(v1FixtureMatchups);
    expect(await client.getTransactions(COMING_SOON_LEAGUE_ID, 1)).toEqual([]);
    expect(await client.getTransactions(V1_LEAGUE_ID, 1)).toEqual(fixtureTransactions);

    const unknownMembers = await client.getLeagueUsers("not-a-fixture-league");
    expect(unknownMembers).toEqual([]);
  });

  it("exposes a commissioner with is_owner and a challenge-shaped team name, plus non-owner members", async () => {
    const client = createFixtureClient();
    const members = await client.getLeagueUsers(V1_LEAGUE_ID);
    const commissioner = members.find((member) => member.user_id === EXAMPLE_COMMISSIONER_USER_ID);
    const exampleMember = members.find((member) => member.user_id === v1FixtureUser.user_id);

    expect(commissioner).toEqual(v1FixtureCommissioner);
    expect(commissioner?.is_owner).toBe(true);
    expect(commissioner?.username).toBe(EXAMPLE_COMMISSIONER_USERNAME);
    expect(commissioner?.metadata?.team_name).toBe(EXAMPLE_COMMISSIONER_TEAM_NAME);
    expect(commissioner?.metadata?.team_name).toContain(EXAMPLE_COMMISSIONER_CHALLENGE);
    expect(EXAMPLE_COMMISSIONER_CHALLENGE).toMatch(/^CUTMAN-[A-Z0-9]{4}$/);

    expect(exampleMember?.is_owner).toBe(false);
    expect(members.filter((member) => member.is_owner)).toHaveLength(1);

    const resolved = await client.getUser(EXAMPLE_COMMISSIONER_USERNAME);
    expect(resolved?.user_id).toBe(EXAMPLE_COMMISSIONER_USER_ID);
  });

  it("resolves a renamed username and display name to the same stable user_id", async () => {
    const client = createFixtureClient();
    const byCurrent = await client.getUser(MUTABLE_SLEEPER_USERNAME);
    const byPrevious = await client.getUser(MUTABLE_SLEEPER_PREVIOUS_USERNAME);
    const byId = await client.getUser(MUTABLE_SLEEPER_USER_ID);

    expect(byCurrent).toEqual(mutableFixtureUser);
    expect(byPrevious).toEqual(mutableFixtureUser);
    expect(byId).toEqual(mutableFixtureUser);
    expect(byCurrent?.user_id).toBe(MUTABLE_SLEEPER_USER_ID);
    expect(byCurrent?.username).toBe(MUTABLE_SLEEPER_USERNAME);
    expect(byCurrent?.display_name).toBe(MUTABLE_SLEEPER_DISPLAY_NAME);
    expect(byPrevious?.user_id).toBe(byCurrent?.user_id);

    expect(await client.getUser("nobody_here")).toBeNull();
  });

  it("does not alias the previous username onto a custom users override", async () => {
    const client = createFixtureClient({
      users: [{ user_id: "custom", username: "custom", display_name: "Custom", is_owner: false }],
    });
    expect(await client.getUser(MUTABLE_SLEEPER_PREVIOUS_USERNAME)).toBeNull();
    expect(await client.getUser("custom")).toEqual({
      user_id: "custom",
      username: "custom",
      display_name: "Custom",
    });
  });

  it("does not alias the previous username onto a usersByLeagueId override", async () => {
    const client = createFixtureClient({
      usersByLeagueId: {
        [V1_LEAGUE_ID]: [{ user_id: "custom", username: "custom", display_name: "Custom", is_owner: false }],
      },
    });
    expect(await client.getUser(MUTABLE_SLEEPER_PREVIOUS_USERNAME)).toBeNull();
    expect(await client.getUser("custom")).toEqual({
      user_id: "custom",
      username: "custom",
      display_name: "Custom",
    });
  });

  it("isolates usersByLeagueId to the mapped league", async () => {
    const client = createFixtureClient({
      usersByLeagueId: {
        [V1_LEAGUE_ID]: [{ user_id: "only_pilot", username: "only_pilot", display_name: "Only Pilot", is_owner: false }],
      },
    });
    expect(await client.getLeagueUsers(V1_LEAGUE_ID)).toEqual([
      { user_id: "only_pilot", username: "only_pilot", display_name: "Only Pilot", is_owner: false },
    ]);
    expect(await client.getLeagueUsers(COMING_SOON_LEAGUE_ID)).toEqual([]);
  });
});

describe("HttpSleeperClient errors", () => {
  it("throws SleeperRequestError on a 429 so callers can serve stale cache", async () => {
    const client = new HttpSleeperClient(async () => new Response("slow down", { status: 429 }));
    await expect(client.getNflState()).rejects.toEqual(expect.objectContaining({ status: 429, path: "/state/nfl" }));
    const error = await client.getNflState().then(
      () => {
        throw new Error("expected getNflState to reject");
      },
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(SleeperRequestError);
    expect(isSleeperRateLimited(error)).toBe(true);
    expect((error as Error).message).toBe("Sleeper /state/nfl failed: 429");
  });

  it("keeps the raw path on the error but redacts it from the message", async () => {
    const client = new HttpSleeperClient(async () => new Response("nope", { status: 502 }));
    const error = await client.getUser("alice").then(
      () => {
        throw new Error("expected getUser to reject");
      },
      (rejection: unknown) => rejection,
    );
    expect(error).toEqual(expect.objectContaining({ path: "/user/alice", status: 502 }));
    expect((error as Error).message).toBe("Sleeper /user/:id failed: 502");
    expect((error as Error).message).not.toContain("alice");
    expect(Object.keys(error as object)).not.toContain("path");
    expect((error as SleeperRequestError).path).toBe("/user/alice");
    expect(isSleeperRateLimited(new Error("Sleeper /user/:id failed: 429"))).toBe(true);

    const reserved = await client.getUser("league").then(
      () => {
        throw new Error("expected getUser to reject");
      },
      (rejection: unknown) => rejection,
    );
    expect((reserved as Error).message).toBe("Sleeper /user/:id failed: 502");
    expect((reserved as Error).message).not.toContain("league");
  });

  it("redacts unknown path prefixes after the first segment", () => {
    const error = new SleeperRequestError("/draft/abc123", 502);
    expect(error.message).toBe("Sleeper /draft/:redacted failed: 502");
    expect(error.message).not.toContain("abc123");
    expect(error.path).toBe("/draft/abc123");
    expect(Object.keys(error)).not.toContain("path");
  });

  it("redacts the league id on /league/:id/users without dropping the sub-resource", async () => {
    const client = new HttpSleeperClient(async () => new Response("nope", { status: 502 }));
    const error = await client.getLeagueUsers("fake-league-id").then(
      () => {
        throw new Error("expected getLeagueUsers to reject");
      },
      (rejection: unknown) => rejection,
    );
    expect(error).toEqual(expect.objectContaining({ path: "/league/fake-league-id/users", status: 502 }));
    expect((error as Error).message).toBe("Sleeper /league/:id/users failed: 502");
    expect((error as Error).message).not.toContain("fake-league-id");
    expect((error as SleeperRequestError).path).toBe("/league/fake-league-id/users");
  });

  it("does not call fetch as a method of the client (Workers native fetch throws Illegal invocation)", async () => {
    const nflState = { week: 1, season_type: "regular", season: "2026", league_season: "2026" };
    function thisSensitiveFetch(this: unknown, _input: Parameters<typeof fetch>[0]) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(
          "Illegal invocation: function called with incorrect this reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.",
        );
      }
      return Promise.resolve(new Response(JSON.stringify(nflState), { status: 200 }));
    }
    const client = new HttpSleeperClient(thisSensitiveFetch as typeof fetch);
    await expect(client.getNflState()).resolves.toEqual(nflState);
  });

  it("passes a timeout AbortSignal so a hung Sleeper call cannot stall forever", async () => {
    const requested: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      requested.push(ms);
      return original(ms);
    });
    try {
      let signal: AbortSignal | null | undefined;
      const nflState = { week: 1, season_type: "regular", season: "2026", league_season: "2026" };
      const fetchImpl: typeof fetch = async (_input, init) => {
        signal = init?.signal;
        return new Response(JSON.stringify(nflState), { status: 200 });
      };
      const client = new HttpSleeperClient(fetchImpl);
      await expect(client.getNflState()).resolves.toEqual(nflState);
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
      expect(requested).toEqual([REQUEST_TIMEOUT_MS]);
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the passed timeoutMs on getJsonOrNull", async () => {
    const requested: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      requested.push(ms);
      return original(ms);
    });
    try {
      const client = new HttpSleeperClient(async () => new Response("null", { status: 404 }));
      await expect(
        (
          client as unknown as {
            getJsonOrNull: (path: string, timeoutMs?: number) => Promise<unknown>;
          }
        ).getJsonOrNull("/user/alice", 1_500),
      ).resolves.toBeNull();
      expect(requested).toEqual([1_500]);
    } finally {
      spy.mockRestore();
    }
  });

  it("uses a longer timeout for getPlayers so the body read is covered", async () => {
    const requested: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      requested.push(ms);
      return original(ms);
    });
    try {
      const client = new HttpSleeperClient(async () => new Response("{}", { status: 200 }));
      await expect(client.getPlayers()).resolves.toEqual({});
      expect(requested).toEqual([30_000]);
    } finally {
      spy.mockRestore();
    }
  });
});

