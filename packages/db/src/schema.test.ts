import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL, SCHEMA_STATEMENTS } from "./ensure.ts";

const here = dirname(fileURLToPath(import.meta.url));
const d1Dir = join(here, "../../../apps/web/d1");

// Exact SQL deployed as 0001 on main. 0002 migrates this shape to the current schema.
const LEGACY_0001_SQL = `-- D1 holds identity, the allowlist, and recap opt-in.
-- LeagueBrain DO holds bible, timeline, snapshot, and recaps.
-- Live league/user rows are seeded at runtime from Environment V1_* vars.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS allowlist (
  sleeper_user_id TEXT PRIMARY KEY,
  sleeper_username TEXT NOT NULL,
  clerk_email TEXT UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leagues (
  sleeper_league_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  enabled_at INTEGER NOT NULL,
  tone TEXT NOT NULL DEFAULT 'playful'
);

CREATE TABLE IF NOT EXISTS league_members (
  sleeper_league_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sleeper_user_id TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  recap_email_opt_in INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sleeper_league_id, user_id),
  FOREIGN KEY (sleeper_league_id) REFERENCES leagues(sleeper_league_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`;

const FINAL_CREATE_RE =
  /^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS)\b/i;
const SCRATCH_NAME_RE = /\b_cutman_0002_/;
const USERS_CREATE_RE = /^CREATE TABLE IF NOT EXISTS users\b/i;

function statements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function schemaFinalWithoutUsers(): string[] {
  return statements(SCHEMA_SQL).filter((statement) => !USERS_CREATE_RE.test(statement));
}

function migrationFinalCreates(onboarding: string): string[] {
  return statements(onboarding).filter(
    (statement) => FINAL_CREATE_RE.test(statement) && !SCRATCH_NAME_RE.test(statement),
  );
}

function readMigration(name: string): string {
  return readFileSync(join(d1Dir, name), "utf8");
}

describe("SCHEMA_SQL", () => {
  it("strips inline comments as well as whole-line comments", () => {
    expect(statements("-- whole line\nSELECT 1 -- inline\n; -- trailing")).toEqual(["SELECT 1"]);
  });

  it("is derived by joining SCHEMA_STATEMENTS and never split on semicolons to apply", () => {
    expect(SCHEMA_SQL).toBe(`${SCHEMA_STATEMENTS.join(";\n\n")};\n`);
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(0);
    for (const statement of SCHEMA_STATEMENTS) {
      const applied = statement.replace(/--.*$/gm, "").trim();
      expect(applied).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS\b/i);
      expect(applied).not.toMatch(/\bDROP\b/i);
      expect(applied).not.toMatch(/\bALTER\b/i);
    }
    expect(SCHEMA_SQL).not.toMatch(/\bALTER\b/i);
    expect(SCHEMA_SQL).toMatch(/provisioning_started_at INTEGER\s*(?:,|\))/);
    expect(SCHEMA_SQL).not.toMatch(/provisioning_started_at INTEGER NOT NULL/);
  });

  it("keeps a statement with a semicolon in a SQL comment as one SCHEMA_STATEMENTS entry", () => {
    const quota = SCHEMA_STATEMENTS.find((statement) =>
      /CREATE TABLE IF NOT EXISTS explorer_origin_quota\b/i.test(statement),
    );
    expect(quota).toMatch(/--[^\n]*;/);
    expect(quota?.split(";").length).toBeGreaterThan(1);
    const naive = SCHEMA_SQL.split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    expect(naive.length).toBeGreaterThan(SCHEMA_STATEMENTS.length);
    expect(SCHEMA_STATEMENTS.filter((statement) => statement.includes("explorer_origin_quota"))).toHaveLength(1);
  });

  it("matches schema.sql after stripping comments", () => {
    const packaged = readFileSync(join(here, "schema.sql"), "utf8");
    expect(statements(SCHEMA_SQL)).toEqual(statements(packaged));
  });

  it("keeps restored 0001 as the deployed legacy schema, not the final additive schema", () => {
    const init = readMigration("0001_init.sql");
    expect(init).toBe(LEGACY_0001_SQL);
    expect(statements(init)).toEqual(statements(LEGACY_0001_SQL));
    expect(statements(SCHEMA_SQL)).not.toEqual(statements(init));
  });

  it("covers every final CREATE TABLE/INDEX except users across 0002 then 0003 then 0004", () => {
    const onboarding = readMigration("0002_sleeper_onboarding.sql");
    const backlog = readMigration("0003_recap_attempt_backlog.sql");
    const quota = readMigration("0004_explorer_origin_quota.sql");
    const finalWithoutUsers = schemaFinalWithoutUsers();
    const migrationStatements = [...statements(onboarding), ...statements(backlog), ...statements(quota)];
    const migrationCreates = [
      ...migrationFinalCreates(onboarding),
      ...migrationFinalCreates(backlog),
      ...migrationFinalCreates(quota),
    ];
    expect(finalWithoutUsers.length).toBeGreaterThan(0);
    for (const statement of finalWithoutUsers) {
      expect(migrationStatements).toContainEqual(statement);
    }
    expect(sorted(migrationCreates)).toEqual(sorted(finalWithoutUsers));
    expect(onboarding).not.toMatch(/recap_attempt_backlog/);
    expect(onboarding).not.toMatch(/explorer_origin_quota/);
    expect(backlog).toMatch(/CREATE TABLE IF NOT EXISTS recap_attempt_backlog\b/);
    expect(backlog).not.toMatch(/explorer_origin_quota/);
    expect(quota).toMatch(/CREATE TABLE IF NOT EXISTS explorer_origin_quota\b/);
    expect(quota).not.toMatch(/recap_attempt_backlog/);
  });

  it("keeps 0003 additive (CREATE IF NOT EXISTS only, no DROP or ALTER)", () => {
    const backlog = readMigration("0003_recap_attempt_backlog.sql");
    expect(backlog).not.toMatch(/\bDROP\b/i);
    expect(backlog).not.toMatch(/\bALTER\b/i);
    const creates = migrationFinalCreates(backlog);
    expect(creates.length).toBeGreaterThan(0);
    for (const statement of creates) {
      expect(statement).toMatch(/^CREATE (UNIQUE INDEX|INDEX|TABLE) IF NOT EXISTS\b/i);
    }
  });

  it("keeps 0004 additive (CREATE IF NOT EXISTS only, no DROP or ALTER)", () => {
    const quota = readMigration("0004_explorer_origin_quota.sql");
    expect(quota).not.toMatch(/\bDROP\b/i);
    expect(quota).not.toMatch(/\bALTER\b/i);
    const creates = migrationFinalCreates(quota);
    expect(creates.length).toBeGreaterThan(0);
    for (const statement of creates) {
      expect(statement).toMatch(/^CREATE (UNIQUE INDEX|INDEX|TABLE) IF NOT EXISTS\b/i);
    }
  });

  it("copies rebuilt leagues and members with explicit column lists", () => {
    const onboarding = readMigration("0002_sleeper_onboarding.sql");
    const migrationStatements = statements(onboarding);

    expect(
      migrationStatements.filter((statement) =>
        /^CREATE TABLE IF NOT EXISTS _cutman_0002_leagues\b/i.test(statement),
      ),
    ).toHaveLength(1);
    expect(
      migrationStatements.filter((statement) =>
        /^CREATE TABLE IF NOT EXISTS _cutman_0002_league_members\b/i.test(statement),
      ),
    ).toHaveLength(1);
    expect(migrationStatements.some((statement) => /^CREATE TABLE _cutman_0002_/i.test(statement))).toBe(
      false,
    );

    expect(onboarding).not.toMatch(/INSERT INTO leagues\s+SELECT\s+\*/i);
    expect(onboarding).not.toMatch(/INSERT INTO league_members\s+SELECT\s+\*/i);

    const scratchLeaguesCreate = migrationStatements.find((statement) =>
      /^CREATE TABLE IF NOT EXISTS _cutman_0002_leagues\b/i.test(statement),
    );
    expect(scratchLeaguesCreate).toMatch(/provisioning_started_at INTEGER/);
    expect(scratchLeaguesCreate).not.toMatch(/provisioning_started_at INTEGER NOT NULL/);

    expect(migrationStatements).toContainEqual(
      [
        "INSERT INTO _cutman_0002_leagues (",
        "  id, sleeper_league_id, name, season, status, tone, created_at, activated_at, provisioning_error, provisioning_started_at",
        ")",
        "SELECT",
        "  'legacy_' || sleeper_league_id,",
        "  sleeper_league_id,",
        "  name,",
        "  season,",
        "  'active',",
        "  tone,",
        "  enabled_at AS created_at,",
        "  enabled_at AS activated_at,",
        "  NULL,",
        "  NULL",
        "FROM leagues",
      ].join("\n"),
    );
    expect(migrationStatements).toContainEqual(
      [
        "INSERT INTO _cutman_0002_league_members (",
        "  league_id, user_id, role, recap_email_opt_in, created_at",
        ")",
        "SELECT",
        "  'legacy_' || lm.sleeper_league_id,",
        "  lm.user_id,",
        "  'member',",
        "  lm.recap_email_opt_in,",
        "  l.enabled_at",
        "FROM league_members AS lm",
        "INNER JOIN leagues AS l ON l.sleeper_league_id = lm.sleeper_league_id",
      ].join("\n"),
    );
    expect(onboarding).not.toMatch(/CASE WHEN lm\.is_owner/);
    expect(onboarding).not.toMatch(/THEN 'commissioner'/);

    expect(migrationStatements).toContainEqual(
      [
        "INSERT INTO leagues (",
        "  id, sleeper_league_id, name, season, status, tone, created_at, activated_at, provisioning_error, provisioning_started_at",
        ")",
        "SELECT",
        "  id, sleeper_league_id, name, season, status, tone, created_at, activated_at, provisioning_error, provisioning_started_at",
        "FROM _cutman_0002_leagues",
      ].join("\n"),
    );
    expect(migrationStatements).toContainEqual(
      [
        "INSERT INTO league_members (",
        "  league_id, user_id, role, recap_email_opt_in, created_at",
        ")",
        "SELECT",
        "  league_id, user_id, role, recap_email_opt_in, created_at",
        "FROM _cutman_0002_league_members",
      ].join("\n"),
    );
  });

  it("does not embed live Sleeper ids in migration SQL", () => {
    const liveId = /(?<!\d)[1-9]\d{10,}(?!\d)/;
    // Word-boundary `\b` misses a digit-run glued to an identifier (`legacy_123...`).
    expect("legacy_12345678901").toMatch(liveId);
    expect("id=12345678901").toMatch(liveId);
    expect("v1").not.toMatch(liveId);
    expect(readMigration("0001_init.sql")).not.toMatch(liveId);
    expect(readMigration("0002_sleeper_onboarding.sql")).not.toMatch(liveId);
    expect(readMigration("0003_recap_attempt_backlog.sql")).not.toMatch(liveId);
    expect(readMigration("0004_explorer_origin_quota.sql")).not.toMatch(liveId);
  });
});
