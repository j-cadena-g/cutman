import { describe, expect, it } from "vitest";
import { getDashboardOrNull } from "../app/lib/dashboard.ts";
import type { Dashboard } from "../workers/league-brain.ts";

async function withSilentConsoleError<T>(run: () => Promise<T>): Promise<unknown[][]> {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await run();
    return errors;
  } finally {
    console.error = original;
  }
}

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
    const errors = await withSilentConsoleError(async () => {
      const result = await getDashboardOrNull({
        getDashboard: async () => {
          throw new Error("Cutman is not bootstrapped");
        },
      });
      expect(result).toBeNull();
    });
    expect(errors).toHaveLength(1);
  });

  it("returns null instead of throwing for any other getDashboard failure", async () => {
    const errors = await withSilentConsoleError(async () => {
      const result = await getDashboardOrNull({
        getDashboard: async () => {
          throw new Error("some other Durable Object failure");
        },
      });
      expect(result).toBeNull();
    });
    expect(errors).toHaveLength(1);
  });
});
