import { listActiveLeagues, type LeagueRow } from "@cutman/db";
import {
  easternParts,
  shouldAttemptTuesdayRecap,
  shouldPoll,
  toneOrPlayful,
  type RecapAttemptResult,
  type RecapStatus,
} from "@cutman/story";
import {
  EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS,
  EXPLORER_ORIGIN_QUOTA_STALE_SWEEP_LIMIT,
  sweepStaleExplorerOriginQuota,
} from "../app/lib/explorer-origin-quota.server.ts";

/** Cap Durable Object work per cron tick. Successive ticks continue from a D1 cursor. */
export const MAX_SCHEDULED_LEAGUES_PER_TICK = 10;

/** Max recap attempts per league per week before the backlog row is done/exhausted. */
export const MAX_RECAP_ATTEMPTS = 3;

/** Dedicated app_state key for fair active-league rotation. */
export const SCHEDULED_LEAGUE_CURSOR_KEY = "scheduled:active-leagues:cursor";

/** Dedicated app_state key for bounded Tuesday recap backlog enrollment. */
export const SCHEDULED_RECAP_ENROLLMENT_KEY = "scheduled:recap-enrollment";

export type ScheduledLeaguePage<T extends { id: string } = { id: string }> = {
  leagues: T[];
  nextAfterId: string | null;
  hasDeferred: boolean;
};

export type RecapEnrollmentState = {
  weekKey: string;
  afterId: string | null;
  complete: boolean;
};

export type ScheduledFailureReason = "error" | "unknown";

export function parseScheduledLeagueCursor(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const afterId = (parsed as { afterId?: unknown }).afterId;
    if (typeof afterId !== "string") return null;
    const trimmed = afterId.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function parseRecapEnrollmentState(raw: string | null): RecapEnrollmentState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const weekKey = (parsed as { weekKey?: unknown }).weekKey;
    if (typeof weekKey !== "string") return null;
    const trimmedWeek = weekKey.trim();
    if (trimmedWeek.length === 0) return null;
    const complete = (parsed as { complete?: unknown }).complete;
    if (typeof complete !== "boolean") return null;
    const afterIdRaw = (parsed as { afterId?: unknown }).afterId;
    let afterId: string | null = null;
    if (afterIdRaw === null || afterIdRaw === undefined) {
      afterId = null;
    } else if (typeof afterIdRaw === "string") {
      const trimmed = afterIdRaw.trim();
      afterId = trimmed.length > 0 ? trimmed : null;
    } else {
      return null;
    }
    return { weekKey: trimmedWeek, afterId, complete };
  } catch {
    return null;
  }
}

export function scheduledFailureReason(error: unknown): ScheduledFailureReason {
  return error instanceof Error ? "error" : "unknown";
}

/** America/New_York calendar date of the Tuesday that opened the current recap week. */
export function easternRecapWeekKey(now: Date): string {
  const { weekday } = easternParts(now);
  const calendar = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [yearRaw, monthRaw, dayRaw] = calendar.split("-");
  const year = Number.parseInt(yearRaw ?? "0", 10);
  const month = Number.parseInt(monthRaw ?? "0", 10);
  const day = Number.parseInt(dayRaw ?? "0", 10);
  const daysSinceTuesday = (weekday - 2 + 7) % 7;
  const utc = new Date(Date.UTC(year, month - 1, day - daysSinceTuesday));
  const yyyy = String(utc.getUTCFullYear());
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function selectScheduledLeaguePage<T extends { id: string }>(input: {
  forward: T[];
  wrap: T[];
  limit: number;
  afterId: string | null;
  prefixExists?: boolean;
}): ScheduledLeaguePage<T> {
  const { forward, wrap, afterId } = input;
  const limit = input.limit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("scheduled league page limit must be a positive integer");
  }

  const hasMoreForward = forward.length > limit;
  const forwardTaken = forward.slice(0, limit);

  if (forwardTaken.length === limit) {
    return {
      leagues: forwardTaken,
      nextAfterId: forwardTaken[forwardTaken.length - 1]?.id ?? null,
      hasDeferred: hasMoreForward || Boolean(input.prefixExists),
    };
  }

  if (afterId === null) {
    const last = forwardTaken[forwardTaken.length - 1];
    return {
      leagues: forwardTaken,
      nextAfterId: last?.id ?? null,
      hasDeferred: false,
    };
  }

  const selectedIds = new Set(forwardTaken.map((league) => league.id));
  const wrapUnique = wrap.filter((league) => !selectedIds.has(league.id));
  const remaining = limit - forwardTaken.length;
  const wrapTaken = wrapUnique.slice(0, remaining);
  const leagues = [...forwardTaken, ...wrapTaken];
  const last = leagues[leagues.length - 1];
  return {
    leagues,
    nextAfterId: last?.id ?? null,
    hasDeferred: wrapUnique.length > remaining,
  };
}

/**
 * Ordinary poll-hour split of the per-tick DO cap.
 * maxLeagues=1 keeps the only slot for regular rotation; backlog drains on idle hours.
 */
export function scheduledPollHourLimits(maxLeagues: number): {
  backlogLimit: number;
  pollLimit: number;
} {
  if (!Number.isInteger(maxLeagues) || maxLeagues < 1) {
    throw new Error("scheduled league page limit must be a positive integer");
  }
  if (maxLeagues === 1) {
    return { backlogLimit: 0, pollLimit: 1 };
  }
  const backlogLimit = Math.floor(maxLeagues / 2);
  return { backlogLimit, pollLimit: maxLeagues - backlogLimit };
}

function uniqueLeaguesById<T extends { id: string }>(leagues: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const league of leagues) {
    if (seen.has(league.id)) continue;
    seen.add(league.id);
    unique.push(league);
  }
  return unique;
}

/** Bounded last_error codes. Never store raw Error.message or model text. */
export type RecapAttemptReason = RecapStatus | "thrown";

function recapAttemptReason(result: RecapAttemptResult): RecapAttemptReason {
  const status = result.status;
  switch (status) {
    case "published":
    case "skipped_already":
    case "skipped_not_final":
    case "model_error":
    case "blank":
      return status;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function recapAttemptIsTerminal(reason: RecapAttemptReason): boolean {
  switch (reason) {
    case "published":
    case "skipped_already":
    case "blank":
      return true;
    case "skipped_not_final":
    case "model_error":
    case "thrown":
      return false;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function logScheduledLeagueFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      event: "scheduled.league.failed",
      reason: scheduledFailureReason(error),
    }),
  );
}

async function loadScheduledLeaguePage(
  db: D1Database,
  afterId: string | null,
  limit: number,
): Promise<ScheduledLeaguePage<LeagueRow>> {
  const forward = await listActiveLeagues(db, {
    ...(afterId ? { afterId } : {}),
    limit: limit + 1,
  });
  const remaining = Math.max(0, limit - Math.min(forward.length, limit));
  let wrap: LeagueRow[] = [];
  let prefixExists = false;
  if (remaining > 0 && afterId) {
    wrap = await listActiveLeagues(db, { limit: remaining + 1 });
  } else if (remaining === 0 && afterId && forward.length <= limit) {
    const first = await listActiveLeagues(db, { limit: 1 });
    prefixExists = Boolean(first[0] && first[0].id <= afterId);
  }
  return selectScheduledLeaguePage({ forward, wrap, limit, afterId, prefixExists });
}

async function listUnenrolledActiveLeagues(
  db: D1Database,
  weekKey: string,
  afterId: string | null,
  limit: number,
): Promise<LeagueRow[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("unenrolled recap enrollment limit must be a positive integer");
  }
  const clauses = ["leagues.status = 'active'"];
  const params: unknown[] = [];
  if (afterId) {
    clauses.push("leagues.id > ?");
    params.push(afterId);
  }
  clauses.push(`NOT EXISTS (
    SELECT 1 FROM recap_attempt_backlog
    WHERE recap_attempt_backlog.league_id = leagues.id
      AND recap_attempt_backlog.week_key = ?
  )`);
  params.push(weekKey, limit);
  const result = await db
    .prepare(
      `SELECT leagues.* FROM leagues
       WHERE ${clauses.join(" AND ")}
       ORDER BY leagues.id ASC
       LIMIT ?`,
    )
    .bind(...params)
    .all<LeagueRow>();
  return result.results;
}

async function loadUnenrolledRecapPage(
  db: D1Database,
  weekKey: string,
  afterId: string | null,
  limit: number,
): Promise<ScheduledLeaguePage<LeagueRow>> {
  const forward = await listUnenrolledActiveLeagues(db, weekKey, afterId, limit + 1);
  const remaining = Math.max(0, limit - Math.min(forward.length, limit));
  let wrap: LeagueRow[] = [];
  let prefixExists = false;
  if (remaining > 0 && afterId) {
    wrap = await listUnenrolledActiveLeagues(db, weekKey, null, remaining + 1);
  } else if (remaining === 0 && afterId && forward.length <= limit) {
    const first = await listUnenrolledActiveLeagues(db, weekKey, null, 1);
    prefixExists = Boolean(first[0] && first[0].id <= afterId);
  }
  return selectScheduledLeaguePage({ forward, wrap, limit, afterId, prefixExists });
}

async function readScheduledLeagueCursor(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(SCHEDULED_LEAGUE_CURSOR_KEY)
    .first<{ value: string }>();
  return parseScheduledLeagueCursor(row?.value ?? null);
}

async function writeScheduledLeagueCursor(
  db: D1Database,
  afterId: string | null,
  now: number,
): Promise<void> {
  if (afterId === null) {
    await db.prepare("DELETE FROM app_state WHERE key = ?").bind(SCHEDULED_LEAGUE_CURSOR_KEY).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(SCHEDULED_LEAGUE_CURSOR_KEY, JSON.stringify({ afterId }), now)
    .run();
}

async function readRecapEnrollmentState(db: D1Database): Promise<RecapEnrollmentState | null> {
  const row = await db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(SCHEDULED_RECAP_ENROLLMENT_KEY)
    .first<{ value: string }>();
  return parseRecapEnrollmentState(row?.value ?? null);
}

async function writeRecapEnrollmentState(
  db: D1Database,
  state: RecapEnrollmentState,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(
      SCHEDULED_RECAP_ENROLLMENT_KEY,
      JSON.stringify({
        weekKey: state.weekKey,
        afterId: state.afterId,
        complete: state.complete,
      }),
      now,
    )
    .run();
}

async function deleteStaleRecapAttempts(db: D1Database, weekKey: string): Promise<void> {
  await db.prepare("DELETE FROM recap_attempt_backlog WHERE week_key != ?").bind(weekKey).run();
}

/** Stay under D1's bound-parameter cap while still inserting at most the current page. */
const ENROLL_INSERT_CHUNK = 20;

async function enqueueRecapAttemptsForLeagues(
  db: D1Database,
  weekKey: string,
  now: number,
  leagueIds: string[],
): Promise<void> {
  for (let offset = 0; offset < leagueIds.length; offset += ENROLL_INSERT_CHUNK) {
    const chunk = leagueIds.slice(offset, offset + ENROLL_INSERT_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    await db
      .prepare(
        `INSERT INTO recap_attempt_backlog (league_id, week_key, status, attempts, last_error, created_at, updated_at)
         SELECT id, ?, 'pending', 0, NULL, ?, ?
         FROM leagues
         WHERE status = 'active' AND id IN (${placeholders})
         ON CONFLICT(league_id, week_key) DO NOTHING`,
      )
      .bind(weekKey, now, now, ...chunk)
      .run();
  }
}

async function enrollRecapBacklogPage(
  db: D1Database,
  weekKey: string,
  now: number,
  maxLeagues: number,
  existing: RecapEnrollmentState | null,
): Promise<RecapEnrollmentState> {
  if (existing?.weekKey === weekKey && existing.complete) {
    return existing;
  }
  const afterId = existing?.weekKey === weekKey ? existing.afterId : null;
  const page = await loadUnenrolledRecapPage(db, weekKey, afterId, maxLeagues);
  await enqueueRecapAttemptsForLeagues(
    db,
    weekKey,
    now,
    page.leagues.map((league) => league.id),
  );
  const next: RecapEnrollmentState = {
    weekKey,
    afterId: page.nextAfterId,
    complete: !page.hasDeferred,
  };
  await writeRecapEnrollmentState(db, next, now);
  return next;
}

async function listPendingRecapLeagues(db: D1Database, weekKey: string, limit: number): Promise<LeagueRow[]> {
  const result = await db
    .prepare(
      `SELECT leagues.* FROM recap_attempt_backlog
       INNER JOIN leagues ON leagues.id = recap_attempt_backlog.league_id
       WHERE recap_attempt_backlog.week_key = ?
         AND recap_attempt_backlog.status = 'pending'
         AND recap_attempt_backlog.attempts < ?
         AND leagues.status = 'active'
       ORDER BY recap_attempt_backlog.league_id ASC
       LIMIT ?`,
    )
    .bind(weekKey, MAX_RECAP_ATTEMPTS, limit)
    .all<LeagueRow>();
  return result.results;
}

async function hasPendingRecapAttempts(db: D1Database, weekKey: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM recap_attempt_backlog
       INNER JOIN leagues ON leagues.id = recap_attempt_backlog.league_id
       WHERE recap_attempt_backlog.week_key = ?
         AND recap_attempt_backlog.status = 'pending'
         AND recap_attempt_backlog.attempts < ?
         AND leagues.status = 'active'
       LIMIT 1`,
    )
    .bind(weekKey, MAX_RECAP_ATTEMPTS)
    .first<{ ok: number }>();
  return row !== null;
}

async function pendingRecapIds(
  db: D1Database,
  weekKey: string,
  leagueIds: string[],
): Promise<Set<string>> {
  if (leagueIds.length === 0) return new Set();
  const placeholders = leagueIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT league_id FROM recap_attempt_backlog
       WHERE week_key = ? AND status = 'pending' AND attempts < ? AND league_id IN (${placeholders})`,
    )
    .bind(weekKey, MAX_RECAP_ATTEMPTS, ...leagueIds)
    .all<{ league_id: string }>();
  return new Set(result.results.map((row) => row.league_id));
}

async function settleRecapAttempt(
  db: D1Database,
  input: { leagueId: string; weekKey: string; reason: RecapAttemptReason; now: number },
): Promise<void> {
  const lastError = input.reason === "published" ? null : input.reason;
  const terminal = recapAttemptIsTerminal(input.reason) ? 1 : 0;
  await db
    .prepare(
      `UPDATE recap_attempt_backlog
       SET status = CASE
             WHEN ? = 1 OR (attempts + 1) >= ? THEN 'done'
             ELSE 'pending'
           END,
           attempts = attempts + 1,
           last_error = ?,
           updated_at = ?
       WHERE league_id = ? AND week_key = ? AND status = 'pending' AND attempts < ?`,
    )
    .bind(
      terminal,
      MAX_RECAP_ATTEMPTS,
      lastError,
      input.now,
      input.leagueId,
      input.weekKey,
      MAX_RECAP_ATTEMPTS,
    )
    .run();
}

export async function handleScheduled(
  env: Env,
  now = new Date(),
  maxLeagues = MAX_SCHEDULED_LEAGUES_PER_TICK,
): Promise<{ polled: number; recapped: number }> {
  const parts = easternParts(now);
  const poll = shouldPoll(parts);
  const recapWindow = shouldAttemptTuesdayRecap(parts);
  const weekKey = easternRecapWeekKey(now);
  const nowMs = now.getTime();
  await sweepStaleExplorerOriginQuota(env.DB, {
    now: nowMs,
    retentionHours: EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS,
    limit: EXPLORER_ORIGIN_QUOTA_STALE_SWEEP_LIMIT,
  });

  let enrollment = await readRecapEnrollmentState(env.DB);
  if (recapWindow) {
    if (enrollment?.weekKey !== weekKey) {
      await deleteStaleRecapAttempts(env.DB, weekKey);
      enrollment = { weekKey, afterId: null, complete: false };
    }
    if (!enrollment.complete) {
      enrollment = await enrollRecapBacklogPage(env.DB, weekKey, nowMs, maxLeagues, enrollment);
    }
  } else if (enrollment?.weekKey === weekKey && !enrollment.complete) {
    enrollment = await enrollRecapBacklogPage(env.DB, weekKey, nowMs, maxLeagues, enrollment);
  }

  const enrollmentForWeek = enrollment?.weekKey === weekKey ? enrollment : null;

  let pending: LeagueRow[] = [];
  if (!recapWindow) {
    if (!poll && !enrollmentForWeek) {
      return { polled: 0, recapped: 0 };
    }
    if (!poll && enrollmentForWeek?.complete) {
      if (!(await hasPendingRecapAttempts(env.DB, weekKey))) {
        return { polled: 0, recapped: 0 };
      }
    }
    if (!poll) {
      pending = await listPendingRecapLeagues(env.DB, weekKey, maxLeagues);
      if (pending.length === 0) {
        return { polled: 0, recapped: 0 };
      }
    }
  }

  let page: ScheduledLeaguePage<LeagueRow> | null = null;
  let work: LeagueRow[] = [];
  let recapIds = new Set<string>();

  if (recapWindow) {
    const afterId = await readScheduledLeagueCursor(env.DB);
    page = await loadScheduledLeaguePage(env.DB, afterId, maxLeagues);
    work = page.leagues;
    recapIds = await pendingRecapIds(
      env.DB,
      weekKey,
      work.map((league) => league.id),
    );
  } else if (poll) {
    const { backlogLimit, pollLimit } = scheduledPollHourLimits(maxLeagues);
    pending =
      backlogLimit > 0 ? await listPendingRecapLeagues(env.DB, weekKey, backlogLimit) : [];
    const afterId = await readScheduledLeagueCursor(env.DB);
    const pollPageLimit = pending.length > 0 ? pollLimit : maxLeagues;
    page = await loadScheduledLeaguePage(env.DB, afterId, pollPageLimit);
    work = uniqueLeaguesById([...page.leagues, ...pending]);
    recapIds = await pendingRecapIds(
      env.DB,
      weekKey,
      work.map((league) => league.id),
    );
  } else {
    work = pending;
    recapIds = new Set(work.map((league) => league.id));
  }

  let polled = 0;
  let recapped = 0;
  for (const league of work) {
    const shouldRecap = recapIds.has(league.id);
    try {
      const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(league.id));
      await stub.bootstrap({
        leagueId: league.id,
        sleeperLeagueId: league.sleeper_league_id,
        name: league.name,
        tone: toneOrPlayful(league.tone),
      });
      if (poll || shouldRecap) {
        await stub.poll();
        polled += 1;
      }
      if (shouldRecap) {
        const result = await stub.attemptRecap();
        if (result.status === "published") recapped += 1;
        await settleRecapAttempt(env.DB, {
          leagueId: league.id,
          weekKey,
          reason: recapAttemptReason(result),
          now: nowMs,
        });
      }
    } catch (error) {
      logScheduledLeagueFailure(error);
      if (shouldRecap) {
        await settleRecapAttempt(env.DB, {
          leagueId: league.id,
          weekKey,
          reason: "thrown",
          now: nowMs,
        });
      }
    }
  }

  if (page) {
    await writeScheduledLeagueCursor(env.DB, page.nextAfterId, nowMs);
    if (page.hasDeferred) {
      console.warn(
        JSON.stringify({
          event: "scheduled.leagues.deferred",
          processed: page.leagues.length,
          limit: maxLeagues,
        }),
      );
    }
  }

  return { polled, recapped };
}
