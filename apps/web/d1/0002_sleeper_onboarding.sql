-- Forward migration from the deployed legacy 0001 schema (allowlist, leagues keyed by
-- sleeper_league_id with enabled_at, league_members.is_owner) to the onboarding schema.
-- Fresh databases apply 0001 then this file. Remote D1 that already applied legacy 0001
-- picks this up as a new migration. No remote wipe. Local D1 that applied a rewritten 0001
-- still needs `pnpm run db:reset:local`.
--
-- Mapping:
--   leagues.id = 'legacy_' || sleeper_league_id (stable, distinct from Sleeper snowflakes)
--   enabled leagues -> status 'active', created_at/activated_at from enabled_at,
--   provisioning_started_at NULL (legacy rows were already active; they never re-provision)
--   every membership is role 'member' regardless of lm.is_owner (commissioner
--   authority only follows successful league_verifications). recap_email_opt_in copied
--   sleeper_accounts: one row per Clerk user, and one Clerk user per sleeper_user_id.
--   Membership identity is the sleeper_user_id from that user's most recently enabled
--   league (leagues.enabled_at DESC). Ties break on sleeper_league_id ASC, then
--   sleeper_user_id ASC — not lexical MIN(sleeper_user_id).
--   Those per-user winners are then ranked PARTITION BY sleeper_user_id so a shared
--   Sleeper id maps to one Clerk user. Prefer the candidate whose LOWER(TRIM(users.email))
--   equals LOWER(TRIM(allowlist.clerk_email)); null clerk_email is not matched.
--   Remaining ties: enabled_at DESC, sleeper_league_id ASC, user_id ASC (deterministic;
--   repeated SELECT executions pick the same Clerk user). INSERT OR IGNORE is a safety
--   net for leftover unique sleeper_user_id collisions, not the selection rule.
--   Then allowlist-only users not already copied from league_members: rows whose
--   LOWER(TRIM(clerk_email)) matches LOWER(TRIM(users.email)); null clerk_email is not
--   matched. Matching users are ranked PARTITION BY sleeper_user_id; keep rn = 1.
--   Ties: users.created_at ASC, users.id ASC (deterministic; repeated SELECT executions
--   pick the same Clerk user). username/display_name from allowlist.sleeper_username,
--   else 'legacy_' || sleeper_user_id
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

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Scratch rebuilds use IF NOT EXISTS. D1 applies this file in a transaction (failed
-- attempts roll back); do not pre-DROP leftover scratch names.
CREATE TABLE IF NOT EXISTS _cutman_0002_leagues (
  id TEXT PRIMARY KEY,
  sleeper_league_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  status TEXT NOT NULL,
  tone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  provisioning_error TEXT,
  provisioning_started_at INTEGER
);

INSERT INTO _cutman_0002_leagues (
  id, sleeper_league_id, name, season, status, tone, created_at, activated_at, provisioning_error, provisioning_started_at
)
SELECT
  'legacy_' || sleeper_league_id,
  sleeper_league_id,
  name,
  season,
  'active',
  tone,
  enabled_at AS created_at,
  enabled_at AS activated_at,
  NULL,
  NULL
FROM leagues;

CREATE TABLE IF NOT EXISTS _cutman_0002_league_members (
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
  'member',
  lm.recap_email_opt_in,
  l.enabled_at
FROM league_members AS lm
INNER JOIN leagues AS l ON l.sleeper_league_id = lm.sleeper_league_id;

INSERT OR IGNORE INTO sleeper_accounts (user_id, sleeper_user_id, username, display_name, updated_at)
SELECT
  preferred.user_id,
  preferred.sleeper_user_id,
  COALESCE(NULLIF(preferred.sleeper_username, ''), 'legacy_' || preferred.sleeper_user_id),
  COALESCE(NULLIF(preferred.sleeper_username, ''), 'legacy_' || preferred.sleeper_user_id),
  COALESCE(preferred.allowlist_created_at, preferred.user_created_at)
FROM (
  SELECT
    per_user.user_id,
    per_user.sleeper_user_id,
    a.sleeper_username AS sleeper_username,
    a.created_at AS allowlist_created_at,
    u.created_at AS user_created_at,
    ROW_NUMBER() OVER (
      PARTITION BY per_user.sleeper_user_id
      ORDER BY
        CASE
          WHEN a.clerk_email IS NOT NULL
            AND LOWER(TRIM(u.email)) = LOWER(TRIM(a.clerk_email))
          THEN 0
          ELSE 1
        END ASC,
        per_user.enabled_at DESC,
        per_user.sleeper_league_id ASC,
        per_user.user_id ASC
    ) AS sleeper_rn
  FROM (
    SELECT
      lm.user_id AS user_id,
      lm.sleeper_user_id AS sleeper_user_id,
      l.enabled_at AS enabled_at,
      l.sleeper_league_id AS sleeper_league_id,
      ROW_NUMBER() OVER (
        PARTITION BY lm.user_id
        ORDER BY l.enabled_at DESC, l.sleeper_league_id ASC, lm.sleeper_user_id ASC
      ) AS rn
    FROM league_members AS lm
    INNER JOIN leagues AS l ON l.sleeper_league_id = lm.sleeper_league_id
  ) AS per_user
  INNER JOIN users AS u ON u.id = per_user.user_id
  LEFT JOIN allowlist AS a ON a.sleeper_user_id = per_user.sleeper_user_id
  WHERE per_user.rn = 1
) AS preferred
WHERE preferred.sleeper_rn = 1;

INSERT OR IGNORE INTO sleeper_accounts (user_id, sleeper_user_id, username, display_name, updated_at)
SELECT
  ranked.user_id,
  ranked.sleeper_user_id,
  COALESCE(NULLIF(ranked.sleeper_username, ''), 'legacy_' || ranked.sleeper_user_id),
  COALESCE(NULLIF(ranked.sleeper_username, ''), 'legacy_' || ranked.sleeper_user_id),
  COALESCE(ranked.allowlist_created_at, ranked.user_created_at)
FROM (
  SELECT
    u.id AS user_id,
    a.sleeper_user_id AS sleeper_user_id,
    a.sleeper_username AS sleeper_username,
    a.created_at AS allowlist_created_at,
    u.created_at AS user_created_at,
    ROW_NUMBER() OVER (
      PARTITION BY a.sleeper_user_id
      ORDER BY u.created_at ASC, u.id ASC
    ) AS rn
  FROM allowlist AS a
  INNER JOIN users AS u ON LOWER(TRIM(u.email)) = LOWER(TRIM(a.clerk_email))
  WHERE a.clerk_email IS NOT NULL
) AS ranked
WHERE ranked.rn = 1;

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
  provisioning_error TEXT,
  provisioning_started_at INTEGER
);

INSERT INTO leagues (
  id, sleeper_league_id, name, season, status, tone, created_at, activated_at, provisioning_error, provisioning_started_at
)
SELECT
  id, sleeper_league_id, name, season, status, tone, created_at, activated_at, provisioning_error, provisioning_started_at
FROM _cutman_0002_leagues;
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

INSERT INTO league_members (
  league_id, user_id, role, recap_email_opt_in, created_at
)
SELECT
  league_id, user_id, role, recap_email_opt_in, created_at
FROM _cutman_0002_league_members;
DROP TABLE _cutman_0002_league_members;

CREATE INDEX IF NOT EXISTS league_members_user_id_idx ON league_members (user_id);
