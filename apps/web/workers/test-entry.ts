import { LeagueBrain } from "./league-brain.ts";
import { handleScheduled } from "./scheduled.ts";

export { LeagueBrain };

export default {
  async fetch() {
    return new Response("league-brain-test");
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Env>;
