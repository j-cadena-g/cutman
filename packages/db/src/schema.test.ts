import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "./ensure.ts";

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

function statements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function readMigration(name: string): string {
  return readFileSync(join(d1Dir, name), "utf8");
}

describe("SCHEMA_SQL", () => {
  it("strips inline comments as well as whole-line comments", () => {
    expect(statements("-- whole line\nSELECT 1 -- inline\n; -- trailing")).toEqual(["SELECT 1"]);
  });

  it("contains no -- SQL comments because ensureSchema splits on semicolons without stripping them", () => {
    expect(SCHEMA_SQL).not.toMatch(/--/);
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

  it("includes every final CREATE TABLE/INDEX except users in 0002", () => {
    const onboarding = readMigration("0002_sleeper_onboarding.sql");
    const finalWithoutUsers = statements(SCHEMA_SQL).filter(
      (statement) => !/^CREATE TABLE IF NOT EXISTS users\b/i.test(statement),
    );
    const migrationStatements = statements(onboarding);
    expect(finalWithoutUsers.length).toBeGreaterThan(0);
    for (const statement of finalWithoutUsers) {
      expect(migrationStatements).toContainEqual(statement);
    }
  });

  it("does not embed live Sleeper ids in migration SQL", () => {
    const liveId = /\b[1-9]\d{10,}\b/;
    expect(readMigration("0001_init.sql")).not.toMatch(liveId);
    expect(readMigration("0002_sleeper_onboarding.sql")).not.toMatch(liveId);
  });
});
