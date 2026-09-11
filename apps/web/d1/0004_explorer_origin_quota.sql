-- Forward migration: one row per Clerk user for explorer origin quota.
-- Stores the latest hour_key and used so history does not grow unbounded.
-- Remote D1 that already applied 0003 picks this up as a new migration. No remote wipe.
-- ensureSchema also CREATE TABLE IF NOT EXISTS the same shape.

CREATE TABLE IF NOT EXISTS explorer_origin_quota (
  clerk_user_id TEXT NOT NULL CHECK (clerk_user_id != ''),
  hour_key INTEGER NOT NULL CHECK (hour_key >= 0),
  used INTEGER NOT NULL CHECK (used >= 0),
  PRIMARY KEY (clerk_user_id)
);
