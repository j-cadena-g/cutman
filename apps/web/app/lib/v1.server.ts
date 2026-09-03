import {
  V1_LEAGUE_ID as DEFAULT_V1_LEAGUE_ID,
  V1_LEAGUE_NAME as DEFAULT_V1_LEAGUE_NAME,
  activateLeague,
  createLeague,
  getLeagueBySleeperId,
  provisionLeague,
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
// `activateLeague` is only legal from "provisioning", so a league left in "error" from a prior
// attempt is explicitly re-provisioned first.
//
// Two concurrent first loads (no league row yet) can race: `createLeague` idempotently resolves
// to the same row either way (see its own concurrent-insert handling), but only one of the two
// `activateLeague` calls can win the "provisioning" -> "active" compare-and-swap — the other
// throws, because `activateLeague`'s lifecycle rule is intentionally strict and is not weakened
// here. Instead of letting that reject bubble up as a 500, we re-check the row: if another
// caller already won and it is now "active", that satisfies this caller's contract too, so we
// return the current row instead of the stale error.
export async function ensureV1LeagueRow(env: Env, now: number): Promise<LeagueRow> {
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
  const provisioning = league.status === "error" ? await provisionLeague(env.DB, league.id) : league;
  try {
    return await activateLeague(env.DB, provisioning.id, now);
  } catch (error) {
    const current = await getLeagueBySleeperId(env.DB, sleeperLeagueId);
    if (current?.status === "active") return current;
    throw error;
  }
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
