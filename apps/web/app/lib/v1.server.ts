import {
  V1_LEAGUE_ID as DEFAULT_V1_LEAGUE_ID,
  V1_LEAGUE_NAME as DEFAULT_V1_LEAGUE_NAME,
  activateLeague,
  createLeague,
  getLeagueBySleeperId,
  type LeagueRow,
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

// v1 has no commissioner-driven provisioning flow yet, so the configured league is created and
// activated immediately. Later onboarding tasks own the real provisioning/verification lifecycle.
async function ensureV1LeagueRow(env: Env, now: number): Promise<LeagueRow> {
  const sleeperLeagueId = v1LeagueId(env);
  const existing = await getLeagueBySleeperId(env.DB, sleeperLeagueId);
  if (existing?.status === "active") return existing;
  const league =
    existing ??
    (await createLeague(env.DB, {
      id: sleeperLeagueId,
      sleeperLeagueId,
      name: v1LeagueName(env),
      season: "2026",
      tone: "playful",
      now,
    }));
  return activateLeague(env.DB, league.id, now);
}

export async function ensureV1League(env: Env, now = Date.now()): Promise<void> {
  const league = await ensureV1LeagueRow(env, now);
  const leagueId = v1LeagueId(env);
  const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(leagueId));
  await stub.bootstrap({
    leagueId,
    name: league.name || v1LeagueName(env),
    tone: toneOrPlayful(league.tone),
  });
}
