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
  return `https://sleepercdn.com/avatars/thumbs/${encodeURIComponent(avatar)}`;
}

const TEAM_ID_PATTERN = /^[A-Z]{2,3}$/;

export function sleeperPlayerHeadshotUrl(playerId: string): string | null {
  if (!isRealPlayerId(playerId)) return null;
  if (TEAM_ID_PATTERN.test(playerId)) {
    return `https://sleepercdn.com/images/team_logos/nfl/${encodeURIComponent(playerId.toLowerCase())}.png`;
  }
  return `https://sleepercdn.com/content/nfl/players/thumb/${encodeURIComponent(playerId)}.jpg`;
}

export function formatExplorerScore(value: number | null): string {
  if (value === null) return "—";
  return value.toFixed(2);
}

export function formatExplorerRecord(wins: number, losses: number, ties: number): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

export function playerDisplayName(playerId: string, players: PlayerMap): string {
  const player = players[playerId];
  if (!player) return playerId;
  if (player.full_name) return player.full_name;
  const parts = [player.first_name, player.last_name].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : playerId;
}

// Sleeper uses "0" as an empty-slot sentinel. Treat that, plus missing or blank ids, as not a player.
export function isRealPlayerId(playerId: string | null | undefined): playerId is string {
  return typeof playerId === "string" && playerId.length > 0 && playerId !== "0";
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
  avatarUrl: string | null;
};

export type ExplorerPlayer = {
  playerId: string;
  name: string;
  position: string | null;
  team: string | null;
  points: number | null;
  headshotUrl: string | null;
};

export type ExplorerManager = {
  rosterId: number;
  teamName: string;
  displayName: string;
  abandoned: boolean;
  avatarUrl: string | null;
  wins: number;
  losses: number;
  ties: number;
};

export type ExplorerStandingRow = ExplorerManager & {
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

export type ExplorerMatchupLine = {
  slot: string | null;
  left: ExplorerPlayer | null;
  right: ExplorerPlayer | null;
};

export function zipMatchupStarters(left: ExplorerPlayer[], right: ExplorerPlayer[]): ExplorerMatchupLine[] {
  const length = Math.max(left.length, right.length);
  const lines: ExplorerMatchupLine[] = [];
  for (let index = 0; index < length; index += 1) {
    const leftPlayer = left[index] ?? null;
    const rightPlayer = right[index] ?? null;
    lines.push({
      slot: leftPlayer?.position ?? rightPlayer?.position ?? null,
      left: leftPlayer,
      right: rightPlayer,
    });
  }
  return lines;
}

export function matchupLeader(sides: ExplorerMatchupSide[]): number | null {
  if (sides.length < 2) return null;
  const [left, right] = sides;
  if (left?.points == null || right?.points == null) return null;
  if (left.points === right.points) return null;
  return left.points > right.points ? left.rosterId : right.rosterId;
}

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
    avatarUrl: sleeperAvatarUrl(league.avatar),
  };
}

export function usersById(users: SleeperLeagueUser[]): Map<string, SleeperLeagueUser> {
  return new Map(users.map((user) => [user.user_id, user]));
}

function recordFromRoster(roster: SleeperRoster | undefined): Pick<ExplorerManager, "wins" | "losses" | "ties"> {
  return {
    wins: roster?.settings?.wins ?? 0,
    losses: roster?.settings?.losses ?? 0,
    ties: roster?.settings?.ties ?? 0,
  };
}

export function managerForRoster(
  roster: SleeperRoster,
  users: Map<string, SleeperLeagueUser>,
): ExplorerManager {
  const record = recordFromRoster(roster);
  if (!roster.owner_id) {
    return {
      rosterId: roster.roster_id,
      teamName: "Abandoned roster",
      displayName: "No owner",
      abandoned: true,
      avatarUrl: null,
      ...record,
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
    avatarUrl: sleeperAvatarUrl(user?.avatar),
    ...record,
  };
}

function emptyExplorerPlayer(slot: string | null): ExplorerPlayer {
  return {
    playerId: "",
    name: "Empty",
    position: slot,
    team: null,
    points: null,
    headshotUrl: null,
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
    team: player?.team ?? (TEAM_ID_PATTERN.test(playerId) ? playerId : null),
    points: points?.[playerId] ?? null,
    headshotUrl: sleeperPlayerHeadshotUrl(playerId),
  };
}

function starterPlayers(
  starterIds: string[] | null | undefined,
  rosterPositions: string[] | null | undefined,
  players: PlayerMap,
  points: Record<string, number> | null | undefined,
  keepEmptySlots = false,
): ExplorerPlayer[] {
  const ids = starterIds ?? [];
  return ids.flatMap((playerId, index) => {
    const slot = rosterPositions?.[index] ?? null;
    if (!isRealPlayerId(playerId)) {
      return keepEmptySlots ? [emptyExplorerPlayer(slot)] : [];
    }
    return [toExplorerPlayer(playerId, players, points, slot)];
  });
}

function remainingPlayers(
  playerIds: string[] | null | undefined,
  exclude: Set<string>,
  players: PlayerMap,
  points: Record<string, number> | null | undefined,
): ExplorerPlayer[] {
  return (playerIds ?? [])
    .filter(isRealPlayerId)
    .filter((playerId) => !exclude.has(playerId))
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
      pointsFor: (roster.settings?.fpts ?? 0) + (roster.settings?.fpts_decimal ?? 0) / 100,
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
              avatarUrl: null,
              wins: 0,
              losses: 0,
              ties: 0,
            };
        return {
          ...manager,
          points: side.custom_points ?? side.points,
          starters: starterPlayers(side.starters, rosterPositions, players, side.players_points, true),
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
      const starterIds = new Set((roster.starters ?? []).filter(isRealPlayerId));
      const reserveIds = new Set((roster.reserve ?? []).filter(isRealPlayerId));
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

type ExplorerErrorKind =
  | "invalid_username"
  | "not_found"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable";

const EXPLORER_ERROR_MESSAGES = {
  invalid_username: "Enter a Sleeper username of 1–32 letters, digits, underscores, or hyphens.",
  not_found: "Sleeper has no public profile for that username or league.",
  rate_limited: "Sleeper asked Cutman to slow down. Try again in a minute.",
  quota_exceeded: "Too many Sleeper lookups this hour. Try again later.",
  unavailable: "Cutman couldn't reach Sleeper just now. Try again in a moment.",
} as const satisfies Record<ExplorerErrorKind, string>;

export function describeExplorerError(kind: ExplorerErrorKind): string {
  return EXPLORER_ERROR_MESSAGES[kind];
}

export type ExplorerUsernameFormResult =
  | { ok: true; username: string }
  | { ok: false; error: string; submittedUsername: string };

export function parseExplorerUsernameForm(rawInput: string): ExplorerUsernameFormResult {
  const username = normalizeExplorerUsername(rawInput);
  if (!isValidExplorerUsername(username)) {
    return {
      ok: false,
      error: describeExplorerError("invalid_username"),
      submittedUsername: rawInput,
    };
  }
  return { ok: true, username };
}
