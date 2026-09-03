import { V1_LEAGUE_NAME } from "./ensure.ts";

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

export type AllowlistRow = {
  sleeper_user_id: string;
  sleeper_username: string;
  clerk_email: string | null;
  created_at: number;
};

export type LeagueRow = {
  sleeper_league_id: string;
  name: string;
  season: string;
  enabled_at: number;
  tone: string;
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

export async function findAllowlistByEmail(db: D1Database, email: string): Promise<AllowlistRow | null> {
  return db
    .prepare("SELECT * FROM allowlist WHERE clerk_email = ?")
    .bind(email.toLowerCase())
    .first<AllowlistRow>();
}

export async function findAllowlistBySleeperUserId(
  db: D1Database,
  sleeperUserId: string,
): Promise<AllowlistRow | null> {
  return db.prepare("SELECT * FROM allowlist WHERE sleeper_user_id = ?").bind(sleeperUserId).first<AllowlistRow>();
}

export async function ensureAllowlistEntry(
  db: D1Database,
  input: { sleeperUserId: string; sleeperUsername: string; now: number },
): Promise<AllowlistRow> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO allowlist (sleeper_user_id, sleeper_username, clerk_email, created_at)
       VALUES (?, ?, NULL, ?)`,
    )
    .bind(input.sleeperUserId, input.sleeperUsername, input.now)
    .run();
  const row = await findAllowlistBySleeperUserId(db, input.sleeperUserId);
  if (!row) throw new Error("Failed to seed allowlist");
  return row;
}

export async function ensureOperatorSeed(
  db: D1Database,
  input: {
    leagueId?: string;
    leagueName?: string;
    sleeperUserId?: string;
    sleeperUsername?: string;
    now?: number;
  },
): Promise<void> {
  const now = input.now ?? Date.now();
  const leagueId = input.leagueId?.trim();
  const leagueName = input.leagueName?.trim() || V1_LEAGUE_NAME;
  const sleeperUserId = input.sleeperUserId?.trim();
  const sleeperUsername = input.sleeperUsername?.trim();
  if (leagueId) {
    await ensureLeague(db, { leagueId, name: leagueName, season: "2026", now });
  }
  if (sleeperUserId && sleeperUsername) {
    await ensureAllowlistEntry(db, { sleeperUserId, sleeperUsername, now });
  }
}

export async function getLeague(db: D1Database, leagueId: string): Promise<LeagueRow | null> {
  return db.prepare("SELECT * FROM leagues WHERE sleeper_league_id = ?").bind(leagueId).first<LeagueRow>();
}

export async function ensureLeague(
  db: D1Database,
  input: { leagueId: string; name: string; season: string; tone?: string; now: number },
): Promise<LeagueRow> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO leagues (sleeper_league_id, name, season, enabled_at, tone)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.leagueId, input.name, input.season, input.now, input.tone ?? "playful")
    .run();
  const row = await getLeague(db, input.leagueId);
  if (!row) throw new Error("Failed to enable league");
  return row;
}

export async function setLeagueTone(db: D1Database, leagueId: string, tone: string): Promise<void> {
  await db.prepare("UPDATE leagues SET tone = ? WHERE sleeper_league_id = ?").bind(tone, leagueId).run();
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
