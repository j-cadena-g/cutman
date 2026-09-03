import { describe, expect, it } from "vitest";
import { getDashboardOrNull } from "../app/lib/dashboard.ts";
import type { Dashboard } from "../workers/league-brain.ts";

function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    leagueId: "pilot_league",
    sleeperLeagueId: "sleeper_pilot_league",
    name: "The Pilot",
    tone: "playful",
    week: 3,
    lastHash: null,
    bible: [],
    timeline: [],
    recaps: [],
    ...overrides,
  };
}

describe("getDashboardOrNull", () => {
  it("returns the dashboard as-is when the Brain resolves it", async () => {
    const dashboard = makeDashboard();
    const result = await getDashboardOrNull({ getDashboard: async () => dashboard });
    expect(result).toBe(dashboard);
  });

  it("returns null instead of throwing when the Brain hasn't been bootstrapped yet", async () => {
    const result = await getDashboardOrNull({
      getDashboard: async () => {
        throw new Error("Cutman is not bootstrapped");
      },
    });
    expect(result).toBeNull();
  });

  it("returns null instead of throwing for any other getDashboard failure", async () => {
    const result = await getDashboardOrNull({
      getDashboard: async () => {
        throw new Error("some other Durable Object failure");
      },
    });
    expect(result).toBeNull();
  });
});
