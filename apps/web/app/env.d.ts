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
}
