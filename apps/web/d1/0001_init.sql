-- D1 holds identity, the allowlist, and recap opt-in.
-- LeagueBrain DO holds bible, timeline, snapshot, and recaps.
-- Tracked seed rows are fake placeholders. Live league/user ids belong in gitignored / 1Password config.

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
VALUES ('0000000000000000001', 'example_user', NULL, 0);

INSERT OR IGNORE INTO leagues (sleeper_league_id, name, season, enabled_at, tone)
VALUES ('0000000000000000000', 'Example League', '2026', 0, 'playful');
