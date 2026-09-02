import { createFixtureClient, HttpSleeperClient, type PlayerMap, type SleeperClient } from "@league-brain/sleeper";

const PLAYERS_KEY = "players:nfl";
const PLAYERS_AT_KEY = "players:nfl:fetched_at";
const DAY_MS = 24 * 60 * 60 * 1000;

export function sleeperFromEnv(env: Env): SleeperClient {
  if ((env.USE_SLEEPER_FIXTURES as string) === "true") {
    return createFixtureClient();
  }
  return new HttpSleeperClient();
}

export async function getPlayerMap(env: Env, sleeper: SleeperClient, now = Date.now()): Promise<PlayerMap> {
  const fetchedAtRaw = await env.PLAYERS.get(PLAYERS_AT_KEY);
  const fetchedAt = fetchedAtRaw ? Number(fetchedAtRaw) : 0;
  if (fetchedAt && now - fetchedAt < DAY_MS) {
    const cached = await env.PLAYERS.get<PlayerMap>(PLAYERS_KEY, "json");
    if (cached) return cached;
  }
  const players = await sleeper.getPlayers();
  await env.PLAYERS.put(PLAYERS_KEY, JSON.stringify(players));
  await env.PLAYERS.put(PLAYERS_AT_KEY, String(now));
  return players;
}
