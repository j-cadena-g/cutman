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

export { LeagueBrain };

export default {
  async fetch(request, env, ctx) {
    await ensureSchema(env.DB);
    const context = new RouterContextProvider();
    Object.assign(context, { cloudflare: { env, ctx } });
    return requestHandler(request, context);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      ensureSchema(env.DB).then(() => handleScheduled(env)),
    );
  },
} satisfies ExportedHandler<Env>;
