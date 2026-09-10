import type {
  PlayerMap,
  SleeperLeague,
  SleeperLeagueUser,
  SleeperMatchup,
  SleeperRoster,
  SleeperUser,
} from "@cutman/sleeper";

export function normalizeExplorerUsername(input: string): string {
  return input.trim().toLowerCase();
}

// Sleeper usernames are 1–32 chars of letters, digits, underscore, or hyphen. Anything else is
// rejected before it reaches a KV key or a Sleeper URL.
export const EXPLORER_USERNAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
export function isValidExplorerUsername(username: string): boolean {
  return EXPLORER_USERNAME_PATTERN.test(username);
}

// Sleeper league ids are numeric snowflakes. Reject anything else before it reaches a KV key
// or a Sleeper URL.
export const EXPLORER_LEAGUE_ID_PATTERN = /^[0-9]{1,32}$/;
export function isValidExplorerLeagueId(leagueId: string): boolean {
  return EXPLORER_LEAGUE_ID_PATTERN.test(leagueId);
}

export function sleeperAvatarUrl(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  return `https://sleepercdn.com/avatars/thumbs/${avatar}`;
}

export function playerDisplayName(playerId: string, players: PlayerMap): string {
  const player = players[playerId];
  if (!player) return playerId;
  if (player.full_name) return player.full_name;
  const parts = [player.first_name, player.last_name].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : playerId;
}

export function formatLeagueStatus(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return status.replaceAll("_", " ");
}

export type ExplorerUserCard = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type ExplorerLeagueCard = {
  sleeperLeagueId: string;
  name: string;
  season: string;
  status: string | null;
  totalRosters: number | null;
};

export type ExplorerPlayer = {
  playerId: string;
  name: string;
  position: string | null;
  team: string | null;
  points: number | null;
};

export type ExplorerManager = {
  rosterId: number;
  teamName: string;
  displayName: string;
  abandoned: boolean;
};

export type ExplorerStandingRow = ExplorerManager & {
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
};

export type ExplorerMatchupSide = ExplorerManager & {
  points: number | null;
  starters: ExplorerPlayer[];
};

export type ExplorerMatchupView = {
  matchupId: number | null;
  sides: ExplorerMatchupSide[];
};

export type ExplorerRosterView = ExplorerManager & {
  starters: ExplorerPlayer[];
  bench: ExplorerPlayer[];
  reserve: ExplorerPlayer[];
};

export type ExplorerBoardView = {
  league: ExplorerLeagueCard;
  week: number;
  season: string;
  standings: ExplorerStandingRow[];
  matchups: ExplorerMatchupView[];
  rosters: ExplorerRosterView[];
};

export function toExplorerUserCard(user: SleeperUser): ExplorerUserCard {
  return {
    userId: user.user_id,
    username: user.username,
    displayName: user.display_name || user.username,
    avatarUrl: sleeperAvatarUrl(user.avatar),
  };
}

export function toExplorerLeagueCard(league: SleeperLeague): ExplorerLeagueCard {
  return {
    sleeperLeagueId: league.league_id,
    name: league.name,
    season: league.season,
    status: league.status ?? null,
    totalRosters: league.total_rosters ?? null,
  };
}

export function usersById(users: SleeperLeagueUser[]): Map<string, SleeperLeagueUser> {
  return new Map(users.map((user) => [user.user_id, user]));
}

export function managerForRoster(
  roster: SleeperRoster,
  users: Map<string, SleeperLeagueUser>,
): ExplorerManager {
  if (!roster.owner_id) {
    return {
      rosterId: roster.roster_id,
      teamName: "Abandoned roster",
      displayName: "No owner",
      abandoned: true,
    };
  }
  const user = users.get(roster.owner_id);
  const displayName = user?.display_name || user?.username || "Unknown manager";
  const teamName = user?.metadata?.team_name || displayName;
  return {
    rosterId: roster.roster_id,
    teamName,
    displayName,
    abandoned: false,
  };
}

function toExplorerPlayer(
  playerId: string,
  players: PlayerMap,
  points: Record<string, number> | null | undefined,
  slot: string | null,
): ExplorerPlayer {
  const player = players[playerId];
  return {
    playerId,
    name: playerDisplayName(playerId, players),
    position: slot && slot !== "BN" ? slot : (player?.position ?? null),
    team: player?.team ?? (/^[A-Z]{2,3}$/.test(playerId) ? playerId : null),
    points: points?.[playerId] ?? null,
  };
}

function starterPlayers(
  starterIds: string[] | null | undefined,
  rosterPositions: string[] | null | undefined,
  players: PlayerMap,
  points: Record<string, number> | null | undefined,
): ExplorerPlayer[] {
  const ids = starterIds ?? [];
  return ids.flatMap((playerId, index) => {
    if (!playerId || playerId === "0") return [];
    return [toExplorerPlayer(playerId, players, points, rosterPositions?.[index] ?? null)];
  });
}

function remainingPlayers(
  playerIds: string[] | null | undefined,
  exclude: Set<string>,
  players: PlayerMap,
  points: Record<string, number> | null | undefined,
): ExplorerPlayer[] {
  return (playerIds ?? [])
    .filter((playerId) => playerId && !exclude.has(playerId))
    .map((playerId) => toExplorerPlayer(playerId, players, points, null));
}

export function assembleStandings(
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
): ExplorerStandingRow[] {
  const owners = usersById(users);
  const rows = rosters.map((roster) => {
    const manager = managerForRoster(roster, owners);
    return {
      ...manager,
      wins: roster.settings?.wins ?? 0,
      losses: roster.settings?.losses ?? 0,
      ties: roster.settings?.ties ?? 0,
      pointsFor: roster.settings?.fpts ?? 0,
    };
  });
  rows.sort((left, right) => {
    const leftScore = left.wins * 2 + left.ties;
    const rightScore = right.wins * 2 + right.ties;
    if (rightScore !== leftScore) return rightScore - leftScore;
    if (right.pointsFor !== left.pointsFor) return right.pointsFor - left.pointsFor;
    return left.rosterId - right.rosterId;
  });
  return rows;
}

export function assembleScoreboard(
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
  matchups: SleeperMatchup[],
  players: PlayerMap,
  rosterPositions?: string[] | null,
): ExplorerMatchupView[] {
  const owners = usersById(users);
  const rostersById = new Map(rosters.map((roster) => [roster.roster_id, roster]));
  const groups = new Map<string, SleeperMatchup[]>();
  for (const matchup of matchups) {
    // `== null` is intentional: treat both null and omitted/undefined as a bye, but keep 0 as `m:0`.
    const key = matchup.matchup_id == null ? `bye:${matchup.roster_id}` : `m:${matchup.matchup_id}`;
    const list = groups.get(key) ?? [];
    list.push(matchup);
    groups.set(key, list);
  }

  const games: ExplorerMatchupView[] = [];
  const byes: ExplorerMatchupView[] = [];
  for (const sides of groups.values()) {
    const view: ExplorerMatchupView = {
      matchupId: sides[0]?.matchup_id ?? null,
      sides: sides.map((side) => {
        const roster = rostersById.get(side.roster_id);
        const manager = roster
          ? managerForRoster(roster, owners)
          : {
              rosterId: side.roster_id,
              teamName: `Roster ${side.roster_id}`,
              displayName: "Unknown manager",
              abandoned: true,
            };
        return {
          ...manager,
          points: side.custom_points ?? side.points,
          starters: starterPlayers(side.starters, rosterPositions, players, side.players_points),
        };
      }),
    };
    if (view.matchupId === null) byes.push(view);
    else games.push(view);
  }
  games.sort((left, right) => (left.matchupId ?? 0) - (right.matchupId ?? 0));
  return [...games, ...byes];
}

export function assembleRosters(
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
  matchups: SleeperMatchup[],
  players: PlayerMap,
  rosterPositions?: string[] | null,
): ExplorerRosterView[] {
  const owners = usersById(users);
  const pointsByRoster = new Map(matchups.map((matchup) => [matchup.roster_id, matchup.players_points ?? null]));
  return rosters
    .map((roster) => {
      const manager = managerForRoster(roster, owners);
      const points = pointsByRoster.get(roster.roster_id);
      const starters = starterPlayers(roster.starters, rosterPositions, players, points);
      const starterIds = new Set((roster.starters ?? []).filter(Boolean));
      const reserveIds = new Set((roster.reserve ?? []).filter(Boolean));
      const exclude = new Set([...starterIds, ...reserveIds]);
      return {
        ...manager,
        starters,
        bench: remainingPlayers(roster.players, exclude, players, points),
        reserve: remainingPlayers(roster.reserve, starterIds, players, points),
      };
    })
    .sort((left, right) => left.rosterId - right.rosterId);
}

export function assembleExplorerBoard(input: {
  league: SleeperLeague;
  week: number;
  users: SleeperLeagueUser[];
  rosters: SleeperRoster[];
  matchups: SleeperMatchup[];
  players: PlayerMap;
}): ExplorerBoardView {
  return {
    league: toExplorerLeagueCard(input.league),
    week: input.week,
    season: input.league.season,
    standings: assembleStandings(input.rosters, input.users),
    matchups: assembleScoreboard(
      input.rosters,
      input.users,
      input.matchups,
      input.players,
      input.league.roster_positions,
    ),
    rosters: assembleRosters(
      input.rosters,
      input.users,
      input.matchups,
      input.players,
      input.league.roster_positions,
    ),
  };
}

export function describeExplorerError(
  kind: "invalid_username" | "not_found" | "rate_limited" | "quota_exceeded" | "unavailable",
): string {
  switch (kind) {
    case "invalid_username":
      return "Enter a Sleeper username of 1–32 letters, digits, underscores, or hyphens.";
    case "not_found":
      return "Sleeper has no public profile for that username or league.";
    case "rate_limited":
      return "Sleeper asked Cutman to slow down. Try again in a minute.";
    case "quota_exceeded":
      return "Too many Sleeper lookups this hour. Try again later.";
    case "unavailable":
      return "Cutman couldn't reach Sleeper just now. Try again in a moment.";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
