import type { PlayerMap, SleeperLeagueUser, SleeperRoster } from "@cutman/sleeper";

export function teamLabel(users: SleeperLeagueUser[], rosters: SleeperRoster[], rosterId: number): string {
  const roster = rosters.find((entry) => entry.roster_id === rosterId);
  const user = users.find((entry) => entry.user_id === roster?.owner_id);
  return user?.metadata?.team_name || user?.display_name || `Roster ${rosterId}`;
}

export function playerLabel(playerId: string, players: PlayerMap): string {
  const player = players[playerId];
  if (player?.full_name) return player.full_name;
  // Team defenses carry only first/last name ("San Francisco" / "49ers").
  const name = [player?.first_name, player?.last_name].filter(Boolean).join(" ");
  if (name) return player?.position === "DEF" ? `${name} D/ST` : name;
  return `Player ${playerId}`;
}
