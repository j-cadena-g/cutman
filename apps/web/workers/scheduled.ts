import { listEnabledLeagues } from "@cutman/db";
import { easternParts, shouldAttemptTuesdayRecap, shouldPoll } from "@cutman/story";

export async function handleScheduled(env: Env, now = new Date()): Promise<{ polled: number; recapped: number }> {
  const parts = easternParts(now);
  const poll = shouldPoll(parts);
  const recap = shouldAttemptTuesdayRecap(parts);
  if (!poll && !recap) {
    return { polled: 0, recapped: 0 };
  }
  const leagues = await listEnabledLeagues(env.DB);
  let polled = 0;
  let recapped = 0;
  for (const league of leagues) {
    const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(league.sleeper_league_id));
    if (poll) {
      await stub.poll();
      polled += 1;
    }
    if (recap) {
      await stub.attemptRecap();
      recapped += 1;
    }
  }
  return { polled, recapped };
}
