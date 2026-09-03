/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import {
  EXAMPLE_SLEEPER_USER_ID,
  V1_LEAGUE_ID,
  ensureLeague,
  ensureOperatorSeed,
  ensureSchema,
  findAllowlistBySleeperUserId,
  getLeague,
} from "@cutman/db";
import { beforeAll, describe, expect, it } from "vitest";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

describe("schema and operator seed", () => {
  it("does not insert placeholder league or allowlist rows", async () => {
    await ensureSchema(env.DB);
    expect(await getLeague(env.DB, V1_LEAGUE_ID)).toBeNull();
    expect(await findAllowlistBySleeperUserId(env.DB, EXAMPLE_SLEEPER_USER_ID)).toBeNull();
  });

  it("seeds the configured league and operator with the provided timestamp", async () => {
    const now = 1_700_000_000_000;
    await ensureOperatorSeed(env.DB, {
      leagueId: "123456789012345678",
      leagueName: "Live League",
      sleeperUserId: "987654321098765432",
      sleeperUsername: "operator",
      now,
    });
    const league = await getLeague(env.DB, "123456789012345678");
    expect(league?.name).toBe("Live League");
    expect(league?.enabled_at).toBe(now);
    const allowlist = await findAllowlistBySleeperUserId(env.DB, "987654321098765432");
    expect(allowlist?.sleeper_username).toBe("operator");
    expect(allowlist?.created_at).toBe(now);
  });

  it("does not fail or overwrite when ensureLeague runs twice", async () => {
    const now = 1_700_000_000_001;
    const first = await ensureLeague(env.DB, {
      leagueId: "111111111111111111",
      name: "Once",
      season: "2026",
      now,
    });
    const second = await ensureLeague(env.DB, {
      leagueId: "111111111111111111",
      name: "Twice",
      season: "2026",
      now: now + 1,
    });
    expect(second.sleeper_league_id).toBe(first.sleeper_league_id);
    expect(second.name).toBe("Once");
    expect(second.enabled_at).toBe(now);
  });
});
