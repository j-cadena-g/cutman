import { describe, expect, it } from "vitest";
import {
  getDashboardOrNull,
  isLegacyImportPendingDashboardError,
  isUnbootstrappedDashboardError,
} from "../app/lib/dashboard.ts";
import {
  LEGACY_IMPORT_PENDING_MESSAGE,
  UNBOOTSTRAPPED_MESSAGE,
  type Dashboard,
} from "../workers/league-brain.ts";

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

describe("isUnbootstrappedDashboardError", () => {
  it("accepts only the exact LeagueBrain.readSettings Error", () => {
    expect(isUnbootstrappedDashboardError(new Error(UNBOOTSTRAPPED_MESSAGE))).toBe(true);
    expect(isUnbootstrappedDashboardError(new Error("some other Durable Object failure"))).toBe(false);
    expect(isUnbootstrappedDashboardError(new Error("Cutman is not bootstrapped yet"))).toBe(false);
    expect(isUnbootstrappedDashboardError(new Error(LEGACY_IMPORT_PENDING_MESSAGE))).toBe(false);
    expect(isUnbootstrappedDashboardError(UNBOOTSTRAPPED_MESSAGE)).toBe(false);
    expect(isUnbootstrappedDashboardError({ message: UNBOOTSTRAPPED_MESSAGE })).toBe(false);
  });
});

describe("isLegacyImportPendingDashboardError", () => {
  it("accepts only the exact LeagueBrain pending-import Error", () => {
    expect(isLegacyImportPendingDashboardError(new Error(LEGACY_IMPORT_PENDING_MESSAGE))).toBe(true);
    expect(isLegacyImportPendingDashboardError(new Error("some other Durable Object failure"))).toBe(false);
    expect(isLegacyImportPendingDashboardError(new Error("League history import is pending now"))).toBe(false);
    expect(isLegacyImportPendingDashboardError(new Error(UNBOOTSTRAPPED_MESSAGE))).toBe(false);
    expect(isLegacyImportPendingDashboardError(LEGACY_IMPORT_PENDING_MESSAGE)).toBe(false);
    expect(isLegacyImportPendingDashboardError({ message: LEGACY_IMPORT_PENDING_MESSAGE })).toBe(false);
  });
});

describe("getDashboardOrNull", () => {
  it("returns the dashboard as-is when the Brain resolves it", async () => {
    const dashboard = makeDashboard();
    const result = await getDashboardOrNull({ getDashboard: async () => dashboard });
    expect(result).toBe(dashboard);
  });

  it("returns null for the exact unbootstrapped Error and does not log it", async () => {
    const errors = await withSilentConsoleError(async () => {
      const result = await getDashboardOrNull({
        getDashboard: async () => {
          throw new Error(UNBOOTSTRAPPED_MESSAGE);
        },
      });
      expect(result).toBeNull();
    });
    expect(errors).toHaveLength(0);
  });

  it("rethrows a different Error so the route can handle the outage", async () => {
    const failure = new Error("some other Durable Object failure");
    await expect(
      getDashboardOrNull({
        getDashboard: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it("rethrows a non-Error thrown value even when it looks like the unbootstrapped message", async () => {
    const failure = UNBOOTSTRAPPED_MESSAGE;
    await expect(
      getDashboardOrNull({
        getDashboard: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it("returns null for the exact pending-import Error and does not log it", async () => {
    const errors = await withSilentConsoleError(async () => {
      const result = await getDashboardOrNull({
        getDashboard: async () => {
          throw new Error(LEGACY_IMPORT_PENDING_MESSAGE);
        },
      });
      expect(result).toBeNull();
    });
    expect(errors).toHaveLength(0);
  });

  it("rethrows a different Error that only resembles the pending-import message", async () => {
    const failure = new Error("League history import is pending now");
    await expect(
      getDashboardOrNull({
        getDashboard: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it("rethrows a non-Error thrown value even when it looks like the pending-import message", async () => {
    const failure = LEGACY_IMPORT_PENDING_MESSAGE;
    await expect(
      getDashboardOrNull({
        getDashboard: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
});
