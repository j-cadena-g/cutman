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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDashboardOrNull } from "../app/lib/dashboard.ts";
import { LeagueBrain } from "./league-brain.ts";
import {
  handleScheduled,
  MAX_SCHEDULED_LEAGUES_PER_TICK,
  parseScheduledLeagueCursor,
  SCHEDULED_LEAGUE_CURSOR_KEY,
  selectScheduledLeaguePage,
} from "./scheduled.ts";

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

async function clearScheduledCursor(): Promise<void> {
  await env.DB.prepare("DELETE FROM app_state WHERE key = ?").bind(SCHEDULED_LEAGUE_CURSOR_KEY).run();
}

async function scheduledCursorValue(): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(SCHEDULED_LEAGUE_CURSOR_KEY)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function putAppState(key: string, value: string, updatedAt = 1): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, updatedAt)
    .run();
}

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

describe("selectScheduledLeaguePage", () => {
  it("bounds work to the named limit and marks leftover leagues deferred", () => {
    const page = selectScheduledLeaguePage({
      forward: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
      wrap: [],
      limit: 2,
      afterId: null,
    });
    expect(page.leagues.map((league) => league.id)).toEqual(["a", "b"]);
    expect(page.nextAfterId).toBe("b");
    expect(page.hasDeferred).toBe(true);
  });

  it("continues from the cursor in deterministic id order", () => {
    const page = selectScheduledLeaguePage({
      forward: [{ id: "c" }, { id: "d" }, { id: "e" }],
      wrap: [],
      limit: 2,
      afterId: "b",
    });
    expect(page.leagues.map((league) => league.id)).toEqual(["c", "d"]);
    expect(page.nextAfterId).toBe("d");
    expect(page.hasDeferred).toBe(true);
  });

  it("wraps to the start to fill remaining capacity without duplicates", () => {
    const page = selectScheduledLeaguePage({
      forward: [{ id: "e" }],
      wrap: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
      limit: 3,
      afterId: "d",
    });
    expect(page.leagues.map((league) => league.id)).toEqual(["e", "a", "b"]);
    expect(page.nextAfterId).toBe("b");
    expect(page.hasDeferred).toBe(true);
  });

  it("rotates fairly across ticks and returns to earlier ids after a wrap", () => {
    const limit = 2;
    const tick1 = selectScheduledLeaguePage({
      forward: [{ id: "a" }, { id: "b" }, { id: "c" }],
      wrap: [],
      limit,
      afterId: null,
    });
    expect(tick1.leagues.map((league) => league.id)).toEqual(["a", "b"]);
    expect(tick1.nextAfterId).toBe("b");
    expect(tick1.hasDeferred).toBe(true);

    const tick2 = selectScheduledLeaguePage({
      forward: [{ id: "c" }, { id: "d" }],
      wrap: [],
      limit,
      afterId: tick1.nextAfterId,
      prefixExists: true,
    });
    expect(tick2.leagues.map((league) => league.id)).toEqual(["c", "d"]);
    expect(tick2.nextAfterId).toBe("d");
    expect(tick2.hasDeferred).toBe(true);

    const tick3 = selectScheduledLeaguePage({
      forward: [],
      wrap: [{ id: "a" }, { id: "b" }, { id: "c" }],
      limit,
      afterId: tick2.nextAfterId,
    });
    expect(tick3.leagues.map((league) => league.id)).toEqual(["a", "b"]);
    expect(tick3.nextAfterId).toBe("b");
    expect(tick3.hasDeferred).toBe(true);
  });

  it("wraps without deferring when remaining unique leagues fit in the page", () => {
    const page = selectScheduledLeaguePage({
      forward: [{ id: "c" }],
      wrap: [{ id: "a" }, { id: "b" }, { id: "c" }],
      limit: 3,
      afterId: "b",
    });
    expect(page.leagues.map((league) => league.id)).toEqual(["c", "a", "b"]);
    expect(page.nextAfterId).toBe("b");
    expect(page.hasDeferred).toBe(false);
  });

  it("processes a single pilot league in one tick without deferring", () => {
    const page = selectScheduledLeaguePage({
      forward: [{ id: "pilot" }],
      wrap: [],
      limit: MAX_SCHEDULED_LEAGUES_PER_TICK,
      afterId: null,
    });
    expect(page.leagues.map((league) => league.id)).toEqual(["pilot"]);
    expect(page.nextAfterId).toBe("pilot");
    expect(page.hasDeferred).toBe(false);
  });
});

describe("parseScheduledLeagueCursor", () => {
  it("treats missing and corrupt cursor values as the start of the list", () => {
    expect(parseScheduledLeagueCursor(null)).toBeNull();
    expect(parseScheduledLeagueCursor("")).toBeNull();
    expect(parseScheduledLeagueCursor("not-json")).toBeNull();
    expect(parseScheduledLeagueCursor("[]")).toBeNull();
    expect(parseScheduledLeagueCursor("{\"afterId\":1}")).toBeNull();
    expect(parseScheduledLeagueCursor("{\"afterId\":\"\"}")).toBeNull();
    expect(parseScheduledLeagueCursor("{\"afterId\":\"league_next\"}")).toBe("league_next");
  });
});

describe("handleScheduled", () => {
  beforeEach(async () => {
    await clearScheduledCursor();
  });

  afterEach(async () => {
    await clearScheduledCursor();
  });

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

    const activeCount = (await listActiveLeagues(env.DB)).length;
    const result = await handleScheduled(env, POLL_NOW, activeCount);

    expect(result.polled).toBe(activeCount);
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
    // Optional on Env: only assert leftover-env DO emptiness when a non-blank value is
    // actually configured. Do not fall back to V1_LEAGUE_ID or the fixture placeholder.
    const leftoverPilotSleeperId = env.PILOT_SLEEPER_LEAGUE_ID?.trim();
    if (leftoverPilotSleeperId) {
      expect(await settingKeys(leftoverPilotSleeperId)).toEqual([]);
    }
  });

  it("polls every active league on Tuesday 9:00 America/New_York and publishes no recap when no week is final", async () => {
    const now = 1_805_200_000_000;
    const league = await seedLeague("recap_active", now, "active");

    const activeCount = (await listActiveLeagues(env.DB)).length;
    const result = await handleScheduled(env, RECAP_NOW, activeCount);

    expect(result.polled).toBe(activeCount);
    expect(result.recapped).toBe(0);
    const dashboard = await env.LEAGUE_BRAIN.getByName(league.id).getDashboard();
    expect(dashboard.leagueId).toBe(league.id);
  });

  it("counts a published recap once and reports recapped 0 on a second Tuesday 9:00 tick", async () => {
    const now = 1_805_400_000_000;
    const league = await seedLeague("recap_once", now, "active");

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const published = new Set<string>();
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      if (dashboard.leagueId !== league.id) {
        return { status: "skipped_not_final" };
      }
      if (published.has(league.id)) {
        return { status: "skipped_already" };
      }
      published.add(league.id);
      return { status: "published", recap: { subject: "Week 3 recap", body: "The chat survived." } };
    };

    try {
      const activeCount = (await listActiveLeagues(env.DB)).length;
      const first = await handleScheduled(env, RECAP_NOW, activeCount);
      expect(first.recapped).toBe(1);
      const second = await handleScheduled(env, RECAP_NOW, activeCount);
      expect(second.recapped).toBe(0);
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("isolates per-league failures so one throwing poll does not prevent others", async () => {
    const now = 1_805_300_000_000;
    const failing = await seedLeague("failing", now, "active");
    const surviving = await seedLeague("surviving", now + 50, "active");

    const originalPoll = LeagueBrain.prototype.poll;
    const originalError = console.error;
    const errors: unknown[][] = [];
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      if (dashboard.leagueId === failing.id) {
        throw new Error("boom from failing league");
      }
      return originalPoll.call(this);
    };
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const activeCount = (await listActiveLeagues(env.DB)).length;
      const result = await handleScheduled(env, POLL_NOW, activeCount);
      expect(result.polled).toBe(activeCount - 1);
      expect(errors).toHaveLength(1);
      const survived = await env.LEAGUE_BRAIN.getByName(surviving.id).getDashboard();
      expect(survived.leagueId).toBe(surviving.id);
      expect(survived.week).not.toBeNull();
      expect(await getDashboardOrNull(env.LEAGUE_BRAIN.getByName(failing.id))).not.toBeNull();
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      console.error = originalError;
    }
  });

  it("caps Durable Object work, persists a D1 cursor, and warns once when leagues remain", async () => {
    await seedLeague("cursor_a", 1_805_500_000_000, "active");
    await seedLeague("cursor_b", 1_805_500_000_100, "active");
    await seedLeague("cursor_c", 1_805_500_000_200, "active");
    await putAppState("scheduled-test:keep", "1");

    const originalPoll = LeagueBrain.prototype.poll;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    LeagueBrain.prototype.poll = async () => ({ wroteBeat: false, hash: "test", facts: 0 });
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const first = await handleScheduled(env, POLL_NOW, 2);
      expect(first.polled).toBe(2);
      expect(first.recapped).toBe(0);

      expect(await env.PLAYERS.get(SCHEDULED_LEAGUE_CURSOR_KEY)).toBeNull();
      const raw1 = await scheduledCursorValue();
      const cursor1 = parseScheduledLeagueCursor(raw1);
      expect(cursor1).not.toBeNull();
      expect(raw1).toBe(JSON.stringify({ afterId: cursor1 }));
      expect(warnings).toHaveLength(1);
      const payload = JSON.parse(String(warnings[0]?.[0])) as Record<string, unknown>;
      expect(payload).toEqual({
        event: "scheduled.leagues.deferred",
        processed: 2,
        limit: 2,
      });
      expect(JSON.stringify(payload).toLowerCase()).not.toContain("sleeper");

      const second = await handleScheduled(env, POLL_NOW, 2);
      expect(second.polled).toBe(2);
      expect(await env.PLAYERS.get(SCHEDULED_LEAGUE_CURSOR_KEY)).toBeNull();
      const cursor2 = parseScheduledLeagueCursor(await scheduledCursorValue());
      expect(cursor2).not.toBeNull();
      expect(cursor2).not.toBe(cursor1);
      expect(warnings).toHaveLength(2);
      const kept = await env.DB
        .prepare("SELECT value FROM app_state WHERE key = ?")
        .bind("scheduled-test:keep")
        .first<{ value: string }>();
      expect(kept?.value).toBe("1");
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      console.warn = originalWarn;
      await env.DB.prepare("DELETE FROM app_state WHERE key = ?").bind("scheduled-test:keep").run();
    }
  });

  it("ignores a corrupt D1 cursor and still processes a bounded page", async () => {
    await seedLeague("corrupt_cursor", 1_805_600_000_000, "active");
    await putAppState(SCHEDULED_LEAGUE_CURSOR_KEY, "!!!corrupt");

    const originalPoll = LeagueBrain.prototype.poll;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    LeagueBrain.prototype.poll = async () => ({ wroteBeat: false, hash: "test", facts: 0 });
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const result = await handleScheduled(env, POLL_NOW, 1);
      expect(result.polled).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(await env.PLAYERS.get(SCHEDULED_LEAGUE_CURSOR_KEY)).toBeNull();
      const stored = await scheduledCursorValue();
      expect(stored).not.toBe("!!!corrupt");
      expect(parseScheduledLeagueCursor(stored)).not.toBeNull();
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      console.warn = originalWarn;
    }
  });
});
