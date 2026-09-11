import {
  isSleeperRateLimited,
  type NflState,
  type PlayerMap,
  type SleeperClient,
  type SleeperLeague,
  type SleeperLeagueUser,
  type SleeperMatchup,
  type SleeperRoster,
  type SleeperUser,
} from "@cutman/sleeper";
import {
  d1ExplorerOriginQuota,
  type ExplorerOriginQuota,
} from "./explorer-origin-quota.server.ts";
import {
  assembleExplorerBoard,
  isValidExplorerLeagueId,
  isValidExplorerUsername,
  normalizeExplorerUsername,
  toExplorerLeagueCard,
  toExplorerUserCard,
  type ExplorerBoardView,
  type ExplorerLeagueCard,
  type ExplorerUserCard,
} from "./sleeper-explorer.ts";
import { getPlayerMap, sleeperFromEnv } from "./sleeper.server.ts";

export const NFL_STATE_TTL_MS = 15 * 60 * 1000;
export const USER_TTL_MS = 60 * 60 * 1000;
export const LEAGUES_TTL_MS = 15 * 60 * 1000;
export const BOARD_TTL_MS = 5 * 60 * 1000;
export const ORIGIN_QUOTA_PER_HOUR = 30;
/** Board miss: getLeague, getLeagueUsers, getRosters, getMatchups, and getPlayers. */
const BOARD_MISS_ORIGIN_CHARGE = 5;

type Cached<T> = {
  fetchedAt: number;
  payload: T;
};

export type ExplorerCache = {
  getJson<T>(key: string): Promise<T | null>;
  putJson(key: string, value: unknown, options?: { expirationTtl?: number }): Promise<void>;
};

export type ExplorerDeps = {
  sleeper: SleeperClient;
  cache: ExplorerCache;
  getPlayers: () => Promise<PlayerMap>;
  now: () => number;
  quotaPerHour?: number;
  originQuota: ExplorerOriginQuota;
};

export function createMemoryExplorerCache(store = new Map<string, string>()): ExplorerCache {
  return {
    async getJson<T>(key: string): Promise<T | null> {
      const raw = store.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    },
    async putJson(key: string, value: unknown, _options?: { expirationTtl?: number }): Promise<void> {
      store.set(key, JSON.stringify(value));
    },
  };
}

export function kvExplorerCache(kv: KVNamespace): ExplorerCache {
  return {
    async getJson<T>(key: string): Promise<T | null> {
      return kv.get<T>(key, "json");
    },
    async putJson(key: string, value: unknown, options?: { expirationTtl?: number }): Promise<void> {
      await kv.put(key, JSON.stringify(value), options?.expirationTtl ? { expirationTtl: options.expirationTtl } : undefined);
    },
  };
}

export function explorerDepsFromEnv(env: Env): ExplorerDeps {
  const sleeper = sleeperFromEnv(env);
  return {
    sleeper,
    cache: kvExplorerCache(env.EXPLORER_CACHE),
    getPlayers: () => getPlayerMap(env, sleeper),
    now: () => Date.now(),
    originQuota: d1ExplorerOriginQuota(env.DB),
  };
}

type CacheRead<T> = {
  payload: T;
  fetchedAt: number;
  fresh: boolean;
};

async function readJsonOrNull<T>(cache: ExplorerCache, key: string): Promise<T | null> {
  try {
    return (await cache.getJson<T>(key)) ?? null;
  } catch {
    return null;
  }
}

async function readCache<T>(
  deps: ExplorerDeps,
  key: string,
  ttlMs: number,
): Promise<CacheRead<T> | null> {
  const cached = await readJsonOrNull<Cached<T>>(deps.cache, key);
  if (!cached) return null;
  return {
    payload: cached.payload,
    fetchedAt: cached.fetchedAt,
    fresh: deps.now() - cached.fetchedAt < ttlMs,
  };
}

async function writeCache<T>(deps: ExplorerDeps, key: string, payload: T, ttlMs: number): Promise<void> {
  await deps.cache.putJson(
    key,
    { fetchedAt: deps.now(), payload } satisfies Cached<T>,
    { expirationTtl: Math.max(60, Math.ceil((ttlMs * 4) / 1000)) },
  );
}

async function tryConsumeQuota(deps: ExplorerDeps, clerkUserId: string, charge: number): Promise<boolean> {
  return deps.originQuota.tryConsume({
    clerkUserId,
    charge,
    now: deps.now(),
    limit: deps.quotaPerHour ?? ORIGIN_QUOTA_PER_HOUR,
  });
}

function plannedUserOriginCharge(
  user: SleeperUser | null | undefined,
  leagues: SleeperLeague[] | undefined,
  leaguesCached: CacheRead<SleeperLeague[]> | null,
): { charge: number; expectLeaguesOrigin: boolean } {
  const needUserOrigin = user === undefined;
  const expectLeaguesOrigin = leagues === undefined && !(needUserOrigin && Boolean(leaguesCached?.fresh));
  return {
    charge: (needUserOrigin ? 1 : 0) + (expectLeaguesOrigin ? 1 : 0),
    expectLeaguesOrigin,
  };
}

export type ExplorerUserLeaguesDecisionInput = {
  user: Pick<SleeperUser, "user_id">;
  cachedUserId: string | undefined;
  leagues: SleeperLeague[] | undefined;
  leaguesCached: CacheRead<SleeperLeague[]> | null;
  leaguesCachedUserId: string | undefined;
  /** Leagues cache already loaded for `user.user_id` when ownership must switch. */
  resolvedUserLeaguesCached: CacheRead<SleeperLeague[]> | null;
  expectLeaguesOrigin: boolean;
};

export type ExplorerUserLeaguesDecision = {
  leagues: SleeperLeague[] | undefined;
  leaguesCached: CacheRead<SleeperLeague[]> | null;
  leaguesCachedUserId: string;
  needsExtraQuota: boolean;
  denyStaleFallback: boolean;
};

/**
 * After the live Sleeper user is known, decide which leagues cache this lookup owns
 * and whether a second origin charge is required before fetching leagues.
 */
export function resolveExplorerUserLeagues(
  input: ExplorerUserLeaguesDecisionInput,
): ExplorerUserLeaguesDecision {
  const denyStaleFallback = Boolean(input.cachedUserId && input.user.user_id !== input.cachedUserId);
  let leagues = input.leagues;
  let leaguesCached = input.leaguesCached;

  if (input.leaguesCachedUserId !== input.user.user_id) {
    leagues = undefined;
    leaguesCached = input.resolvedUserLeaguesCached;
    if (leaguesCached?.fresh) leagues = leaguesCached.payload;
  } else if (leagues === undefined && leaguesCached?.fresh) {
    leagues = leaguesCached.payload;
  }

  return {
    leagues,
    leaguesCached,
    leaguesCachedUserId: input.user.user_id,
    needsExtraQuota: leagues === undefined && !input.expectLeaguesOrigin,
    denyStaleFallback,
  };
}

export type ExplorerUserResult =
  | {
      kind: "ok";
      stale: boolean;
      season: string;
      week: number;
      user: ExplorerUserCard;
      leagues: ExplorerLeagueCard[];
    }
  | { kind: "invalid_username" }
  | { kind: "not_found"; username: string }
  | { kind: "rate_limited" }
  | { kind: "quota_exceeded" }
  | { kind: "unavailable" };

export type ExplorerBoardResult =
  | { kind: "ok"; stale: boolean; board: ExplorerBoardView }
  | { kind: "not_found" }
  | { kind: "rate_limited" }
  | { kind: "quota_exceeded" }
  | { kind: "unavailable" };

type ExplorerPlayerMapResult =
  | { kind: "ok"; players: PlayerMap }
  | { kind: "rate_limited" }
  | { kind: "unavailable" };

async function loadExplorerPlayers(deps: ExplorerDeps): Promise<ExplorerPlayerMapResult> {
  try {
    return { kind: "ok", players: await deps.getPlayers() };
  } catch (error) {
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}

type BoardPayload = {
  league: SleeperLeague | null;
  users: SleeperLeagueUser[];
  rosters: SleeperRoster[];
  matchups: SleeperMatchup[];
};

async function explorerBoardFromCache(
  deps: ExplorerDeps,
  cached: CacheRead<BoardPayload> | null,
  week: number,
  stale: boolean,
): Promise<ExplorerBoardResult | null> {
  const payload = cached?.payload;
  const league = payload?.league;
  if (!league) return null;
  const playersResult = await loadExplorerPlayers(deps);
  if (playersResult.kind !== "ok") return playersResult;
  return {
    kind: "ok",
    stale,
    board: assembleExplorerBoard({
      league,
      week,
      users: payload.users ?? [],
      rosters: payload.rosters ?? [],
      matchups: payload.matchups ?? [],
      players: playersResult.players,
    }),
  };
}

function nflStateKey(): string {
  return "explore:nfl-state";
}

function userKey(username: string): string {
  return `explore:user:${username}`;
}

function leaguesKey(userId: string, season: string): string {
  return `explore:leagues:${userId}:${season}`;
}

function boardKey(leagueId: string, week: number): string {
  return `explore:board:${leagueId}:${week}`;
}

async function readNflState(deps: ExplorerDeps): Promise<{ state: NflState; stale: boolean } | { kind: "rate_limited" | "unavailable" }> {
  const cached = await readCache<NflState>(deps, nflStateKey(), NFL_STATE_TTL_MS);
  if (cached?.fresh) return { state: cached.payload, stale: false };
  try {
    const state = await deps.sleeper.getNflState();
    await writeCache(deps, nflStateKey(), state, NFL_STATE_TTL_MS);
    return { state, stale: false };
  } catch (error) {
    if (isSleeperRateLimited(error) && cached) return { state: cached.payload, stale: true };
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    if (cached) return { state: cached.payload, stale: true };
    return { kind: "unavailable" };
  }
}

function displayWeek(state: NflState): number {
  return state.display_week ?? state.week;
}

function staleUserResult(
  username: string,
  userCached: CacheRead<SleeperUser | null> | null,
  leaguesCached: CacheRead<SleeperLeague[]> | null,
  season: string,
  week: number,
): ExplorerUserResult | null {
  if (userCached?.fresh && userCached.payload === null) return { kind: "not_found", username };
  if (userCached?.payload && leaguesCached) {
    return {
      kind: "ok",
      stale: true,
      season,
      week,
      user: toExplorerUserCard(userCached.payload),
      leagues: leaguesCached.payload.map(toExplorerLeagueCard),
    };
  }
  return null;
}

export async function lookupExplorerUser(
  deps: ExplorerDeps,
  input: { username: string; clerkUserId: string },
): Promise<ExplorerUserResult> {
  const username = normalizeExplorerUsername(input.username);
  if (!isValidExplorerUsername(username)) return { kind: "invalid_username" };

  const stateResult = await readNflState(deps);
  if ("kind" in stateResult) return stateResult;
  const { state } = stateResult;
  const season = state.league_season;
  const week = displayWeek(state);

  const userCached = await readCache<SleeperUser | null>(deps, userKey(username), USER_TTL_MS);
  if (userCached?.fresh && userCached.payload === null) return { kind: "not_found", username };

  let user: SleeperUser | null | undefined = userCached?.fresh ? userCached.payload : undefined;
  let leagues: SleeperLeague[] | undefined;
  const cachedUserId = user?.user_id ?? userCached?.payload?.user_id;
  let leaguesCachedUserId = cachedUserId;
  let leaguesCached = cachedUserId
    ? await readCache<SleeperLeague[]>(deps, leaguesKey(cachedUserId, season), LEAGUES_TTL_MS)
    : null;
  // Fresh leagues belong to the user-id key they were stored under. Only reuse them
  // when that key already matches the *current* user (fresh username cache). A stale
  // username may now resolve to a different Sleeper id.
  if (user && leaguesCached?.fresh && user.user_id === leaguesCachedUserId) {
    leagues = leaguesCached.payload;
  }

  if (user && leagues) {
    return {
      kind: "ok",
      stale: stateResult.stale,
      season,
      week,
      user: toExplorerUserCard(user),
      leagues: leagues.map(toExplorerLeagueCard),
    };
  }

  const { charge, expectLeaguesOrigin } = plannedUserOriginCharge(user, leagues, leaguesCached);
  const allowed = await tryConsumeQuota(deps, input.clerkUserId, charge);
  if (!allowed) {
    return staleUserResult(username, userCached, leaguesCached, season, week) ?? { kind: "quota_exceeded" };
  }

  try {
    if (user === undefined) {
      user = await deps.sleeper.getUser(username);
      await writeCache(deps, userKey(username), user, USER_TTL_MS);
    }
    if (!user) return { kind: "not_found", username };

    // Username remapped: leave the previous id's leagues cache intact and load the
    // cache for the resolved id only. A first-time user id is the same ownership switch.
    const resolvedUserLeaguesCached =
      leaguesCachedUserId === user.user_id
        ? leaguesCached
        : await readCache<SleeperLeague[]>(deps, leaguesKey(user.user_id, season), LEAGUES_TTL_MS);
    const resolved = resolveExplorerUserLeagues({
      user,
      cachedUserId,
      leagues,
      leaguesCached,
      leaguesCachedUserId,
      resolvedUserLeaguesCached,
      expectLeaguesOrigin,
    });
    leagues = resolved.leagues;
    leaguesCached = resolved.leaguesCached;
    leaguesCachedUserId = resolved.leaguesCachedUserId;

    if (leagues === undefined) {
      if (resolved.needsExtraQuota) {
        const extraAllowed = await tryConsumeQuota(deps, input.clerkUserId, 1);
        if (!extraAllowed) {
          if (resolved.denyStaleFallback) return { kind: "quota_exceeded" };
          return staleUserResult(username, userCached, leaguesCached, season, week) ?? { kind: "quota_exceeded" };
        }
      }
      leagues = await deps.sleeper.getUserLeagues(user.user_id, season);
      await writeCache(deps, leaguesKey(user.user_id, season), leagues, LEAGUES_TTL_MS);
    }
    return {
      kind: "ok",
      stale: stateResult.stale,
      season,
      week,
      user: toExplorerUserCard(user),
      leagues: leagues.map(toExplorerLeagueCard),
    };
  } catch (error) {
    if (user && cachedUserId && user.user_id !== cachedUserId) {
      if (leaguesCached && leaguesCachedUserId === user.user_id) {
        return {
          kind: "ok",
          stale: true,
          season,
          week,
          user: toExplorerUserCard(user),
          leagues: leaguesCached.payload.map(toExplorerLeagueCard),
        };
      }
      if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
      return { kind: "unavailable" };
    }
    const stale = staleUserResult(username, userCached, leaguesCached, season, week);
    if (stale) return stale;
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}

export async function lookupExplorerBoard(
  deps: ExplorerDeps,
  input: { sleeperLeagueId: string; clerkUserId: string },
): Promise<ExplorerBoardResult> {
  const leagueId = input.sleeperLeagueId.trim();
  if (!isValidExplorerLeagueId(leagueId)) return { kind: "not_found" };

  const stateResult = await readNflState(deps);
  if ("kind" in stateResult) return stateResult;
  const week = displayWeek(stateResult.state);
  const cached = await readCache<BoardPayload>(deps, boardKey(leagueId, week), BOARD_TTL_MS);

  if (cached?.fresh) {
    return (await explorerBoardFromCache(deps, cached, week, stateResult.stale)) ?? { kind: "not_found" };
  }

  const allowed = await tryConsumeQuota(deps, input.clerkUserId, BOARD_MISS_ORIGIN_CHARGE);
  if (!allowed) {
    return (await explorerBoardFromCache(deps, cached, week, true)) ?? { kind: "quota_exceeded" };
  }

  try {
    const league = await deps.sleeper.getLeague(leagueId);
    if (!league) {
      await writeCache(
        deps,
        boardKey(leagueId, week),
        {
          league: null,
          users: [],
          rosters: [],
          matchups: [],
        } satisfies BoardPayload,
        BOARD_TTL_MS,
      );
      return { kind: "not_found" };
    }
    const [users, rosters, matchups, playersResult] = await Promise.all([
      deps.sleeper.getLeagueUsers(leagueId),
      deps.sleeper.getRosters(leagueId),
      deps.sleeper.getMatchups(leagueId, week),
      loadExplorerPlayers(deps),
    ]);
    const payload: BoardPayload = { league, users, rosters, matchups };
    await writeCache(deps, boardKey(leagueId, week), payload, BOARD_TTL_MS);
    if (playersResult.kind !== "ok") return playersResult;
    return {
      kind: "ok",
      stale: stateResult.stale,
      board: assembleExplorerBoard({
        league,
        week,
        users,
        rosters,
        matchups,
        players: playersResult.players,
      }),
    };
  } catch (error) {
    const fallback = await explorerBoardFromCache(deps, cached, week, true);
    if (fallback) return fallback;
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}
