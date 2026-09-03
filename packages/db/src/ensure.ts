export const EXAMPLE_SLEEPER_USER_ID = "0000000000000000001";
export const EXAMPLE_SLEEPER_USERNAME = "example_user";
export const V1_LEAGUE_ID = "0000000000000000000";
export const V1_LEAGUE_NAME = "Example League";

const SCHEMA_SQL = `DROP TABLE IF EXISTS magic_links;
DROP TABLE IF EXISTS verification_codes;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS allowlist;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sleeper_accounts (
  user_id TEXT PRIMARY KEY,
  sleeper_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  sleeper_league_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'active', 'error')),
  tone TEXT NOT NULL DEFAULT 'playful',
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  provisioning_error TEXT
);

CREATE TABLE IF NOT EXISTS league_members (
  league_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('commissioner', 'member')),
  recap_email_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id),
  FOREIGN KEY (league_id) REFERENCES leagues(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS league_members_user_id_idx ON league_members (user_id);

CREATE TABLE IF NOT EXISTS league_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sleeper_user_id TEXT NOT NULL,
  sleeper_league_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS league_verifications_user_id_idx ON league_verifications (user_id);
CREATE INDEX IF NOT EXISTS league_verifications_sleeper_league_id_idx ON league_verifications (sleeper_league_id);
`;

const applying = new WeakMap<D1Database, Promise<void>>();

function statements(): string[] {
  return SCHEMA_SQL.split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function tableColumns(db: D1Database, table: string): Promise<Set<string> | null> {
  const exists = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(table)
    .first<{ name: string }>();
  if (!exists) return null;
  const columns = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set((columns.results ?? []).map((column) => column.name));
}

// The project is early: rather than hand-migrate legacy local shapes column by column, drop the
// affected tables and let `CREATE TABLE IF NOT EXISTS` below rebuild them clean. Losing local/dev
// rows here is acceptable; this must never run against a database with real production data.
async function dropLegacyShapes(db: D1Database): Promise<void> {
  const leagueCols = await tableColumns(db, "leagues");
  const memberCols = await tableColumns(db, "league_members");
  const leaguesAreCurrent = leagueCols === null || leagueCols.has("status");
  const membersAreCurrent = memberCols === null || memberCols.has("role");
  if (leaguesAreCurrent && membersAreCurrent) return;
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS league_verifications"),
    db.prepare("DROP TABLE IF EXISTS league_members"),
    db.prepare("DROP TABLE IF EXISTS leagues"),
  ]);
}

async function applySchema(db: D1Database): Promise<void> {
  await dropLegacyShapes(db);
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
