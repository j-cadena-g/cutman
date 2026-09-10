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

describe("0003 recap attempt backlog migration", () => {
  it("adds recap_attempt_backlog without dropping 0002 rows", async () => {
    await applyD1Migrations(env.DB, migrationNamed("0001_init"));
    await applyD1Migrations(env.DB, migrationNamed("0002_sleeper_onboarding"));

    await env.DB.prepare(
      `INSERT INTO leagues (id, sleeper_league_id, name, season, status, tone, created_at, activated_at)
       VALUES (?, ?, ?, ?, 'active', 'playful', ?, ?)`,
    )
      .bind("league_keep", "sleeper_keep", "Keep", "2026", 9_000, 9_001)
      .run();

    expect(await userTables()).not.toContain("recap_attempt_backlog");

    await applyD1Migrations(env.DB, migrationNamed("0003_recap_attempt_backlog"));

    expect(await userTables()).toContain("recap_attempt_backlog");
    const league = await env.DB.prepare("SELECT id, name FROM leagues WHERE id = ?")
      .bind("league_keep")
      .first<{ id: string; name: string }>();
    expect(league).toEqual({ id: "league_keep", name: "Keep" });
    const backlogCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM recap_attempt_backlog").first<{
      n: number;
    }>();
    expect(backlogCount?.n).toBe(0);
  });
});
