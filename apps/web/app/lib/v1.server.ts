import { V1_LEAGUE_ID as DEFAULT_V1_LEAGUE_ID, V1_LEAGUE_NAME as DEFAULT_V1_LEAGUE_NAME } from "@cutman/db";

// Pure config accessors only. The v1 stopgap that used to create/activate the configured league
// and bootstrap LeagueBrain on every signed-in request (`ensureV1LeagueRow`/`ensureV1League`) has
// been removed: no signed-in request may create, activate, or bootstrap a league (see
// app/lib/access.server.ts). The real lifecycle is now owned by app/lib/onboarding.server.ts
// (creates the league in `provisioning` once a commissioner completes the challenge) and a later
// task (activation + LeagueBrain bootstrap). `v1LeagueId`/`v1LeagueName` remain because they are
// just config readers — callers (routes, the onboarding services' `pilotSleeperLeagueId`) still
// need the configured Sleeper league id/name.
export function v1LeagueId(env: Env): string {
  const id = env.V1_LEAGUE_ID?.trim();
  return id || DEFAULT_V1_LEAGUE_ID;
}

export function v1LeagueName(env: Env): string {
  const name = env.V1_LEAGUE_NAME?.trim();
  return name || DEFAULT_V1_LEAGUE_NAME;
}
