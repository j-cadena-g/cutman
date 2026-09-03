/// <reference types="vite/client" />

declare module "virtual:react-router/server-build" {
  const serverBuild: unknown;
  export default serverBuild;
}

interface Env {
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  APP_ENV: string;
  APP_ORIGIN: string;
  APP_URL?: string;
  EMAIL_FROM: string;
  USE_SLEEPER_FIXTURES: string;
  V1_LEAGUE_ID: string;
  V1_LEAGUE_NAME: string;
  V1_SLEEPER_USER_ID: string;
  V1_SLEEPER_USERNAME: string;
  // The Sleeper league id for the single configured pilot league that onboarding challenges
  // against (see app/lib/v1.server.ts's `pilotSleeperLeagueId`). Optional: falls back to
  // `V1_LEAGUE_ID` until the wrangler manifest defines this var directly (Task 5).
  PILOT_SLEEPER_LEAGUE_ID?: string;
}
