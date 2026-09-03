import { describe, expect, it } from "vitest";
import { pilotSleeperLeagueId } from "../app/lib/v1.server.ts";

function envWith(overrides: Record<string, string | undefined> = {}): Env {
  return overrides as unknown as Env;
}

describe("pilotSleeperLeagueId", () => {
  it("returns the trimmed PILOT_SLEEPER_LEAGUE_ID", () => {
    expect(
      pilotSleeperLeagueId(envWith({ PILOT_SLEEPER_LEAGUE_ID: " 987654321098765432 " })),
    ).toBe("987654321098765432");
  });

  it("throws when PILOT_SLEEPER_LEAGUE_ID is missing", () => {
    expect(() => pilotSleeperLeagueId(envWith({}))).toThrow(/PILOT_SLEEPER_LEAGUE_ID/);
  });

  it("throws when PILOT_SLEEPER_LEAGUE_ID is blank", () => {
    expect(() => pilotSleeperLeagueId(envWith({ PILOT_SLEEPER_LEAGUE_ID: "   " }))).toThrow(
      /PILOT_SLEEPER_LEAGUE_ID/,
    );
  });

  it("does not fall back to V1_LEAGUE_ID or the example fixture id", () => {
    expect(() =>
      pilotSleeperLeagueId(
        envWith({
          PILOT_SLEEPER_LEAGUE_ID: "",
          V1_LEAGUE_ID: "0000000000000000000",
        }),
      ),
    ).toThrow(/PILOT_SLEEPER_LEAGUE_ID/);
  });
});
