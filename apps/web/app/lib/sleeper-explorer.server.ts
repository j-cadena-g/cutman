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
import { getPlayerMap, sleeperFromEnv } from "../../workers/sleeper.ts";

export const NFL_STATE_TTL_MS = 15 * 60 * 1000;
export const USER_TTL_MS = 60 * 60 * 1000;
export const LEAGUES_TTL_MS = 15 * 60 * 1000;
export const BOARD_TTL_MS = 5 * 60 * 1000;
export const ORIGIN_QUOTA_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

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
    cache: kvExplorerCache(env.PLAYERS),
    getPlayers: () => getPlayerMap(env, sleeper),
    now: () => Date.now(),
  };
}

type CacheRead<T> = {
  payload: T;
  fetchedAt: number;
  fresh: boolean;
};

async function readCache<T>(
  deps: ExplorerDeps,
  key: string,
  ttlMs: number,
): Promise<CacheRead<T> | null> {
  const cached = await deps.cache.getJson<Cached<T>>(key);
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

function quotaKey(clerkUserId: string, now: number): string {
  return `explore:quota:${clerkUserId}:${Math.floor(now / HOUR_MS)}`;
}

// Advisory only: KV get-then-put is eventually consistent, so concurrent requests can exceed the hour budget. Strict enforcement needs an atomic serialized counter before public rollout.
async function tryConsumeQuota(deps: ExplorerDeps, clerkUserId: string): Promise<boolean> {
  const key = quotaKey(clerkUserId, deps.now());
  const entry = await deps.cache.getJson<{ count: number }>(key);
  const count = entry?.count ?? 0;
  const limit = deps.quotaPerHour ?? ORIGIN_QUOTA_PER_HOUR;
  if (count >= limit) return false;
  await deps.cache.putJson(key, { count: count + 1 }, { expirationTtl: 2 * 60 * 60 });
  return true;
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
  if (userCached && userCached.payload === null) return { kind: "not_found", username };
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
  const leaguesCached = cachedUserId
    ? await readCache<SleeperLeague[]>(deps, leaguesKey(cachedUserId, season), LEAGUES_TTL_MS)
    : null;
  if (leaguesCached?.fresh) leagues = leaguesCached.payload;

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

  const allowed = await tryConsumeQuota(deps, input.clerkUserId);
  if (!allowed) {
    return staleUserResult(username, userCached, leaguesCached, season, week) ?? { kind: "quota_exceeded" };
  }

  try {
    if (user === undefined) {
      user = await deps.sleeper.getUser(username);
      await writeCache(deps, userKey(username), user, USER_TTL_MS);
    }
    if (!user) return { kind: "not_found", username };
    if (leagues === undefined) {
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
    if (!cached.payload.league) return { kind: "not_found" };
    const playersResult = await loadExplorerPlayers(deps);
    if (playersResult.kind !== "ok") return playersResult;
    return {
      kind: "ok",
      stale: stateResult.stale,
      board: assembleExplorerBoard({
        ...cached.payload,
        league: cached.payload.league,
        week,
        players: playersResult.players,
      }),
    };
  }

  const allowed = await tryConsumeQuota(deps, input.clerkUserId);
  if (!allowed) {
    if (cached?.payload.league) {
      const playersResult = await loadExplorerPlayers(deps);
      if (playersResult.kind !== "ok") return playersResult;
      return {
        kind: "ok",
        stale: true,
        board: assembleExplorerBoard({
          ...cached.payload,
          league: cached.payload.league,
          week,
          players: playersResult.players,
        }),
      };
    }
    return { kind: "quota_exceeded" };
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
    if (playersResult.kind !== "ok") return playersResult;
    const payload: BoardPayload = { league, users, rosters, matchups };
    await writeCache(deps, boardKey(leagueId, week), payload, BOARD_TTL_MS);
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
    if (cached?.payload.league) {
      const playersResult = await loadExplorerPlayers(deps);
      if (playersResult.kind !== "ok") return playersResult;
      return {
        kind: "ok",
        stale: true,
        board: assembleExplorerBoard({
          ...cached.payload,
          league: cached.payload.league,
          week,
          players: playersResult.players,
        }),
      };
    }
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}
