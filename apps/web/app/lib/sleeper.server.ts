// Thin `.server.ts` re-export so route files can pull `sleeperFromEnv` without importing
// `workers/sleeper.ts` directly. React Router's `.server` naming convention guarantees this
// import chain (and the real `SleeperClient` construction it performs) is stripped from the
// client bundle, the same way app/lib/session.server.ts and app/lib/clerk.server.ts already are.
export { sleeperFromEnv } from "../../workers/sleeper.ts";
