import { ensureSchema } from "@cutman/db";
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
    // League creation/activation now happens lazily in `ensureV1League` (see
    // app/lib/v1.server.ts) via the explicit provisioning lifecycle, not at worker boot.
    pending = ensureSchema(env.DB).catch((error: unknown) => {
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
