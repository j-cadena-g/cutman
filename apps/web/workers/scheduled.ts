import { V1_LEAGUE_ID, V1_LEAGUE_NAME } from "@cutman/db";
import { easternParts, shouldAttemptTuesdayRecap, shouldPoll, toneOrPlayful } from "@cutman/story";

export async function handleScheduled(env: Env, now = new Date()): Promise<{ polled: number; recapped: number }> {
  const parts = easternParts(now);
  const poll = shouldPoll(parts);
  const recap = shouldAttemptTuesdayRecap(parts);
  if (!poll && !recap) {
    return { polled: 0, recapped: 0 };
  }
  const leagueId = env.V1_LEAGUE_ID?.trim() || V1_LEAGUE_ID;
  const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(leagueId));
  await stub.bootstrap({ leagueId, name: V1_LEAGUE_NAME, tone: toneOrPlayful(undefined) });
  let polled = 0;
  let recapped = 0;
  if (poll) {
    await stub.poll();
    polled += 1;
  }
  if (recap) {
    await stub.attemptRecap();
    recapped += 1;
  }
  return { polled, recapped };
}
