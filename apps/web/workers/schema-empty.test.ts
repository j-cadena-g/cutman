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

describe("schema", () => {
  it("does not insert placeholder league rows", async () => {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM leagues").first<{ n: number }>();
    expect(row?.n).toBe(0);
    expect(await getLeagueBySleeperId(env.DB, EXAMPLE_SLEEPER_LEAGUE_ID)).toBeNull();
  });
});
