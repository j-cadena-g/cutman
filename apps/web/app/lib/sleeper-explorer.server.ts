import {
  isSleeperRateLimited,
  type NflState,
  type PlayerMap,
  type SleeperClient,
  type SleeperDraft,
  type SleeperDraftPick,
  type SleeperDraftPickRow,
  type SleeperBracketGame,
  type SleeperLeague,
  type SleeperLeagueUser,
  type SleeperMatchup,
  type SleeperRoster,
  type SleeperTransaction,
  type SleeperUser,
} from "@cutman/sleeper";
import {
  d1ExplorerOriginQuota,
  type ExplorerOriginQuota,
} from "./explorer-origin-quota.server.ts";
import {
  assembleExplorerBoard,
  assembleExplorerBracket,
  assembleExplorerDraft,
  assembleExplorerTradedPicks,
  clampExplorerWeek,
  isValidExplorerLeagueId,
  isValidExplorerUsername,
  leagueLastScoredWeek,
  maxExplorerWeek,
  normalizeExplorerUsername,
  toExplorerLeagueCard,
  toExplorerUserCard,
  type ExplorerBoardView,
  type ExplorerDraftView,
  type ExplorerLeagueCard,
  type ExplorerTradedPickView,
  type ExplorerBracketGameView,
  type ExplorerUserCard,
} from "./sleeper-explorer.ts";
import { getPlayerMap, sleeperFromEnv } from "./sleeper.server.ts";

export const NFL_STATE_TTL_MS = 15 * 60 * 1000;
export const USER_TTL_MS = 60 * 60 * 1000;
export const LEAGUES_TTL_MS = 15 * 60 * 1000;
export const BOARD_TTL_MS = 5 * 60 * 1000;
/** Finished drafts and completed leagues' picks and brackets no longer change. */
export const SETTLED_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
/** Per-Clerk-user Sleeper origin units per hour. A username lookup is 1–3 (extra previous-season charge when that cache is cold or stale); a cold league board is 5 (3 meta + 2 week). */
export const ORIGIN_QUOTA_PER_HOUR = 120;
/** League identity miss: getLeague, getLeagueUsers, getRosters. */
const META_MISS_ORIGIN_CHARGE = 3;
/** Week miss: getMatchups and getTransactions. */
const WEEK_MISS_ORIGIN_CHARGE = 2;
/** Drafts, picks, brackets, or previous-season leagues. */
const HISTORY_MISS_ORIGIN_CHARGE = 1;

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
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
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

function isCachedEnvelope<T>(value: unknown): value is Cached<T> {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.fetchedAt === "number" &&
    Number.isFinite(entry.fetchedAt) &&
    entry.payload !== undefined
  );
}

async function readCache<T>(
  deps: ExplorerDeps,
  key: string,
  ttlMs: number,
): Promise<CacheRead<T> | null> {
  const cached = await readJsonOrNull<unknown>(deps.cache, key);
  if (!isCachedEnvelope<T>(cached)) return null;
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
      previousSeason: string | null;
      previousLeagues: ExplorerLeagueCard[];
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

type MetaPayload = {
  league: SleeperLeague | null;
  users: SleeperLeagueUser[];
  rosters: SleeperRoster[];
};

type WeekPayload = {
  matchups: SleeperMatchup[];
  transactions: SleeperTransaction[];
};

async function explorerBoardFromPieces(
  deps: ExplorerDeps,
  meta: MetaPayload | null | undefined,
  weekPayload: WeekPayload | null | undefined,
  selectedWeek: number,
  currentWeek: number,
  nflSeason: string,
  stale: boolean,
): Promise<ExplorerBoardResult | null> {
  const league = meta?.league;
  if (!league) return null;
  const playersResult = await loadExplorerPlayers(deps);
  if (playersResult.kind !== "ok") return playersResult;
  return {
    kind: "ok",
    stale,
    board: assembleExplorerBoard({
      league,
      week: selectedWeek,
      currentWeek,
      selectedWeek,
      nflSeason,
      users: meta.users ?? [],
      rosters: meta.rosters ?? [],
      matchups: weekPayload?.matchups ?? [],
      transactions: weekPayload?.transactions ?? [],
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

function metaKey(leagueId: string): string {
  return `explore:meta:${leagueId}`;
}

function weekKey(leagueId: string, week: number): string {
  return `explore:week:${leagueId}:${week}`;
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
  previousSeason: string | null,
  previousLeagues: ExplorerLeagueCard[] = [],
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
      previousSeason,
      previousLeagues,
    };
  }
  return null;
}

async function loadPreviousSeasonLeagues(
  deps: ExplorerDeps,
  input: { userId: string; previousSeason: string | null; clerkUserId: string },
): Promise<{ leagues: SleeperLeague[]; stale: boolean }> {
  if (!input.previousSeason) return { leagues: [], stale: false };
  const cached = await readCache<SleeperLeague[]>(deps, leaguesKey(input.userId, input.previousSeason), LEAGUES_TTL_MS);
  if (cached?.fresh) return { leagues: cached.payload, stale: false };
  const allowed = await tryConsumeQuota(deps, input.clerkUserId, HISTORY_MISS_ORIGIN_CHARGE);
  if (!allowed) return { leagues: cached?.payload ?? [], stale: true };
  try {
    const leagues = await deps.sleeper.getUserLeagues(input.userId, input.previousSeason);
    await writeCache(deps, leaguesKey(input.userId, input.previousSeason), leagues, LEAGUES_TTL_MS);
    return { leagues, stale: false };
  } catch {
    return { leagues: cached?.payload ?? [], stale: true };
  }
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
  const previousSeason = state.previous_season ?? null;

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
    const previous = await loadPreviousSeasonLeagues(deps, {
      userId: user.user_id,
      previousSeason,
      clerkUserId: input.clerkUserId,
    });
    return {
      kind: "ok",
      stale: stateResult.stale || previous.stale,
      season,
      week,
      user: toExplorerUserCard(user),
      leagues: leagues.map(toExplorerLeagueCard),
      previousSeason,
      previousLeagues: previous.leagues.map(toExplorerLeagueCard),
    };
  }

  const { charge, expectLeaguesOrigin } = plannedUserOriginCharge(user, leagues, leaguesCached);
  const allowed = await tryConsumeQuota(deps, input.clerkUserId, charge);
  if (!allowed) {
    return staleUserResult(username, userCached, leaguesCached, season, week, previousSeason) ?? { kind: "quota_exceeded" };
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
          return staleUserResult(username, userCached, leaguesCached, season, week, previousSeason) ?? { kind: "quota_exceeded" };
        }
      }
      leagues = await deps.sleeper.getUserLeagues(user.user_id, season);
      await writeCache(deps, leaguesKey(user.user_id, season), leagues, LEAGUES_TTL_MS);
    }
    const previous = await loadPreviousSeasonLeagues(deps, {
      userId: user.user_id,
      previousSeason,
      clerkUserId: input.clerkUserId,
    });
    return {
      kind: "ok",
      stale: stateResult.stale || previous.stale,
      season,
      week,
      user: toExplorerUserCard(user),
      leagues: leagues.map(toExplorerLeagueCard),
      previousSeason,
      previousLeagues: previous.leagues.map(toExplorerLeagueCard),
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
          previousSeason,
          previousLeagues: [],
        };
      }
      if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
      return { kind: "unavailable" };
    }
    const stale = staleUserResult(username, userCached, leaguesCached, season, week, previousSeason);
    if (stale) return stale;
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}

export async function lookupExplorerBoard(
  deps: ExplorerDeps,
  input: { sleeperLeagueId: string; clerkUserId: string; week?: number | null },
): Promise<ExplorerBoardResult> {
  const leagueId = input.sleeperLeagueId.trim();
  if (!isValidExplorerLeagueId(leagueId)) return { kind: "not_found" };

  const stateResult = await readNflState(deps);
  if ("kind" in stateResult) return stateResult;
  const nflSeason = stateResult.state.league_season;
  const currentWeek = displayWeek(stateResult.state);
  const metaCached = await readCache<MetaPayload>(deps, metaKey(leagueId), BOARD_TTL_MS);

  if (metaCached?.fresh && !metaCached.payload?.league) return { kind: "not_found" };

  const selectedWeek = clampExplorerWeek(
    input.week,
    maxExplorerWeek({
      leagueSeason: metaCached?.payload?.league?.season,
      nflSeason,
      displayWeek: currentWeek,
      lastScoredWeek: leagueLastScoredWeek(metaCached?.payload?.league),
    }),
  );
  const weekCached = await readCache<WeekPayload>(deps, weekKey(leagueId, selectedWeek), BOARD_TTL_MS);

  const needMeta = !metaCached?.fresh;
  const needWeek = !weekCached?.fresh;

  if (!needMeta && !needWeek) {
    return (
      (await explorerBoardFromPieces(
        deps,
        metaCached.payload,
        weekCached.payload,
        selectedWeek,
        currentWeek,
        nflSeason,
        stateResult.stale,
      )) ?? { kind: "not_found" }
    );
  }

  const charge = (needMeta ? META_MISS_ORIGIN_CHARGE : 0) + (needWeek ? WEEK_MISS_ORIGIN_CHARGE : 0);
  const allowed = await tryConsumeQuota(deps, input.clerkUserId, charge);
  if (!allowed) {
    return (
      (await explorerBoardFromPieces(
        deps,
        metaCached?.payload,
        weekCached?.payload,
        selectedWeek,
        currentWeek,
        nflSeason,
        true,
      )) ?? {
        kind: "quota_exceeded",
      }
    );
  }

  let meta = metaCached?.payload;
  let weekPayload = weekCached?.payload;
  let week = selectedWeek;
  let payloadWeek = selectedWeek;

  try {
    if (needMeta) {
      const league = await deps.sleeper.getLeague(leagueId);
      if (!league) {
        await writeCache(deps, metaKey(leagueId), { league: null, users: [], rosters: [] } satisfies MetaPayload, BOARD_TTL_MS);
        return { kind: "not_found" };
      }
      const [users, rosters] = await Promise.all([
        deps.sleeper.getLeagueUsers(leagueId),
        deps.sleeper.getRosters(leagueId),
      ]);
      meta = { league, users, rosters };
      await writeCache(deps, metaKey(leagueId), meta, BOARD_TTL_MS);
    }

    if (!meta?.league) return { kind: "not_found" };
    const league = meta.league;

    week = clampExplorerWeek(
      input.week,
      maxExplorerWeek({
        leagueSeason: league.season,
        nflSeason,
        displayWeek: currentWeek,
        lastScoredWeek: leagueLastScoredWeek(league),
      }),
    );
    const weekRead =
      week === selectedWeek ? weekCached : await readCache<WeekPayload>(deps, weekKey(leagueId, week), BOARD_TTL_MS);
    if (weekRead?.fresh) {
      weekPayload = weekRead.payload;
      payloadWeek = week;
    } else {
      if (week !== selectedWeek && !needWeek) {
        const extraAllowed = await tryConsumeQuota(deps, input.clerkUserId, WEEK_MISS_ORIGIN_CHARGE);
        if (!extraAllowed) {
          return (
            (await explorerBoardFromPieces(
              deps,
              meta,
              weekPayload,
              selectedWeek,
              currentWeek,
              nflSeason,
              true,
            )) ?? { kind: "quota_exceeded" }
          );
        }
      }
      const [matchups, transactions] = await Promise.all([
        deps.sleeper.getMatchups(leagueId, week),
        deps.sleeper.getTransactions(leagueId, week),
      ]);
      weekPayload = { matchups, transactions };
      payloadWeek = week;
      await writeCache(deps, weekKey(leagueId, week), weekPayload, BOARD_TTL_MS);
    }
    const playersResult = await loadExplorerPlayers(deps);
    if (playersResult.kind !== "ok") return playersResult;
    return {
      kind: "ok",
      stale: stateResult.stale,
      board: assembleExplorerBoard({
        league,
        week,
        currentWeek,
        selectedWeek: week,
        nflSeason,
        users: meta.users ?? [],
        rosters: meta.rosters ?? [],
        matchups: weekPayload?.matchups ?? [],
        transactions: weekPayload?.transactions ?? [],
        players: playersResult.players,
      }),
    };
  } catch (error) {
    const fallback = await explorerBoardFromPieces(deps, meta, weekPayload, payloadWeek, currentWeek, nflSeason, true);
    if (fallback) return fallback;
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}

function draftsKey(leagueId: string): string {
  return `explore:drafts:${leagueId}`;
}

function draftPicksKey(draftId: string): string {
  return `explore:draft-picks:${draftId}`;
}

function tradedPicksKey(leagueId: string): string {
  return `explore:traded-picks:${leagueId}`;
}

function winnersBracketKey(leagueId: string): string {
  return `explore:winners-bracket:${leagueId}`;
}

function losersBracketKey(leagueId: string): string {
  return `explore:losers-bracket:${leagueId}`;
}

type ExplorerHistoryError = { kind: "not_found" | "rate_limited" | "quota_exceeded" | "unavailable" };

async function ensureExplorerMeta(
  deps: ExplorerDeps,
  input: { leagueId: string; clerkUserId: string },
): Promise<{ kind: "ok"; meta: MetaPayload; stale: boolean } | ExplorerHistoryError> {
  const cached = await readCache<MetaPayload>(deps, metaKey(input.leagueId), BOARD_TTL_MS);
  const meta = cached?.payload;
  if (cached?.fresh) {
    if (!meta?.league) return { kind: "not_found" };
    return { kind: "ok", meta, stale: false };
  }
  const allowed = await tryConsumeQuota(deps, input.clerkUserId, META_MISS_ORIGIN_CHARGE);
  if (!allowed) {
    if (meta?.league) return { kind: "ok", meta, stale: true };
    return { kind: "quota_exceeded" };
  }
  try {
    const league = await deps.sleeper.getLeague(input.leagueId);
    if (!league) {
      await writeCache(deps, metaKey(input.leagueId), { league: null, users: [], rosters: [] }, BOARD_TTL_MS);
      return { kind: "not_found" };
    }
    const [users, rosters] = await Promise.all([
      deps.sleeper.getLeagueUsers(input.leagueId),
      deps.sleeper.getRosters(input.leagueId),
    ]);
    const next = { league, users, rosters };
    await writeCache(deps, metaKey(input.leagueId), next, BOARD_TTL_MS);
    return { kind: "ok", meta: next, stale: false };
  } catch (error) {
    if (meta?.league) return { kind: "ok", meta, stale: true };
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}

async function readOrFetchHistory<T>(
  deps: ExplorerDeps,
  input: { clerkUserId: string; key: string; settled: boolean; load: () => Promise<T> },
): Promise<{ kind: "ok"; payload: T; stale: boolean } | ExplorerHistoryError> {
  const ttlMs = input.settled ? SETTLED_HISTORY_TTL_MS : BOARD_TTL_MS;
  const cached = await readCache<T>(deps, input.key, ttlMs);
  if (cached?.fresh) return { kind: "ok", payload: cached.payload, stale: false };
  const allowed = await tryConsumeQuota(deps, input.clerkUserId, HISTORY_MISS_ORIGIN_CHARGE);
  if (!allowed) {
    if (cached) return { kind: "ok", payload: cached.payload, stale: true };
    return { kind: "quota_exceeded" };
  }
  try {
    const payload = await input.load();
    await writeCache(deps, input.key, payload, ttlMs);
    return { kind: "ok", payload, stale: false };
  } catch (error) {
    if (cached) return { kind: "ok", payload: cached.payload, stale: true };
    if (isSleeperRateLimited(error)) return { kind: "rate_limited" };
    return { kind: "unavailable" };
  }
}

export type ExplorerDraftsResult =
  | {
      kind: "ok";
      stale: boolean;
      league: ExplorerLeagueCard;
      drafts: ExplorerDraftView[];
      tradedPicks: ExplorerTradedPickView[];
    }
  | ExplorerHistoryError;

export async function lookupExplorerDrafts(
  deps: ExplorerDeps,
  input: { sleeperLeagueId: string; clerkUserId: string },
): Promise<ExplorerDraftsResult> {
  const leagueId = input.sleeperLeagueId.trim();
  if (!isValidExplorerLeagueId(leagueId)) return { kind: "not_found" };
  const metaResult = await ensureExplorerMeta(deps, { leagueId, clerkUserId: input.clerkUserId });
  if (metaResult.kind !== "ok") return metaResult;
  const league = metaResult.meta.league;
  if (!league) return { kind: "not_found" };
  const leagueComplete = league.status === "complete";

  const draftsResult = await readOrFetchHistory<SleeperDraft[]>(deps, {
    clerkUserId: input.clerkUserId,
    key: draftsKey(leagueId),
    settled: leagueComplete,
    load: () => deps.sleeper.getLeagueDrafts(leagueId),
  });
  if (draftsResult.kind !== "ok") return draftsResult;

  const picksByDraftId = new Map<string, SleeperDraftPickRow[]>();
  let picksStale = false;
  const pickResults = await Promise.all(
    draftsResult.payload.map(async (draft) => {
      const picksResult = await readOrFetchHistory<SleeperDraftPickRow[]>(deps, {
        clerkUserId: input.clerkUserId,
        key: draftPicksKey(draft.draft_id),
        settled: draft.status === "complete",
        load: () => deps.sleeper.getDraftPicks(draft.draft_id),
      });
      return { draftId: draft.draft_id, picksResult };
    }),
  );
  for (const { draftId, picksResult } of pickResults) {
    if (picksResult.kind !== "ok") {
      picksByDraftId.set(draftId, []);
      picksStale = true;
      continue;
    }
    picksByDraftId.set(draftId, picksResult.payload);
    picksStale = picksStale || picksResult.stale;
  }

  // Like a failed pick list, missing traded picks leave that list empty instead of failing the page.
  const tradedResult = await readOrFetchHistory<SleeperDraftPick[]>(deps, {
    clerkUserId: input.clerkUserId,
    key: tradedPicksKey(leagueId),
    settled: leagueComplete,
    load: () => deps.sleeper.getTradedPicks(leagueId),
  });
  const tradedPicks = tradedResult.kind === "ok" ? tradedResult.payload : [];
  const tradedStale = tradedResult.kind !== "ok" || tradedResult.stale;

  const playersResult = await loadExplorerPlayers(deps);
  if (playersResult.kind !== "ok") return playersResult;

  return {
    kind: "ok",
    stale: metaResult.stale || draftsResult.stale || picksStale || tradedStale,
    league: toExplorerLeagueCard(league),
    drafts: draftsResult.payload.map((draft) =>
      assembleExplorerDraft(
        draft,
        picksByDraftId.get(draft.draft_id) ?? [],
        metaResult.meta.rosters,
        metaResult.meta.users,
        playersResult.players,
      ),
    ),
    tradedPicks: assembleExplorerTradedPicks(tradedPicks, metaResult.meta.rosters, metaResult.meta.users),
  };
}

export type ExplorerBracketsResult =
  | {
      kind: "ok";
      stale: boolean;
      league: ExplorerLeagueCard;
      winners: ExplorerBracketGameView[];
      losers: ExplorerBracketGameView[];
    }
  | ExplorerHistoryError;

export async function lookupExplorerBrackets(
  deps: ExplorerDeps,
  input: { sleeperLeagueId: string; clerkUserId: string },
): Promise<ExplorerBracketsResult> {
  const leagueId = input.sleeperLeagueId.trim();
  if (!isValidExplorerLeagueId(leagueId)) return { kind: "not_found" };
  const metaResult = await ensureExplorerMeta(deps, { leagueId, clerkUserId: input.clerkUserId });
  if (metaResult.kind !== "ok") return metaResult;
  const league = metaResult.meta.league;
  if (!league) return { kind: "not_found" };

  const leagueComplete = league.status === "complete";

  const winnersResult = await readOrFetchHistory<SleeperBracketGame[]>(deps, {
    clerkUserId: input.clerkUserId,
    key: winnersBracketKey(leagueId),
    settled: leagueComplete,
    load: () => deps.sleeper.getWinnersBracket(leagueId),
  });
  if (winnersResult.kind !== "ok") return winnersResult;
  const losersResult = await readOrFetchHistory<SleeperBracketGame[]>(deps, {
    clerkUserId: input.clerkUserId,
    key: losersBracketKey(leagueId),
    settled: leagueComplete,
    load: () => deps.sleeper.getLosersBracket(leagueId),
  });
  if (losersResult.kind !== "ok") return losersResult;

  return {
    kind: "ok",
    stale: metaResult.stale || winnersResult.stale || losersResult.stale,
    league: toExplorerLeagueCard(league),
    winners: assembleExplorerBracket(winnersResult.payload, metaResult.meta.rosters, metaResult.meta.users),
    losers: assembleExplorerBracket(losersResult.payload, metaResult.meta.rosters, metaResult.meta.users),
  };
}
