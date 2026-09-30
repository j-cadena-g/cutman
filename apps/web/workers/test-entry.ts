import { beatPrompt, type StoryFact } from "@cutman/story";
import { LeagueBrain } from "./league-brain.ts";
import { handleScheduled } from "./scheduled.ts";

// The test worker has no AI binding. Polls and provisioning still need a stored
// snapshot when the slate has facts, so a missing model falls back to a non-blank
// beat. Prompt, bible, and gate errors still propagate. Tests that cover a failed
// draft replace generateBeatDraft on the instance.
const beatSeam = LeagueBrain.prototype as unknown as {
  generateBeatDraft(week: number, facts: StoryFact[]): Promise<{ copy: string }>;
};
const generateBeatDraft = beatSeam.generateBeatDraft;
beatSeam.generateBeatDraft = async function (this: LeagueBrain, week, facts) {
  const brain = this as unknown as {
    env: { AI?: unknown };
    readSettings(): { tone: "playful" | "savage" | "sportscenter"; name: string };
    bibleLines(): string[];
  };
  if (brain.env.AI) return generateBeatDraft.call(this, week, facts);
  const settings = brain.readSettings();
  beatPrompt({
    tone: settings.tone,
    leagueName: settings.name,
    week,
    bible: brain.bibleLines(),
    facts,
  });
  return { copy: "Test beat." };
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
