-- Forward migration from the deployed legacy 0001 schema (allowlist, leagues keyed by
-- sleeper_league_id with enabled_at, league_members.is_owner) to the onboarding schema.
-- Fresh databases apply 0001 then this file. Remote D1 that already applied legacy 0001
-- picks this up as a new migration. No remote wipe. Local D1 that applied a rewritten 0001
-- still needs `pnpm run db:reset:local`.
--
-- Mapping:
--   leagues.id = 'legacy_' || sleeper_league_id (stable, distinct from Sleeper snowflakes)
--   enabled leagues -> status 'active', created_at/activated_at from enabled_at
--   is_owner = 1 -> commissioner, else member. recap_email_opt_in copied
--   sleeper_accounts from memberships, then allowlist rows whose clerk_email matches users.email
--   username/display_name from allowlist.sleeper_username, else 'legacy_' || sleeper_user_id
-- Drop allowlist and rebuilt legacy tables only after copies succeed.

CREATE TABLE IF NOT EXISTS sleeper_accounts (
  user_id TEXT PRIMARY KEY,
  sleeper_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

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

CREATE TABLE _cutman_0002_leagues (
  id TEXT PRIMARY KEY,
  sleeper_league_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  status TEXT NOT NULL,
  tone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  provisioning_error TEXT
);

INSERT INTO _cutman_0002_leagues (
  id, sleeper_league_id, name, season, status, tone, created_at, activated_at, provisioning_error
)
SELECT
  'legacy_' || sleeper_league_id,
  sleeper_league_id,
  name,
  season,
  'active',
  tone,
  enabled_at,
  enabled_at,
  NULL
FROM leagues;

CREATE TABLE _cutman_0002_league_members (
  league_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  recap_email_opt_in INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id)
);

INSERT INTO _cutman_0002_league_members (
  league_id, user_id, role, recap_email_opt_in, created_at
)
SELECT
  'legacy_' || lm.sleeper_league_id,
  lm.user_id,
  CASE WHEN lm.is_owner = 1 THEN 'commissioner' ELSE 'member' END,
  lm.recap_email_opt_in,
  l.enabled_at
FROM league_members AS lm
INNER JOIN leagues AS l ON l.sleeper_league_id = lm.sleeper_league_id;

INSERT OR IGNORE INTO sleeper_accounts (user_id, sleeper_user_id, username, display_name, updated_at)
SELECT
  grouped.user_id,
  grouped.sleeper_user_id,
  COALESCE(NULLIF(a.sleeper_username, ''), 'legacy_' || grouped.sleeper_user_id),
  COALESCE(NULLIF(a.sleeper_username, ''), 'legacy_' || grouped.sleeper_user_id),
  COALESCE(a.created_at, u.created_at)
FROM (
  SELECT user_id, MIN(sleeper_user_id) AS sleeper_user_id
  FROM league_members
  GROUP BY user_id
) AS grouped
INNER JOIN users AS u ON u.id = grouped.user_id
LEFT JOIN allowlist AS a ON a.sleeper_user_id = grouped.sleeper_user_id;

INSERT OR IGNORE INTO sleeper_accounts (user_id, sleeper_user_id, username, display_name, updated_at)
SELECT
  u.id,
  a.sleeper_user_id,
  COALESCE(NULLIF(a.sleeper_username, ''), 'legacy_' || a.sleeper_user_id),
  COALESCE(NULLIF(a.sleeper_username, ''), 'legacy_' || a.sleeper_user_id),
  COALESCE(a.created_at, u.created_at)
FROM allowlist AS a
INNER JOIN users AS u ON u.email = a.clerk_email
WHERE a.clerk_email IS NOT NULL;

DROP TABLE league_members;
DROP TABLE leagues;
DROP TABLE allowlist;

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

INSERT INTO leagues SELECT * FROM _cutman_0002_leagues;
DROP TABLE _cutman_0002_leagues;

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

INSERT INTO league_members SELECT * FROM _cutman_0002_league_members;
DROP TABLE _cutman_0002_league_members;

CREATE INDEX IF NOT EXISTS league_members_user_id_idx ON league_members (user_id);
