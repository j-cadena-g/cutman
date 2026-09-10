import { listActiveLeagues, type LeagueRow } from "@cutman/db";
import { easternParts, shouldAttemptTuesdayRecap, shouldPoll, toneOrPlayful } from "@cutman/story";

/** Cap Durable Object work per cron tick. Successive ticks continue from a D1 cursor. */
export const MAX_SCHEDULED_LEAGUES_PER_TICK = 10;

/** Dedicated app_state key for fair active-league rotation. */
export const SCHEDULED_LEAGUE_CURSOR_KEY = "scheduled:active-leagues:cursor";

export type ScheduledLeaguePage<T extends { id: string } = { id: string }> = {
  leagues: T[];
  nextAfterId: string | null;
  hasDeferred: boolean;
};

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

export async function handleScheduled(
  env: Env,
  now = new Date(),
  maxLeagues = MAX_SCHEDULED_LEAGUES_PER_TICK,
): Promise<{ polled: number; recapped: number }> {
  const parts = easternParts(now);
  const poll = shouldPoll(parts);
  const recap = shouldAttemptTuesdayRecap(parts);
  if (!poll && !recap) {
    return { polled: 0, recapped: 0 };
  }

  // Process a bounded page of active leagues serially so a single tick never fans out
  // unbounded Durable Object calls. The D1 cursor continues fairly on the next tick.
  const afterId = await readScheduledLeagueCursor(env.DB);
  const page = await loadScheduledLeaguePage(env.DB, afterId, maxLeagues);

  let polled = 0;
  let recapped = 0;
  for (const league of page.leagues) {
    try {
      const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(league.id));
      await stub.bootstrap({
        leagueId: league.id,
        sleeperLeagueId: league.sleeper_league_id,
        name: league.name,
        tone: toneOrPlayful(league.tone),
      });
      if (poll) {
        await stub.poll();
        polled += 1;
      }
      if (recap) {
        const result = await stub.attemptRecap();
        if (result.status === "published") recapped += 1;
      }
    } catch (error) {
      console.error(`scheduled tick failed for league ${league.id}`, error);
    }
  }

  await writeScheduledLeagueCursor(env.DB, page.nextAfterId, now.getTime());

  if (page.hasDeferred) {
    console.warn(
      JSON.stringify({
        event: "scheduled.leagues.deferred",
        processed: page.leagues.length,
        limit: maxLeagues,
      }),
    );
  }

  return { polled, recapped };
}
