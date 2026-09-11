export const EXPLORER_QUOTA_HOUR_MS = 60 * 60 * 1000;

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

export function explorerOriginQuotaHourKey(now: number): number {
  return Math.floor(now / EXPLORER_QUOTA_HOUR_MS);
}

function isValidExplorerOriginQuotaConsume(input: ExplorerOriginQuotaConsumeInput): boolean {
  if (typeof input.clerkUserId !== "string" || input.clerkUserId.length === 0) return false;
  if (!Number.isInteger(input.charge) || input.charge <= 0) return false;
  if (!Number.isInteger(input.limit) || input.limit < 0) return false;
  if (!Number.isFinite(input.now)) return false;
  const hourKey = explorerOriginQuotaHourKey(input.now);
  return Number.isInteger(hourKey) && hourKey >= 0;
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

export function d1ExplorerOriginQuotaAccepted(changes: number | undefined): boolean {
  return changes === 1;
}

export function d1ExplorerOriginQuota(db: D1Database): ExplorerOriginQuota {
  return {
    async tryConsume(input) {
      if (!isValidExplorerOriginQuotaConsume(input)) return false;
      const result = await db
        .prepare(EXPLORER_ORIGIN_QUOTA_CONSUME_SQL)
        .bind(
          input.clerkUserId,
          explorerOriginQuotaHourKey(input.now),
          input.charge,
          input.charge,
          input.limit,
          input.limit,
          input.limit,
        )
        .run();
      return d1ExplorerOriginQuotaAccepted(result.meta.changes);
    },
  };
}
