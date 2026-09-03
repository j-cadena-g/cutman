export const EXAMPLE_SLEEPER_USER_ID = "0000000000000000001";
export const EXAMPLE_SLEEPER_USERNAME = "example_user";
export const V1_LEAGUE_ID = "0000000000000000000";
export const V1_LEAGUE_NAME = "Example League";

const SCHEMA_SQL = `DROP TABLE IF EXISTS magic_links;
DROP TABLE IF EXISTS verification_codes;
DROP TABLE IF EXISTS sessions;

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

INSERT OR IGNORE INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at)
VALUES ('${EXAMPLE_SLEEPER_USER_ID}', '${EXAMPLE_SLEEPER_USERNAME}', NULL, 0);

INSERT OR IGNORE INTO leagues (sleeper_league_id, name, season, enabled_at, tone)
VALUES ('${V1_LEAGUE_ID}', '${V1_LEAGUE_NAME}', '2026', 0, 'playful');
`;

const applying = new WeakMap<D1Database, Promise<void>>();

function statements(): string[] {
  return SCHEMA_SQL.split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function applySchema(db: D1Database): Promise<void> {
  await db.batch(statements().map((statement) => db.prepare(statement)));
}

export async function ensureSchema(db: D1Database): Promise<void> {
  let pending = applying.get(db);
  if (!pending) {
    pending = applySchema(db).catch((error: unknown) => {
      applying.delete(db);
      throw error;
    });
    applying.set(db, pending);
  }
  await pending;
}
