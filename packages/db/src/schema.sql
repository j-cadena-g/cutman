-- D1 holds Clerk identity, linked Sleeper accounts, leagues, per-league membership / recap opt-in,
-- strongly consistent app_state (scheduled active-league cursor), the Tuesday recap attempt backlog,
-- and per-Clerk-user explorer origin quota (one current-hour row per user; stale rows are swept hourly).
-- LeagueBrain DO holds bible, timeline, snapshot, and recaps (one DO per league id).
-- Schema is multi-league. Leagues are created during onboarding, not auto-seeded.
-- LeagueBrain Durable Objects are keyed by internal leagues.id.

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
  provisioning_error TEXT,
  provisioning_started_at INTEGER
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
CREATE UNIQUE INDEX IF NOT EXISTS league_verifications_pending_user_league_idx
  ON league_verifications (user_id, sleeper_league_id)
  WHERE status = 'pending';

-- Strongly consistent worker key/value (scheduled active-league cursor).
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recap_attempt_backlog (
  league_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (league_id, week_key),
  FOREIGN KEY (league_id) REFERENCES leagues(id)
);

CREATE INDEX IF NOT EXISTS recap_attempt_backlog_pending_week_idx
  ON recap_attempt_backlog (week_key, league_id)
  WHERE status = 'pending';

-- one latest row per user; stale hour_key rows are swept
CREATE TABLE IF NOT EXISTS explorer_origin_quota (
  clerk_user_id TEXT NOT NULL CHECK (clerk_user_id != ''),
  hour_key INTEGER NOT NULL CHECK (hour_key >= 0),
  used INTEGER NOT NULL CHECK (used >= 0),
  PRIMARY KEY (clerk_user_id)
);
