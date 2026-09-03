import { describe, expect, it } from "vitest";
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
  V1_LEAGUE_ID,
  V1_LEAGUE_NAME,
  comingSoonFixtureLeague,
  comingSoonFixtureUsers,
  createFixtureClient,
  isSleeperRateLimited,
  mutableFixtureUser,
  SleeperRequestError,
  v1FixtureCommissioner,
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
});

describe("HttpSleeperClient errors", () => {
  it("throws SleeperRequestError on a 429 so callers can serve stale cache", async () => {
    const client = new HttpSleeperClient(async () => new Response("slow down", { status: 429 }));
    await expect(client.getNflState()).rejects.toEqual(expect.objectContaining({ status: 429, path: "/state/nfl" }));
    try {
      await client.getNflState();
    } catch (error) {
      expect(error).toBeInstanceOf(SleeperRequestError);
      expect(isSleeperRateLimited(error)).toBe(true);
    }
  });
});
