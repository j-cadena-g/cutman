import { listActiveLeagues } from "@cutman/db";
import { easternParts, shouldAttemptTuesdayRecap, shouldPoll, toneOrPlayful } from "@cutman/story";

export async function handleScheduled(env: Env, now = new Date()): Promise<{ polled: number; recapped: number }> {
  const parts = easternParts(now);
  const poll = shouldPoll(parts);
  const recap = shouldAttemptTuesdayRecap(parts);
  if (!poll && !recap) {
    return { polled: 0, recapped: 0 };
  }

  const leagues = await listActiveLeagues(env.DB);
  let polled = 0;
  let recapped = 0;
  for (const league of leagues) {
    try {
      const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(league.id));
      await stub.bootstrap({
        leagueId: league.id,
        sleeperLeagueId: league.sleeper_league_id,
        name: league.name,
        tone: toneOrPlayful(league.tone),
      });
      if (poll) {
        await stub.poll();
        polled += 1;
      }
      if (recap) {
        await stub.attemptRecap();
        recapped += 1;
      }
    } catch (error) {
      console.error(`scheduled tick failed for league ${league.id}`, error);
    }
  }
  return { polled, recapped };
}
