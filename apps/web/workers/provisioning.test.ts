/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import {
  activateLeague,
  createLeague,
  ensureSchema,
  failLeague,
  getLeague,
  provisionLeague,
  upsertLeagueMember,
  upsertUserByClerkId,
  type LeagueRow,
} from "@cutman/db";
import { V1_LEAGUE_ID } from "@cutman/sleeper";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PROVISION_TIMEOUT_MS,
  provisionAndActivateLeague,
  provisioningDepsFromEnv,
  retryProvisionAndActivateLeague,
  type LeagueBrainHandle,
  type ProvisioningDeps,
} from "../app/lib/provisioning.server.ts";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

let leagueSeq = 0;
function nextIds(label: string): { internalId: string; sleeperId: string } {
  leagueSeq += 1;
  return {
    internalId: `internal_prov_${label}_${leagueSeq}`,
    sleeperId: `sleeper_prov_${label}_${leagueSeq}`,
  };
}

async function seedProvisioningLeague(label: string, now: number): Promise<LeagueRow> {
  await ensureSchema(env.DB);
  const { internalId, sleeperId } = nextIds(label);
  return createLeague(env.DB, {
    id: internalId,
    sleeperLeagueId: sleeperId,
    name: `Prov ${label}`,
    season: "2026",
    now,
  });
}

function throwingBrain(error: Error): LeagueBrainHandle {
  return {
    async bootstrap() {
      /* bootstrap itself succeeds so the failure is isolated to poll */
    },
    async poll() {
      throw error;
    },
  };
}

function silentBrain(): LeagueBrainHandle {
  return {
    async bootstrap() {},
    async poll() {},
  };
}

function depsWithBrain(brain: LeagueBrainHandle, now: number, clock: () => number = Date.now): ProvisioningDeps {
  return { db: env.DB, brain, now: () => now, clock };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function useProvisionFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}

function injectableClock(start = 0): { clock: () => number; elapse: (ms: number) => void } {
  let t = start;
  return {
    clock: () => t,
    elapse: (ms: number) => {
      t += ms;
    },
  };
}

describe("provisionAndActivateLeague", () => {
  it("bootstraps the Durable Object by internal id, polls once, and activates the D1 row", async () => {
    const now = 1_804_000_000_000;
    const league = await seedProvisioningLeague("happy", now);
    expect(league.id).not.toBe(league.sleeper_league_id);
    expect(league.status).toBe("provisioning");

    const deps = provisioningDepsFromEnv(env, league.id, () => now + 50);
    const result = await provisionAndActivateLeague(deps, league);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
    expect(result.league.created_at).toBe(now);
    expect(result.league.provisioning_started_at).toBe(now + 50);
    expect(result.league.activated_at).toBe(now + 50);
    expect(result.league.provisioning_error).toBeNull();
    expect(await getLeague(env.DB, league.id)).toMatchObject({ status: "active", id: league.id });

    // Addressed by internal id, bootstrapped with both ids. Polling the fixture client with a
    // non-V1 Sleeper id still succeeds (empty roster) — first import is current-state only.
    const stub = env.LEAGUE_BRAIN.getByName(league.id);
    const dashboard = await stub.getDashboard();
    expect(dashboard.leagueId).toBe(league.id);
    expect(dashboard.sleeperLeagueId).toBe(league.sleeper_league_id);
    expect(dashboard.week).toBe(1);

    const sleeperNamed = env.LEAGUE_BRAIN.getByName(league.sleeper_league_id);
    const sleeperSettings = await runInDurableObject(sleeperNamed, async (_instance, state) => {
      return state.storage.sql.exec("SELECT key FROM settings").toArray();
    });
    expect(sleeperSettings).toEqual([]);
  });

  it("polls Sleeper using the Sleeper league id so fixture users land on a distinct internal league", async () => {
    await ensureSchema(env.DB);
    const now = 1_804_010_000_000;
    const { internalId } = nextIds("poll_v1");
    const league = await createLeague(env.DB, {
      id: internalId,
      sleeperLeagueId: V1_LEAGUE_ID,
      name: "V1 Sleeper Poll",
      season: "2026",
      now,
    });
    expect(league.id).not.toBe(league.sleeper_league_id);

    const result = await provisionAndActivateLeague(provisioningDepsFromEnv(env, league.id, () => now + 1), league);
    expect(result.ok).toBe(true);

    const dashboard = await env.LEAGUE_BRAIN.getByName(league.id).getDashboard();
    expect(dashboard.leagueId).toBe(league.id);
    expect(dashboard.sleeperLeagueId).toBe(V1_LEAGUE_ID);
    expect(dashboard.lastHash).not.toBeNull();
  });

  it("returns success without calling provisionLeague when the league is already active", async () => {
    const now = 1_804_020_000_000;
    const league = await seedProvisioningLeague("already_active", now);
    const activated = await activateLeague(env.DB, league.id, now + 1);
    const nowFn = vi.fn(() => now + 2);

    const result = await provisionAndActivateLeague(
      { db: env.DB, brain: silentBrain(), now: nowFn },
      activated,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(nowFn).not.toHaveBeenCalled();
    expect(result.league.status).toBe("active");
    expect(result.league.activated_at).toBe(now + 1);
    expect(result.league.provisioning_started_at).toBe(now);
  });

  it("retries from error by moving back to provisioning, then activating after a successful bootstrap and poll", async () => {
    const now = 1_804_030_000_000;
    const league = await seedProvisioningLeague("from_error", now);
    await failLeague(env.DB, league.id, "previous poll failed");
    const errored = await getLeague(env.DB, league.id);
    expect(errored?.status).toBe("error");

    const result = await provisionAndActivateLeague(
      provisioningDepsFromEnv(env, league.id, () => now + 9),
      errored!,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
    expect(result.league.created_at).toBe(now);
    expect(result.league.provisioning_started_at).toBe(now + 9);
    expect(result.league.provisioning_error).toBeNull();
  });

  it("marks the league error with a safe diagnostic and a typed retryable result when poll fails", async () => {
    const now = 1_804_040_000_000;
    const league = await seedProvisioningLeague("poll_fail", now);

    const result = await provisionAndActivateLeague(
      depsWithBrain(throwingBrain(new Error("Sleeper 502 from getNflState")), now + 3),
      league,
    );

    expect(result).toEqual({ ok: false, error: { kind: "provisioning_failed" } });
    const stored = await getLeague(env.DB, league.id);
    expect(stored?.status).toBe("error");
    expect(stored?.provisioning_error).toBe("Sleeper 502 from getNflState");
    expect(stored?.provisioning_error).not.toMatch(/at poll|TypeError|stack/i);
  });

  it("converges on active when two provision calls race, instead of throwing", async () => {
    const now = 1_804_050_000_000;
    const league = await seedProvisioningLeague("race_ok", now);
    const deps = provisioningDepsFromEnv(env, league.id, () => now + 8);

    const [first, second] = await Promise.all([
      provisionAndActivateLeague(deps, league),
      provisionAndActivateLeague(deps, league),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await getLeague(env.DB, league.id))?.status).toBe("active");
  });

  it("returns success when poll fails but a peer already activated (failLeague CAS miss)", async () => {
    const now = 1_804_060_000_000;
    const league = await seedProvisioningLeague("fail_cas_active", now);
    const brain: LeagueBrainHandle = {
      async bootstrap() {},
      async poll() {
        await activateLeague(env.DB, league.id, now + 4);
        throw new Error("poll failed after peer activated");
      },
    };

    const result = await provisionAndActivateLeague(depsWithBrain(brain, now + 5), league);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
    expect((await getLeague(env.DB, league.id))?.provisioning_error).toBeNull();
  });

  it("returns a typed failure when an error-row retry cannot reread the league", async () => {
    const now = 1_804_072_000_000;
    const league = await seedProvisioningLeague("missing_row", now);
    await failLeague(env.DB, league.id, "previous poll failed");
    const errored = (await getLeague(env.DB, league.id))!;
    await env.DB.prepare("DELETE FROM leagues WHERE id = ?").bind(league.id).run();

    const result = await provisionAndActivateLeague(depsWithBrain(silentBrain(), now + 1), errored);

    expect(result).toEqual({ ok: false, error: { kind: "provisioning_failed" } });
  });

  it("returns success when a stale error row retries after a peer already activated", async () => {
    const now = 1_804_075_000_000;
    const league = await seedProvisioningLeague("stale_error_active", now);
    await failLeague(env.DB, league.id, "previous poll failed");
    const errored = (await getLeague(env.DB, league.id))!;
    expect(errored.status).toBe("error");
    await provisionLeague(env.DB, league.id, now + 1);
    await activateLeague(env.DB, league.id, now + 2);

    const result = await provisionAndActivateLeague(depsWithBrain(silentBrain(), now + 3), errored);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
  });

  it("returns the existing typed failure when poll fails and a peer already marked error (does not overwrite)", async () => {
    const now = 1_804_070_000_000;
    const league = await seedProvisioningLeague("fail_cas_error", now);
    const brain: LeagueBrainHandle = {
      async bootstrap() {},
      async poll() {
        await failLeague(env.DB, league.id, "peer failed first");
        throw new Error("our poll also failed");
      },
    };

    const result = await provisionAndActivateLeague(depsWithBrain(brain, now + 6), league);

    expect(result).toEqual({ ok: false, error: { kind: "provisioning_failed" } });
    const stored = await getLeague(env.DB, league.id);
    expect(stored?.status).toBe("error");
    expect(stored?.provisioning_error).toBe("peer failed first");
  });

  it("stamps provisioning_started_at from a single attempt-start now() before bootstrap", async () => {
    const createdAt = 1_804_200_000_000;
    const attemptAt = createdAt + 5_000;
    const activatedAt = createdAt + 6_000;
    const league = await seedProvisioningLeague("now_once", createdAt);
    expect(league.provisioning_started_at).toBe(createdAt);

    const nowFn = vi.fn().mockReturnValueOnce(attemptAt).mockReturnValueOnce(activatedAt);
    const result = await provisionAndActivateLeague(
      { db: env.DB, brain: silentBrain(), now: nowFn },
      league,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(nowFn).toHaveBeenCalledTimes(2);
    expect(result.league.created_at).toBe(createdAt);
    expect(result.league.provisioning_started_at).toBe(attemptAt);
    expect(result.league.activated_at).toBe(activatedAt);
    expect(await getLeague(env.DB, league.id)).toMatchObject({
      created_at: createdAt,
      provisioning_started_at: attemptAt,
      activated_at: activatedAt,
    });
  });

  it("refreshes provisioning_started_at from the retry now when recovering from error", async () => {
    const createdAt = 1_804_210_000_000;
    const retryAt = createdAt + 10_000;
    const league = await seedProvisioningLeague("error_refresh", createdAt);
    await failLeague(env.DB, league.id, "previous poll failed");
    const errored = (await getLeague(env.DB, league.id))!;
    expect(errored.provisioning_started_at).toBe(createdAt);

    const nowFn = vi.fn().mockReturnValueOnce(retryAt).mockReturnValueOnce(retryAt + 1);
    const result = await provisionAndActivateLeague(
      { db: env.DB, brain: silentBrain(), now: nowFn },
      errored,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(nowFn).toHaveBeenCalledTimes(2);
    expect(result.league.created_at).toBe(createdAt);
    expect(result.league.provisioning_started_at).toBe(retryAt);
    expect(result.league.activated_at).toBe(retryAt + 1);
  });

  it("records attempt start with now() once when poll fails", async () => {
    const createdAt = 1_804_220_000_000;
    const attemptAt = createdAt + 3;
    const league = await seedProvisioningLeague("fail_now_once", createdAt);
    const nowFn = vi.fn(() => attemptAt);

    const result = await provisionAndActivateLeague(
      { db: env.DB, brain: throwingBrain(new Error("Sleeper 502")), now: nowFn },
      league,
    );

    expect(result).toEqual({ ok: false, error: { kind: "provisioning_failed" } });
    expect(nowFn).toHaveBeenCalledTimes(1);
    const stored = await getLeague(env.DB, league.id);
    expect(stored?.status).toBe("error");
    expect(stored?.created_at).toBe(createdAt);
    expect(stored?.provisioning_started_at).toBe(attemptAt);
  });
});

describe("provision deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a hung bootstrap, skips poll, and stores a safe D1 diagnostic", async () => {
    const now = 1_804_100_000_000;
    const league = await seedProvisioningLeague("bootstrap_timeout", now);
    const bootstrap = deferred<void>();
    let pollCalls = 0;
    const brain: LeagueBrainHandle = {
      bootstrap: () => bootstrap.promise,
      poll: async () => {
        pollCalls += 1;
      },
    };

    useProvisionFakeTimers();
    let settled = false;
    const pending = provisionAndActivateLeague(depsWithBrain(brain, now + 1, injectableClock().clock), league).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(PROVISION_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(pollCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    const result = await pending;
    bootstrap.resolve();

    expect(result).toEqual({ ok: false, error: { kind: "provisioning_failed" } });
    expect(pollCalls).toBe(0);
    const stored = await getLeague(env.DB, league.id);
    expect(stored?.status).toBe("error");
    expect(stored?.provisioning_error).toBe("League setup timed out");
    expect(stored?.provisioning_error).not.toMatch(/at bootstrap|TypeError|stack/i);
  });

  it("times out a hung poll after bootstrap succeeds and stores a safe D1 diagnostic", async () => {
    const now = 1_804_110_000_000;
    const league = await seedProvisioningLeague("poll_timeout", now);
    const poll = deferred<void>();
    let bootstrapCalls = 0;
    const brain: LeagueBrainHandle = {
      async bootstrap() {
        bootstrapCalls += 1;
      },
      poll: () => poll.promise,
    };

    useProvisionFakeTimers();
    let settled = false;
    const pending = provisionAndActivateLeague(depsWithBrain(brain, now + 1, injectableClock().clock), league).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(PROVISION_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(bootstrapCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    const result = await pending;
    poll.resolve();

    expect(result).toEqual({ ok: false, error: { kind: "provisioning_failed" } });
    const stored = await getLeague(env.DB, league.id);
    expect(stored?.status).toBe("error");
    expect(stored?.provisioning_error).toBe("League setup timed out");
    expect(stored?.provisioning_error).not.toMatch(/at poll|TypeError|stack/i);
  });

  it("activates when bootstrap and poll finish before the deadline", async () => {
    const now = 1_804_120_000_000;
    const league = await seedProvisioningLeague("timely", now);
    const bootstrap = deferred<void>();
    const poll = deferred<void>();
    const brain: LeagueBrainHandle = {
      bootstrap: () => bootstrap.promise,
      poll: () => poll.promise,
    };

    useProvisionFakeTimers();
    const pending = provisionAndActivateLeague(depsWithBrain(brain, now + 1, injectableClock().clock), league);
    bootstrap.resolve();
    poll.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
    expect(result.league.provisioning_error).toBeNull();
  });

  it("clears the deadline timer so a timely success does not reject later", async () => {
    const now = 1_804_130_000_000;
    const league = await seedProvisioningLeague("timer_cleanup", now);
    const bootstrap = deferred<void>();
    const poll = deferred<void>();
    const brain: LeagueBrainHandle = {
      bootstrap: () => bootstrap.promise,
      poll: () => poll.promise,
    };

    useProvisionFakeTimers();
    const pending = provisionAndActivateLeague(depsWithBrain(brain, now + 1, injectableClock().clock), league);
    bootstrap.resolve();
    poll.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(PROVISION_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
    expect(result.league.provisioning_error).toBeNull();
    expect((await getLeague(env.DB, league.id))?.status).toBe("active");
  });

  it("gives poll only the remaining budget after a slow bootstrap, and never exceeds 20s total", async () => {
    const now = 1_804_140_000_000;
    const league = await seedProvisioningLeague("shared_deadline", now);
    const bootstrap = deferred<void>();
    const poll = deferred<void>();
    let pollCalls = 0;
    const brain: LeagueBrainHandle = {
      bootstrap: () => bootstrap.promise,
      poll: () => {
        pollCalls += 1;
        return poll.promise;
      },
    };

    const { clock, elapse } = injectableClock();
    useProvisionFakeTimers();
    let settled = false;
    const pending = provisionAndActivateLeague(depsWithBrain(brain, now + 1, clock), league).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    elapse(15_000);
    expect(settled).toBe(false);
    expect(pollCalls).toBe(0);
    bootstrap.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollCalls).toBe(1);
    expect(settled).toBe(false);

    const remainingAfterBootstrap = PROVISION_TIMEOUT_MS - 15_000;
    await vi.advanceTimersByTimeAsync(remainingAfterBootstrap - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    const result = await pending;
    poll.resolve();

    expect(result).toEqual({ ok: false, error: { kind: "provisioning_failed" } });
    expect((await getLeague(env.DB, league.id))?.provisioning_error).toBe("League setup timed out");
  });

  it("activates when a slow bootstrap leaves enough remaining time for poll", async () => {
    const now = 1_804_145_000_000;
    const league = await seedProvisioningLeague("remainder_success", now);
    const bootstrap = deferred<void>();
    const poll = deferred<void>();
    const brain: LeagueBrainHandle = {
      bootstrap: () => bootstrap.promise,
      poll: () => poll.promise,
    };

    const { clock, elapse } = injectableClock();
    useProvisionFakeTimers();
    const pending = provisionAndActivateLeague(depsWithBrain(brain, now + 1, clock), league);

    await vi.advanceTimersByTimeAsync(15_000);
    elapse(15_000);
    bootstrap.resolve();
    poll.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
    expect(result.league.provisioning_error).toBeNull();
  });

  it("skips poll when bootstrap consumes the entire deadline", async () => {
    const now = 1_804_150_000_000;
    const league = await seedProvisioningLeague("budget_exhausted", now);
    let elapsed = 0;
    let pollCalls = 0;
    const brain: LeagueBrainHandle = {
      async bootstrap() {
        elapsed = PROVISION_TIMEOUT_MS;
      },
      poll: async () => {
        pollCalls += 1;
      },
    };

    const result = await provisionAndActivateLeague(depsWithBrain(brain, now + 1, () => elapsed), league);

    expect(pollCalls).toBe(0);
    expect(result).toEqual({ ok: false, error: { kind: "provisioning_failed" } });
    const stored = await getLeague(env.DB, league.id);
    expect(stored?.status).toBe("error");
    expect(stored?.provisioning_error).toBe("League setup timed out");
  });
});

describe("retryProvisionAndActivateLeague", () => {
  it("rejects a non-commissioner member and leaves the league in error", async () => {
    const now = 1_804_080_000_000;
    const league = await seedProvisioningLeague("retry_member", now);
    await failLeague(env.DB, league.id, "setup exploded");
    const errored = (await getLeague(env.DB, league.id))!;
    const member = await upsertUserByClerkId(env.DB, {
      id: "user_prov_member_retry",
      email: "prov-member-retry@example.test",
      now,
    });
    const membership = await upsertLeagueMember(env.DB, {
      leagueId: league.id,
      userId: member.id,
      role: "member",
      now,
    });

    const result = await retryProvisionAndActivateLeague(depsWithBrain(silentBrain(), now + 1), {
      league: errored,
      membership,
    });

    expect(result).toEqual({ ok: false, error: { kind: "not_commissioner" } });
    expect((await getLeague(env.DB, league.id))?.status).toBe("error");
  });

  it("lets the commissioner retry an error league through to active", async () => {
    const now = 1_804_090_000_000;
    const league = await seedProvisioningLeague("retry_commish", now);
    await failLeague(env.DB, league.id, "setup exploded");
    const errored = (await getLeague(env.DB, league.id))!;
    const commish = await upsertUserByClerkId(env.DB, {
      id: "user_prov_commish_retry",
      email: "prov-commish-retry@example.test",
      now,
    });
    const membership = await upsertLeagueMember(env.DB, {
      leagueId: league.id,
      userId: commish.id,
      role: "commissioner",
      now,
    });

    const result = await retryProvisionAndActivateLeague(
      provisioningDepsFromEnv(env, league.id, () => now + 2),
      { league: errored, membership },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
  });
});
