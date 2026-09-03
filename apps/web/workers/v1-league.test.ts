/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { getLeagueBySleeperId } from "@cutman/db";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureV1LeagueRow } from "../app/lib/v1.server.ts";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

describe("ensureV1LeagueRow", () => {
  it("resolves two concurrent first loads to the same active league instead of one throwing", async () => {
    const now = Date.now();

    // Neither request has ever run before: there is no league row for the configured Sleeper
    // league id yet. Both requests race through create -> provision -> activate; only one
    // `activateLeague` compare-and-swap can win, so the loser must recover to the now-active
    // row instead of rejecting (which would surface as a 500 to whichever request lost).
    const [first, second] = await Promise.all([ensureV1LeagueRow(env, now), ensureV1LeagueRow(env, now)]);

    expect(first.status).toBe("active");
    expect(second.status).toBe("active");
    expect(first.id).toBe(second.id);
    expect(first.activated_at).not.toBeNull();

    const stored = await getLeagueBySleeperId(env.DB, first.sleeper_league_id);
    expect(stored?.status).toBe("active");
  });
});
