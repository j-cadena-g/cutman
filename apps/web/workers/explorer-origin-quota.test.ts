/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { EXAMPLE_SLEEPER_USERNAME, V1_LEAGUE_ID, createFixtureClient, type SleeperClient } from "@cutman/sleeper";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXPLORER_ORIGIN_QUOTA_CONSUME_SQL,
  EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS,
  EXPLORER_ORIGIN_QUOTA_STALE_SWEEP_LIMIT,
  EXPLORER_QUOTA_HOUR_MS,
  createMemoryExplorerOriginQuota,
  d1ExplorerOriginQuota,
  d1ExplorerOriginQuotaAccepted,
  explorerOriginQuotaConsumeBinds,
  explorerOriginQuotaHourKey,
  explorerOriginQuotaStaleCutoffHourKey,
  sweepStaleExplorerOriginQuota,
  type ExplorerOriginQuota,
  type ExplorerOriginQuotaRow,
} from "../app/lib/explorer-origin-quota.server.ts";
import {
  ORIGIN_QUOTA_PER_HOUR,
  createMemoryExplorerCache,
  lookupExplorerBoard,
  lookupExplorerUser,
  type ExplorerDeps,
} from "../app/lib/sleeper-explorer.server.ts";
import { allMigrations } from "./d1-migration-test-helpers.ts";

beforeAll(async () => {
  await applyD1Migrations(env.DB, allMigrations());
});

const FIXED_NOW = 1_700_000_000_000;
const USER_A = "clerk_quota_a";
const USER_B = "clerk_quota_b";

async function quotaRowOnD1(clerkUserId: string): Promise<{ hour_key: number; used: number } | null> {
  return env.DB.prepare("SELECT hour_key, used FROM explorer_origin_quota WHERE clerk_user_id = ?")
    .bind(clerkUserId)
    .first<{ hour_key: number; used: number }>();
}

async function usedOnD1(clerkUserId: string, now: number): Promise<number> {
  const row = await quotaRowOnD1(clerkUserId);
  if (!row || row.hour_key !== explorerOriginQuotaHourKey(now)) return 0;
  return row.used;
}

async function rowCountOnD1(clerkUserId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM explorer_origin_quota WHERE clerk_user_id = ?")
    .bind(clerkUserId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

function memoryUsed(store: Map<string, ExplorerOriginQuotaRow>, clerkUserId: string, now: number): number {
  const row = store.get(clerkUserId);
  if (!row || row.hourKey !== explorerOriginQuotaHourKey(now)) return 0;
  return row.used;
}

async function runConsumeSql(input: {
  clerkUserId: string;
  charge: number;
  now: number;
  limit: number;
}): Promise<{ changes: number | undefined; rowsWritten: number | undefined }> {
  const result = await env.DB.prepare(EXPLORER_ORIGIN_QUOTA_CONSUME_SQL)
    .bind(...explorerOriginQuotaConsumeBinds(input))
    .run();
  return { changes: result.meta.changes, rowsWritten: result.meta.rows_written };
}

async function insertQuotaRow(clerkUserId: string, hourKey: number, used = 1): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO explorer_origin_quota (clerk_user_id, hour_key, used) VALUES (?, ?, ?)",
  )
    .bind(clerkUserId, hourKey, used)
    .run();
}

async function countQuotaRows(clerkUserIds: string[]): Promise<number> {
  const placeholders = clerkUserIds.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM explorer_origin_quota WHERE clerk_user_id IN (${placeholders})`,
  )
    .bind(...clerkUserIds)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

function makeUserDeps(overrides: Partial<ExplorerDeps> = {}): ExplorerDeps {
  const sleeper = overrides.sleeper ?? createFixtureClient();
  return {
    sleeper,
    cache: overrides.cache ?? createMemoryExplorerCache(),
    getPlayers: overrides.getPlayers ?? (async () => sleeper.getPlayers()),
    now: overrides.now ?? (() => FIXED_NOW),
    quotaPerHour: overrides.quotaPerHour,
    originQuota: overrides.originQuota ?? createMemoryExplorerOriginQuota(),
  };
}

function countingSleeper(base: SleeperClient = createFixtureClient()) {
  const calls = { getLeague: 0, getPlayers: 0 };
  const sleeper: SleeperClient = {
    ...base,
    async getLeague(leagueId) {
      calls.getLeague += 1;
      return base.getLeague(leagueId);
    },
    async getPlayers() {
      calls.getPlayers += 1;
      return base.getPlayers();
    },
  };
  return { sleeper, calls };
}

describe("explorer origin quota contract", () => {
  const backends: Array<{
    name: string;
    setup: () => {
      quota: ExplorerOriginQuota;
      used: (clerkUserId: string, now: number) => Promise<number>;
      rows: (clerkUserId: string) => Promise<number>;
      uniqueUser: () => string;
    };
  }> = [
    {
      name: "memory",
      setup: () => {
        const store = new Map<string, ExplorerOriginQuotaRow>();
        return {
          quota: createMemoryExplorerOriginQuota(store),
          used: async (clerkUserId, now) => memoryUsed(store, clerkUserId, now),
          rows: async (clerkUserId) => (store.has(clerkUserId) ? 1 : 0),
          uniqueUser: () => `mem_${crypto.randomUUID()}`,
        };
      },
    },
    {
      name: "d1",
      setup: () => ({
        quota: d1ExplorerOriginQuota(env.DB),
        used: usedOnD1,
        rows: rowCountOnD1,
        uniqueUser: () => `d1_${crypto.randomUUID()}`,
      }),
    },
  ];

  for (const backend of backends) {
    describe(backend.name, () => {
      it("accepts a first charge that exactly matches the limit", async () => {
        const { quota, used, uniqueUser } = backend.setup();
        const clerkUserId = uniqueUser();
        expect(await quota.tryConsume({ clerkUserId, charge: 5, now: FIXED_NOW, limit: 5 })).toBe(true);
        expect(await used(clerkUserId, FIXED_NOW)).toBe(5);
      });

      it("rejects a first charge above the limit without inserting usage", async () => {
        const { quota, used, rows, uniqueUser } = backend.setup();
        const clerkUserId = uniqueUser();
        expect(await quota.tryConsume({ clerkUserId, charge: 6, now: FIXED_NOW, limit: 5 })).toBe(false);
        expect(await used(clerkUserId, FIXED_NOW)).toBe(0);
        expect(await rows(clerkUserId)).toBe(0);
      });

      it("rejects a later charge that would pass the limit and leaves used unchanged", async () => {
        const { quota, used, uniqueUser } = backend.setup();
        const clerkUserId = uniqueUser();
        expect(await quota.tryConsume({ clerkUserId, charge: 4, now: FIXED_NOW, limit: 5 })).toBe(true);
        expect(await quota.tryConsume({ clerkUserId, charge: 2, now: FIXED_NOW, limit: 5 })).toBe(false);
        expect(await used(clerkUserId, FIXED_NOW)).toBe(4);
      });

      it("keys usage per Clerk user in the same hour", async () => {
        const { quota, used, uniqueUser } = backend.setup();
        const userA = uniqueUser();
        const userB = uniqueUser();
        expect(await quota.tryConsume({ clerkUserId: userA, charge: 3, now: FIXED_NOW, limit: 3 })).toBe(true);
        expect(await quota.tryConsume({ clerkUserId: userB, charge: 3, now: FIXED_NOW, limit: 3 })).toBe(true);
        expect(await used(userA, FIXED_NOW)).toBe(3);
        expect(await used(userB, FIXED_NOW)).toBe(3);
        expect(await quota.tryConsume({ clerkUserId: userA, charge: 1, now: FIXED_NOW, limit: 3 })).toBe(false);
      });

      it("opens a new hour window without carrying used forward or growing rows", async () => {
        const { quota, used, rows, uniqueUser } = backend.setup();
        const clerkUserId = uniqueUser();
        expect(await quota.tryConsume({ clerkUserId, charge: 2, now: FIXED_NOW, limit: 2 })).toBe(true);
        expect(await quota.tryConsume({ clerkUserId, charge: 1, now: FIXED_NOW, limit: 2 })).toBe(false);
        const nextHour = FIXED_NOW + EXPLORER_QUOTA_HOUR_MS;
        expect(await quota.tryConsume({ clerkUserId, charge: 2, now: nextHour, limit: 2 })).toBe(true);
        expect(await used(clerkUserId, FIXED_NOW)).toBe(0);
        expect(await used(clerkUserId, nextHour)).toBe(2);
        expect(await rows(clerkUserId)).toBe(1);
      });

      it("rejects a stale older-hour consume without rolling used backward", async () => {
        const { quota, used, uniqueUser } = backend.setup();
        const clerkUserId = uniqueUser();
        const nextHour = FIXED_NOW + EXPLORER_QUOTA_HOUR_MS;
        expect(await quota.tryConsume({ clerkUserId, charge: 1, now: FIXED_NOW, limit: 5 })).toBe(true);
        expect(await quota.tryConsume({ clerkUserId, charge: 3, now: nextHour, limit: 5 })).toBe(true);
        expect(await quota.tryConsume({ clerkUserId, charge: 1, now: FIXED_NOW, limit: 5 })).toBe(false);
        expect(await used(clerkUserId, FIXED_NOW)).toBe(0);
        expect(await used(clerkUserId, nextHour)).toBe(3);
      });

      it("rejects a newer-hour charge above the limit without advancing the window", async () => {
        const { quota, used, uniqueUser } = backend.setup();
        const clerkUserId = uniqueUser();
        const nextHour = FIXED_NOW + EXPLORER_QUOTA_HOUR_MS;
        expect(await quota.tryConsume({ clerkUserId, charge: 2, now: FIXED_NOW, limit: 2 })).toBe(true);
        expect(await quota.tryConsume({ clerkUserId, charge: 3, now: nextHour, limit: 2 })).toBe(false);
        expect(await used(clerkUserId, FIXED_NOW)).toBe(2);
        expect(await used(clerkUserId, nextHour)).toBe(0);
      });

      it("returns false for invalid charge, limit, user, or time without mutating usage", async () => {
        const { quota, used, uniqueUser } = backend.setup();
        const clerkUserId = uniqueUser();
        const invalid = [
          { clerkUserId, charge: 0, now: FIXED_NOW, limit: 5 },
          { clerkUserId, charge: -1, now: FIXED_NOW, limit: 5 },
          { clerkUserId, charge: 1.5, now: FIXED_NOW, limit: 5 },
          { clerkUserId, charge: Number.NaN, now: FIXED_NOW, limit: 5 },
          { clerkUserId, charge: Number.POSITIVE_INFINITY, now: FIXED_NOW, limit: 5 },
          { clerkUserId, charge: 1, now: FIXED_NOW, limit: -1 },
          { clerkUserId, charge: 1, now: FIXED_NOW, limit: 1.5 },
          { clerkUserId, charge: 1, now: FIXED_NOW, limit: Number.NaN },
          { clerkUserId: "", charge: 1, now: FIXED_NOW, limit: 5 },
          { clerkUserId, charge: 1, now: Number.NaN, limit: 5 },
        ];
        for (const input of invalid) {
          expect(await quota.tryConsume(input)).toBe(false);
        }
        expect(await used(clerkUserId, FIXED_NOW)).toBe(0);
      });
    });
  }
});

describe("d1 explorer origin quota metadata and concurrency", () => {
  it("rejects a first charge above the limit with meta.changes === 0", async () => {
    const clerkUserId = `meta_first_${crypto.randomUUID()}`;
    const rejected = await runConsumeSql({ clerkUserId, charge: 6, now: FIXED_NOW, limit: 5 });
    expect(rejected.changes).toBe(0);
    expect(await usedOnD1(clerkUserId, FIXED_NOW)).toBe(0);
    expect(await rowCountOnD1(clerkUserId)).toBe(0);
  });

  it("accepts from meta.changes === 1 and ignores rows_written as the success signal", async () => {
    const clerkUserId = `meta_${crypto.randomUUID()}`;
    const accepted = await runConsumeSql({ clerkUserId, charge: 2, now: FIXED_NOW, limit: 3 });
    expect(accepted.changes).toBe(1);
    expect(await usedOnD1(clerkUserId, FIXED_NOW)).toBe(2);

    const rejected = await runConsumeSql({ clerkUserId, charge: 2, now: FIXED_NOW, limit: 3 });
    expect(rejected.changes).not.toBe(1);
    expect(await usedOnD1(clerkUserId, FIXED_NOW)).toBe(2);
    // A rejected UPSERT WHERE can still report a write in some D1 versions; acceptance is changes.
    expect(d1ExplorerOriginQuotaAccepted(rejected.changes)).toBe(false);
  });

  it("does not exceed the limit under concurrent first-insert and update races", async () => {
    const quota = d1ExplorerOriginQuota(env.DB);
    const clerkUserId = `race_${crypto.randomUUID()}`;
    const limit = 10;
    const results = await Promise.all(
      Array.from({ length: 40 }, () => quota.tryConsume({ clerkUserId, charge: 1, now: FIXED_NOW, limit })),
    );
    expect(results.filter((allowed) => allowed).length).toBe(limit);
    expect(results.filter((allowed) => !allowed).length).toBe(30);
    expect(await usedOnD1(clerkUserId, FIXED_NOW)).toBe(limit);
    expect(await rowCountOnD1(clerkUserId)).toBe(1);
  });

  it("does not roll a newer hour backward under concurrent boundary races", async () => {
    const quota = d1ExplorerOriginQuota(env.DB);
    const clerkUserId = `boundary_${crypto.randomUUID()}`;
    const limit = 10;
    const nextHour = FIXED_NOW + EXPLORER_QUOTA_HOUR_MS;
    const hourKey0 = explorerOriginQuotaHourKey(FIXED_NOW);
    const hourKey1 = explorerOriginQuotaHourKey(nextHour);
    const requests = [
      ...Array.from({ length: 20 }, () => ({ now: FIXED_NOW })),
      ...Array.from({ length: 20 }, () => ({ now: nextHour })),
    ];
    const results = await Promise.all(
      requests.map((request) => quota.tryConsume({ clerkUserId, charge: 1, now: request.now, limit })),
    );
    const hour1Accepted = results.filter(
      (allowed, index) => allowed && requests[index]?.now === nextHour,
    ).length;
    const row = await quotaRowOnD1(clerkUserId);
    expect(hour1Accepted).toBeGreaterThan(0);
    expect(row).toEqual({ hour_key: hourKey1, used: hour1Accepted });
    expect(row?.hour_key).not.toBe(hourKey0);
    expect(hour1Accepted).toBeLessThanOrEqual(limit);
    expect(await rowCountOnD1(clerkUserId)).toBe(1);
  });
});
describe("explorer lookups against the quota abstraction", () => {
  it("returns quota_exceeded for one Clerk user without blocking another in the same hour", async () => {
    const originQuota = createMemoryExplorerOriginQuota();
    const cache = createMemoryExplorerCache();
    const spent = await lookupExplorerUser(
      makeUserDeps({ cache, originQuota, quotaPerHour: 2 }),
      { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: USER_A },
    );
    expect(spent.kind).toBe("ok");
    const blocked = await lookupExplorerUser(
      makeUserDeps({ cache, originQuota, quotaPerHour: 2 }),
      { username: "mina", clerkUserId: USER_A },
    );
    expect(blocked.kind).toBe("quota_exceeded");
    const other = await lookupExplorerUser(
      makeUserDeps({ cache, originQuota, quotaPerHour: 2 }),
      { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: USER_B },
    );
    expect(other.kind).toBe("ok");
  });

  it("allows origin again after the hour window rolls", async () => {
    const originQuota = createMemoryExplorerOriginQuota();
    const cache = createMemoryExplorerCache();
    let now = FIXED_NOW;
    const first = await lookupExplorerUser(
      makeUserDeps({ cache, originQuota, quotaPerHour: 2, now: () => now }),
      { username: EXAMPLE_SLEEPER_USERNAME, clerkUserId: USER_A },
    );
    expect(first.kind).toBe("ok");
    const blocked = await lookupExplorerUser(
      makeUserDeps({ cache, originQuota, quotaPerHour: 2, now: () => now }),
      { username: "mina", clerkUserId: USER_A },
    );
    expect(blocked.kind).toBe("quota_exceeded");
    now += EXPLORER_QUOTA_HOUR_MS;
    const nextHour = await lookupExplorerUser(
      makeUserDeps({ cache, originQuota, quotaPerHour: 2, now: () => now }),
      { username: "mina", clerkUserId: USER_A },
    );
    expect(nextHour.kind).toBe("ok");
  });

  it("does not exceed the planned origin budget under concurrent user lookups", async () => {
    const originQuota = d1ExplorerOriginQuota(env.DB);
    // Always-miss cache so every lookup still plans a 2-origin charge instead of
    // serving a board/user written by a sibling that already consumed quota.
    const cache: ExplorerDeps["cache"] = {
      async getJson() {
        return null;
      },
      async putJson() {},
    };
    const clerkUserId = `explore_race_${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        lookupExplorerUser(makeUserDeps({ cache, originQuota, quotaPerHour: 4 }), {
          username: EXAMPLE_SLEEPER_USERNAME,
          clerkUserId,
        }),
      ),
    );
    expect(results.filter((result) => result.kind === "ok").length).toBe(2);
    expect(results.filter((result) => result.kind === "quota_exceeded").length).toBe(18);
    expect(await usedOnD1(clerkUserId, FIXED_NOW)).toBe(4);
    expect(await rowCountOnD1(clerkUserId)).toBe(1);
  });

  it("serves a fresh cached board without consuming quota even when the hour is spent", async () => {
    const store = new Map<string, ExplorerOriginQuotaRow>();
    const originQuota = createMemoryExplorerOriginQuota(store);
    const cache = createMemoryExplorerCache();
    const first = await lookupExplorerBoard(makeUserDeps({ cache, originQuota }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: USER_A,
    });
    expect(first.kind).toBe("ok");
    store.set(USER_A, { hourKey: explorerOriginQuotaHourKey(FIXED_NOW), used: ORIGIN_QUOTA_PER_HOUR });
    const { sleeper, calls } = countingSleeper();
    const cached = await lookupExplorerBoard(makeUserDeps({ sleeper, cache, originQuota }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId: USER_A,
    });
    expect(cached.kind).toBe("ok");
    expect(calls.getLeague).toBe(0);
    expect(calls.getPlayers).toBe(1);
    expect(memoryUsed(store, USER_A, FIXED_NOW)).toBe(ORIGIN_QUOTA_PER_HOUR);
  });

  it("does not charge D1 quota on a fresh cached board", async () => {
    const originQuota = d1ExplorerOriginQuota(env.DB);
    const clerkUserId = `board_fresh_${crypto.randomUUID()}`;
    const cache = createMemoryExplorerCache();
    const first = await lookupExplorerBoard(makeUserDeps({ cache, originQuota }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId,
    });
    expect(first.kind).toBe("ok");
    expect(await usedOnD1(clerkUserId, FIXED_NOW)).toBe(5);
    const { sleeper, calls } = countingSleeper();
    const second = await lookupExplorerBoard(makeUserDeps({ sleeper, cache, originQuota }), {
      sleeperLeagueId: V1_LEAGUE_ID,
      clerkUserId,
    });
    expect(second.kind).toBe("ok");
    expect(calls.getLeague).toBe(0);
    expect(calls.getPlayers).toBe(1);
    expect(await usedOnD1(clerkUserId, FIXED_NOW)).toBe(5);
  });
});
describe("explorer origin quota consume binds", () => {
  it("emits the seven-placeholder tuple in consume SQL order", () => {
    expect(
      explorerOriginQuotaConsumeBinds({
        clerkUserId: USER_A,
        charge: 2,
        now: FIXED_NOW,
        limit: 5,
      }),
    ).toEqual([USER_A, explorerOriginQuotaHourKey(FIXED_NOW), 2, 2, 5, 5, 5]);
  });
});

describe("stale explorer origin quota sweep", () => {
  it("deletes rows older than the 24h retention and keeps the current hour", async () => {
    const staleUser = `stale_${crypto.randomUUID()}`;
    const edgeUser = `edge_${crypto.randomUUID()}`;
    const freshUser = `fresh_${crypto.randomUUID()}`;
    const currentHour = explorerOriginQuotaHourKey(FIXED_NOW);
    const cutoff = explorerOriginQuotaStaleCutoffHourKey(FIXED_NOW);
    expect(cutoff).toBe(currentHour - EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS);
    await insertQuotaRow(staleUser, cutoff - 1);
    await insertQuotaRow(edgeUser, cutoff);
    await insertQuotaRow(freshUser, currentHour, 3);

    expect(await sweepStaleExplorerOriginQuota(env.DB, { now: FIXED_NOW })).toBeGreaterThanOrEqual(1);
    expect(await quotaRowOnD1(staleUser)).toBeNull();
    expect(await quotaRowOnD1(edgeUser)).toEqual({ hour_key: cutoff, used: 1 });
    expect(await quotaRowOnD1(freshUser)).toEqual({ hour_key: currentHour, used: 3 });
  });

  it("bounds deletions per call and leaves remaining stale rows for a later tick", async () => {
    for (let i = 0; i < 32; i++) {
      const deleted = await sweepStaleExplorerOriginQuota(env.DB, {
        now: FIXED_NOW,
        limit: EXPLORER_ORIGIN_QUOTA_STALE_SWEEP_LIMIT,
      });
      if (deleted === 0) break;
      if (i === 31) throw new Error("stale explorer origin quota sweep did not drain");
    }
    const staleHour = explorerOriginQuotaStaleCutoffHourKey(FIXED_NOW) - 1;
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].map(
      (id) => `sweep_${id}`,
    );
    for (const id of ids) {
      await insertQuotaRow(id, staleHour);
    }
    expect(await countQuotaRows(ids)).toBe(3);
    expect(await sweepStaleExplorerOriginQuota(env.DB, { now: FIXED_NOW, limit: 2 })).toBe(2);
    expect(await countQuotaRows(ids)).toBe(1);
    expect(await sweepStaleExplorerOriginQuota(env.DB, { now: FIXED_NOW, limit: 2 })).toBe(1);
    expect(await countQuotaRows(ids)).toBe(0);
  });

  it("does not weaken atomic consume for a current-hour row", async () => {
    const quota = d1ExplorerOriginQuota(env.DB);
    const clerkUserId = `keep_${crypto.randomUUID()}`;
    expect(await quota.tryConsume({ clerkUserId, charge: 1, now: FIXED_NOW, limit: 2 })).toBe(true);
    expect(await sweepStaleExplorerOriginQuota(env.DB, { now: FIXED_NOW })).toBeGreaterThanOrEqual(0);
    expect(await quota.tryConsume({ clerkUserId, charge: 1, now: FIXED_NOW, limit: 2 })).toBe(true);
    expect(await quota.tryConsume({ clerkUserId, charge: 1, now: FIXED_NOW, limit: 2 })).toBe(false);
    expect(await usedOnD1(clerkUserId, FIXED_NOW)).toBe(2);
    expect(await rowCountOnD1(clerkUserId)).toBe(1);
  });

  it("returns 0 for invalid now, retention, or limit without deleting current-hour rows", async () => {
    const clerkUserId = `invalid_sweep_${crypto.randomUUID()}`;
    await insertQuotaRow(clerkUserId, explorerOriginQuotaHourKey(FIXED_NOW), 4);
    expect(await sweepStaleExplorerOriginQuota(env.DB, { now: Number.NaN })).toBe(0);
    expect(await sweepStaleExplorerOriginQuota(env.DB, { now: FIXED_NOW, retentionHours: 0 })).toBe(0);
    expect(await sweepStaleExplorerOriginQuota(env.DB, { now: FIXED_NOW, limit: 0 })).toBe(0);
    expect(await quotaRowOnD1(clerkUserId)).toEqual({
      hour_key: explorerOriginQuotaHourKey(FIXED_NOW),
      used: 4,
    });
  });
});
