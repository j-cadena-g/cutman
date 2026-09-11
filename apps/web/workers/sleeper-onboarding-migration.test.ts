/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { migrationNamed, userTables } from "./d1-migration-test-helpers.ts";

async function indexNames(): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'index'
       AND name IN (
         'league_members_user_id_idx',
         'league_verifications_user_id_idx',
         'league_verifications_sleeper_league_id_idx',
         'league_verifications_pending_user_league_idx'
       )
     ORDER BY name`,
  ).all<{ name: string }>();
  return result.results.map((row) => row.name);
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? -1;
}

const FINAL_TABLES = [
  "app_state",
  "league_members",
  "league_verifications",
  "leagues",
  "sleeper_accounts",
  "users",
];

const FINAL_INDEXES = [
  "league_members_user_id_idx",
  "league_verifications_pending_user_league_idx",
  "league_verifications_sleeper_league_id_idx",
  "league_verifications_user_id_idx",
];

describe("0002 sleeper onboarding migration", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, migrationNamed("0001_init"));

    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_commish",
        "commish@example.test",
        1_000,
      ),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_member",
        "member@example.test",
        2_000,
      ),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_allowlist",
        "allow@example.test",
        3_000,
      ),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_unlinked",
        "unlinked@example.test",
        4_000,
      ),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_recent",
        "recent@example.test",
        7_000,
      ),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_spaced",
        "  Spaced@example.test",
        8_000,
      ),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_commish", "hoopz", "Commish@example.test", 1_100),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_member", "bench", null, 2_100),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_allow_only", "waivers", "Allow@example.test", 3_100),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_orphan", "ghost", "ghost@example.test", 4_100),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_aaa_old", "oldest", null, 7_050),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_zzz_recent", "latest", null, 7_100),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_spaced", "padded", "  SPACED@example.test  ", 8_100),
      env.DB.prepare(
        "INSERT INTO leagues (sleeper_league_id, name, season, enabled_at, tone) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_aaa", "Dynasty", "2026", 5_000, "playful"),
      env.DB.prepare(
        "INSERT INTO leagues (sleeper_league_id, name, season, enabled_at, tone) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_bbb", "Redraft", "2025", 6_000, "dry"),
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_aaa", "user_commish", "sleeper_commish", 1, 1),
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_aaa", "user_member", "sleeper_member", 0, 0),
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_bbb", "user_commish", "sleeper_commish", 0, 1),
      // Lexical MIN(sleeper_user_id) would pick sleeper_aaa_old; most recently enabled is bbb.
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_aaa", "user_recent", "sleeper_aaa_old", 0, 0),
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_bbb", "user_recent", "sleeper_zzz_recent", 0, 0),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_email_match",
        "  Preferred@example.test",
        9_000,
      ),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_recency",
        "recency@example.test",
        9_100,
      ),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_aaa",
        "aaa@example.test",
        9_200,
      ),
      env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
        "user_zzz",
        "zzz@example.test",
        9_300,
      ),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_shared_email", "shared", "  PREFERRED@example.test  ", 9_050),
      env.DB.prepare(
        "INSERT INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at) VALUES (?, ?, ?, ?)",
      ).bind("sleeper_shared_tie", "tied", null, 9_150),
      env.DB.prepare(
        "INSERT INTO leagues (sleeper_league_id, name, season, enabled_at, tone) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_old_email", "Old Email", "2025", 1_000, "playful"),
      env.DB.prepare(
        "INSERT INTO leagues (sleeper_league_id, name, season, enabled_at, tone) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_new_email", "New Email", "2026", 9_000, "playful"),
      env.DB.prepare(
        "INSERT INTO leagues (sleeper_league_id, name, season, enabled_at, tone) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_old_tie", "Old Tie", "2025", 1_000, "playful"),
      env.DB.prepare(
        "INSERT INTO leagues (sleeper_league_id, name, season, enabled_at, tone) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_new_tie", "New Tie", "2026", 9_000, "playful"),
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_old_email", "user_email_match", "sleeper_shared_email", 0, 0),
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_new_email", "user_recency", "sleeper_shared_email", 0, 0),
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_old_tie", "user_aaa", "sleeper_shared_tie", 0, 0),
      env.DB.prepare(
        "INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in) VALUES (?, ?, ?, ?, ?)",
      ).bind("sleeper_league_new_tie", "user_zzz", "sleeper_shared_tie", 0, 0),
    ]);

    await applyD1Migrations(env.DB, migrationNamed("0002_sleeper_onboarding"));
  });

  it("migrates representative legacy rows without dropping users or memberships", async () => {
    expect(await userTables()).toEqual(FINAL_TABLES);
    expect(await indexNames()).toEqual(FINAL_INDEXES);

    const pendingIndex = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'league_verifications_pending_user_league_idx'",
    ).first<{ sql: string }>();
    expect(pendingIndex?.sql).toMatch(/WHERE\s+status\s*=\s*'pending'/i);

    const users = await env.DB.prepare("SELECT id, email, created_at FROM users ORDER BY id").all<{
      id: string;
      email: string;
      created_at: number;
    }>();
    expect(users.results).toEqual([
      { id: "user_aaa", email: "aaa@example.test", created_at: 9_200 },
      { id: "user_allowlist", email: "allow@example.test", created_at: 3_000 },
      { id: "user_commish", email: "commish@example.test", created_at: 1_000 },
      { id: "user_email_match", email: "  Preferred@example.test", created_at: 9_000 },
      { id: "user_member", email: "member@example.test", created_at: 2_000 },
      { id: "user_recency", email: "recency@example.test", created_at: 9_100 },
      { id: "user_recent", email: "recent@example.test", created_at: 7_000 },
      { id: "user_spaced", email: "  Spaced@example.test", created_at: 8_000 },
      { id: "user_unlinked", email: "unlinked@example.test", created_at: 4_000 },
      { id: "user_zzz", email: "zzz@example.test", created_at: 9_300 },
    ]);

    const leagueColumns = await env.DB.prepare("PRAGMA table_info(leagues)").all<{
      name: string;
      notnull: number;
    }>();
    expect(leagueColumns.results.map((column) => column.name)).toEqual([
      "id",
      "sleeper_league_id",
      "name",
      "season",
      "status",
      "tone",
      "created_at",
      "activated_at",
      "provisioning_error",
      "provisioning_started_at",
    ]);
    expect(leagueColumns.results.find((column) => column.name === "provisioning_started_at")?.notnull).toBe(0);
    const memberColumns = await env.DB.prepare("PRAGMA table_info(league_members)").all<{
      name: string;
    }>();
    expect(memberColumns.results.map((column) => column.name)).toEqual([
      "league_id",
      "user_id",
      "role",
      "recap_email_opt_in",
      "created_at",
    ]);

    const leagues = await env.DB.prepare(
      `SELECT id, sleeper_league_id, name, season, status, tone, created_at, activated_at, provisioning_error, provisioning_started_at
       FROM leagues
       ORDER BY id`,
    ).all<{
      id: string;
      sleeper_league_id: string;
      name: string;
      season: string;
      status: string;
      tone: string;
      created_at: number;
      activated_at: number | null;
      provisioning_error: string | null;
      provisioning_started_at: number | null;
    }>();
    expect(leagues.results).toEqual([
      {
        id: "legacy_sleeper_league_aaa",
        sleeper_league_id: "sleeper_league_aaa",
        name: "Dynasty",
        season: "2026",
        status: "active",
        tone: "playful",
        created_at: 5_000,
        activated_at: 5_000,
        provisioning_error: null,
        provisioning_started_at: null,
      },
      {
        id: "legacy_sleeper_league_bbb",
        sleeper_league_id: "sleeper_league_bbb",
        name: "Redraft",
        season: "2025",
        status: "active",
        tone: "dry",
        created_at: 6_000,
        activated_at: 6_000,
        provisioning_error: null,
        provisioning_started_at: null,
      },
      {
        id: "legacy_sleeper_league_new_email",
        sleeper_league_id: "sleeper_league_new_email",
        name: "New Email",
        season: "2026",
        status: "active",
        tone: "playful",
        created_at: 9_000,
        activated_at: 9_000,
        provisioning_error: null,
        provisioning_started_at: null,
      },
      {
        id: "legacy_sleeper_league_new_tie",
        sleeper_league_id: "sleeper_league_new_tie",
        name: "New Tie",
        season: "2026",
        status: "active",
        tone: "playful",
        created_at: 9_000,
        activated_at: 9_000,
        provisioning_error: null,
        provisioning_started_at: null,
      },
      {
        id: "legacy_sleeper_league_old_email",
        sleeper_league_id: "sleeper_league_old_email",
        name: "Old Email",
        season: "2025",
        status: "active",
        tone: "playful",
        created_at: 1_000,
        activated_at: 1_000,
        provisioning_error: null,
        provisioning_started_at: null,
      },
      {
        id: "legacy_sleeper_league_old_tie",
        sleeper_league_id: "sleeper_league_old_tie",
        name: "Old Tie",
        season: "2025",
        status: "active",
        tone: "playful",
        created_at: 1_000,
        activated_at: 1_000,
        provisioning_error: null,
        provisioning_started_at: null,
      },
    ]);
    expect(leagues.results.every((league) => league.id !== league.sleeper_league_id)).toBe(true);

    const members = await env.DB.prepare(
      "SELECT league_id, user_id, role, recap_email_opt_in, created_at FROM league_members ORDER BY league_id, user_id",
    ).all<{
      league_id: string;
      user_id: string;
      role: string;
      recap_email_opt_in: number;
      created_at: number;
    }>();
    expect(members.results).toEqual([
      {
        league_id: "legacy_sleeper_league_aaa",
        user_id: "user_commish",
        role: "member",
        recap_email_opt_in: 1,
        created_at: 5_000,
      },
      {
        league_id: "legacy_sleeper_league_aaa",
        user_id: "user_member",
        role: "member",
        recap_email_opt_in: 0,
        created_at: 5_000,
      },
      {
        league_id: "legacy_sleeper_league_aaa",
        user_id: "user_recent",
        role: "member",
        recap_email_opt_in: 0,
        created_at: 5_000,
      },
      {
        league_id: "legacy_sleeper_league_bbb",
        user_id: "user_commish",
        role: "member",
        recap_email_opt_in: 1,
        created_at: 6_000,
      },
      {
        league_id: "legacy_sleeper_league_bbb",
        user_id: "user_recent",
        role: "member",
        recap_email_opt_in: 0,
        created_at: 6_000,
      },
      {
        league_id: "legacy_sleeper_league_new_email",
        user_id: "user_recency",
        role: "member",
        recap_email_opt_in: 0,
        created_at: 9_000,
      },
      {
        league_id: "legacy_sleeper_league_new_tie",
        user_id: "user_zzz",
        role: "member",
        recap_email_opt_in: 0,
        created_at: 9_000,
      },
      {
        league_id: "legacy_sleeper_league_old_email",
        user_id: "user_email_match",
        role: "member",
        recap_email_opt_in: 0,
        created_at: 1_000,
      },
      {
        league_id: "legacy_sleeper_league_old_tie",
        user_id: "user_aaa",
        role: "member",
        recap_email_opt_in: 0,
        created_at: 1_000,
      },
    ]);
    expect(members.results.every((member) => member.role === "member")).toBe(true);
    expect(members.results.some((member) => member.role === "commissioner")).toBe(false);

    const accounts = await env.DB.prepare(
      "SELECT user_id, sleeper_user_id, username, display_name, updated_at FROM sleeper_accounts ORDER BY user_id",
    ).all<{
      user_id: string;
      sleeper_user_id: string;
      username: string;
      display_name: string;
      updated_at: number;
    }>();
    expect(accounts.results).toEqual([
      {
        user_id: "user_allowlist",
        sleeper_user_id: "sleeper_allow_only",
        username: "waivers",
        display_name: "waivers",
        updated_at: 3_100,
      },
      {
        user_id: "user_commish",
        sleeper_user_id: "sleeper_commish",
        username: "hoopz",
        display_name: "hoopz",
        updated_at: 1_100,
      },
      {
        user_id: "user_email_match",
        sleeper_user_id: "sleeper_shared_email",
        username: "shared",
        display_name: "shared",
        updated_at: 9_050,
      },
      {
        user_id: "user_member",
        sleeper_user_id: "sleeper_member",
        username: "bench",
        display_name: "bench",
        updated_at: 2_100,
      },
      {
        user_id: "user_recent",
        sleeper_user_id: "sleeper_zzz_recent",
        username: "latest",
        display_name: "latest",
        updated_at: 7_100,
      },
      {
        user_id: "user_spaced",
        sleeper_user_id: "sleeper_spaced",
        username: "padded",
        display_name: "padded",
        updated_at: 8_100,
      },
      {
        user_id: "user_zzz",
        sleeper_user_id: "sleeper_shared_tie",
        username: "tied",
        display_name: "tied",
        updated_at: 9_150,
      },
    ]);
    expect(accounts.results.some((account) => account.sleeper_user_id === "sleeper_aaa_old")).toBe(
      false,
    );

    expect(await count("league_verifications")).toBe(0);
    expect(await count("users")).toBe(10);
    expect(await count("league_members")).toBe(9);
    expect(await count("sleeper_accounts")).toBe(7);
    expect(await count("app_state")).toBe(0);
  });

  it("keeps the allowlist email-matched Clerk user when two users share a sleeper_user_id", async () => {
    const shared = await env.DB.prepare(
      `SELECT user_id, sleeper_user_id, username, display_name, updated_at
       FROM sleeper_accounts
       WHERE sleeper_user_id = ?
       ORDER BY user_id`,
    )
      .bind("sleeper_shared_email")
      .all<{
        user_id: string;
        sleeper_user_id: string;
        username: string;
        display_name: string;
        updated_at: number;
      }>();
    expect(shared.results).toEqual([
      {
        user_id: "user_email_match",
        sleeper_user_id: "sleeper_shared_email",
        username: "shared",
        display_name: "shared",
        updated_at: 9_050,
      },
    ]);
    const discarded = await env.DB.prepare("SELECT user_id FROM sleeper_accounts WHERE user_id = ?")
      .bind("user_recency")
      .first<{ user_id: string }>();
    expect(discarded).toBeNull();

    const members = await env.DB.prepare(
      `SELECT user_id, role FROM league_members
       WHERE user_id IN ('user_email_match', 'user_recency')
       ORDER BY user_id`,
    ).all<{ user_id: string; role: string }>();
    expect(members.results).toEqual([
      { user_id: "user_email_match", role: "member" },
      { user_id: "user_recency", role: "member" },
    ]);
  });

  it("keeps the documented tie-break Clerk user when two users share a sleeper_user_id without an allowlist email match", async () => {
    const shared = await env.DB.prepare(
      `SELECT user_id, sleeper_user_id, username, display_name, updated_at
       FROM sleeper_accounts
       WHERE sleeper_user_id = ?
       ORDER BY user_id`,
    )
      .bind("sleeper_shared_tie")
      .all<{
        user_id: string;
        sleeper_user_id: string;
        username: string;
        display_name: string;
        updated_at: number;
      }>();
    expect(shared.results).toEqual([
      {
        user_id: "user_zzz",
        sleeper_user_id: "sleeper_shared_tie",
        username: "tied",
        display_name: "tied",
        updated_at: 9_150,
      },
    ]);
    const discarded = await env.DB.prepare("SELECT user_id FROM sleeper_accounts WHERE user_id = ?")
      .bind("user_aaa")
      .first<{ user_id: string }>();
    expect(discarded).toBeNull();

    const members = await env.DB.prepare(
      `SELECT user_id, role FROM league_members
       WHERE user_id IN ('user_aaa', 'user_zzz')
       ORDER BY user_id`,
    ).all<{ user_id: string; role: string }>();
    expect(members.results).toEqual([
      { user_id: "user_aaa", role: "member" },
      { user_id: "user_zzz", role: "member" },
    ]);
  });
});
