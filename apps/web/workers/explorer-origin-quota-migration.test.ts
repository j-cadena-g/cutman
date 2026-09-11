/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type D1Migration = { name: string; queries: string[] };

function migrationNamed(fragment: string): D1Migration[] {
  const found = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS.filter((migration) =>
    migration.name.includes(fragment),
  );
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one migration matching ${fragment}, got ${found.map((m) => m.name).join(",") || "(none)"}`,
    );
  }
  return found;
}

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

describe("0004 explorer origin quota migration", () => {
  it("adds explorer_origin_quota without dropping 0003 rows", async () => {
    await applyD1Migrations(env.DB, migrationNamed("0001_init"));
    await applyD1Migrations(env.DB, migrationNamed("0002_sleeper_onboarding"));
    await applyD1Migrations(env.DB, migrationNamed("0003_recap_attempt_backlog"));

    await env.DB.prepare(
      `INSERT INTO leagues (id, sleeper_league_id, name, season, status, tone, created_at, activated_at)
       VALUES (?, ?, ?, ?, 'active', 'playful', ?, ?)`,
    )
      .bind("league_keep", "sleeper_keep", "Keep", "2026", 9_000, 9_001)
      .run();
    await env.DB.prepare(
      `INSERT INTO recap_attempt_backlog (league_id, week_key, status, attempts, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?)`,
    )
      .bind("league_keep", "2026-W01", 9_002, 9_003)
      .run();

    expect(await userTables()).not.toContain("explorer_origin_quota");

    await applyD1Migrations(env.DB, migrationNamed("0004_explorer_origin_quota"));

    expect(await userTables()).toContain("explorer_origin_quota");
    const league = await env.DB.prepare("SELECT id, name FROM leagues WHERE id = ?")
      .bind("league_keep")
      .first<{ id: string; name: string }>();
    expect(league).toEqual({ id: "league_keep", name: "Keep" });
    const backlog = await env.DB.prepare(
      "SELECT league_id, week_key, status FROM recap_attempt_backlog WHERE league_id = ?",
    )
      .bind("league_keep")
      .first<{ league_id: string; week_key: string; status: string }>();
    expect(backlog).toEqual({ league_id: "league_keep", week_key: "2026-W01", status: "pending" });
    const quotaCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM explorer_origin_quota").first<{
      n: number;
    }>();
    expect(quotaCount?.n).toBe(0);

    const createSql = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'explorer_origin_quota'",
    ).first<{ sql: string }>();
    expect(createSql?.sql).toMatch(/PRIMARY KEY\s*\(\s*clerk_user_id\s*\)/i);
    expect(createSql?.sql).not.toMatch(/PRIMARY KEY\s*\(\s*clerk_user_id\s*,\s*hour_key\s*\)/i);
    expect(createSql?.sql).toMatch(/CHECK\s*\(\s*used\s*>=\s*0\s*\)/i);
    expect(createSql?.sql).toMatch(/CHECK\s*\(\s*hour_key\s*>=\s*0\s*\)/i);
  });
});
