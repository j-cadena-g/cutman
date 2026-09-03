// Pure config accessor for the single configured pilot league's Sleeper league id.
// Callers (routes, onboarding) pass this into OnboardingDeps. There is no V1_* fallback:
// a missing or blank PILOT_SLEEPER_LEAGUE_ID is a configuration error, not an invitation
// to use the sleeper fixture id `0000000000000000000`.
export function pilotSleeperLeagueId(env: Env): string {
  const id = env.PILOT_SLEEPER_LEAGUE_ID?.trim();
  if (!id) {
    throw new Error("PILOT_SLEEPER_LEAGUE_ID is not configured");
  }
  return id;
}
