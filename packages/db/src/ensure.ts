export const EXAMPLE_SLEEPER_USER_ID = "0000000000000000001";
export const EXAMPLE_SLEEPER_USERNAME = "example_user";
export const EXAMPLE_SLEEPER_LEAGUE_ID = "0000000000000000000";

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS users (
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

// Idempotent and non-destructive: only `CREATE TABLE/INDEX IF NOT EXISTS`, never a DROP. This must
// be safe to run on every worker boot against a real database. This early project resets local D1
// explicitly (e.g. wiping local wrangler state) when the schema shape changes; ensureSchema does
// not attempt to detect or migrate legacy shapes at runtime.
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
