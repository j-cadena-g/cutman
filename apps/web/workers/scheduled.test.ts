/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import {
  activateLeague,
  createLeague,
  ensureSchema,
  failLeague,
  listActiveLeagues,
  type LeagueRow,
} from "@cutman/db";
import { V1_LEAGUE_ID } from "@cutman/sleeper";
import { easternParts, shouldAttemptTuesdayRecap, shouldPoll } from "@cutman/story";
import { beforeAll, describe, expect, it } from "vitest";
import { getDashboardOrNull } from "../app/lib/dashboard.ts";
import { LeagueBrain } from "./league-brain.ts";
import { handleScheduled } from "./scheduled.ts";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

// Wednesday 3:00 America/New_York (EDT) — poll hour, not Tuesday recap.
const POLL_NOW = new Date("2026-09-09T07:00:00.000Z");
// Tuesday 9:00 America/New_York (EDT) — both poll and recap.
const RECAP_NOW = new Date("2026-09-08T13:00:00.000Z");
// Tuesday 10:00 America/New_York — neither.
const IDLE_NOW = new Date("2026-09-08T14:00:00.000Z");

let seq = 0;
async function seedLeague(
  label: string,
  now: number,
  status: "provisioning" | "active" | "error",
): Promise<LeagueRow> {
  await ensureSchema(env.DB);
  seq += 1;
  const league = await createLeague(env.DB, {
    id: `internal_sched_${label}_${seq}`,
    sleeperLeagueId: `sleeper_sched_${label}_${seq}`,
    name: `Sched ${label}`,
    season: "2026",
    now,
  });
  expect(league.id).not.toBe(league.sleeper_league_id);
  if (status === "active") return activateLeague(env.DB, league.id, now + 1);
  if (status === "error") return failLeague(env.DB, league.id, "seeded error");
  return league;
}

async function settingKeys(name: string): Promise<string[]> {
  const stub = env.LEAGUE_BRAIN.getByName(name);
  const rows = await runInDurableObject(stub, async (_instance, state) => {
    return state.storage.sql.exec("SELECT key FROM settings").toArray() as Array<{ key: string }>;
  });
  return rows.map((row) => row.key);
}

describe("handleScheduled", () => {
  it("uses poll/recap windows in America/New_York", () => {
    expect(shouldPoll(easternParts(POLL_NOW))).toBe(true);
    expect(shouldAttemptTuesdayRecap(easternParts(POLL_NOW))).toBe(false);
    expect(shouldPoll(easternParts(RECAP_NOW))).toBe(true);
    expect(shouldAttemptTuesdayRecap(easternParts(RECAP_NOW))).toBe(true);
    expect(shouldPoll(easternParts(IDLE_NOW))).toBe(false);
    expect(shouldAttemptTuesdayRecap(easternParts(IDLE_NOW))).toBe(false);
  });

  it("does nothing when it is not a poll or recap hour", async () => {
    await seedLeague("idle_active", 1_805_000_000_000, "active");
    const result = await handleScheduled(env, IDLE_NOW);
    expect(result).toEqual({ polled: 0, recapped: 0 });
  });

  it("polls every active league by internal id and ignores leftover env names, V1-named DOs, pending, error, and discovered-only leagues", async () => {
    const now = 1_805_100_000_000;
    const first = await seedLeague("active_a", now, "active");
    const second = await seedLeague("active_b", now + 100, "active");
    const pending = await seedLeague("pending", now + 200, "provisioning");
    const errored = await seedLeague("errored", now + 300, "error");
    const discoveredOnlySleeperId = "sleeper_discovered_only_never_inserted";

    const result = await handleScheduled(env, POLL_NOW);

    expect(result.polled).toBe((await listActiveLeagues(env.DB)).length);
    expect(result.recapped).toBe(0);

    for (const league of [first, second]) {
      const dashboard = await env.LEAGUE_BRAIN.getByName(league.id).getDashboard();
      expect(dashboard.leagueId).toBe(league.id);
      expect(dashboard.sleeperLeagueId).toBe(league.sleeper_league_id);
      expect(dashboard.week).not.toBeNull();
      expect(await settingKeys(league.sleeper_league_id)).toEqual([]);
    }

    expect(await settingKeys(pending.id)).toEqual([]);
    expect(await settingKeys(errored.id)).toEqual([]);
    expect(await settingKeys(discoveredOnlySleeperId)).toEqual([]);
    expect(await settingKeys(V1_LEAGUE_ID)).toEqual([]);
    expect("V1_LEAGUE_ID" in env).toBe(false);
    expect(await settingKeys(env.PILOT_SLEEPER_LEAGUE_ID)).toEqual([]);
  });

  it("still recaps every active league on the Tuesday 9:00 America/New_York window", async () => {
    const now = 1_805_200_000_000;
    const league = await seedLeague("recap_active", now, "active");

    const result = await handleScheduled(env, RECAP_NOW);

    const activeCount = (await listActiveLeagues(env.DB)).length;
    expect(result.polled).toBe(activeCount);
    expect(result.recapped).toBe(activeCount);
    const dashboard = await env.LEAGUE_BRAIN.getByName(league.id).getDashboard();
    expect(dashboard.leagueId).toBe(league.id);
  });

  it("isolates per-league failures so one throwing poll does not prevent others", async () => {
    const now = 1_805_300_000_000;
    const failing = await seedLeague("failing", now, "active");
    const surviving = await seedLeague("surviving", now + 50, "active");

    const originalPoll = LeagueBrain.prototype.poll;
    const originalError = console.error;
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      if (dashboard.leagueId === failing.id) {
        throw new Error("boom from failing league");
      }
      return originalPoll.call(this);
    };
    console.error = () => {};

    try {
      const result = await handleScheduled(env, POLL_NOW);
      const activeCount = (await listActiveLeagues(env.DB)).length;
      expect(result.polled).toBe(activeCount - 1);
      const survived = await env.LEAGUE_BRAIN.getByName(surviving.id).getDashboard();
      expect(survived.leagueId).toBe(surviving.id);
      expect(survived.week).not.toBeNull();
      expect(await getDashboardOrNull(env.LEAGUE_BRAIN.getByName(failing.id))).not.toBeNull();
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      console.error = originalError;
    }
  });
});
