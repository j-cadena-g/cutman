/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrationNamed, userTables } from "./d1-migration-test-helpers.ts";

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
