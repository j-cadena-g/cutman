import type { DiscoverLeaguesResult, DiscoveredLeague } from "./onboarding.server.ts";
import type { ExplorerCache } from "./sleeper-explorer.server.ts";

// Bounded onboarding discovery cache on the existing EXPLORER_CACHE KV (no extra binding).
// Keys include both Clerk and Sleeper account ids so two users — or one Clerk user who
// reconnects a different Sleeper account — cannot read each other's leagues. Only a typed
// `{ ok: true }` result is stored; failures stay uncached so the next load retries Sleeper.
export const ONBOARDING_DISCOVERY_TTL_MS = 15 * 60 * 1000;
const CACHE_KEY_PREFIX = "onboarding:discovery:";
const RELATIVE_URL_BASE = "https://cutman.invalid";

export type OnboardingDiscoveryCacheDeps = {
  cache: ExplorerCache;
  now: () => number;
  ttlMs?: number;
  discover: () => Promise<DiscoverLeaguesResult>;
};

type CachedOnboardingDiscovery = {
  fetchedAt: number;
  expiresAt: number;
  season: string;
  leagues: DiscoveredLeague[];
};

export function onboardingDiscoveryCacheKey(clerkUserId: string, sleeperUserId: string): string {
  return `${CACHE_KEY_PREFIX}${encodeURIComponent(clerkUserId)}:${encodeURIComponent(sleeperUserId)}`;
}

export function onboardingDiscoveryKvExpirationTtlSeconds(ttlMs: number): number {
  return Math.max(60, Math.ceil(ttlMs / 1000));
}

// `Request.url` is usually absolute; still parse without throwing so a relative or malformed
// URL cannot 500 the onboarding loader. Only `searchParams` are consumed — never used as a
// redirect target — so the dummy `.invalid` base cannot leak into navigation.
export function parseRequestSearchParams(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams;
  } catch {
    try {
      return new URL(url, RELATIVE_URL_BASE).searchParams;
    } catch {
      return new URLSearchParams();
    }
  }
}

export function onboardingDiscoveryRefreshRequested(request: { url: string }): boolean {
  const value = parseRequestSearchParams(request.url).get("refresh");
  return value === "1" || value === "true";
}

function discoveryTtlMs(deps: OnboardingDiscoveryCacheDeps): number {
  const ttlMs = deps.ttlMs ?? ONBOARDING_DISCOVERY_TTL_MS;
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : ONBOARDING_DISCOVERY_TTL_MS;
}

function isLeagueClassification(value: unknown): value is DiscoveredLeague["classification"] {
  return value === "pilot" || value === "coming_soon";
}

function isDiscoveredLeague(value: unknown): value is DiscoveredLeague {
  if (!value || typeof value !== "object") return false;
  const league = value as Record<string, unknown>;
  return (
    typeof league.sleeperLeagueId === "string" &&
    league.sleeperLeagueId.length > 0 &&
    typeof league.name === "string" &&
    typeof league.season === "string" &&
    isLeagueClassification(league.classification) &&
    typeof league.isOwner === "boolean"
  );
}

function isCachedOnboardingDiscovery(value: unknown): value is CachedOnboardingDiscovery {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.fetchedAt === "number" &&
    Number.isFinite(entry.fetchedAt) &&
    typeof entry.expiresAt === "number" &&
    Number.isFinite(entry.expiresAt) &&
    typeof entry.season === "string" &&
    entry.season.length > 0 &&
    Array.isArray(entry.leagues) &&
    entry.leagues.every(isDiscoveredLeague)
  );
}

function isFreshCachedDiscovery(entry: CachedOnboardingDiscovery, now: number, ttlMs: number): boolean {
  if (entry.fetchedAt > now) return false;
  if (entry.expiresAt <= entry.fetchedAt) return false;
  if (now >= entry.expiresAt) return false;
  if (now - entry.fetchedAt >= ttlMs) return false;
  if (entry.expiresAt - entry.fetchedAt > ttlMs) return false;
  return true;
}

async function readCachedDiscovery(
  deps: OnboardingDiscoveryCacheDeps,
  key: string,
): Promise<DiscoverLeaguesResult | null> {
  let raw: unknown = null;
  try {
    raw = await deps.cache.getJson<unknown>(key);
  } catch {
    return null;
  }
  if (!isCachedOnboardingDiscovery(raw)) return null;
  const ttlMs = discoveryTtlMs(deps);
  if (!isFreshCachedDiscovery(raw, deps.now(), ttlMs)) return null;
  return { ok: true, season: raw.season, leagues: raw.leagues };
}

async function writeCachedDiscovery(
  deps: OnboardingDiscoveryCacheDeps,
  key: string,
  result: Extract<DiscoverLeaguesResult, { ok: true }>,
): Promise<void> {
  const now = deps.now();
  const ttlMs = discoveryTtlMs(deps);
  const entry: CachedOnboardingDiscovery = {
    fetchedAt: now,
    expiresAt: now + ttlMs,
    season: result.season,
    leagues: result.leagues,
  };
  await deps.cache.putJson(key, entry, {
    expirationTtl: onboardingDiscoveryKvExpirationTtlSeconds(ttlMs),
  });
}

export async function loadCachedOnboardingDiscovery(
  deps: OnboardingDiscoveryCacheDeps,
  input: { clerkUserId: string; sleeperUserId: string; refresh?: boolean },
): Promise<DiscoverLeaguesResult> {
  const canCache =
    typeof input.clerkUserId === "string" &&
    input.clerkUserId.length > 0 &&
    typeof input.sleeperUserId === "string" &&
    input.sleeperUserId.length > 0;

  if (!canCache) {
    return deps.discover();
  }

  const key = onboardingDiscoveryCacheKey(input.clerkUserId, input.sleeperUserId);
  if (!input.refresh) {
    const cached = await readCachedDiscovery(deps, key);
    if (cached) return cached;
  }

  const result = await deps.discover();
  if (result.ok) {
    try {
      await writeCachedDiscovery(deps, key, result);
    } catch {
      // Persist is best-effort. A KV write error must not turn a typed success into a
      // discovery failure for this request.
    }
  }
  return result;
}
