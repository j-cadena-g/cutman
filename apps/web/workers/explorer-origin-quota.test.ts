/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { EXAMPLE_SLEEPER_USERNAME, createFixtureClient } from "@cutman/sleeper";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXPLORER_ORIGIN_QUOTA_CONSUME_SQL,
  EXPLORER_QUOTA_HOUR_MS,
  createMemoryExplorerOriginQuota,
  d1ExplorerOriginQuota,
  d1ExplorerOriginQuotaAccepted,
  explorerOriginQuotaHourKey,
  type ExplorerOriginQuota,
  type ExplorerOriginQuotaRow,
} from "../app/lib/explorer-origin-quota.server.ts";
import {
  createMemoryExplorerCache,
  lookupExplorerUser,
  type ExplorerDeps,
} from "../app/lib/sleeper-explorer.server.ts";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
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
    .bind(
      input.clerkUserId,
      explorerOriginQuotaHourKey(input.now),
      input.charge,
      input.charge,
      input.limit,
      input.limit,
      input.limit,
    )
    .run();
  return { changes: result.meta.changes, rowsWritten: result.meta.rows_written };
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
});
