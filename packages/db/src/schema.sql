CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sleeper_username TEXT,
  sleeper_user_id TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_codes (
  user_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS leagues (
  sleeper_league_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  enabled_at INTEGER NOT NULL,
  enabled_by_user_id TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'playful',
  tone_control TEXT NOT NULL DEFAULT 'enabler',
  FOREIGN KEY (enabled_by_user_id) REFERENCES users(id)
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
