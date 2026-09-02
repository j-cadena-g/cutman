export type UserRow = {
  id: string;
  email: string;
  sleeper_username: string | null;
  sleeper_user_id: string | null;
  verified_at: number | null;
  created_at: number;
};

export type SessionRow = {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
};

export type LeagueRow = {
  sleeper_league_id: string;
  name: string;
  season: string;
  enabled_at: number;
  enabled_by_user_id: string;
  tone: string;
  tone_control: "enabler" | "commish";
};

export type LeagueMemberRow = {
  sleeper_league_id: string;
  user_id: string;
  sleeper_user_id: string;
  is_owner: number;
  recap_email_opt_in: number;
};

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first<UserRow>();
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function upsertUserByEmail(db: D1Database, input: { id: string; email: string; now: number }): Promise<UserRow> {
  const existing = await findUserByEmail(db, input.email);
  if (existing) return existing;
  await db
    .prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(input.id, input.email.toLowerCase(), input.now)
    .run();
  const created = await findUserById(db, input.id);
  if (!created) throw new Error("Failed to create user");
  return created;
}

export async function saveSleeperUsername(db: D1Database, userId: string, username: string): Promise<void> {
  await db.prepare("UPDATE users SET sleeper_username = ? WHERE id = ?").bind(username, userId).run();
}

export async function markUserVerified(db: D1Database, userId: string, sleeperUserId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE users SET sleeper_user_id = ?, verified_at = ? WHERE id = ?")
    .bind(sleeperUserId, now, userId)
    .run();
}

export async function putVerificationCode(db: D1Database, userId: string, code: string, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO verification_codes (user_id, code, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET code = excluded.code, created_at = excluded.created_at",
    )
    .bind(userId, code, now)
    .run();
}

export async function getVerificationCode(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare("SELECT code FROM verification_codes WHERE user_id = ?").bind(userId).first<{ code: string }>();
  return row?.code ?? null;
}

export async function createSession(db: D1Database, input: { id: string; userId: string; expiresAt: number; now: number }): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(input.id, input.userId, input.expiresAt, input.now)
    .run();
}

export async function findSession(db: D1Database, sessionId: string, now: number): Promise<(SessionRow & { email: string }) | null> {
  return db
    .prepare(
      "SELECT sessions.*, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ?",
    )
    .bind(sessionId, now)
    .first<SessionRow & { email: string }>();
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export async function putMagicLink(db: D1Database, input: { tokenHash: string; email: string; expiresAt: number; now: number }): Promise<void> {
  await db
    .prepare("INSERT INTO magic_links (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(input.tokenHash, input.email.toLowerCase(), input.expiresAt, input.now)
    .run();
}

export async function consumeMagicLink(db: D1Database, tokenHash: string, now: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT email, expires_at FROM magic_links WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ email: string; expires_at: number }>();
  if (!row) return null;
  await db.prepare("DELETE FROM magic_links WHERE token_hash = ?").bind(tokenHash).run();
  if (row.expires_at <= now) return null;
  return row.email;
}

export async function listEnabledLeagues(db: D1Database): Promise<LeagueRow[]> {
  const result = await db.prepare("SELECT * FROM leagues ORDER BY name").all<LeagueRow>();
  return result.results;
}

export async function getLeague(db: D1Database, leagueId: string): Promise<LeagueRow | null> {
  return db.prepare("SELECT * FROM leagues WHERE sleeper_league_id = ?").bind(leagueId).first<LeagueRow>();
}

export async function enableLeague(
  db: D1Database,
  input: {
    leagueId: string;
    name: string;
    season: string;
    enabledBy: string;
    tone: string;
    toneControl: "enabler" | "commish";
    now: number;
  },
): Promise<LeagueRow> {
  const existing = await getLeague(db, input.leagueId);
  if (existing) return existing;
  await db
    .prepare(
      "INSERT INTO leagues (sleeper_league_id, name, season, enabled_at, enabled_by_user_id, tone, tone_control) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(input.leagueId, input.name, input.season, input.now, input.enabledBy, input.tone, input.toneControl)
    .run();
  const created = await getLeague(db, input.leagueId);
  if (!created) throw new Error("Failed to enable league");
  return created;
}

export async function setLeagueTone(
  db: D1Database,
  leagueId: string,
  tone: string,
  toneControl: "enabler" | "commish",
): Promise<void> {
  await db
    .prepare("UPDATE leagues SET tone = ?, tone_control = ? WHERE sleeper_league_id = ?")
    .bind(tone, toneControl, leagueId)
    .run();
}

export async function upsertLeagueMember(
  db: D1Database,
  input: {
    leagueId: string;
    userId: string;
    sleeperUserId: string;
    isOwner: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO league_members (sleeper_league_id, user_id, sleeper_user_id, is_owner, recap_email_opt_in)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(sleeper_league_id, user_id) DO UPDATE SET
         sleeper_user_id = excluded.sleeper_user_id,
         is_owner = excluded.is_owner`,
    )
    .bind(input.leagueId, input.userId, input.sleeperUserId, input.isOwner ? 1 : 0)
    .run();
}

export async function getLeagueMember(
  db: D1Database,
  leagueId: string,
  userId: string,
): Promise<LeagueMemberRow | null> {
  return db
    .prepare("SELECT * FROM league_members WHERE sleeper_league_id = ? AND user_id = ?")
    .bind(leagueId, userId)
    .first<LeagueMemberRow>();
}

export async function setRecapOptIn(db: D1Database, leagueId: string, userId: string, optIn: boolean): Promise<void> {
  await db
    .prepare("UPDATE league_members SET recap_email_opt_in = ? WHERE sleeper_league_id = ? AND user_id = ?")
    .bind(optIn ? 1 : 0, leagueId, userId)
    .run();
}

export async function listRecapRecipients(db: D1Database, leagueId: string): Promise<Array<{ email: string }>> {
  const result = await db
    .prepare(
      `SELECT users.email FROM league_members
       JOIN users ON users.id = league_members.user_id
       WHERE league_members.sleeper_league_id = ? AND league_members.recap_email_opt_in = 1`,
    )
    .bind(leagueId)
    .all<{ email: string }>();
  return result.results;
}

export async function listEnabledLeagueIdsForUser(db: D1Database, userId: string): Promise<string[]> {
  const result = await db
    .prepare("SELECT sleeper_league_id FROM league_members WHERE user_id = ?")
    .bind(userId)
    .all<{ sleeper_league_id: string }>();
  return result.results.map((row) => row.sleeper_league_id);
}
