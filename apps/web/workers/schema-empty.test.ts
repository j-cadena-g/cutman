/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { EXAMPLE_SLEEPER_LEAGUE_ID, ensureSchema, getLeagueBySleeperId } from "@cutman/db";
import { beforeAll, describe, expect, it } from "vitest";

type D1Migration = { name: string; queries: string[] };

// Own isolate: @cloudflare/vitest-pool-workers isolates storage per test file by default
// (vitest.config.ts does not set --no-isolate). A global COUNT(*) = 0 cannot live in
// db-seed.test.ts, which inserts league rows in later tests.
beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

async function userTables(): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '_cf_%'
       AND name != 'd1_migrations'
     ORDER BY name`,
  ).all<{ name: string }>();
  return result.results.map((row) => row.name);
}

describe("schema", () => {
  it("does not insert placeholder league rows", async () => {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM leagues").first<{ n: number }>();
    expect(row?.n).toBe(0);
    expect(await getLeagueBySleeperId(env.DB, EXAMPLE_SLEEPER_LEAGUE_ID)).toBeNull();
  });

  it("yields the expected empty final schema after 0001 then 0002", async () => {
    await ensureSchema(env.DB);
    expect(await userTables()).toEqual([
      "league_members",
      "league_verifications",
      "leagues",
      "sleeper_accounts",
      "users",
    ]);

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM sleeper_accounts) AS sleeper_accounts,
         (SELECT COUNT(*) FROM leagues) AS leagues,
         (SELECT COUNT(*) FROM league_members) AS league_members,
         (SELECT COUNT(*) FROM league_verifications) AS league_verifications`,
    ).first<Record<string, number>>();
    expect(counts).toEqual({
      users: 0,
      sleeper_accounts: 0,
      leagues: 0,
      league_members: 0,
      league_verifications: 0,
    });

    const indexes = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name IN (
           'league_members_user_id_idx',
           'league_verifications_user_id_idx',
           'league_verifications_sleeper_league_id_idx',
           'league_verifications_pending_user_league_idx'
         )
       ORDER BY name`,
    ).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual([
      "league_members_user_id_idx",
      "league_verifications_pending_user_league_idx",
      "league_verifications_sleeper_league_id_idx",
      "league_verifications_user_id_idx",
    ]);

    const pendingIndex = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'league_verifications_pending_user_league_idx'",
    ).first<{ sql: string }>();
    expect(pendingIndex?.sql).toMatch(/WHERE\s+status\s*=\s*'pending'/i);

    const leagueColumns = await env.DB.prepare("PRAGMA table_info(leagues)").all<{ name: string }>();
    expect(leagueColumns.results.map((column) => column.name)).toEqual([
      "id",
      "sleeper_league_id",
      "name",
      "season",
      "status",
      "tone",
      "created_at",
      "activated_at",
      "provisioning_error",
    ]);
  });
});
