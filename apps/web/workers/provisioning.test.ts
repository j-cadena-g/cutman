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
import { beforeAll, describe, expect, it } from "vitest";
import {
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

function depsWithBrain(brain: LeagueBrainHandle, now: number): ProvisioningDeps {
  return { db: env.DB, brain, now: () => now };
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
    const league = await createLeague(env.DB, {
      id: "internal_prov_poll_v1",
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

    const result = await provisionAndActivateLeague(depsWithBrain(silentBrain(), now + 2), activated);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.league.status).toBe("active");
    expect(result.league.activated_at).toBe(now + 1);
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

  it("returns success when a stale error row retries after a peer already activated", async () => {
    const now = 1_804_075_000_000;
    const league = await seedProvisioningLeague("stale_error_active", now);
    await failLeague(env.DB, league.id, "previous poll failed");
    const errored = (await getLeague(env.DB, league.id))!;
    expect(errored.status).toBe("error");
    await provisionLeague(env.DB, league.id);
    await activateLeague(env.DB, league.id, now + 1);

    const result = await provisionAndActivateLeague(depsWithBrain(silentBrain(), now + 2), errored);

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
