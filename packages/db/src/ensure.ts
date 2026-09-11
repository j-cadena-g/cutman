export const EXAMPLE_SLEEPER_USER_ID = "0000000000000000001";
export const EXAMPLE_SLEEPER_USERNAME = "example_user";
export const EXAMPLE_SLEEPER_LEAGUE_ID = "0000000000000000000";

// Complete statements applied by `applySchema`. Keep each entry a full SQL statement — never split
// on `;`, so a comment or string literal may contain a semicolon without breaking application.
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS sleeper_accounts (
  user_id TEXT PRIMARY KEY,
  sleeper_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
)`,
  `CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  sleeper_league_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'active', 'error')),
  tone TEXT NOT NULL DEFAULT 'playful',
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  provisioning_error TEXT,
  provisioning_started_at INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS league_members (
  league_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('commissioner', 'member')),
  recap_email_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id),
  FOREIGN KEY (league_id) REFERENCES leagues(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
)`,
  `CREATE INDEX IF NOT EXISTS league_members_user_id_idx ON league_members (user_id)`,
  `CREATE TABLE IF NOT EXISTS league_verifications (
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
)`,
  `CREATE INDEX IF NOT EXISTS league_verifications_user_id_idx ON league_verifications (user_id)`,
  `CREATE INDEX IF NOT EXISTS league_verifications_sleeper_league_id_idx ON league_verifications (sleeper_league_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS league_verifications_pending_user_league_idx
  ON league_verifications (user_id, sleeper_league_id)
  WHERE status = 'pending'`,
  `CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS recap_attempt_backlog (
  league_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (league_id, week_key),
  FOREIGN KEY (league_id) REFERENCES leagues(id)
)`,
  `CREATE INDEX IF NOT EXISTS recap_attempt_backlog_pending_week_idx
  ON recap_attempt_backlog (week_key, league_id)
  WHERE status = 'pending'`,
  `-- one latest row per user; stale hour_key rows are swept
CREATE TABLE IF NOT EXISTS explorer_origin_quota (
  clerk_user_id TEXT NOT NULL CHECK (clerk_user_id != ''),
  hour_key INTEGER NOT NULL CHECK (hour_key >= 0),
  used INTEGER NOT NULL CHECK (used >= 0),
  PRIMARY KEY (clerk_user_id)
)`,
];

export const SCHEMA_SQL = `${SCHEMA_STATEMENTS.join(";\n\n")};\n`;

const applying = new WeakMap<D1Database, Promise<void>>();

// Idempotent and non-destructive: only `CREATE TABLE/INDEX IF NOT EXISTS`, never a DROP. This must
// be safe to run on every worker boot against a real database. This early project resets local D1
// explicitly (e.g. wiping local wrangler state) when the schema shape changes; ensureSchema does
// not attempt to detect or migrate legacy shapes at runtime.
export async function applySchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)));
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
