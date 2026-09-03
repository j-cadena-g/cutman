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
// Two concurrent first loads (no league row yet, or a league stuck in "error") can race at
// either transition: `createLeague` idempotently resolves to the same row either way (see its
// own concurrent-insert handling), but only one of two concurrent `provisionLeague` calls, or
// one of two concurrent `activateLeague` calls, can win its compare-and-swap — the other throws,
// because both lifecycle rules are intentionally strict and are not weakened here. A caller can
// lose at `provisionLeague` for two different reasons: a concurrent retry from the same
// "error"/"provisioning" state (harmless, `provisionLeague` already tolerates that), or — the
// case this specifically guards — a concurrent caller having *already* raced all the way through
// to "active" by the time this call's own `provisionLeague` UPDATE executes. Either rejection is
// handled the same way: re-check the row, and if another caller already won and it is now
// "active", that satisfies this caller's contract too, so we return the current row instead of
// the stale error.
async function recoverToActiveOrRethrow(env: Env, sleeperLeagueId: string, error: unknown): Promise<LeagueRow> {
  const current = await getLeagueBySleeperId(env.DB, sleeperLeagueId);
  if (current?.status === "active") return current;
  throw error;
}

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

  let provisioning = league;
  if (league.status === "error") {
    try {
      provisioning = await provisionLeague(env.DB, league.id);
    } catch (error) {
      return recoverToActiveOrRethrow(env, sleeperLeagueId, error);
    }
  }

  try {
    return await activateLeague(env.DB, provisioning.id, now);
  } catch (error) {
    return recoverToActiveOrRethrow(env, sleeperLeagueId, error);
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
