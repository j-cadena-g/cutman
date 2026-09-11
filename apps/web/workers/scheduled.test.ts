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
import {
  EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS,
  explorerOriginQuotaHourKey,
} from "../app/lib/explorer-origin-quota.server.ts";
import { LeagueBrain } from "./league-brain.ts";
import {
  easternRecapWeekKey,
  handleScheduled,
  MAX_RECAP_ATTEMPTS,
  MAX_SCHEDULED_LEAGUES_PER_TICK,
  parseRecapEnrollmentState,
  parseScheduledLeagueCursor,
  SCHEDULED_LEAGUE_CURSOR_KEY,
  SCHEDULED_RECAP_ENROLLMENT_KEY,
  scheduledFailureReason,
  scheduledPollHourLimits,
  selectScheduledLeaguePage,
  STALE_RECAP_ATTEMPT_SWEEP_LIMIT,
  type RecapEnrollmentState,
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
// Next Tuesday 9:00 America/New_York — following recap week.
const NEXT_RECAP_NOW = new Date("2026-09-15T13:00:00.000Z");
// Next Tuesday 10:00 America/New_York — neither poll nor recap.
const NEXT_IDLE_NOW = new Date("2026-09-15T14:00:00.000Z");
const RECAP_WEEK_KEY = "2026-09-08";
const NEXT_RECAP_WEEK_KEY = "2026-09-15";

async function clearScheduledCursor(): Promise<void> {
  await env.DB.prepare("DELETE FROM app_state WHERE key = ?").bind(SCHEDULED_LEAGUE_CURSOR_KEY).run();
}

async function clearRecapEnrollment(): Promise<void> {
  await env.DB.prepare("DELETE FROM app_state WHERE key = ?").bind(SCHEDULED_RECAP_ENROLLMENT_KEY).run();
}

async function clearRecapBacklog(): Promise<void> {
  await env.DB.prepare("DELETE FROM recap_attempt_backlog").run();
}

async function recapEnrollmentState(): Promise<RecapEnrollmentState | null> {
  const row = await env.DB
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(SCHEDULED_RECAP_ENROLLMENT_KEY)
    .first<{ value: string }>();
  return parseRecapEnrollmentState(row?.value ?? null);
}

async function backlogCount(weekKey: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM recap_attempt_backlog WHERE week_key = ?")
    .bind(weekKey)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function backlogRows(
  weekKey: string,
  leagueIds: string[],
): Promise<Array<{ league_id: string; status: string; attempts: number; last_error: string | null }>> {
  const placeholders = leagueIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT league_id, status, attempts, last_error FROM recap_attempt_backlog
     WHERE week_key = ? AND league_id IN (${placeholders})
     ORDER BY league_id`,
  )
    .bind(weekKey, ...leagueIds)
    .all<{ league_id: string; status: string; attempts: number; last_error: string | null }>();
  return result.results;
}

async function pendingBelowCapCount(weekKey: string, leagueIds?: string[]): Promise<number> {
  if (leagueIds && leagueIds.length > 0) {
    const placeholders = leagueIds.map(() => "?").join(", ");
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM recap_attempt_backlog
       WHERE week_key = ? AND status = 'pending' AND attempts < ? AND league_id IN (${placeholders})`,
    )
      .bind(weekKey, MAX_RECAP_ATTEMPTS, ...leagueIds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM recap_attempt_backlog
     WHERE week_key = ? AND status = 'pending' AND attempts < ?`,
  )
    .bind(weekKey, MAX_RECAP_ATTEMPTS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function drainTickBudget(leagueCount: number, limit: number): number {
  const n = Math.max(leagueCount, 1);
  const enrollTicks = Math.ceil(n / limit);
  const attemptTicks = Math.ceil((n * MAX_RECAP_ATTEMPTS) / limit);
  return enrollTicks + attemptTicks + 8;
}

async function drainUntilBacklogDone(
  weekKey: string,
  leagueIds: string[],
  limit: number,
  now: Date,
): Promise<void> {
  const maxTicks = drainTickBudget((await listActiveLeagues(env.DB)).length, limit);
  for (let ticks = 0; ticks < maxTicks; ticks += 1) {
    const rows = await backlogRows(weekKey, leagueIds);
    if (rows.length === leagueIds.length && rows.every((row) => row.status === "done")) {
      return;
    }
    await handleScheduled(env, now, limit);
  }
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

async function insertPendingRecap(leagueId: string, weekKey: string, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO recap_attempt_backlog (league_id, week_key, status, attempts, last_error, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, NULL, ?, ?)`,
  )
    .bind(leagueId, weekKey, now, now)
    .run();
}

async function completeRecapEnrollment(weekKey: string): Promise<void> {
  await putAppState(
    SCHEDULED_RECAP_ENROLLMENT_KEY,
    JSON.stringify({ weekKey, afterId: null, complete: true }),
  );
}

/** Keep first/all/raw on intercepted D1 statements; override only bind and run. */
function overridePreparedBindRun(
  statement: D1PreparedStatement,
  run: (bound: D1PreparedStatement) => ReturnType<D1PreparedStatement["run"]>,
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, prop, receiver) {
      if (prop === "bind") {
        return (...values: unknown[]) => {
          const bound = target.bind(...values);
          return new Proxy(bound, {
            get(boundTarget, boundProp, boundReceiver) {
              if (boundProp === "run") {
                return () => run(boundTarget);
              }
              const boundValue = Reflect.get(boundTarget, boundProp, boundReceiver);
              return typeof boundValue === "function" ? boundValue.bind(boundTarget) : boundValue;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function setCursorBeforeLeague(leagueId: string): Promise<void> {
  const allActive = await listActiveLeagues(env.DB, { limit: 10_000 });
  const idx = allActive.findIndex((league) => league.id === leagueId);
  if (idx < 0) throw new Error("expected league to be active");
  if (idx === 0) {
    await clearScheduledCursor();
    return;
  }
  const previous = allActive[idx - 1];
  if (!previous) throw new Error("expected predecessor league");
  await putAppState(SCHEDULED_LEAGUE_CURSOR_KEY, JSON.stringify({ afterId: previous.id }));
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

describe("scheduledPollHourLimits", () => {
  it("gives regular polling the only slot when maxLeagues is 1", () => {
    expect(scheduledPollHourLimits(1)).toEqual({ backlogLimit: 0, pollLimit: 1 });
  });

  it("splits capacity between backlog and regular polling when maxLeagues is greater than 1", () => {
    expect(scheduledPollHourLimits(2)).toEqual({ backlogLimit: 1, pollLimit: 1 });
    expect(scheduledPollHourLimits(3)).toEqual({ backlogLimit: 1, pollLimit: 2 });
    expect(scheduledPollHourLimits(10)).toEqual({ backlogLimit: 5, pollLimit: 5 });
  });

  it("rejects a non-positive page limit", () => {
    expect(() => scheduledPollHourLimits(0)).toThrow(/positive integer/);
    expect(() => scheduledPollHourLimits(1.5)).toThrow(/positive integer/);
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

describe("scheduledFailureReason", () => {
  it("maps Error to error and anything else to unknown", () => {
    expect(scheduledFailureReason(new Error("secret detail"))).toBe("error");
    expect(scheduledFailureReason("secret detail")).toBe("unknown");
    expect(scheduledFailureReason(null)).toBe("unknown");
    expect(scheduledFailureReason({ message: "secret detail" })).toBe("unknown");
  });
});

describe("parseRecapEnrollmentState", () => {
  it("treats missing and corrupt enrollment values as unset", () => {
    expect(parseRecapEnrollmentState(null)).toBeNull();
    expect(parseRecapEnrollmentState("")).toBeNull();
    expect(parseRecapEnrollmentState("not-json")).toBeNull();
    expect(parseRecapEnrollmentState("[]")).toBeNull();
    expect(parseRecapEnrollmentState("{\"weekKey\":1,\"complete\":false}")).toBeNull();
    expect(parseRecapEnrollmentState("{\"weekKey\":\"\",\"complete\":false}")).toBeNull();
    expect(parseRecapEnrollmentState("{\"weekKey\":\"2026-09-08\",\"complete\":\"yes\"}")).toBeNull();
    expect(parseRecapEnrollmentState("{\"weekKey\":\"2026-09-08\",\"complete\":false,\"afterId\":1}")).toBeNull();
    expect(parseRecapEnrollmentState("{\"weekKey\":\"2026-09-08\",\"complete\":false}")).toEqual({
      weekKey: "2026-09-08",
      afterId: null,
      complete: false,
    });
    expect(
      parseRecapEnrollmentState("{\"weekKey\":\"2026-09-08\",\"afterId\":\"league_next\",\"complete\":true}"),
    ).toEqual({
      weekKey: "2026-09-08",
      afterId: "league_next",
      complete: true,
    });
  });
});

describe("handleScheduled", () => {
  beforeEach(async () => {
    await clearScheduledCursor();
    await clearRecapEnrollment();
    await clearRecapBacklog();
  });

  afterEach(async () => {
    await clearScheduledCursor();
    await clearRecapEnrollment();
    await clearRecapBacklog();
  });

  it("uses poll/recap windows in America/New_York", () => {
    expect(shouldPoll(easternParts(POLL_NOW))).toBe(true);
    expect(shouldAttemptTuesdayRecap(easternParts(POLL_NOW))).toBe(false);
    expect(shouldPoll(easternParts(RECAP_NOW))).toBe(true);
    expect(shouldAttemptTuesdayRecap(easternParts(RECAP_NOW))).toBe(true);
    expect(shouldPoll(easternParts(IDLE_NOW))).toBe(false);
    expect(shouldAttemptTuesdayRecap(easternParts(IDLE_NOW))).toBe(false);
    expect(shouldPoll(easternParts(NEXT_IDLE_NOW))).toBe(false);
    expect(shouldAttemptTuesdayRecap(easternParts(NEXT_IDLE_NOW))).toBe(false);
  });

  it("does nothing when it is not a poll or recap hour", async () => {
    await seedLeague("idle_active", 1_805_000_000_000, "active");
    const result = await handleScheduled(env, IDLE_NOW);
    expect(result).toEqual({ polled: 0, recapped: 0 });
  });

  it("sweeps stale explorer origin quota rows on idle hours and keeps the current hour", async () => {
    const nowMs = IDLE_NOW.getTime();
    const currentHour = explorerOriginQuotaHourKey(nowMs);
    const staleUser = `sched_stale_${crypto.randomUUID()}`;
    const freshUser = `sched_fresh_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO explorer_origin_quota (clerk_user_id, hour_key, used) VALUES (?, ?, 1)",
    )
      .bind(staleUser, currentHour - EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS - 1)
      .run();
    await env.DB.prepare(
      "INSERT INTO explorer_origin_quota (clerk_user_id, hour_key, used) VALUES (?, ?, 2)",
    )
      .bind(freshUser, currentHour)
      .run();

    const result = await handleScheduled(env, IDLE_NOW);
    expect(result).toEqual({ polled: 0, recapped: 0 });
    expect(
      await env.DB.prepare("SELECT clerk_user_id FROM explorer_origin_quota WHERE clerk_user_id = ?")
        .bind(staleUser)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT hour_key, used FROM explorer_origin_quota WHERE clerk_user_id = ?")
        .bind(freshUser)
        .first<{ hour_key: number; used: number }>(),
    ).toEqual({ hour_key: currentHour, used: 2 });
  });

  it("continues polling when the stale explorer origin quota sweep throws", async () => {
    const now = 1_805_050_000_000;
    const league = await seedLeague("quota_sweep_throw", now, "active");
    await setCursorBeforeLeague(league.id);

    const polledIds: string[] = [];
    const originalPoll = LeagueBrain.prototype.poll;
    const originalError = console.error;
    const errors: unknown[][] = [];
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    const originalPrepare = env.DB.prepare.bind(env.DB);
    const wrappedDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            const statement = originalPrepare(query);
            if (!query.includes("DELETE FROM explorer_origin_quota")) {
              return statement;
            }
            return overridePreparedBindRun(statement, async () => {
              throw new Error("sweep boom");
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const scheduledEnv = new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === "DB") return wrappedDb;
        return Reflect.get(target, prop, receiver);
      },
    }) as Env;

    try {
      const result = await handleScheduled(scheduledEnv, POLL_NOW, 1);
      expect(result.polled).toBe(1);
      expect(result.recapped).toBe(0);
      expect(polledIds).toContain(league.id);
      expect(errors).toHaveLength(1);
      const payload = JSON.parse(String(errors[0]?.[0])) as Record<string, unknown>;
      expect(payload).toEqual({ event: "scheduled.league.failed", reason: "error" });
      const serialized = JSON.stringify(errors);
      expect(serialized).not.toContain(league.id);
      expect(serialized).not.toContain("sweep boom");
      expect(await scheduledCursorValue()).toBe(JSON.stringify({ afterId: league.id }));
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      console.error = originalError;
    }
  });

  it("continues polling when the stale recap attempt sweep throws", async () => {
    const now = 1_805_051_000_000;
    const league = await seedLeague("stale_recap_sweep_throw", now, "active");
    await setCursorBeforeLeague(league.id);

    const polledIds: string[] = [];
    const originalPoll = LeagueBrain.prototype.poll;
    const originalError = console.error;
    const errors: unknown[][] = [];
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    const originalPrepare = env.DB.prepare.bind(env.DB);
    const wrappedDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            const statement = originalPrepare(query);
            if (
              !query.includes("DELETE FROM recap_attempt_backlog") ||
              !query.includes("week_key")
            ) {
              return statement;
            }
            return overridePreparedBindRun(statement, async () => {
              throw new Error("stale recap sweep boom");
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const scheduledEnv = new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === "DB") return wrappedDb;
        return Reflect.get(target, prop, receiver);
      },
    }) as Env;

    try {
      const result = await handleScheduled(scheduledEnv, POLL_NOW, 1);
      expect(result.polled).toBe(1);
      expect(result.recapped).toBe(0);
      expect(polledIds).toContain(league.id);
      expect(errors).toHaveLength(1);
      const payload = JSON.parse(String(errors[0]?.[0])) as Record<string, unknown>;
      expect(payload).toEqual({ event: "scheduled.league.failed", reason: "error" });
      const serialized = JSON.stringify(errors);
      expect(serialized).not.toContain(league.id);
      expect(serialized).not.toContain("stale recap sweep boom");
      expect(await scheduledCursorValue()).toBe(JSON.stringify({ afterId: league.id }));
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      console.error = originalError;
    }
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
    const recapCalls: string[] = [];
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
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
      expect(recapCalls.filter((id) => id === league.id)).toHaveLength(1);
      const second = await handleScheduled(env, RECAP_NOW, activeCount);
      expect(second.recapped).toBe(0);
      expect(recapCalls.filter((id) => id === league.id)).toHaveLength(1);
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
      const payload = JSON.parse(String(errors[0]?.[0])) as Record<string, unknown>;
      expect(payload).toEqual({ event: "scheduled.league.failed", reason: "error" });
      const serialized = JSON.stringify(errors);
      expect(serialized).not.toContain(failing.id);
      expect(serialized).not.toContain(failing.sleeper_league_id);
      expect(serialized).not.toContain("boom from failing league");
      const survived = await env.LEAGUE_BRAIN.getByName(surviving.id).getDashboard();
      expect(survived.leagueId).toBe(surviving.id);
      expect(survived.week).not.toBeNull();
      expect(await getDashboardOrNull(env.LEAGUE_BRAIN.getByName(failing.id))).not.toBeNull();
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      console.error = originalError;
    }
  });

  it("logs a bounded error reason without the thrown payload or league ids", async () => {
    const now = 1_805_350_000_000;
    const failing = await seedLeague("failing_unknown", now, "active");

    const originalPoll = LeagueBrain.prototype.poll;
    const originalError = console.error;
    const errors: unknown[][] = [];
    LeagueBrain.prototype.poll = async () => {
      throw "string boom with secret";
    };
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const result = await handleScheduled(env, POLL_NOW, 1);
      expect(result.polled).toBe(0);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.parse(String(errors[0]?.[0])) as Record<string, unknown>;
      expect(payload.event).toBe("scheduled.league.failed");
      expect(payload.reason === "error" || payload.reason === "unknown").toBe(true);
      const serialized = JSON.stringify(errors);
      expect(serialized).not.toContain(failing.id);
      expect(serialized).not.toContain(failing.sleeper_league_id);
      expect(serialized).not.toContain("string boom");
      expect(serialized).not.toContain("secret");
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
    // Two active leagues so hasDeferred (and the warning) do not depend on leftover D1 rows.
    await seedLeague("corrupt_cursor_a", 1_805_600_000_000, "active");
    await seedLeague("corrupt_cursor_b", 1_805_600_000_100, "active");
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

describe("easternRecapWeekKey", () => {
  it("keys the recap week to the most recent Tuesday in America/New_York", () => {
    expect(easternRecapWeekKey(RECAP_NOW)).toBe(RECAP_WEEK_KEY);
    expect(easternRecapWeekKey(IDLE_NOW)).toBe(RECAP_WEEK_KEY);
    expect(easternRecapWeekKey(POLL_NOW)).toBe(RECAP_WEEK_KEY);
    expect(easternRecapWeekKey(NEXT_RECAP_NOW)).toBe(NEXT_RECAP_WEEK_KEY);
    expect(easternRecapWeekKey(NEXT_IDLE_NOW)).toBe(NEXT_RECAP_WEEK_KEY);
  });
});

describe("handleScheduled recap backlog", () => {
  beforeEach(async () => {
    await clearScheduledCursor();
    await clearRecapEnrollment();
    await clearRecapBacklog();
  });

  afterEach(async () => {
    await clearScheduledCursor();
    await clearRecapEnrollment();
    await clearRecapBacklog();
  });

  it("attempts each deferred league once across later ticks and counts published exactly once", async () => {
    const now = 1_805_800_000_000;
    const ours = [
      await seedLeague("backlog_a", now, "active"),
      await seedLeague("backlog_b", now + 1, "active"),
      await seedLeague("backlog_c", now + 2, "active"),
    ];
    const oursIds = new Set(ours.map((league) => league.id));
    const recapCalls: string[] = [];
    const published = new Set<string>();

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      if (!oursIds.has(dashboard.leagueId)) {
        return { status: "skipped_not_final" };
      }
      if (published.has(dashboard.leagueId)) {
        return { status: "skipped_already" };
      }
      published.add(dashboard.leagueId);
      return { status: "published", recap: { subject: "Week recap", body: "Covered." } };
    };

    try {
      const limit = 2;
      const first = await handleScheduled(env, RECAP_NOW, limit);
      expect(first.polled).toBe(limit);
      expect(first.recapped).toBeLessThanOrEqual(limit);
      expect(first.recapped).toBe(Math.min(published.size, limit));
      expect(published.size).toBeLessThan(oursIds.size);

      const oursLeagueIds = ours.map((league) => league.id);
      const enrolledAfterFirst = await backlogCount(RECAP_WEEK_KEY);
      expect(enrolledAfterFirst).toBeGreaterThan(0);
      expect(enrolledAfterFirst).toBeLessThanOrEqual(limit);
      const rowsAfterFirst = await backlogRows(RECAP_WEEK_KEY, oursLeagueIds);
      expect(rowsAfterFirst.length).toBeLessThanOrEqual(limit);
      expect(rowsAfterFirst.length).toBeLessThan(oursIds.size);

      let recappedTotal = first.recapped;
      const activeCount = (await listActiveLeagues(env.DB)).length;
      const maxTicks = drainTickBudget(activeCount, limit);
      let ticks = 1;
      while (published.size < oursIds.size && ticks < maxTicks) {
        const later = await handleScheduled(env, IDLE_NOW, limit);
        recappedTotal += later.recapped;
        ticks += 1;
      }
      expect(published).toEqual(oursIds);
      expect(recappedTotal).toBe(3);
      for (const id of oursIds) {
        expect(recapCalls.filter((call) => call === id)).toHaveLength(1);
      }

      const rowsAfterDrain = await backlogRows(RECAP_WEEK_KEY, oursLeagueIds);
      expect(rowsAfterDrain.every((row) => row.status === "done")).toBe(true);
      expect(rowsAfterDrain.every((row) => row.attempts === 1)).toBe(true);
      expect(rowsAfterDrain.every((row) => row.last_error === null)).toBe(true);

      while (ticks < maxTicks + 20) {
        if ((await pendingBelowCapCount(RECAP_WEEK_KEY)) === 0) break;
        const later = await handleScheduled(env, IDLE_NOW, limit);
        expect(later.recapped).toBe(0);
        ticks += 1;
      }

      const extra = await handleScheduled(env, IDLE_NOW, limit);
      expect(extra).toEqual({ polled: 0, recapped: 0 });
      for (const id of oursIds) {
        expect(recapCalls.filter((call) => call === id)).toHaveLength(1);
      }
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("settles blank and skipped_already as done after one attempt with safe reason codes", async () => {
    const now = 1_805_810_000_000;
    const blank = await seedLeague("backlog_blank", now, "active");
    const already = await seedLeague("backlog_skipped_already", now + 1, "active");
    const recapCalls: string[] = [];

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      if (dashboard.leagueId === blank.id) return { status: "blank" };
      if (dashboard.leagueId === already.id) return { status: "skipped_already" };
      return { status: "skipped_not_final" };
    };

    try {
      const limit = 2;
      const first = await handleScheduled(env, RECAP_NOW, limit);
      expect(first.recapped).toBe(0);
      const targetIds = [blank.id, already.id];
      const attempted = () => recapCalls.filter((id) => targetIds.includes(id));
      await drainUntilBacklogDone(RECAP_WEEK_KEY, targetIds, limit, IDLE_NOW);

      expect(new Set(attempted()).size).toBe(2);
      expect(attempted()).toHaveLength(2);
      const rows = await backlogRows(RECAP_WEEK_KEY, targetIds);
      expect(rows.find((row) => row.league_id === blank.id)).toMatchObject({
        status: "done",
        attempts: 1,
        last_error: "blank",
      });
      expect(rows.find((row) => row.league_id === already.id)).toMatchObject({
        status: "done",
        attempts: 1,
        last_error: "skipped_already",
      });

      const extra = await handleScheduled(env, IDLE_NOW, limit);
      expect(extra.recapped).toBe(0);
      expect(attempted()).toHaveLength(2);
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("retries skipped_not_final, model_error, and thrown until the cap then marks done", async () => {
    const now = 1_805_811_000_000;
    const notFinal = await seedLeague("backlog_not_final", now, "active");
    const failing = await seedLeague("backlog_throw", now + 1, "active");
    const modelError = await seedLeague("backlog_model_error", now + 2, "active");
    const recapCalls: string[] = [];

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const originalError = console.error;
    const errors: unknown[][] = [];
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      if (dashboard.leagueId === failing.id) {
        throw new Error("recap boom with secret detail");
      }
      if (dashboard.leagueId === modelError.id) {
        return { status: "model_error", error: "gemma failed with prompt leak" };
      }
      if (dashboard.leagueId === notFinal.id) {
        return { status: "skipped_not_final" };
      }
      return { status: "skipped_not_final" };
    };
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const limit = 2;
      const targetIds = [notFinal.id, failing.id, modelError.id];
      const first = await handleScheduled(env, RECAP_NOW, limit);
      expect(first.recapped).toBe(0);

      const attempted = () => recapCalls.filter((id) => targetIds.includes(id));
      await drainUntilBacklogDone(RECAP_WEEK_KEY, targetIds, limit, IDLE_NOW);

      expect(new Set(attempted()).size).toBe(3);
      expect(attempted()).toHaveLength(MAX_RECAP_ATTEMPTS * 3);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      for (const entry of errors) {
        const payload = JSON.parse(String(entry[0])) as Record<string, unknown>;
        expect(payload).toEqual({ event: "scheduled.league.failed", reason: "error" });
      }
      const errorSerialized = JSON.stringify(errors);
      expect(errorSerialized).not.toContain(failing.id);
      expect(errorSerialized).not.toContain(failing.sleeper_league_id);
      expect(errorSerialized).not.toContain("recap boom");
      expect(errorSerialized).not.toContain("secret detail");

      const rows = await backlogRows(RECAP_WEEK_KEY, targetIds);
      expect(rows.find((row) => row.league_id === notFinal.id)).toMatchObject({
        status: "done",
        attempts: MAX_RECAP_ATTEMPTS,
        last_error: "skipped_not_final",
      });
      expect(rows.find((row) => row.league_id === failing.id)).toMatchObject({
        status: "done",
        attempts: MAX_RECAP_ATTEMPTS,
        last_error: "thrown",
      });
      expect(rows.find((row) => row.league_id === modelError.id)).toMatchObject({
        status: "done",
        attempts: MAX_RECAP_ATTEMPTS,
        last_error: "model_error",
      });
      expect(rows.every((row) => row.attempts === MAX_RECAP_ATTEMPTS)).toBe(true);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain("recap boom");
      expect(serialized).not.toContain("secret detail");
      expect(serialized).not.toContain("gemma failed");
      expect(serialized).not.toContain("prompt leak");

      const extra = await handleScheduled(env, IDLE_NOW, limit);
      expect(extra.recapped).toBe(0);
      expect(attempted()).toHaveLength(MAX_RECAP_ATTEMPTS * 3);
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
      console.error = originalError;
    }
  });

  it("publishes on a later tick after skipped_not_final and does not republish", async () => {
    const now = 1_805_812_000_000;
    const league = await seedLeague("backlog_retry_then_publish", now, "active");
    const recapCalls: string[] = [];
    let weekFinal = false;
    const published = new Set<string>();

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      if (dashboard.leagueId !== league.id) {
        return { status: "skipped_not_final" };
      }
      if (!weekFinal) return { status: "skipped_not_final" };
      if (published.has(league.id)) return { status: "skipped_already" };
      published.add(league.id);
      return { status: "published", recap: { subject: "Week recap", body: "Now final." } };
    };

    try {
      const activeCount = (await listActiveLeagues(env.DB)).length;
      const first = await handleScheduled(env, RECAP_NOW, activeCount);
      expect(first.recapped).toBe(0);
      expect(recapCalls.filter((id) => id === league.id)).toHaveLength(1);
      const [afterRetryable] = await backlogRows(RECAP_WEEK_KEY, [league.id]);
      expect(afterRetryable).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error: "skipped_not_final",
      });

      weekFinal = true;
      const limit = 2;
      const maxTicks = drainTickBudget((await listActiveLeagues(env.DB)).length, limit);
      let recappedTotal = 0;
      for (let ticks = 0; ticks < maxTicks && (await pendingBelowCapCount(RECAP_WEEK_KEY, [league.id])) > 0; ticks += 1) {
        const later = await handleScheduled(env, IDLE_NOW, limit);
        recappedTotal += later.recapped;
      }
      expect(recappedTotal).toBe(1);
      expect(published).toEqual(new Set([league.id]));
      const [done] = await backlogRows(RECAP_WEEK_KEY, [league.id]);
      expect(done).toMatchObject({ status: "done", attempts: 2, last_error: null });

      const extra = await handleScheduled(env, IDLE_NOW, limit);
      expect(extra.recapped).toBe(0);
      expect(recapCalls.filter((id) => id === league.id)).toHaveLength(2);
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("on a poll hour with pending backlog, splits work, polls the rotation page, and advances the regular cursor", async () => {
    const now = 1_805_814_000_000;
    const backlogA = await seedLeague("poll_backlog_a", now, "active");
    const backlogB = await seedLeague("poll_backlog_b", now + 1, "active");
    const backlogC = await seedLeague("poll_backlog_c", now + 2, "active");
    const rotate = await seedLeague("poll_backlog_rotate", now + 3, "active");
    const oursIds = [backlogA.id, backlogB.id, backlogC.id, rotate.id];
    const backlogIds = [backlogA.id, backlogB.id, backlogC.id].sort();
    const expectedBacklogId = backlogIds[0];
    const deferredBacklogIds = backlogIds.slice(1);
    if (expectedBacklogId === undefined || deferredBacklogIds.length !== 2) {
      throw new Error("expected three backlog league ids");
    }
    await setCursorBeforeLeague(rotate.id);
    for (const league of [backlogA, backlogB, backlogC]) {
      await insertPendingRecap(league.id, RECAP_WEEK_KEY, now);
    }

    const touchedIds: string[] = [];
    const polledIds: string[] = [];
    const recapIds: string[] = [];
    const originalBootstrap = LeagueBrain.prototype.bootstrap;
    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.bootstrap = async function (this: LeagueBrain, input) {
      touchedIds.push(input.leagueId);
      return originalBootstrap.call(this, input);
    };
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapIds.push(dashboard.leagueId);
      return { status: "skipped_not_final" };
    };

    try {
      const limit = 2;
      const result = await handleScheduled(env, POLL_NOW, limit);
      expect(result.polled).toBeLessThanOrEqual(limit);
      expect(result.recapped).toBe(0);
      expect(new Set(touchedIds).size).toBe(touchedIds.length);
      expect(touchedIds.length).toBeLessThanOrEqual(limit);
      expect(polledIds).toContain(rotate.id);
      expect(polledIds).toContain(expectedBacklogId);
      expect(recapIds).toEqual([expectedBacklogId]);
      for (const deferredId of deferredBacklogIds) {
        expect(polledIds).not.toContain(deferredId);
        expect(recapIds).not.toContain(deferredId);
      }

      expect(await scheduledCursorValue()).toBe(JSON.stringify({ afterId: rotate.id }));
      expect(await env.PLAYERS.get(SCHEDULED_LEAGUE_CURSOR_KEY)).toBeNull();

      const rows = await backlogRows(RECAP_WEEK_KEY, oursIds);
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.league_id === expectedBacklogId)).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error: "skipped_not_final",
      });
      for (const deferredId of deferredBacklogIds) {
        expect(rows.find((row) => row.league_id === deferredId)).toMatchObject({
          status: "pending",
          attempts: 0,
          last_error: null,
        });
      }
      expect(rows.some((row) => row.league_id === rotate.id)).toBe(false);
    } finally {
      LeagueBrain.prototype.bootstrap = originalBootstrap;
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("on a poll hour, overlapping backlog and rotation leagues poll once and recap once", async () => {
    const now = 1_805_814_100_000;
    const league = await seedLeague("poll_overlap", now, "active");
    await insertPendingRecap(league.id, RECAP_WEEK_KEY, now);
    await setCursorBeforeLeague(league.id);

    const touchedIds: string[] = [];
    const polledIds: string[] = [];
    const recapIds: string[] = [];
    const originalBootstrap = LeagueBrain.prototype.bootstrap;
    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.bootstrap = async function (this: LeagueBrain, input) {
      touchedIds.push(input.leagueId);
      return originalBootstrap.call(this, input);
    };
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapIds.push(dashboard.leagueId);
      return { status: "skipped_not_final" };
    };

    try {
      const limit = 2;
      const result = await handleScheduled(env, POLL_NOW, limit);
      expect(result).toEqual({ polled: 1, recapped: 0 });
      expect(touchedIds.filter((id) => id === league.id)).toHaveLength(1);
      expect(polledIds.filter((id) => id === league.id)).toHaveLength(1);
      expect(recapIds).toEqual([league.id]);
      expect(await scheduledCursorValue()).toBe(JSON.stringify({ afterId: league.id }));
      const [row] = await backlogRows(RECAP_WEEK_KEY, [league.id]);
      expect(row).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error: "skipped_not_final",
      });
    } finally {
      LeagueBrain.prototype.bootstrap = originalBootstrap;
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("on a poll hour, non-overlapping backlog and rotation leagues stay within the total cap", async () => {
    const now = 1_805_814_200_000;
    const backlogLeague = await seedLeague("poll_split_backlog", now, "active");
    const pollLeague = await seedLeague("poll_split_rotate", now + 1, "active");
    await insertPendingRecap(backlogLeague.id, RECAP_WEEK_KEY, now);
    await setCursorBeforeLeague(pollLeague.id);

    const touchedIds: string[] = [];
    const polledIds: string[] = [];
    const recapIds: string[] = [];
    const originalBootstrap = LeagueBrain.prototype.bootstrap;
    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.bootstrap = async function (this: LeagueBrain, input) {
      touchedIds.push(input.leagueId);
      return originalBootstrap.call(this, input);
    };
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapIds.push(dashboard.leagueId);
      return { status: "skipped_not_final" };
    };

    try {
      const limit = 2;
      const result = await handleScheduled(env, POLL_NOW, limit);
      expect(result).toEqual({ polled: 2, recapped: 0 });
      expect(new Set(touchedIds).size).toBe(2);
      expect(touchedIds).toHaveLength(2);
      expect(polledIds).toEqual(expect.arrayContaining([pollLeague.id, backlogLeague.id]));
      expect(recapIds).toEqual([backlogLeague.id]);
      expect(await scheduledCursorValue()).toBe(JSON.stringify({ afterId: pollLeague.id }));
    } finally {
      LeagueBrain.prototype.bootstrap = originalBootstrap;
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("on a poll hour with maxLeagues=1, prioritizes regular polling and leaves backlog for idle hours", async () => {
    const now = 1_805_814_300_000;
    const backlogLeague = await seedLeague("poll_max1_backlog", now, "active");
    const pollLeague = await seedLeague("poll_max1_rotate", now + 1, "active");
    await insertPendingRecap(backlogLeague.id, RECAP_WEEK_KEY, now);
    await completeRecapEnrollment(RECAP_WEEK_KEY);
    await setCursorBeforeLeague(pollLeague.id);

    const polledIds: string[] = [];
    const recapIds: string[] = [];
    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapIds.push(dashboard.leagueId);
      if (dashboard.leagueId === backlogLeague.id) {
        return { status: "published", recap: { subject: "Week recap", body: "Idle drain." } };
      }
      return { status: "skipped_not_final" };
    };

    try {
      const pollHour = await handleScheduled(env, POLL_NOW, 1);
      expect(pollHour).toEqual({ polled: 1, recapped: 0 });
      expect(polledIds).toEqual([pollLeague.id]);
      expect(recapIds).toEqual([]);
      expect(await scheduledCursorValue()).toBe(JSON.stringify({ afterId: pollLeague.id }));
      const [stillPending] = await backlogRows(RECAP_WEEK_KEY, [backlogLeague.id]);
      expect(stillPending).toMatchObject({ status: "pending", attempts: 0, last_error: null });

      polledIds.length = 0;
      const idle = await handleScheduled(env, IDLE_NOW, 1);
      expect(idle).toEqual({ polled: 1, recapped: 1 });
      expect(polledIds).toEqual([backlogLeague.id]);
      expect(recapIds).toEqual([backlogLeague.id]);
      expect(await scheduledCursorValue()).toBe(JSON.stringify({ afterId: pollLeague.id }));
      const [done] = await backlogRows(RECAP_WEEK_KEY, [backlogLeague.id]);
      expect(done).toMatchObject({ status: "done", attempts: 1, last_error: null });
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("never touches more than maxLeagues unique Durable Objects on a poll hour with backlog", async () => {
    const now = 1_805_814_400_000;
    const backlog = [
      await seedLeague("poll_cap_backlog_a", now, "active"),
      await seedLeague("poll_cap_backlog_b", now + 1, "active"),
      await seedLeague("poll_cap_backlog_c", now + 2, "active"),
      await seedLeague("poll_cap_backlog_d", now + 3, "active"),
    ];
    const rotate = await seedLeague("poll_cap_rotate", now + 4, "active");
    for (const league of backlog) {
      await insertPendingRecap(league.id, RECAP_WEEK_KEY, now);
    }
    await setCursorBeforeLeague(rotate.id);

    const touchedIds: string[] = [];
    const recapIds: string[] = [];
    const originalBootstrap = LeagueBrain.prototype.bootstrap;
    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.bootstrap = async function (this: LeagueBrain, input) {
      touchedIds.push(input.leagueId);
      return originalBootstrap.call(this, input);
    };
    LeagueBrain.prototype.poll = async () => ({ wroteBeat: false, hash: "test", facts: 0 });
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapIds.push(dashboard.leagueId);
      return { status: "skipped_not_final" };
    };

    try {
      const limit = 4;
      const { pollLimit, backlogLimit } = scheduledPollHourLimits(limit);
      const result = await handleScheduled(env, POLL_NOW, limit);
      expect(result.polled).toBeLessThanOrEqual(limit);
      expect(new Set(touchedIds).size).toBe(touchedIds.length);
      expect(touchedIds.length).toBeLessThanOrEqual(limit);
      expect(touchedIds).toContain(rotate.id);
      expect(recapIds).toHaveLength(backlogLimit);
      expect(new Set(recapIds)).toEqual(
        new Set([...backlog.map((league) => league.id)].sort().slice(0, backlogLimit)),
      );
      expect(parseScheduledLeagueCursor(await scheduledCursorValue())).toBeTruthy();
      expect(pollLimit).toBeGreaterThanOrEqual(1);
    } finally {
      LeagueBrain.prototype.bootstrap = originalBootstrap;
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("on a poll hour, counts a published recap once and retries skipped_not_final on idle", async () => {
    const now = 1_805_814_500_000;
    const publisher = await seedLeague("poll_publish_once", now, "active");
    const retryable = await seedLeague("poll_retry_later", now + 1, "active");
    const rotate = await seedLeague("poll_publish_rotate", now + 2, "active");
    await insertPendingRecap(publisher.id, RECAP_WEEK_KEY, now);
    await insertPendingRecap(retryable.id, RECAP_WEEK_KEY, now);
    await completeRecapEnrollment(RECAP_WEEK_KEY);
    await setCursorBeforeLeague(rotate.id);

    const recapIds: string[] = [];
    const published = new Set<string>();
    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.poll = async () => ({ wroteBeat: false, hash: "test", facts: 0 });
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapIds.push(dashboard.leagueId);
      if (dashboard.leagueId === publisher.id) {
        if (published.has(publisher.id)) return { status: "skipped_already" };
        published.add(publisher.id);
        return { status: "published", recap: { subject: "Week recap", body: "Once." } };
      }
      if (dashboard.leagueId === retryable.id) {
        if (published.has(retryable.id)) return { status: "skipped_already" };
        if (recapIds.filter((id) => id === retryable.id).length === 1) {
          return { status: "skipped_not_final" };
        }
        published.add(retryable.id);
        return { status: "published", recap: { subject: "Week recap", body: "Later." } };
      }
      return { status: "skipped_not_final" };
    };

    try {
      const limit = 2;
      const first = await handleScheduled(env, POLL_NOW, limit);
      expect(first.recapped).toBe(1);
      expect(recapIds.filter((id) => id === publisher.id)).toHaveLength(1);
      expect(recapIds.filter((id) => id === retryable.id)).toHaveLength(0);
      expect(await scheduledCursorValue()).toBe(JSON.stringify({ afterId: rotate.id }));
      const rowsAfterPoll = await backlogRows(RECAP_WEEK_KEY, [publisher.id, retryable.id]);
      expect(rowsAfterPoll.find((row) => row.league_id === publisher.id)).toMatchObject({
        status: "done",
        attempts: 1,
        last_error: null,
      });
      expect(rowsAfterPoll.find((row) => row.league_id === retryable.id)).toMatchObject({
        status: "pending",
        attempts: 0,
        last_error: null,
      });

      const cursorAfterPoll = await scheduledCursorValue();
      const secondPoll = await handleScheduled(env, POLL_NOW, limit);
      expect(secondPoll.recapped).toBe(0);
      expect(recapIds.filter((id) => id === publisher.id)).toHaveLength(1);
      expect(recapIds.filter((id) => id === retryable.id)).toHaveLength(1);
      expect(await scheduledCursorValue()).not.toBe(cursorAfterPoll);
      const [retryPending] = await backlogRows(RECAP_WEEK_KEY, [retryable.id]);
      expect(retryPending).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error: "skipped_not_final",
      });

      const idle = await handleScheduled(env, IDLE_NOW, limit);
      expect(idle.recapped).toBe(1);
      expect(recapIds.filter((id) => id === retryable.id)).toHaveLength(2);
      expect(published).toEqual(new Set([publisher.id, retryable.id]));
      const [retryDone] = await backlogRows(RECAP_WEEK_KEY, [retryable.id]);
      expect(retryDone).toMatchObject({ status: "done", attempts: 2, last_error: null });

      const extraIdle = await handleScheduled(env, IDLE_NOW, limit);
      expect(extraIdle).toEqual({ polled: 0, recapped: 0 });
      expect(recapIds.filter((id) => id === publisher.id)).toHaveLength(1);
      expect(recapIds.filter((id) => id === retryable.id)).toHaveLength(2);
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("does not select pending rows at or above the attempt cap", async () => {
    const now = 1_805_813_000_000;
    const league = await seedLeague("backlog_at_cap", now, "active");
    await env.DB.prepare(
      `INSERT INTO recap_attempt_backlog (league_id, week_key, status, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, 'skipped_not_final', ?, ?)`,
    )
      .bind(league.id, RECAP_WEEK_KEY, MAX_RECAP_ATTEMPTS, now, now)
      .run();
    await completeRecapEnrollment(RECAP_WEEK_KEY);

    const recapCalls: string[] = [];
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      return { status: "published", recap: { subject: "Week recap", body: "Should not publish." } };
    };

    try {
      const extra = await handleScheduled(env, IDLE_NOW, 10);
      expect(extra).toEqual({ polled: 0, recapped: 0 });
      expect(recapCalls).not.toContain(league.id);
      const [still] = await backlogRows(RECAP_WEEK_KEY, [league.id]);
      expect(still).toMatchObject({
        status: "pending",
        attempts: MAX_RECAP_ATTEMPTS,
        last_error: "skipped_not_final",
      });
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("does not re-attempt done rows on a duplicate Tuesday 9:00 invocation", async () => {
    const now = 1_805_820_000_000;
    const league = await seedLeague("backlog_dup_tuesday", now, "active");
    const recapCalls: string[] = [];

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      if (dashboard.leagueId !== league.id) {
        return { status: "skipped_not_final" };
      }
      return { status: "published", recap: { subject: "Week recap", body: "Once." } };
    };

    try {
      const activeCount = (await listActiveLeagues(env.DB)).length;
      const first = await handleScheduled(env, RECAP_NOW, activeCount);
      expect(first.recapped).toBe(1);
      expect(recapCalls.filter((id) => id === league.id)).toHaveLength(1);
      const [done] = await backlogRows(RECAP_WEEK_KEY, [league.id]);
      expect(done).toMatchObject({ status: "done", attempts: 1, last_error: null });

      const second = await handleScheduled(env, RECAP_NOW, activeCount);
      expect(second.recapped).toBe(0);
      expect(recapCalls.filter((id) => id === league.id)).toHaveLength(1);
      const [still] = await backlogRows(RECAP_WEEK_KEY, [league.id]);
      expect(still).toMatchObject({ status: "done", attempts: 1, last_error: null });
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("does not count a published recap when settle throws; catch still settles thrown", async () => {
    const now = 1_805_821_000_000;
    const league = await seedLeague("backlog_settle_throw", now, "active");
    await insertPendingRecap(league.id, RECAP_WEEK_KEY, now);
    await completeRecapEnrollment(RECAP_WEEK_KEY);

    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const originalError = console.error;
    const errors: unknown[][] = [];
    LeagueBrain.prototype.poll = async () => ({ wroteBeat: false, hash: "test", facts: 0 });
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      if (dashboard.leagueId !== league.id) {
        return { status: "skipped_not_final" };
      }
      return { status: "published", recap: { subject: "Week recap", body: "Published then settle boom." } };
    };
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let settleCalls = 0;
    const wrappedDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            const statement = originalPrepare(query);
            if (!query.includes("UPDATE recap_attempt_backlog")) {
              return statement;
            }
            return overridePreparedBindRun(statement, (bound) => {
              settleCalls += 1;
              if (settleCalls === 1) {
                return Promise.reject(new Error("settle boom"));
              }
              return bound.run();
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const scheduledEnv = new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === "DB") return wrappedDb;
        return Reflect.get(target, prop, receiver);
      },
    }) as Env;

    try {
      const result = await handleScheduled(scheduledEnv, IDLE_NOW, 1);
      expect(result).toEqual({ polled: 1, recapped: 0 });
      expect(settleCalls).toBe(2);
      expect(errors).toHaveLength(1);
      const payload = JSON.parse(String(errors[0]?.[0])) as Record<string, unknown>;
      expect(payload).toEqual({ event: "scheduled.league.failed", reason: "error" });
      const serialized = JSON.stringify(errors);
      expect(serialized).not.toContain(league.id);
      expect(serialized).not.toContain("settle boom");
      const [row] = await backlogRows(RECAP_WEEK_KEY, [league.id]);
      expect(row).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error: "thrown",
      });
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
      console.error = originalError;
    }
  });

  it("continues remaining leagues when catch-path settle throws", async () => {
    const now = 1_805_822_000_000;
    const first = await seedLeague("catch_settle_a", now, "active");
    const second = await seedLeague("catch_settle_b", now + 1, "active");
    const [failing, surviving] = [first, second].sort((a, b) => a.id.localeCompare(b.id));
    await insertPendingRecap(failing.id, RECAP_WEEK_KEY, now);
    await insertPendingRecap(surviving.id, RECAP_WEEK_KEY, now);
    await completeRecapEnrollment(RECAP_WEEK_KEY);

    const polledIds: string[] = [];
    const recapIds: string[] = [];
    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const originalError = console.error;
    const errors: unknown[][] = [];
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      if (dashboard.leagueId === failing.id) {
        throw new Error("poll boom");
      }
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapIds.push(dashboard.leagueId);
      return { status: "published", recap: { subject: "Week recap", body: "Survivor." } };
    };
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let settleCalls = 0;
    const wrappedDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            const statement = originalPrepare(query);
            if (!query.includes("UPDATE recap_attempt_backlog")) {
              return statement;
            }
            return overridePreparedBindRun(statement, (bound) => {
              settleCalls += 1;
              if (settleCalls === 1) {
                return Promise.reject(new Error("settle boom"));
              }
              return bound.run();
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const scheduledEnv = new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === "DB") return wrappedDb;
        return Reflect.get(target, prop, receiver);
      },
    }) as Env;

    try {
      const result = await handleScheduled(scheduledEnv, IDLE_NOW, 10);
      expect(result).toEqual({ polled: 1, recapped: 1 });
      expect(polledIds).toEqual([failing.id, surviving.id]);
      expect(recapIds).toEqual([surviving.id]);
      expect(settleCalls).toBe(2);
      expect(errors).toHaveLength(2);
      for (const entry of errors) {
        const payload = JSON.parse(String(entry[0])) as Record<string, unknown>;
        expect(payload).toEqual({ event: "scheduled.league.failed", reason: "error" });
      }
      const serialized = JSON.stringify(errors);
      expect(serialized).not.toContain(failing.id);
      expect(serialized).not.toContain(surviving.id);
      expect(serialized).not.toContain("poll boom");
      expect(serialized).not.toContain("settle boom");
      const rows = await backlogRows(RECAP_WEEK_KEY, [failing.id, surviving.id]);
      expect(rows.find((row) => row.league_id === failing.id)).toMatchObject({
        status: "pending",
        attempts: 0,
        last_error: null,
      });
      expect(rows.find((row) => row.league_id === surviving.id)).toMatchObject({
        status: "done",
        attempts: 1,
        last_error: null,
      });
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
      console.error = originalError;
    }
  });

  it("drops the previous week's backlog rows when the next Tuesday recap window opens", async () => {
    const now = 1_805_830_000_000;
    const league = await seedLeague("backlog_rollover", now, "active");

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      if (dashboard.leagueId !== league.id) {
        return { status: "skipped_not_final" };
      }
      return { status: "model_error", error: "still failing" };
    };

    try {
      const activeCount = (await listActiveLeagues(env.DB)).length;
      await handleScheduled(env, RECAP_NOW, activeCount);
      expect(await backlogRows(RECAP_WEEK_KEY, [league.id])).toHaveLength(1);
      const enrollBefore = await recapEnrollmentState();
      expect(enrollBefore?.weekKey).toBe(RECAP_WEEK_KEY);
      expect(enrollBefore?.complete).toBe(true);

      await handleScheduled(env, NEXT_RECAP_NOW, 2);
      expect(await backlogRows(RECAP_WEEK_KEY, [league.id])).toEqual([]);
      const enrollAfter = await recapEnrollmentState();
      expect(enrollAfter?.weekKey).toBe(NEXT_RECAP_WEEK_KEY);
      expect(await backlogCount(NEXT_RECAP_WEEK_KEY)).toBeLessThanOrEqual(2);
      const maxTicks = drainTickBudget((await listActiveLeagues(env.DB)).length, 2);
      for (let ticks = 1; ticks < maxTicks && (await backlogRows(NEXT_RECAP_WEEK_KEY, [league.id])).length === 0; ticks += 1) {
        await handleScheduled(env, NEXT_IDLE_NOW, 2);
      }
      const [newRow] = await backlogRows(NEXT_RECAP_WEEK_KEY, [league.id]);
      expect(newRow).toBeDefined();
      expect(["pending", "done"]).toContain(newRow?.status);
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("drops leftover previous-week backlog rows on an idle tick without starting this week's enrollment", async () => {
    const now = 1_805_831_000_000;
    const league = await seedLeague("backlog_idle_rollover", now, "active");
    await insertPendingRecap(league.id, RECAP_WEEK_KEY, now);
    await putAppState(
      SCHEDULED_RECAP_ENROLLMENT_KEY,
      JSON.stringify({ weekKey: RECAP_WEEK_KEY, afterId: null, complete: true }),
    );

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const recapCalls: string[] = [];
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      return { status: "published", recap: { subject: "Should not recap", body: "Idle cleanup." } };
    };

    try {
      expect(await backlogRows(RECAP_WEEK_KEY, [league.id])).toHaveLength(1);
      const result = await handleScheduled(env, NEXT_IDLE_NOW);
      expect(result).toEqual({ polled: 0, recapped: 0 });
      expect(recapCalls).toEqual([]);
      expect(await backlogRows(RECAP_WEEK_KEY, [league.id])).toEqual([]);
      expect(await backlogCount(NEXT_RECAP_WEEK_KEY)).toBe(0);
      expect(await recapEnrollmentState()).toEqual({
        weekKey: RECAP_WEEK_KEY,
        afterId: null,
        complete: true,
      });
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("drops leftover previous-week backlog rows on an idle tick when enrollment state is missing", async () => {
    const now = 1_805_832_000_000;
    const league = await seedLeague("backlog_idle_missing_enroll", now, "active");
    await insertPendingRecap(league.id, RECAP_WEEK_KEY, now);

    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const recapCalls: string[] = [];
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      return { status: "published", recap: { subject: "Should not recap", body: "Idle cleanup." } };
    };

    try {
      expect(await recapEnrollmentState()).toBeNull();
      expect(await backlogRows(RECAP_WEEK_KEY, [league.id])).toHaveLength(1);
      const result = await handleScheduled(env, NEXT_IDLE_NOW);
      expect(result).toEqual({ polled: 0, recapped: 0 });
      expect(recapCalls).toEqual([]);
      expect(await backlogRows(RECAP_WEEK_KEY, [league.id])).toEqual([]);
      expect(await backlogCount(NEXT_RECAP_WEEK_KEY)).toBe(0);
      expect(await recapEnrollmentState()).toBeNull();
    } finally {
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("deletes at most STALE_RECAP_ATTEMPT_SWEEP_LIMIT leftover-week rows per tick", async () => {
    const now = 1_805_833_000_000;
    const staleLeague = await seedLeague("stale_sweep_bound", now, "active");
    const currentPending = await seedLeague("current_week_pending", now + 1, "active");
    const currentDone = await seedLeague("current_week_done", now + 2, "active");
    const staleCount = STALE_RECAP_ATTEMPT_SWEEP_LIMIT + 3;
    const chunk = 20;
    for (let offset = 0; offset < staleCount; offset += chunk) {
      const n = Math.min(chunk, staleCount - offset);
      const placeholders = Array.from({ length: n }, () => "(?, ?, ?, 0, NULL, ?, ?)").join(", ");
      const binds: unknown[] = [];
      for (let i = 0; i < n; i += 1) {
        const status = (offset + i) % 2 === 0 ? "pending" : "done";
        binds.push(
          staleLeague.id,
          `stale-${String(offset + i).padStart(4, "0")}`,
          status,
          now,
          now,
        );
      }
      await env.DB.prepare(
        `INSERT INTO recap_attempt_backlog (league_id, week_key, status, attempts, last_error, created_at, updated_at)
         VALUES ${placeholders}`,
      )
        .bind(...binds)
        .run();
    }
    await insertPendingRecap(currentPending.id, RECAP_WEEK_KEY, now);
    await env.DB.prepare(
      `INSERT INTO recap_attempt_backlog (league_id, week_key, status, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, 'done', 1, NULL, ?, ?)`,
    )
      .bind(currentDone.id, RECAP_WEEK_KEY, now, now)
      .run();

    const staleDoneBefore = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM recap_attempt_backlog WHERE week_key != ? AND status = 'done'`,
      )
      .bind(RECAP_WEEK_KEY)
      .first<{ n: number }>();
    expect(staleDoneBefore?.n ?? 0).toBeGreaterThan(0);

    const result = await handleScheduled(env, IDLE_NOW);
    expect(result).toEqual({ polled: 0, recapped: 0 });

    const staleAfter = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM recap_attempt_backlog WHERE week_key != ?")
      .bind(RECAP_WEEK_KEY)
      .first<{ n: number }>();
    expect(staleAfter?.n).toBe(staleCount - STALE_RECAP_ATTEMPT_SWEEP_LIMIT);
    expect(await backlogCount(RECAP_WEEK_KEY)).toBe(2);
    expect(await backlogRows(RECAP_WEEK_KEY, [currentPending.id, currentDone.id])).toEqual([
      expect.objectContaining({ league_id: currentDone.id, status: "done" }),
      expect.objectContaining({ league_id: currentPending.id, status: "pending" }),
    ]);
    const staleDoneAfter = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM recap_attempt_backlog WHERE week_key != ? AND status = 'done'`,
      )
      .bind(RECAP_WEEK_KEY)
      .first<{ n: number }>();
    expect(staleDoneAfter?.n ?? 0).toBeLessThan(staleDoneBefore?.n ?? 0);
  });

  it("enrolls at most maxLeagues per tick and continues until every active league is covered", async () => {
    const now = 1_805_900_000_000;
    const ours = [
      await seedLeague("enroll_cont_a", now, "active"),
      await seedLeague("enroll_cont_b", now + 1, "active"),
      await seedLeague("enroll_cont_c", now + 2, "active"),
      await seedLeague("enroll_cont_d", now + 3, "active"),
      await seedLeague("enroll_cont_e", now + 4, "active"),
    ];
    const oursIds = new Set(ours.map((league) => league.id));
    const allActive = await listActiveLeagues(env.DB, { limit: 10_000 });
    expect(allActive.length).toBeGreaterThan(2);

    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const polledIds: string[] = [];
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    LeagueBrain.prototype.attemptRecap = async () => ({ status: "skipped_already" });

    try {
      const limit = 2;
      polledIds.length = 0;
      const first = await handleScheduled(env, RECAP_NOW, limit);
      expect(first.polled).toBeLessThanOrEqual(limit);
      expect(polledIds).toHaveLength(first.polled);
      expect(await backlogCount(RECAP_WEEK_KEY)).toBe(limit);
      const firstEnrolled = (
        await env.DB
          .prepare(
            `SELECT league_id FROM recap_attempt_backlog WHERE week_key = ? ORDER BY league_id`,
          )
          .bind(RECAP_WEEK_KEY)
          .all<{ league_id: string }>()
      ).results.map((row) => row.league_id);
      expect(firstEnrolled).toEqual(allActive.slice(0, limit).map((league) => league.id));
      expect((await recapEnrollmentState())?.complete).toBe(false);

      polledIds.length = 0;
      const second = await handleScheduled(env, IDLE_NOW, limit);
      expect(polledIds.length).toBeLessThanOrEqual(limit);
      expect(second.polled).toBeLessThanOrEqual(limit);
      expect(await backlogCount(RECAP_WEEK_KEY)).toBe(Math.min(allActive.length, limit * 2));

      const activeCount = allActive.length;
      const maxTicks = drainTickBudget(activeCount, limit);
      let ticks = 2;
      while (!(await recapEnrollmentState())?.complete && ticks < maxTicks) {
        polledIds.length = 0;
        const later = await handleScheduled(env, IDLE_NOW, limit);
        expect(later.polled).toBeLessThanOrEqual(limit);
        expect(polledIds.length).toBeLessThanOrEqual(limit);
        ticks += 1;
      }

      const enroll = await recapEnrollmentState();
      expect(enroll?.complete).toBe(true);
      expect(enroll?.weekKey).toBe(RECAP_WEEK_KEY);
      expect(await backlogCount(RECAP_WEEK_KEY)).toBe(activeCount);
      const allRows = await env.DB
        .prepare(`SELECT league_id FROM recap_attempt_backlog WHERE week_key = ?`)
        .bind(RECAP_WEEK_KEY)
        .all<{ league_id: string }>();
      expect(new Set(allRows.results.map((row) => row.league_id)).size).toBe(allRows.results.length);
      for (const id of oursIds) {
        expect(allRows.results.some((row) => row.league_id === id)).toBe(true);
      }
      const lastActive = allActive[allActive.length - 1];
      expect(lastActive).toBeDefined();
      expect(await backlogRows(RECAP_WEEK_KEY, [lastActive?.id ?? ""])).toHaveLength(1);
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("wraps enrollment so prefix leagues are not starved when the cursor starts at the end", async () => {
    const now = 1_805_910_000_000;
    await seedLeague("enroll_wrap_a", now, "active");
    await seedLeague("enroll_wrap_b", now + 1, "active");
    await seedLeague("enroll_wrap_c", now + 2, "active");
    const allActive = await listActiveLeagues(env.DB, { limit: 10_000 });
    const last = allActive[allActive.length - 1];
    if (!last) throw new Error("expected active leagues");
    await putAppState(
      SCHEDULED_RECAP_ENROLLMENT_KEY,
      JSON.stringify({ weekKey: RECAP_WEEK_KEY, afterId: last.id, complete: false }),
    );

    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const polledIds: string[] = [];
    LeagueBrain.prototype.poll = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      polledIds.push(dashboard.leagueId);
      return { wroteBeat: false, hash: "test", facts: 0 };
    };
    LeagueBrain.prototype.attemptRecap = async () => ({ status: "skipped_already" });

    try {
      const limit = 2;
      await handleScheduled(env, IDLE_NOW, limit);
      expect(polledIds.length).toBeLessThanOrEqual(limit);
      const enrolled = (
        await env.DB
          .prepare(
            `SELECT league_id FROM recap_attempt_backlog WHERE week_key = ? ORDER BY league_id`,
          )
          .bind(RECAP_WEEK_KEY)
          .all<{ league_id: string }>()
      ).results.map((row) => row.league_id);
      expect(enrolled).toEqual(allActive.slice(0, limit).map((league) => league.id));
      expect(enrolled).not.toContain(last.id);
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("does not move the regular poll cursor while idle enrollment continues", async () => {
    const now = 1_805_920_000_000;
    await seedLeague("enroll_cursor_a", now, "active");
    await seedLeague("enroll_cursor_b", now + 1, "active");
    await seedLeague("enroll_cursor_c", now + 2, "active");
    await seedLeague("enroll_cursor_d", now + 3, "active");
    await seedLeague("enroll_cursor_e", now + 4, "active");
    const cursorBefore = JSON.stringify({ afterId: "cursor_must_not_move" });
    await putAppState(SCHEDULED_LEAGUE_CURSOR_KEY, cursorBefore);

    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    LeagueBrain.prototype.poll = async () => ({ wroteBeat: false, hash: "test", facts: 0 });
    LeagueBrain.prototype.attemptRecap = async () => ({ status: "skipped_already" });

    try {
      const limit = 2;
      await handleScheduled(env, RECAP_NOW, limit);
      const pollAfterRecap = await scheduledCursorValue();
      const enrollAfterRecap = await recapEnrollmentState();
      expect(enrollAfterRecap?.complete).toBe(false);
      expect(enrollAfterRecap?.afterId).toBeTruthy();
      expect(pollAfterRecap).not.toBe(cursorBefore);

      await handleScheduled(env, IDLE_NOW, limit);
      expect(await scheduledCursorValue()).toBe(pollAfterRecap);
      const enrollAfterIdle = await recapEnrollmentState();
      expect(enrollAfterIdle?.afterId).not.toBe(enrollAfterRecap?.afterId);
      expect(enrollAfterIdle?.weekKey).toBe(RECAP_WEEK_KEY);
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });

  it("returns empty on idle ticks once enrollment is complete and no pending remain", async () => {
    const now = 1_805_930_000_000;
    await seedLeague("enroll_idle_empty", now, "active");

    const originalPoll = LeagueBrain.prototype.poll;
    const originalAttemptRecap = LeagueBrain.prototype.attemptRecap;
    const recapCalls: string[] = [];
    LeagueBrain.prototype.poll = async () => ({ wroteBeat: false, hash: "test", facts: 0 });
    LeagueBrain.prototype.attemptRecap = async function (this: LeagueBrain) {
      const dashboard = await this.getDashboard();
      recapCalls.push(dashboard.leagueId);
      return { status: "skipped_already" };
    };

    try {
      const activeCount = (await listActiveLeagues(env.DB)).length;
      await handleScheduled(env, RECAP_NOW, activeCount);
      expect((await recapEnrollmentState())?.complete).toBe(true);

      const maxTicks = drainTickBudget(activeCount, 2);
      for (let ticks = 0; ticks < maxTicks && (await pendingBelowCapCount(RECAP_WEEK_KEY)) > 0; ticks += 1) {
        await handleScheduled(env, IDLE_NOW, 2);
      }

      recapCalls.length = 0;
      const extra = await handleScheduled(env, IDLE_NOW, 2);
      expect(extra).toEqual({ polled: 0, recapped: 0 });
      expect(recapCalls).toEqual([]);
      expect((await recapEnrollmentState())?.complete).toBe(true);
      expect(await pendingBelowCapCount(RECAP_WEEK_KEY)).toBe(0);
    } finally {
      LeagueBrain.prototype.poll = originalPoll;
      LeagueBrain.prototype.attemptRecap = originalAttemptRecap;
    }
  });
});
