-- Forward migration: per-league/per-week Tuesday recap attempt backlog.
-- Remote D1 that already applied 0002 picks this up as a new migration. No remote wipe.
-- ensureSchema also CREATE TABLE/INDEX IF NOT EXISTS the same shape.

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
