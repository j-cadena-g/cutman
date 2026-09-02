import type { SleeperLeagueUser, SleeperMatchup, SleeperRoster, SleeperTransaction } from "@cutman/sleeper";

export type LeagueSnapshot = {
  leagueId: string;
  week: number;
  users: SleeperLeagueUser[];
  rosters: SleeperRoster[];
  matchups: SleeperMatchup[];
  transactions: SleeperTransaction[];
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export async function hashPayload(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashSnapshot(snapshot: LeagueSnapshot): Promise<string> {
  return hashPayload(snapshot);
}
