import {
  V1_LEAGUE_ID as DEFAULT_V1_LEAGUE_ID,
  V1_LEAGUE_NAME as DEFAULT_V1_LEAGUE_NAME,
  ensureLeague,
  ensureOperatorSeed,
  getLeague,
} from "@cutman/db";
import { toneOrPlayful } from "@cutman/story";

export function v1LeagueId(env: Env): string {
  const id = env.V1_LEAGUE_ID?.trim();
  return id || DEFAULT_V1_LEAGUE_ID;
}

export function v1LeagueName(env: Env): string {
  const name = env.V1_LEAGUE_NAME?.trim();
  return name || DEFAULT_V1_LEAGUE_NAME;
}

export async function ensureV1Seed(env: Env, now = Date.now()): Promise<void> {
  await ensureOperatorSeed(env.DB, {
    leagueId: v1LeagueId(env),
    leagueName: v1LeagueName(env),
    sleeperUserId: env.V1_SLEEPER_USER_ID,
    sleeperUsername: env.V1_SLEEPER_USERNAME,
    now,
  });
}

export async function ensureV1League(env: Env, now = Date.now()): Promise<void> {
  await ensureV1Seed(env, now);
  const leagueId = v1LeagueId(env);
  const existing = await getLeague(env.DB, leagueId);
  const league = existing ?? (await ensureLeague(env.DB, {
    leagueId,
    name: v1LeagueName(env),
    season: "2026",
    tone: "playful",
    now,
  }));
  const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(leagueId));
  await stub.bootstrap({
    leagueId,
    name: league.name || v1LeagueName(env),
    tone: toneOrPlayful(league.tone),
  });
}
