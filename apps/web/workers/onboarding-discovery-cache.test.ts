/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_DISCOVERY_TTL_MS,
  loadCachedOnboardingDiscovery,
  onboardingDiscoveryCacheKey,
  onboardingDiscoveryKvExpirationTtlSeconds,
  onboardingDiscoveryRefreshRequested,
  parseRequestSearchParams,
  type OnboardingDiscoveryCacheDeps,
} from "../app/lib/onboarding-discovery-cache.server.ts";
import type { DiscoverLeaguesResult, DiscoveredLeague } from "../app/lib/onboarding.server.ts";
import {
  createMemoryExplorerCache,
  kvExplorerCache,
  type ExplorerCache,
} from "../app/lib/sleeper-explorer.server.ts";

const FIXED_NOW = 1_800_000_000_000;
const CLERK_A = "clerk_cache_a";
const CLERK_B = "clerk_cache_b";
const SLEEPER_A = "sleeper_cache_a";
const SLEEPER_B = "sleeper_cache_b";

const PILOT_LEAGUE: DiscoveredLeague = {
  sleeperLeagueId: "league_pilot",
  name: "Pilot",
  season: "2026",
  classification: "pilot",
  isOwner: true,
};

const OTHER_LEAGUE: DiscoveredLeague = {
  sleeperLeagueId: "league_other",
  name: "Other",
  season: "2026",
  classification: "coming_soon",
  isOwner: false,
};

const SUCCESS: Extract<DiscoverLeaguesResult, { ok: true }> = {
  ok: true,
  season: "2026",
  leagues: [PILOT_LEAGUE, OTHER_LEAGUE],
};

const REFRESHED_SUCCESS: Extract<DiscoverLeaguesResult, { ok: true }> = {
  ok: true,
  season: "2026",
  leagues: [{ ...PILOT_LEAGUE, isOwner: false, name: "Pilot refreshed" }],
};

const NOT_LINKED: DiscoverLeaguesResult = {
  ok: false,
  error: { kind: "sleeper_account_not_linked" },
};

function recordingCache(store = new Map<string, string>()): {
  cache: ExplorerCache;
  store: Map<string, string>;
  puts: Array<{ key: string; value: unknown; expirationTtl?: number }>;
} {
  const base = createMemoryExplorerCache(store);
  const puts: Array<{ key: string; value: unknown; expirationTtl?: number }> = [];
  const cache: ExplorerCache = {
    getJson: (key) => base.getJson(key),
    async putJson(key, value, options) {
      puts.push({ key, value, expirationTtl: options?.expirationTtl });
      return base.putJson(key, value, options);
    },
  };
  return { cache, store, puts };
}

function throwingPutCache(base: ExplorerCache): ExplorerCache {
  return {
    getJson: (key) => base.getJson(key),
    async putJson() {
      throw new Error("kv put failed");
    },
  };
}

function throwingGetCache(): ExplorerCache {
  return {
    async getJson() {
      throw new Error("kv get failed");
    },
    async putJson() {
      return;
    },
  };
}

function countingDiscover(result: DiscoverLeaguesResult | (() => Promise<DiscoverLeaguesResult>)): {
  discover: () => Promise<DiscoverLeaguesResult>;
  calls: { n: number };
} {
  const calls = { n: 0 };
  return {
    calls,
    async discover() {
      calls.n += 1;
      return typeof result === "function" ? result() : result;
    },
  };
}

function makeDeps(
  overrides: Partial<OnboardingDiscoveryCacheDeps> & { cache?: ExplorerCache } = {},
): OnboardingDiscoveryCacheDeps {
  return {
    cache: overrides.cache ?? createMemoryExplorerCache(),
    now: overrides.now ?? (() => FIXED_NOW),
    ttlMs: overrides.ttlMs,
    discover: overrides.discover ?? (async () => SUCCESS),
  };
}

describe("onboardingDiscoveryCacheKey", () => {
  it("isolates Clerk users that share a Sleeper id and Sleeper accounts under one Clerk user", () => {
    expect(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A)).not.toBe(onboardingDiscoveryCacheKey(CLERK_B, SLEEPER_A));
    expect(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A)).not.toBe(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_B));
  });

  it("does not collide when account ids contain the key delimiter", () => {
    expect(onboardingDiscoveryCacheKey("a:b", "c")).not.toBe(onboardingDiscoveryCacheKey("a", "b:c"));
  });

  it("uses the onboarding prefix rather than explorer keys", () => {
    expect(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A).startsWith("onboarding:discovery:")).toBe(true);
    expect(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A).startsWith("explore:")).toBe(false);
  });
});

describe("parseRequestSearchParams / onboardingDiscoveryRefreshRequested", () => {
  it("treats an absolute URL without refresh as a default (cached) load", () => {
    expect(onboardingDiscoveryRefreshRequested({ url: "https://cutman.invalid/onboarding" })).toBe(false);
    expect(parseRequestSearchParams("https://cutman.invalid/onboarding?foo=1").get("refresh")).toBeNull();
  });

  it("honors refresh=1 and refresh=true on an absolute URL", () => {
    expect(onboardingDiscoveryRefreshRequested({ url: "https://cutman.invalid/onboarding?refresh=1" })).toBe(true);
    expect(onboardingDiscoveryRefreshRequested({ url: "https://cutman.invalid/onboarding?refresh=true" })).toBe(true);
  });

  it("ignores other refresh values, including an empty or zero flag", () => {
    expect(onboardingDiscoveryRefreshRequested({ url: "https://cutman.invalid/onboarding?refresh=" })).toBe(false);
    expect(onboardingDiscoveryRefreshRequested({ url: "https://cutman.invalid/onboarding?refresh=0" })).toBe(false);
    expect(onboardingDiscoveryRefreshRequested({ url: "https://cutman.invalid/onboarding?refresh=yes" })).toBe(false);
  });

  it("parses a relative URL without throwing", () => {
    expect(onboardingDiscoveryRefreshRequested({ url: "/onboarding?refresh=1" })).toBe(true);
    expect(onboardingDiscoveryRefreshRequested({ url: "/onboarding" })).toBe(false);
  });

  it("treats a malformed URL as no refresh instead of throwing", () => {
    expect(onboardingDiscoveryRefreshRequested({ url: "http://[invalid" })).toBe(false);
    expect(parseRequestSearchParams("http://[invalid").toString()).toBe("");
  });
});

describe("loadCachedOnboardingDiscovery", () => {
  it("misses an empty cache, discovers once, and persists a successful typed result with KV TTL", async () => {
    const recorded = recordingCache();
    const { discover, calls } = countingDiscover(SUCCESS);
    const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });

    expect(result).toEqual(SUCCESS);
    expect(calls.n).toBe(1);
    expect(recorded.puts).toHaveLength(1);
    expect(recorded.puts[0]?.key).toBe(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A));
    expect(recorded.puts[0]?.expirationTtl).toBe(
      onboardingDiscoveryKvExpirationTtlSeconds(ONBOARDING_DISCOVERY_TTL_MS),
    );
    expect(recorded.puts[0]?.value).toEqual({
      fetchedAt: FIXED_NOW,
      expiresAt: FIXED_NOW + ONBOARDING_DISCOVERY_TTL_MS,
      season: SUCCESS.season,
      leagues: SUCCESS.leagues,
    });
  });

  it("returns the cached success on a later load without calling discover", async () => {
    const recorded = recordingCache();
    const first = countingDiscover(SUCCESS);
    await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: first.discover }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });

    const second = countingDiscover(REFRESHED_SUCCESS);
    const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: second.discover }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });

    expect(result).toEqual(SUCCESS);
    expect(first.calls.n).toBe(1);
    expect(second.calls.n).toBe(0);
    expect(recorded.puts).toHaveLength(1);
  });

  it("treats payload TTL expiry as a miss even if the KV entry is still present", async () => {
    const recorded = recordingCache();
    const ttlMs = 60_000;
    await recorded.cache.putJson(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A), {
      fetchedAt: FIXED_NOW,
      expiresAt: FIXED_NOW + ttlMs,
      season: SUCCESS.season,
      leagues: SUCCESS.leagues,
    });

    const { discover, calls } = countingDiscover(REFRESHED_SUCCESS);
    const result = await loadCachedOnboardingDiscovery(
      makeDeps({ cache: recorded.cache, discover, now: () => FIXED_NOW + ttlMs, ttlMs }),
      { clerkUserId: CLERK_A, sleeperUserId: SLEEPER_A },
    );

    expect(result).toEqual(REFRESHED_SUCCESS);
    expect(calls.n).toBe(1);
  });

  it("treats a payload with a future fetchedAt or inverted expiry window as a miss", async () => {
    const ttlMs = 60_000;
    const bogus = [
      { fetchedAt: FIXED_NOW + 1, expiresAt: FIXED_NOW + ttlMs, season: SUCCESS.season, leagues: SUCCESS.leagues },
      { fetchedAt: FIXED_NOW, expiresAt: FIXED_NOW, season: SUCCESS.season, leagues: SUCCESS.leagues },
    ];
    for (const payload of bogus) {
      const recorded = recordingCache();
      await recorded.cache.putJson(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A), payload);
      const { discover, calls } = countingDiscover(REFRESHED_SUCCESS);
      const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover, ttlMs }), {
        clerkUserId: CLERK_A,
        sleeperUserId: SLEEPER_A,
      });
      expect(result).toEqual(REFRESHED_SUCCESS);
      expect(calls.n).toBe(1);
    }
  });

  it("treats a payload whose claimed TTL exceeds the configured bound as a miss", async () => {
    const recorded = recordingCache();
    const ttlMs = 60_000;
    await recorded.cache.putJson(onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A), {
      fetchedAt: FIXED_NOW - 1,
      expiresAt: FIXED_NOW + ttlMs * 4,
      season: SUCCESS.season,
      leagues: SUCCESS.leagues,
    });

    const { discover, calls } = countingDiscover(REFRESHED_SUCCESS);
    const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover, ttlMs }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });

    expect(result).toEqual(REFRESHED_SUCCESS);
    expect(calls.n).toBe(1);
  });

  it("treats an unreadable cache get as a miss", async () => {
    const { discover, calls } = countingDiscover(SUCCESS);
    const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: throwingGetCache(), discover }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });
    expect(result).toEqual(SUCCESS);
    expect(calls.n).toBe(1);
  });

  it("treats malformed JSON and untyped payloads as a miss", async () => {
    const cases: unknown[] = [
      "not-json",
      { season: "2026" },
      { fetchedAt: FIXED_NOW, expiresAt: FIXED_NOW + 1, season: "2026", leagues: [{ name: "nope" }] },
      {
        fetchedAt: "now",
        expiresAt: FIXED_NOW + 1,
        season: "2026",
        leagues: [PILOT_LEAGUE],
      },
      { fetchedAt: FIXED_NOW, expiresAt: FIXED_NOW + 1, season: "", leagues: [] },
      {
        fetchedAt: FIXED_NOW,
        expiresAt: FIXED_NOW + 1,
        season: "2026",
        leagues: [{ ...PILOT_LEAGUE, classification: "hidden" }],
      },
    ];

    for (const payload of cases) {
      const recorded = recordingCache();
      const key = onboardingDiscoveryCacheKey(CLERK_A, SLEEPER_A);
      if (payload === "not-json") {
        recorded.store.set(key, "not-json");
      } else {
        recorded.store.set(key, JSON.stringify(payload));
      }
      const { discover, calls } = countingDiscover(SUCCESS);
      const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover }), {
        clerkUserId: CLERK_A,
        sleeperUserId: SLEEPER_A,
      });
      expect(result, `payload ${JSON.stringify(payload)}`).toEqual(SUCCESS);
      expect(calls.n, `payload ${JSON.stringify(payload)}`).toBe(1);
    }
  });

  it("does not cache a typed discovery failure", async () => {
    const recorded = recordingCache();
    const { discover, calls } = countingDiscover(NOT_LINKED);
    const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });
    expect(result).toEqual(NOT_LINKED);
    expect(calls.n).toBe(1);
    expect(recorded.puts).toHaveLength(0);
  });

  it("does not cache a thrown discovery failure and rethrows", async () => {
    const recorded = recordingCache();
    const result = loadCachedOnboardingDiscovery(
      makeDeps({
        cache: recorded.cache,
        discover: async () => {
          throw new Error("sleeper unavailable");
        },
      }),
      { clerkUserId: CLERK_A, sleeperUserId: SLEEPER_A },
    );
    await expect(result).rejects.toThrow("sleeper unavailable");
    expect(recorded.puts).toHaveLength(0);
  });

  it("bypasses and replaces cache on an explicit refresh", async () => {
    const recorded = recordingCache();
    const first = countingDiscover(SUCCESS);
    await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: first.discover }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });

    const second = countingDiscover(REFRESHED_SUCCESS);
    const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: second.discover }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
      refresh: true,
    });

    expect(result).toEqual(REFRESHED_SUCCESS);
    expect(second.calls.n).toBe(1);
    expect(recorded.puts).toHaveLength(2);
    expect(recorded.puts[1]?.value).toMatchObject({
      season: REFRESHED_SUCCESS.season,
      leagues: REFRESHED_SUCCESS.leagues,
    });

    const third = countingDiscover(SUCCESS);
    const cached = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: third.discover }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });
    expect(cached).toEqual(REFRESHED_SUCCESS);
    expect(third.calls.n).toBe(0);
  });

  it("leaves the previous success in place when a refresh discover fails", async () => {
    const recorded = recordingCache();
    await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: async () => SUCCESS }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });

    const failed = countingDiscover(NOT_LINKED);
    const refreshResult = await loadCachedOnboardingDiscovery(
      makeDeps({ cache: recorded.cache, discover: failed.discover }),
      { clerkUserId: CLERK_A, sleeperUserId: SLEEPER_A, refresh: true },
    );
    expect(refreshResult).toEqual(NOT_LINKED);
    expect(failed.calls.n).toBe(1);
    expect(recorded.puts).toHaveLength(1);

    const later = countingDiscover(REFRESHED_SUCCESS);
    const defaultResult = await loadCachedOnboardingDiscovery(
      makeDeps({ cache: recorded.cache, discover: later.discover }),
      { clerkUserId: CLERK_A, sleeperUserId: SLEEPER_A },
    );
    expect(defaultResult).toEqual(SUCCESS);
    expect(later.calls.n).toBe(0);
  });

  it("does not let one Clerk/Sleeper pair read another pair's cached leagues", async () => {
    const recorded = recordingCache();
    await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: async () => SUCCESS }), {
      clerkUserId: CLERK_A,
      sleeperUserId: SLEEPER_A,
    });

    const otherClerk = countingDiscover(REFRESHED_SUCCESS);
    const otherClerkResult = await loadCachedOnboardingDiscovery(
      makeDeps({ cache: recorded.cache, discover: otherClerk.discover }),
      { clerkUserId: CLERK_B, sleeperUserId: SLEEPER_A },
    );
    expect(otherClerkResult).toEqual(REFRESHED_SUCCESS);
    expect(otherClerk.calls.n).toBe(1);

    const otherSleeper = countingDiscover(REFRESHED_SUCCESS);
    const otherSleeperResult = await loadCachedOnboardingDiscovery(
      makeDeps({ cache: recorded.cache, discover: otherSleeper.discover }),
      { clerkUserId: CLERK_A, sleeperUserId: SLEEPER_B },
    );
    expect(otherSleeperResult).toEqual(REFRESHED_SUCCESS);
    expect(otherSleeper.calls.n).toBe(1);

    const original = countingDiscover(NOT_LINKED);
    const originalResult = await loadCachedOnboardingDiscovery(
      makeDeps({ cache: recorded.cache, discover: original.discover }),
      { clerkUserId: CLERK_A, sleeperUserId: SLEEPER_A },
    );
    expect(originalResult).toEqual(SUCCESS);
    expect(original.calls.n).toBe(0);
  });

  it("skips cache entirely when Clerk or Sleeper ids are missing so empty keys cannot collide", async () => {
    const recorded = recordingCache();
    const first = countingDiscover(SUCCESS);
    await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: first.discover }), {
      clerkUserId: "",
      sleeperUserId: SLEEPER_A,
    });
    const second = countingDiscover(REFRESHED_SUCCESS);
    const result = await loadCachedOnboardingDiscovery(makeDeps({ cache: recorded.cache, discover: second.discover }), {
      clerkUserId: "",
      sleeperUserId: SLEEPER_A,
    });
    expect(result).toEqual(REFRESHED_SUCCESS);
    expect(first.calls.n).toBe(1);
    expect(second.calls.n).toBe(1);
    expect(recorded.puts).toHaveLength(0);
  });

  it("still returns a typed success when persisting to KV throws", async () => {
    const { discover, calls } = countingDiscover(SUCCESS);
    const result = await loadCachedOnboardingDiscovery(
      makeDeps({ cache: throwingPutCache(createMemoryExplorerCache()), discover }),
      { clerkUserId: CLERK_A, sleeperUserId: SLEEPER_A },
    );
    expect(result).toEqual(SUCCESS);
    expect(calls.n).toBe(1);
  });

  it("persists successful discovery to EXPLORER_CACHE and not PLAYERS", async () => {
    const cache = kvExplorerCache(env.EXPLORER_CACHE);
    const clerkUserId = `clerk_${crypto.randomUUID()}`;
    const sleeperUserId = `sleeper_${crypto.randomUUID()}`;
    const key = onboardingDiscoveryCacheKey(clerkUserId, sleeperUserId);

    await loadCachedOnboardingDiscovery(makeDeps({ cache, discover: async () => SUCCESS }), {
      clerkUserId,
      sleeperUserId,
    });

    expect(await env.EXPLORER_CACHE.get(key, "json")).toMatchObject({
      season: SUCCESS.season,
      leagues: SUCCESS.leagues,
    });
    expect(await env.PLAYERS.get(key)).toBeNull();
  });
});
