import { describe, expect, it } from "vitest";
import { JAMES_SLEEPER_USERNAME, V1_LEAGUE_ID, V1_LEAGUE_NAME, createFixtureClient, v1FixtureUser } from "./index.ts";

describe("fixture sleeper client", () => {
  it("serves 519 Keeper and jcadenag without a live API", async () => {
    const client = createFixtureClient();
    const state = await client.getNflState();
    expect(state.league_season).toBe("2026");
    const user = await client.getUser(JAMES_SLEEPER_USERNAME);
    expect(user).toEqual(v1FixtureUser);
    const leagues = await client.getUserLeagues(user!.user_id, state.league_season);
    expect(leagues.map((league) => league.league_id)).toEqual([V1_LEAGUE_ID]);
    const members = await client.getLeagueUsers(V1_LEAGUE_ID);
    expect(members).toHaveLength(10);
    expect(members.some((member) => member.user_id === v1FixtureUser.user_id)).toBe(true);
    const league = await client.getLeague(V1_LEAGUE_ID);
    expect(league?.name).toBe(V1_LEAGUE_NAME);
    expect(league?.status).toBe("in_season");
    expect(league?.total_rosters).toBe(10);
  });
});
