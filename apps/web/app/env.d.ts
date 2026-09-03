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
  // Sleeper league id for the single configured pilot league. Live value comes from
  // 1Password (`Cutman (dev)` / deploy Environment); tracked wrangler templates keep a fake
  // placeholder. Never a V1_* fallback — see app/lib/v1.server.ts `pilotSleeperLeagueId`.
  PILOT_SLEEPER_LEAGUE_ID: string;
}
