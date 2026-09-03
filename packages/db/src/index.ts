export {
  ensureSchema,
  EXAMPLE_SLEEPER_USER_ID,
  EXAMPLE_SLEEPER_USERNAME,
  V1_LEAGUE_ID,
  V1_LEAGUE_NAME,
} from "./ensure.ts";

export type UserRow = {
  id: string;
  email: string;
  created_at: number;
};

export type SleeperAccountRow = {
  user_id: string;
  sleeper_user_id: string;
  username: string;
  display_name: string;
  updated_at: number;
};

export type LeagueStatus = "provisioning" | "active" | "error";

export type LeagueRow = {
  id: string;
  sleeper_league_id: string;
  name: string;
  season: string;
  status: LeagueStatus;
  tone: string;
  created_at: number;
  activated_at: number | null;
  provisioning_error: string | null;
};

export type LeagueMemberRole = "commissioner" | "member";

export type LeagueMemberRow = {
  league_id: string;
  user_id: string;
  role: LeagueMemberRole;
  recap_email_opt_in: number;
  created_at: number;
};

export type LeagueVerificationStatus = "pending" | "verified" | "expired" | "failed";

export type LeagueVerificationRow = {
  id: string;
  user_id: string;
  sleeper_user_id: string;
  sleeper_league_id: string;
  challenge: string;
  status: LeagueVerificationStatus;
  attempts: number;
  expires_at: number;
  created_at: number;
  verified_at: number | null;
};

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase()).first<UserRow>();
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function upsertUserByClerkId(
  db: D1Database,
  input: { id: string; email: string; now: number },
): Promise<UserRow> {
  const existing = await findUserById(db, input.id);
  const email = input.email.toLowerCase();
  if (existing) {
    if (existing.email !== email) {
      await db.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, input.id).run();
      const updated = await findUserById(db, input.id);
      if (!updated) throw new Error("Failed to update user");
      return updated;
    }
    return existing;
  }
  const byEmail = await findUserByEmail(db, email);
  if (byEmail) return byEmail;
  await db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(input.id, email, input.now).run();
  const created = await findUserById(db, input.id);
  if (!created) throw new Error("Failed to create user");
  return created;
}

export async function getSleeperAccountByUserId(db: D1Database, userId: string): Promise<SleeperAccountRow | null> {
  return db.prepare("SELECT * FROM sleeper_accounts WHERE user_id = ?").bind(userId).first<SleeperAccountRow>();
}

export async function getSleeperAccountBySleeperUserId(
  db: D1Database,
  sleeperUserId: string,
): Promise<SleeperAccountRow | null> {
  return db
    .prepare("SELECT * FROM sleeper_accounts WHERE sleeper_user_id = ?")
    .bind(sleeperUserId)
    .first<SleeperAccountRow>();
}

export async function linkSleeperAccount(
  db: D1Database,
  input: { userId: string; sleeperUserId: string; username: string; displayName: string; now: number },
): Promise<SleeperAccountRow> {
  await db
    .prepare(
      `INSERT INTO sleeper_accounts (user_id, sleeper_user_id, username, display_name, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.userId, input.sleeperUserId, input.username, input.displayName, input.now)
    .run();
  const row = await getSleeperAccountByUserId(db, input.userId);
  if (!row) throw new Error("Failed to link Sleeper account");
  return row;
}

export async function refreshSleeperAccount(
  db: D1Database,
  input: { userId: string; username: string; displayName: string; now: number },
): Promise<SleeperAccountRow> {
  await db
    .prepare("UPDATE sleeper_accounts SET username = ?, display_name = ?, updated_at = ? WHERE user_id = ?")
    .bind(input.username, input.displayName, input.now, input.userId)
    .run();
  const row = await getSleeperAccountByUserId(db, input.userId);
  if (!row) throw new Error("Sleeper account is not linked");
  return row;
}

export async function getLeague(db: D1Database, leagueId: string): Promise<LeagueRow | null> {
  return db.prepare("SELECT * FROM leagues WHERE id = ?").bind(leagueId).first<LeagueRow>();
}

export async function getLeagueBySleeperId(db: D1Database, sleeperLeagueId: string): Promise<LeagueRow | null> {
  return db.prepare("SELECT * FROM leagues WHERE sleeper_league_id = ?").bind(sleeperLeagueId).first<LeagueRow>();
}

export async function listLeaguesForUser(db: D1Database, userId: string): Promise<LeagueRow[]> {
  const result = await db
    .prepare(
      `SELECT leagues.* FROM leagues
       INNER JOIN league_members ON league_members.league_id = leagues.id
       WHERE league_members.user_id = ?
       ORDER BY leagues.created_at ASC, leagues.id ASC`,
    )
    .bind(userId)
    .all<LeagueRow>();
  return result.results;
}

export async function listActiveLeagues(db: D1Database): Promise<LeagueRow[]> {
  const result = await db
    .prepare("SELECT * FROM leagues WHERE status = 'active' ORDER BY activated_at ASC, id ASC")
    .all<LeagueRow>();
  return result.results;
}

export async function createLeague(
  db: D1Database,
  input: { id: string; sleeperLeagueId: string; name: string; season: string; tone?: string; now: number },
): Promise<LeagueRow> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO leagues (id, sleeper_league_id, name, season, status, tone, created_at)
       VALUES (?, ?, ?, ?, 'provisioning', ?, ?)`,
    )
    .bind(input.id, input.sleeperLeagueId, input.name, input.season, input.tone ?? "playful", input.now)
    .run();
  const row = await getLeague(db, input.id);
  if (!row) throw new Error("Failed to create league");
  return row;
}

export async function provisionLeague(db: D1Database, leagueId: string): Promise<LeagueRow> {
  await db
    .prepare("UPDATE leagues SET status = 'provisioning', provisioning_error = NULL WHERE id = ?")
    .bind(leagueId)
    .run();
  const row = await getLeague(db, leagueId);
  if (!row) throw new Error("League not found");
  return row;
}

export async function activateLeague(db: D1Database, leagueId: string, now: number): Promise<LeagueRow> {
  await db
    .prepare("UPDATE leagues SET status = 'active', activated_at = ?, provisioning_error = NULL WHERE id = ?")
    .bind(now, leagueId)
    .run();
  const row = await getLeague(db, leagueId);
  if (!row) throw new Error("League not found");
  return row;
}

export async function failLeague(db: D1Database, leagueId: string, error: string): Promise<LeagueRow> {
  await db
    .prepare("UPDATE leagues SET status = 'error', provisioning_error = ? WHERE id = ?")
    .bind(error, leagueId)
    .run();
  const row = await getLeague(db, leagueId);
  if (!row) throw new Error("League not found");
  return row;
}

export async function setLeagueTone(db: D1Database, leagueId: string, tone: string): Promise<void> {
  await db.prepare("UPDATE leagues SET tone = ? WHERE id = ?").bind(tone, leagueId).run();
}

export async function upsertLeagueMember(
  db: D1Database,
  input: { leagueId: string; userId: string; role: LeagueMemberRole; recapOptIn?: boolean; now: number },
): Promise<LeagueMemberRow> {
  await db
    .prepare(
      `INSERT INTO league_members (league_id, user_id, role, recap_email_opt_in, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(league_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(input.leagueId, input.userId, input.role, input.recapOptIn ? 1 : 0, input.now)
    .run();
  const row = await getLeagueMember(db, input.leagueId, input.userId);
  if (!row) throw new Error("Failed to add league member");
  return row;
}

export async function getLeagueMember(
  db: D1Database,
  leagueId: string,
  userId: string,
): Promise<LeagueMemberRow | null> {
  return db
    .prepare("SELECT * FROM league_members WHERE league_id = ? AND user_id = ?")
    .bind(leagueId, userId)
    .first<LeagueMemberRow>();
}

export async function setRecapOptIn(db: D1Database, leagueId: string, userId: string, optIn: boolean): Promise<void> {
  await db
    .prepare("UPDATE league_members SET recap_email_opt_in = ? WHERE league_id = ? AND user_id = ?")
    .bind(optIn ? 1 : 0, leagueId, userId)
    .run();
}

export async function listRecapRecipients(db: D1Database, leagueId: string): Promise<Array<{ email: string }>> {
  const result = await db
    .prepare(
      `SELECT users.email FROM league_members
       JOIN users ON users.id = league_members.user_id
       WHERE league_members.league_id = ? AND league_members.recap_email_opt_in = 1`,
    )
    .bind(leagueId)
    .all<{ email: string }>();
  return result.results;
}

export async function getVerification(db: D1Database, id: string): Promise<LeagueVerificationRow | null> {
  return db.prepare("SELECT * FROM league_verifications WHERE id = ?").bind(id).first<LeagueVerificationRow>();
}

export async function findPendingVerification(
  db: D1Database,
  input: { userId: string; sleeperLeagueId: string },
): Promise<LeagueVerificationRow | null> {
  return db
    .prepare(
      `SELECT * FROM league_verifications
       WHERE user_id = ? AND sleeper_league_id = ? AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(input.userId, input.sleeperLeagueId)
    .first<LeagueVerificationRow>();
}

export async function createVerification(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    sleeperUserId: string;
    sleeperLeagueId: string;
    challenge: string;
    expiresAt: number;
    now: number;
  },
): Promise<LeagueVerificationRow> {
  await db
    .prepare(
      `INSERT INTO league_verifications
        (id, user_id, sleeper_user_id, sleeper_league_id, challenge, status, attempts, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.sleeperUserId,
      input.sleeperLeagueId,
      input.challenge,
      input.expiresAt,
      input.now,
    )
    .run();
  const row = await getVerification(db, input.id);
  if (!row) throw new Error("Failed to create verification");
  return row;
}

// Consumes a pending verification exactly once: expired challenges are marked `expired` and
// rejected, and any challenge that is not currently `pending` (already verified, expired, or
// failed) is rejected too, which prevents replaying a completed challenge.
export async function consumeVerification(
  db: D1Database,
  input: { id: string; now: number },
): Promise<LeagueVerificationRow> {
  const verification = await getVerification(db, input.id);
  if (!verification) throw new Error("Verification not found");
  if (verification.status === "pending" && verification.expires_at <= input.now) {
    await db.prepare("UPDATE league_verifications SET status = 'expired' WHERE id = ?").bind(input.id).run();
    throw new Error("Verification has expired");
  }
  if (verification.status !== "pending") {
    throw new Error(`Verification is not pending (status: ${verification.status})`);
  }
  await db
    .prepare(
      "UPDATE league_verifications SET status = 'verified', verified_at = ? WHERE id = ? AND status = 'pending'",
    )
    .bind(input.now, input.id)
    .run();
  const row = await getVerification(db, input.id);
  if (!row) throw new Error("Failed to consume verification");
  return row;
}
