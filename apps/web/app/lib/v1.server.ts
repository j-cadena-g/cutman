import { V1_LEAGUE_ID as DEFAULT_V1_LEAGUE_ID, V1_LEAGUE_NAME, ensureLeague, getLeague } from "@cutman/db";
import { toneOrPlayful } from "@cutman/story";

export { V1_LEAGUE_NAME };

export function v1LeagueId(env: Env): string {
  const id = env.V1_LEAGUE_ID?.trim();
  return id || DEFAULT_V1_LEAGUE_ID;
}

export async function ensureV1League(env: Env, now = Date.now()): Promise<void> {
  const leagueId = v1LeagueId(env);
  const existing = await getLeague(env.DB, leagueId);
  const league = existing ?? (await ensureLeague(env.DB, {
    leagueId,
    name: V1_LEAGUE_NAME,
    season: "2026",
    tone: "playful",
    now,
  }));
  const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(leagueId));
  await stub.bootstrap({
    leagueId,
    name: league.name || V1_LEAGUE_NAME,
    tone: toneOrPlayful(league.tone),
  });
}
