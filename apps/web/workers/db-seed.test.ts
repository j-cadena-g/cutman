/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import {
  V1_LEAGUE_ID,
  activateLeague,
  consumeVerification,
  createLeague,
  createVerification,
  ensureLeagueMember,
  ensureSchema,
  failLeague,
  findPendingVerification,
  getLeague,
  getLeagueBySleeperId,
  getLeagueMember,
  getSleeperAccountByUserId,
  getSleeperAccountBySleeperUserId,
  getVerification,
  linkSleeperAccount,
  listActiveLeagues,
  listLeaguesForUser,
  provisionLeague,
  refreshSleeperAccount,
  upsertLeagueMember,
  upsertUserByClerkId,
} from "@cutman/db";
import { beforeAll, describe, expect, it } from "vitest";

type D1Migration = { name: string; queries: string[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

describe("schema", () => {
  it("does not insert placeholder league rows", async () => {
    await ensureSchema(env.DB);
    expect(await getLeague(env.DB, V1_LEAGUE_ID)).toBeNull();
  });

  it("does not create an allowlist table", async () => {
    await ensureSchema(env.DB);
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'allowlist'",
    ).first<{ name: string }>();
    expect(table).toBeNull();
  });

  it("is idempotent and never drops existing rows on repeated calls", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_000_500_000;
    const league = await createLeague(env.DB, {
      id: "league_ensure_idempotent",
      sleeperLeagueId: "sleeper_league_ensure_idempotent",
      name: "Ensure Idempotent",
      season: "2026",
      now,
    });
    await ensureSchema(env.DB);
    await ensureSchema(env.DB);
    expect(await getLeague(env.DB, league.id)).toEqual(league);
  });
});

describe("sleeper accounts", () => {
  it("links, refreshes, and retrieves a Sleeper account by Clerk or Sleeper id", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_100_000_000;
    const user = await upsertUserByClerkId(env.DB, { id: "user_link_1", email: "link1@example.test", now });
    const linked = await linkSleeperAccount(env.DB, {
      userId: user.id,
      sleeperUserId: "sleeper_1",
      username: "hoopz",
      displayName: "Hoopz",
      now,
    });
    expect(linked).toEqual({
      user_id: user.id,
      sleeper_user_id: "sleeper_1",
      username: "hoopz",
      display_name: "Hoopz",
      updated_at: now,
    });
    expect(await getSleeperAccountByUserId(env.DB, user.id)).toEqual(linked);
    expect(await getSleeperAccountBySleeperUserId(env.DB, "sleeper_1")).toEqual(linked);

    const refreshedAt = now + 1000;
    const refreshed = await refreshSleeperAccount(env.DB, {
      userId: user.id,
      username: "hoopz2",
      displayName: "Hoopz Two",
      now: refreshedAt,
    });
    expect(refreshed.sleeper_user_id).toBe("sleeper_1");
    expect(refreshed.username).toBe("hoopz2");
    expect(refreshed.display_name).toBe("Hoopz Two");
    expect(refreshed.updated_at).toBe(refreshedAt);
  });

  it("keeps sleeper_user_id unique across accounts", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_100_100_000;
    const first = await upsertUserByClerkId(env.DB, { id: "user_link_2", email: "link2@example.test", now });
    const second = await upsertUserByClerkId(env.DB, { id: "user_link_3", email: "link3@example.test", now });
    await linkSleeperAccount(env.DB, {
      userId: first.id,
      sleeperUserId: "sleeper_dupe",
      username: "one",
      displayName: "One",
      now,
    });
    await expect(
      linkSleeperAccount(env.DB, {
        userId: second.id,
        sleeperUserId: "sleeper_dupe",
        username: "two",
        displayName: "Two",
        now,
      }),
    ).rejects.toThrow();
  });
});

describe("leagues", () => {
  it("creates a league in provisioning status", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_200_000_000;
    const league = await createLeague(env.DB, {
      id: "league_1",
      sleeperLeagueId: "sleeper_league_1",
      name: "Provisional League",
      season: "2026",
      now,
    });
    expect(league.status).toBe("provisioning");
    expect(league.activated_at).toBeNull();
    expect(league.provisioning_error).toBeNull();
    expect(await getLeagueBySleeperId(env.DB, "sleeper_league_1")).toEqual(league);
  });

  it("activates a provisioning league and clears prior errors after a retry", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_200_100_000;
    const league = await createLeague(env.DB, {
      id: "league_2",
      sleeperLeagueId: "sleeper_league_2",
      name: "Activating League",
      season: "2026",
      now,
    });
    await failLeague(env.DB, league.id, "Sleeper API timed out");
    const failed = await getLeague(env.DB, league.id);
    expect(failed?.status).toBe("error");
    expect(failed?.provisioning_error).toBe("Sleeper API timed out");

    const retried = await provisionLeague(env.DB, league.id);
    expect(retried.status).toBe("provisioning");
    expect(retried.provisioning_error).toBeNull();

    const activatedAt = now + 1000;
    const activated = await activateLeague(env.DB, league.id, activatedAt);
    expect(activated.status).toBe("active");
    expect(activated.activated_at).toBe(activatedAt);
    expect(activated.provisioning_error).toBeNull();
  });

  it("does not fail or duplicate when createLeague runs twice for the same Sleeper league", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_200_200_000;
    const first = await createLeague(env.DB, {
      id: "league_3",
      sleeperLeagueId: "sleeper_league_3",
      name: "Once",
      season: "2026",
      now,
    });
    const second = await createLeague(env.DB, {
      id: "league_3",
      sleeperLeagueId: "sleeper_league_3",
      name: "Once Again",
      season: "2027",
      now: now + 1,
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe(first.name);
    expect(second.created_at).toBe(first.created_at);
  });

  it("rejects a status outside provisioning, active, or error", async () => {
    await ensureSchema(env.DB);
    // This table has no foreign keys, so a rejection here can only come from the `status` CHECK.
    await expect(
      env.DB.prepare(
        "INSERT INTO leagues (id, sleeper_league_id, name, season, status, tone, created_at) VALUES (?, ?, ?, ?, 'bogus', 'playful', ?)",
      )
        .bind("league_bad", "sleeper_league_bad", "Bad", "2026", 1)
        .run(),
    ).rejects.toThrow();
  });

  it("rejects creating a league when the internal id already maps to a different Sleeper league id", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_210_000_000;
    await createLeague(env.DB, {
      id: "league_conflict_1",
      sleeperLeagueId: "sleeper_league_conflict_1",
      name: "Conflict A",
      season: "2026",
      now,
    });
    await expect(
      createLeague(env.DB, {
        id: "league_conflict_1",
        sleeperLeagueId: "sleeper_league_conflict_1_other",
        name: "Conflict A Retry",
        season: "2026",
        now: now + 1,
      }),
    ).rejects.toThrow(/sleeper league id/i);
  });

  it("rejects creating a league when the Sleeper league id already maps to a different internal id", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_210_100_000;
    await createLeague(env.DB, {
      id: "league_conflict_2a",
      sleeperLeagueId: "sleeper_league_conflict_2",
      name: "Conflict B",
      season: "2026",
      now,
    });
    await expect(
      createLeague(env.DB, {
        id: "league_conflict_2b",
        sleeperLeagueId: "sleeper_league_conflict_2",
        name: "Conflict B Retry",
        season: "2026",
        now: now + 1,
      }),
    ).rejects.toThrow(/already linked/i);
  });

  it("never demotes an active league back to provisioning", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_220_000_000;
    const league = await createLeague(env.DB, {
      id: "league_lifecycle_1",
      sleeperLeagueId: "sleeper_league_lifecycle_1",
      name: "Lifecycle",
      season: "2026",
      now,
    });
    await activateLeague(env.DB, league.id, now + 1);
    await expect(provisionLeague(env.DB, league.id)).rejects.toThrow(
      /from status "active"; provisioning only retries from "provisioning" or "error"/,
    );
    const stillActive = await getLeague(env.DB, league.id);
    expect(stillActive?.status).toBe("active");
  });

  it("activates only from provisioning", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_220_100_000;
    const league = await createLeague(env.DB, {
      id: "league_lifecycle_2",
      sleeperLeagueId: "sleeper_league_lifecycle_2",
      name: "Lifecycle 2",
      season: "2026",
      now,
    });
    await activateLeague(env.DB, league.id, now + 1);
    await expect(activateLeague(env.DB, league.id, now + 2)).rejects.toThrow(
      /from status "active"; activation only applies to leagues that are "provisioning"/,
    );
  });

  it("fails only from provisioning", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_220_200_000;
    const league = await createLeague(env.DB, {
      id: "league_lifecycle_3",
      sleeperLeagueId: "sleeper_league_lifecycle_3",
      name: "Lifecycle 3",
      season: "2026",
      now,
    });
    await activateLeague(env.DB, league.id, now + 1);
    await expect(failLeague(env.DB, league.id, "boom")).rejects.toThrow(
      /from status "active"; failure only applies to leagues that are "provisioning"/,
    );
    const stillActive = await getLeague(env.DB, league.id);
    expect(stillActive?.status).toBe("active");
    expect(stillActive?.provisioning_error).toBeNull();
  });
});

describe("league members", () => {
  it("requires an explicit role and never infers commissioner from insertion order", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_300_000_000;
    const league = await createLeague(env.DB, {
      id: "league_members_1",
      sleeperLeagueId: "sleeper_league_members_1",
      name: "Members",
      season: "2026",
      now,
    });
    const first = await upsertUserByClerkId(env.DB, { id: "user_m1", email: "m1@example.test", now });
    const second = await upsertUserByClerkId(env.DB, { id: "user_m2", email: "m2@example.test", now });

    const firstMember = await upsertLeagueMember(env.DB, {
      leagueId: league.id,
      userId: first.id,
      role: "member",
      now,
    });
    const secondMember = await upsertLeagueMember(env.DB, {
      leagueId: league.id,
      userId: second.id,
      role: "commissioner",
      now,
    });
    expect(firstMember.role).toBe("member");
    expect(secondMember.role).toBe("commissioner");
    expect(await getLeagueMember(env.DB, league.id, first.id)).toEqual(firstMember);
  });

  it("lets an explicit upsert change an existing member's role", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_300_100_000;
    const league = await createLeague(env.DB, {
      id: "league_members_2",
      sleeperLeagueId: "sleeper_league_members_2",
      name: "Promote",
      season: "2026",
      now,
    });
    const user = await upsertUserByClerkId(env.DB, { id: "user_m3", email: "m3@example.test", now });
    await upsertLeagueMember(env.DB, { leagueId: league.id, userId: user.id, role: "member", now });
    const promoted = await upsertLeagueMember(env.DB, {
      leagueId: league.id,
      userId: user.id,
      role: "commissioner",
      now: now + 10,
    });
    expect(promoted.role).toBe("commissioner");
  });

  it("rejects a role outside commissioner or member", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_300_200_000;
    const league = await createLeague(env.DB, {
      id: "league_members_3",
      sleeperLeagueId: "sleeper_league_members_3",
      name: "Bad role",
      season: "2026",
      now,
    });
    // Use a real, existing user so a rejection here can only come from the `role` CHECK, not the
    // `user_id` foreign key.
    const user = await upsertUserByClerkId(env.DB, { id: "user_bad_role", email: "bad-role@example.test", now });
    await expect(
      env.DB.prepare(
        "INSERT INTO league_members (league_id, user_id, role, recap_email_opt_in, created_at) VALUES (?, ?, 'owner', 0, ?)",
      )
        .bind(league.id, user.id, now)
        .run(),
    ).rejects.toThrow();
  });

  it("ensures membership without ever overwriting an existing role", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_310_000_000;
    const league = await createLeague(env.DB, {
      id: "league_members_4",
      sleeperLeagueId: "sleeper_league_members_4",
      name: "Ensure",
      season: "2026",
      now,
    });
    const user = await upsertUserByClerkId(env.DB, { id: "user_m4", email: "m4@example.test", now });

    const created = await ensureLeagueMember(env.DB, { leagueId: league.id, userId: user.id, now });
    expect(created.role).toBe("member");

    await upsertLeagueMember(env.DB, {
      leagueId: league.id,
      userId: user.id,
      role: "commissioner",
      now: now + 1,
    });

    const stillCommissioner = await ensureLeagueMember(env.DB, {
      leagueId: league.id,
      userId: user.id,
      now: now + 2,
    });
    expect(stillCommissioner.role).toBe("commissioner");
  });
});

describe("league listings", () => {
  it("lists a user's leagues and separately lists only active leagues", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_400_000_000;
    const user = await upsertUserByClerkId(env.DB, { id: "user_list_1", email: "list1@example.test", now });
    const active = await createLeague(env.DB, {
      id: "league_list_active",
      sleeperLeagueId: "sleeper_league_list_active",
      name: "Active",
      season: "2026",
      now,
    });
    await activateLeague(env.DB, active.id, now + 1);
    const provisioning = await createLeague(env.DB, {
      id: "league_list_provisioning",
      sleeperLeagueId: "sleeper_league_list_provisioning",
      name: "Provisioning",
      season: "2026",
      now: now + 2,
    });
    await upsertLeagueMember(env.DB, { leagueId: active.id, userId: user.id, role: "commissioner", now });
    await upsertLeagueMember(env.DB, { leagueId: provisioning.id, userId: user.id, role: "member", now });

    const userLeagues = await listLeaguesForUser(env.DB, user.id);
    expect(userLeagues.map((league) => league.id)).toEqual([active.id, provisioning.id]);

    const activeLeagues = await listActiveLeagues(env.DB);
    expect(activeLeagues.map((league) => league.id)).toContain(active.id);
    expect(activeLeagues.map((league) => league.id)).not.toContain(provisioning.id);
  });
});

describe("league verifications", () => {
  it("creates, finds, and consumes a pending verification exactly once", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_500_000_000;
    const user = await upsertUserByClerkId(env.DB, { id: "user_verify_1", email: "verify1@example.test", now });
    const created = await createVerification(env.DB, {
      id: "verification_1",
      userId: user.id,
      sleeperUserId: "sleeper_verify_1",
      sleeperLeagueId: "sleeper_league_verify_1",
      challenge: "cutman-4821",
      expiresAt: now + 600_000,
      now,
    });
    expect(created.status).toBe("pending");
    expect(created.attempts).toBe(0);
    expect(created.verified_at).toBeNull();
    expect(await getVerification(env.DB, created.id)).toEqual(created);
    expect(
      await findPendingVerification(env.DB, { userId: user.id, sleeperLeagueId: "sleeper_league_verify_1" }),
    ).toEqual(created);

    const consumedAt = now + 1000;
    const consumed = await consumeVerification(env.DB, { id: created.id, now: consumedAt });
    expect(consumed.status).toBe("verified");
    expect(consumed.verified_at).toBe(consumedAt);

    await expect(consumeVerification(env.DB, { id: created.id, now: consumedAt + 1 })).rejects.toThrow();
    expect(
      await findPendingVerification(env.DB, { userId: user.id, sleeperLeagueId: "sleeper_league_verify_1" }),
    ).toBeNull();
  });

  it("allows only one of two concurrent consume attempts to succeed", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_550_000_000;
    const user = await upsertUserByClerkId(env.DB, {
      id: "user_verify_concurrent",
      email: "verify-concurrent@example.test",
      now,
    });
    const created = await createVerification(env.DB, {
      id: "verification_concurrent",
      userId: user.id,
      sleeperUserId: "sleeper_verify_concurrent",
      sleeperLeagueId: "sleeper_league_verify_concurrent",
      challenge: "cutman-7777",
      expiresAt: now + 600_000,
      now,
    });

    const outcomes = await Promise.allSettled([
      consumeVerification(env.DB, { id: created.id, now: now + 1000 }),
      consumeVerification(env.DB, { id: created.id, now: now + 1000 }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const finalRow = await getVerification(env.DB, created.id);
    expect(finalRow?.status).toBe("verified");
    expect(finalRow?.verified_at).toBe(now + 1000);
  });

  it("expires a stale pending verification and rejects consuming it", async () => {
    await ensureSchema(env.DB);
    const now = 1_700_600_000_000;
    const user = await upsertUserByClerkId(env.DB, { id: "user_verify_2", email: "verify2@example.test", now });
    const created = await createVerification(env.DB, {
      id: "verification_2",
      userId: user.id,
      sleeperUserId: "sleeper_verify_2",
      sleeperLeagueId: "sleeper_league_verify_2",
      challenge: "cutman-1199",
      expiresAt: now + 1000,
      now,
    });
    await expect(consumeVerification(env.DB, { id: created.id, now: now + 5000 })).rejects.toThrow();
    const expired = await getVerification(env.DB, created.id);
    expect(expired?.status).toBe("expired");
  });
});
