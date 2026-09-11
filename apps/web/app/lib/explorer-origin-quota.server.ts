export const EXPLORER_QUOTA_HOUR_MS = 60 * 60 * 1000;

/** Keep the latest 24 hour_key windows; older one-row-per-user leftovers are swept hourly. */
export const EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS = 24;

/** Max stale quota rows removed per scheduled tick. */
export const EXPLORER_ORIGIN_QUOTA_STALE_SWEEP_LIMIT = 500;

export type ExplorerOriginQuotaConsumeInput = {
  clerkUserId: string;
  charge: number;
  now: number;
  limit: number;
};

export type ExplorerOriginQuotaRow = {
  hourKey: number;
  used: number;
};

export type ExplorerOriginQuota = {
  tryConsume(input: ExplorerOriginQuotaConsumeInput): Promise<boolean>;
};

export type ExplorerOriginQuotaConsumeBinds = [
  clerkUserId: string,
  hourKey: number,
  charge: number,
  insertCharge: number,
  insertLimit: number,
  sameHourLimit: number,
  newerHourLimit: number,
];

export function explorerOriginQuotaHourKey(now: number): number {
  return Math.floor(now / EXPLORER_QUOTA_HOUR_MS);
}

export function explorerOriginQuotaStaleCutoffHourKey(
  now: number,
  retentionHours = EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS,
): number {
  return explorerOriginQuotaHourKey(now) - retentionHours;
}

function isValidExplorerOriginQuotaConsume(input: ExplorerOriginQuotaConsumeInput): boolean {
  if (typeof input.clerkUserId !== "string" || input.clerkUserId.length === 0) return false;
  if (!Number.isInteger(input.charge) || input.charge <= 0) return false;
  if (!Number.isInteger(input.limit) || input.limit < 0) return false;
  if (!Number.isFinite(input.now)) return false;
  const hourKey = explorerOriginQuotaHourKey(input.now);
  return Number.isInteger(hourKey) && hourKey >= 0;
}

export function explorerOriginQuotaConsumeBinds(
  input: ExplorerOriginQuotaConsumeInput,
): ExplorerOriginQuotaConsumeBinds {
  const hourKey = explorerOriginQuotaHourKey(input.now);
  return [
    input.clerkUserId,
    hourKey,
    input.charge,
    input.charge,
    input.limit,
    input.limit,
    input.limit,
  ];
}

export function createMemoryExplorerOriginQuota(
  store = new Map<string, ExplorerOriginQuotaRow>(),
): ExplorerOriginQuota {
  return {
    async tryConsume(input) {
      if (!isValidExplorerOriginQuotaConsume(input)) return false;
      if (input.charge > input.limit) return false;
      const hourKey = explorerOriginQuotaHourKey(input.now);
      const existing = store.get(input.clerkUserId);
      if (!existing) {
        store.set(input.clerkUserId, { hourKey, used: input.charge });
        return true;
      }
      if (existing.hourKey === hourKey) {
        if (existing.used + input.charge > input.limit) return false;
        existing.used += input.charge;
        return true;
      }
      if (existing.hourKey < hourKey) {
        store.set(input.clerkUserId, { hourKey, used: input.charge });
        return true;
      }
      return false;
    },
  };
}

// Single atomic UPSERT, one row per Clerk user.
// INSERT...SELECT WHERE rejects a first charge above the limit without writing a row.
// Same-hour UPDATE adds only when used + charge stays within the limit.
// Newer-hour UPDATE resets used to charge (and advances hour_key) only when charge <= limit.
// Older-hour requests miss the WHERE guard so a boundary race cannot roll hour_key backward.
// Acceptance is `meta.changes === 1` (sqlite3_changes), not `rows_written`.
export const EXPLORER_ORIGIN_QUOTA_CONSUME_SQL = `INSERT INTO explorer_origin_quota (clerk_user_id, hour_key, used)
SELECT ?, ?, ?
WHERE ? <= ?
ON CONFLICT (clerk_user_id) DO UPDATE
SET
  used = CASE
    WHEN explorer_origin_quota.hour_key = excluded.hour_key
      THEN explorer_origin_quota.used + excluded.used
    ELSE excluded.used
  END,
  hour_key = excluded.hour_key
WHERE (
  explorer_origin_quota.hour_key = excluded.hour_key
  AND explorer_origin_quota.used + excluded.used <= ?
) OR (
  explorer_origin_quota.hour_key < excluded.hour_key
  AND excluded.used <= ?
)`;

export const EXPLORER_ORIGIN_QUOTA_SWEEP_SQL = `DELETE FROM explorer_origin_quota
WHERE clerk_user_id IN (
  SELECT clerk_user_id
  FROM explorer_origin_quota
  WHERE hour_key < ?
  ORDER BY hour_key ASC, clerk_user_id ASC
  LIMIT ?
)`;

export function d1ExplorerOriginQuotaAccepted(changes: number | undefined): boolean {
  return changes === 1;
}

export function d1ExplorerOriginQuota(db: D1Database): ExplorerOriginQuota {
  return {
    async tryConsume(input) {
      if (!isValidExplorerOriginQuotaConsume(input)) return false;
      const result = await db
        .prepare(EXPLORER_ORIGIN_QUOTA_CONSUME_SQL)
        .bind(...explorerOriginQuotaConsumeBinds(input))
        .run();
      return d1ExplorerOriginQuotaAccepted(result.meta.changes);
    },
  };
}

export async function sweepStaleExplorerOriginQuota(
  db: D1Database,
  input: {
    now: number;
    retentionHours?: number;
    limit?: number;
  },
): Promise<number> {
  const retentionHours = input.retentionHours ?? EXPLORER_ORIGIN_QUOTA_STALE_RETENTION_HOURS;
  const limit = input.limit ?? EXPLORER_ORIGIN_QUOTA_STALE_SWEEP_LIMIT;
  if (!Number.isFinite(input.now)) return 0;
  if (!Number.isInteger(retentionHours) || retentionHours < 1) return 0;
  if (!Number.isInteger(limit) || limit < 1) return 0;
  const cutoff = explorerOriginQuotaStaleCutoffHourKey(input.now, retentionHours);
  if (!Number.isInteger(cutoff)) return 0;
  const result = await db.prepare(EXPLORER_ORIGIN_QUOTA_SWEEP_SQL).bind(cutoff, limit).run();
  return result.meta.changes ?? 0;
}
