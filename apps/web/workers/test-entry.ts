import { LeagueBrain, LEGACY_IMPORT_PENDING_MESSAGE, UNBOOTSTRAPPED_MESSAGE } from "./league-brain.ts";
import { handleScheduled } from "./scheduled.ts";

// The test worker has no AI binding. Polls and provisioning still need a stored
// snapshot when the slate has facts, so a missing model falls back to a non-blank
// beat. Tests that cover a failed draft replace generateBeatDraft on the instance.
const beatSeam = LeagueBrain.prototype as unknown as {
  generateBeatDraft(week: number, facts: unknown[]): Promise<{ copy: string }>;
};
const generateBeatDraft = beatSeam.generateBeatDraft;
beatSeam.generateBeatDraft = async function (this: LeagueBrain, week, facts) {
  try {
    return await generateBeatDraft.call(this, week, facts);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === UNBOOTSTRAPPED_MESSAGE || error.message === LEGACY_IMPORT_PENDING_MESSAGE)
    ) {
      throw error;
    }
    return { copy: "Test beat." };
  }
};

export { LeagueBrain };

export default {
  async fetch() {
    return new Response("league-brain-test");
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Env>;
