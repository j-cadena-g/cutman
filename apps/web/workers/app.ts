import { ensureOperatorSeed, ensureSchema } from "@cutman/db";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { LeagueBrain } from "./league-brain.ts";
import { handleScheduled } from "./scheduled.ts";

declare module "react-router" {
  interface RouterContextProvider {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const prepared = new WeakMap<D1Database, Promise<void>>();

async function prepareDb(env: Env): Promise<void> {
  let pending = prepared.get(env.DB);
  if (!pending) {
    pending = (async () => {
      await ensureSchema(env.DB);
      await ensureOperatorSeed(env.DB, {
        leagueId: env.V1_LEAGUE_ID,
        leagueName: env.V1_LEAGUE_NAME,
        sleeperUserId: env.V1_SLEEPER_USER_ID,
        sleeperUsername: env.V1_SLEEPER_USERNAME,
        now: Date.now(),
      });
    })().catch((error: unknown) => {
      prepared.delete(env.DB);
      throw error;
    });
    prepared.set(env.DB, pending);
  }
  await pending;
}

export { LeagueBrain };

export default {
  async fetch(request, env, ctx) {
    await prepareDb(env);
    const context = new RouterContextProvider();
    Object.assign(context, { cloudflare: { env, ctx } });
    return requestHandler(request, context);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(prepareDb(env).then(() => handleScheduled(env)));
  },
} satisfies ExportedHandler<Env>;
