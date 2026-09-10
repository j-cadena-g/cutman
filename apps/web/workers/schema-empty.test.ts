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

  it("yields the expected empty final schema after 0001, 0002, then 0003", async () => {
    await ensureSchema(env.DB);
    expect(await userTables()).toEqual([
      "app_state",
      "league_members",
      "league_verifications",
      "leagues",
      "recap_attempt_backlog",
      "sleeper_accounts",
      "users",
    ]);

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM sleeper_accounts) AS sleeper_accounts,
         (SELECT COUNT(*) FROM leagues) AS leagues,
         (SELECT COUNT(*) FROM league_members) AS league_members,
         (SELECT COUNT(*) FROM league_verifications) AS league_verifications,
         (SELECT COUNT(*) FROM app_state) AS app_state,
         (SELECT COUNT(*) FROM recap_attempt_backlog) AS recap_attempt_backlog`,
    ).first<Record<string, number>>();
    expect(counts).toEqual({
      users: 0,
      sleeper_accounts: 0,
      leagues: 0,
      league_members: 0,
      league_verifications: 0,
      app_state: 0,
      recap_attempt_backlog: 0,
    });

    const indexes = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name IN (
           'league_members_user_id_idx',
           'league_verifications_user_id_idx',
           'league_verifications_sleeper_league_id_idx',
           'league_verifications_pending_user_league_idx',
           'recap_attempt_backlog_pending_week_idx'
         )
       ORDER BY name`,
    ).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual([
      "league_members_user_id_idx",
      "league_verifications_pending_user_league_idx",
      "league_verifications_sleeper_league_id_idx",
      "league_verifications_user_id_idx",
      "recap_attempt_backlog_pending_week_idx",
    ]);

    const pendingIndex = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'league_verifications_pending_user_league_idx'",
    ).first<{ sql: string }>();
    expect(pendingIndex?.sql).toMatch(/WHERE\s+status\s*=\s*'pending'/i);

    const leagueColumns = await env.DB.prepare("PRAGMA table_info(leagues)").all<{
      name: string;
      notnull: number;
    }>();
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
      "provisioning_started_at",
    ]);
    expect(leagueColumns.results.find((column) => column.name === "provisioning_started_at")?.notnull).toBe(0);

    const backlogColumns = await env.DB.prepare("PRAGMA table_info(recap_attempt_backlog)").all<{
      name: string;
      notnull: number;
    }>();
    expect(backlogColumns.results.map((column) => column.name)).toEqual([
      "league_id",
      "week_key",
      "status",
      "attempts",
      "last_error",
      "created_at",
      "updated_at",
    ]);
    expect(backlogColumns.results.find((column) => column.name === "last_error")?.notnull).toBe(0);

    const backlogPendingIndex = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'recap_attempt_backlog_pending_week_idx'",
    ).first<{ sql: string }>();
    expect(backlogPendingIndex?.sql).toMatch(/WHERE\s+status\s*=\s*'pending'/i);
  });
});
