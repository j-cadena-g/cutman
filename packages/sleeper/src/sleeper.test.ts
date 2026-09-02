import { describe, expect, it } from "vitest";
import { createFixtureClient, fixtureUser } from "./index.ts";

describe("fixture sleeper client", () => {
  it("serves canned NFL state and leagues without a live API", async () => {
    const client = createFixtureClient();
    const state = await client.getNflState();
    expect(state.league_season).toBe("2025");
    const user = await client.getUser("james");
    expect(user).toEqual(fixtureUser);
    const leagues = await client.getUserLeagues(user!.user_id, state.league_season);
    expect(leagues.map((league) => league.league_id)).toEqual(["lg-group-chat", "lg-work"]);
  });
});
