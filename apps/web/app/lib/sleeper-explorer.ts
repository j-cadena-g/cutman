import type {
  PlayerMap,
  SleeperLeague,
  SleeperLeagueUser,
  SleeperMatchup,
  SleeperRoster,
  SleeperTransaction,
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

export function formatExplorerSlot(slot: string | null): string {
  if (!slot) return "—";
  if (slot === "SUPER_FLEX") return "SF";
  if (slot === "IDP_FLEX") return "IDP";
  if (slot === "REC_FLEX") return "REC";
  return slot;
}

export function formatExplorerDraftPick(
  round: number | null,
  draftSlot: number | null,
  pickNo: number | null,
): string {
  if (round == null) return "—";
  if (draftSlot != null) return `${round}.${draftSlot}`;
  if (pickNo != null) return `${round}.${pickNo}`;
  return "—";
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

export function parseExplorerWeekParam(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export function clampExplorerWeek(requested: number | null | undefined, maxWeek: number): number {
  const ceiling = Math.max(1, Math.trunc(maxWeek) || 1);
  if (requested == null || !Number.isFinite(requested)) return ceiling;
  return Math.min(ceiling, Math.max(1, Math.trunc(requested)));
}

export function maxExplorerWeek(input: {
  leagueSeason: string | null | undefined;
  nflSeason: string;
  displayWeek: number;
  lastScoredWeek?: number | null;
}): number {
  if (input.leagueSeason && input.leagueSeason !== input.nflSeason) {
    // A past season ends at its last scored week. Week 18 has no games when playoffs end in 17.
    const last = input.lastScoredWeek;
    return typeof last === "number" && Number.isInteger(last) && last >= 1 && last <= 18 ? last : 18;
  }
  return Math.max(1, input.displayWeek);
}

export function leagueLastScoredWeek(league: SleeperLeague | null | undefined): number | null {
  const value = league?.settings?.last_scored_leg;
  return typeof value === "number" ? value : null;
}

export function explorerLeaguePath(leagueId: string, tab?: "draft" | "brackets"): string {
  const base = `/explore/leagues/${encodeURIComponent(leagueId)}`;
  switch (tab) {
    case "draft":
      return `${base}/draft`;
    case "brackets":
      return `${base}/brackets`;
    case undefined:
      return base;
    default: {
      const exhaustive: never = tab;
      return exhaustive;
    }
  }
}

export function explorerLeagueWeekHref(leagueId: string, week: number): string {
  return `${explorerLeaguePath(leagueId)}?week=${week}`;
}

export function formatExplorerMoveType(type: string): string {
  const labeled = type.replaceAll("_", " ").trim();
  if (!labeled) return "Move";
  return labeled.charAt(0).toUpperCase() + labeled.slice(1);
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
  username: string | null;
  isOwner: boolean;
  abandoned: boolean;
  avatarUrl: string | null;
  wins: number;
  losses: number;
  ties: number;
};

export type ExplorerStandingRow = ExplorerManager & {
  pointsFor: number;
  pointsAgainst: number;
};

export type ExplorerMatchupSide = ExplorerManager & {
  points: number | null;
  starters: ExplorerPlayer[];
  bench: ExplorerPlayer[];
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

export type ExplorerTransactionMove = {
  player: ExplorerPlayer;
  rosterId: number;
  teamName: string;
};

export type ExplorerTransactionView = {
  transactionId: string;
  type: string;
  status: string;
  created: number | null;
  rosterIds: number[];
  teamNames: string[];
  adds: ExplorerTransactionMove[];
  drops: ExplorerTransactionMove[];
  waiverBudget: Array<{ senderName: string; receiverName: string; amount: number }>;
  draftPicks: ExplorerTradedPickView[];
};

export type ExplorerLeagueSettings = {
  rosterSlots: string[];
  playoffWeekStart: number | null;
  scoringLines: Array<{ key: string; value: number }>;
};

export type ExplorerBoardView = {
  league: ExplorerLeagueCard;
  week: number;
  currentWeek: number;
  selectedWeek: number;
  maxWeek: number;
  season: string;
  standings: ExplorerStandingRow[];
  matchups: ExplorerMatchupView[];
  rosters: ExplorerRosterView[];
  transactions: ExplorerTransactionView[];
  settings: ExplorerLeagueSettings;
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

/**
 * Sleeper's league users carry display_name but no username. A Sleeper username is the display
 * name lowercased, so fall back to it for the profile link.
 */
function explorerProfileUsername(user: SleeperLeagueUser | undefined): string | null {
  const candidate = normalizeExplorerUsername(user?.username || user?.display_name || "");
  return isValidExplorerUsername(candidate) ? candidate : null;
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
      username: null,
      isOwner: false,
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
    username: explorerProfileUsername(user),
    isOwner: user?.is_owner === true,
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

function combinedPoints(whole?: number, decimal?: number): number {
  return (whole ?? 0) + (decimal ?? 0) / 100;
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
      pointsFor: combinedPoints(roster.settings?.fpts, roster.settings?.fpts_decimal),
      pointsAgainst: combinedPoints(roster.settings?.fpts_against, roster.settings?.fpts_against_decimal),
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
              username: null,
              isOwner: false,
              abandoned: true,
              avatarUrl: null,
              wins: 0,
              losses: 0,
              ties: 0,
            };
        const starterIds = new Set((side.starters ?? []).filter(isRealPlayerId));
        return {
          ...manager,
          points: side.custom_points ?? side.points,
          starters: starterPlayers(side.starters, rosterPositions, players, side.players_points, true),
          bench: remainingPlayers(side.players, starterIds, players, side.players_points),
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

export function assembleLeagueSettings(league: SleeperLeague): ExplorerLeagueSettings {
  const scoring = league.scoring_settings ?? {};
  const highlightKeys = ["pass_td", "rush_td", "rec_td", "rec", "bonus_rec_te", "fum"];
  return {
    rosterSlots: (league.roster_positions ?? []).filter((slot) => slot !== "BN"),
    playoffWeekStart: typeof league.settings?.playoff_week_start === "number" ? league.settings.playoff_week_start : null,
    scoringLines: highlightKeys.flatMap((key) => {
      const value = scoring[key];
      return typeof value === "number" ? [{ key, value }] : [];
    }),
  };
}

function explorerRosterId(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function teamNameResolver(rosters: SleeperRoster[], users: SleeperLeagueUser[], missing: string) {
  const owners = usersById(users);
  const names = new Map<number, string>();
  return (rosterId: string | number | null | undefined): string => {
    const id = explorerRosterId(rosterId);
    if (id == null) return missing;
    const cached = names.get(id);
    if (cached) return cached;
    const roster = rosters.find((row) => row.roster_id === id);
    const name = roster ? managerForRoster(roster, owners).teamName : `Roster ${id}`;
    names.set(id, name);
    return name;
  };
}

export function assembleExplorerTransactions(
  transactions: SleeperTransaction[],
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
  players: PlayerMap,
): ExplorerTransactionView[] {
  const teamName = teamNameResolver(rosters, users, "Unknown team");
  const movesFrom = (record: Record<string, number> | null | undefined): ExplorerTransactionMove[] =>
    Object.entries(record ?? {}).map(([playerId, rosterId]) => ({
      player: toExplorerPlayer(playerId, players, null, null),
      rosterId,
      teamName: teamName(rosterId),
    }));

  return [...transactions]
    .sort((left, right) => (right.created ?? 0) - (left.created ?? 0) || left.transaction_id.localeCompare(right.transaction_id))
    .map((transaction) => {
      const rosterIds = transaction.roster_ids ?? [];
      return {
        transactionId: transaction.transaction_id,
        type: transaction.type,
        status: transaction.status,
        created: transaction.created ?? null,
        rosterIds,
        teamNames: rosterIds.map(teamName),
        adds: movesFrom(transaction.adds),
        drops: movesFrom(transaction.drops),
        waiverBudget: (transaction.waiver_budget ?? []).map((transfer) => ({
          senderName: teamName(transfer.sender),
          receiverName: teamName(transfer.receiver),
          amount: transfer.amount,
        })),
        draftPicks: (transaction.draft_picks ?? []).map((pick) => ({
          season: pick.season,
          round: pick.round,
          fromTeam: teamName(pick.previous_owner_id),
          toTeam: teamName(pick.owner_id),
          rosterId: explorerRosterId(pick.roster_id),
        })),
      };
    });
}

export function assembleExplorerBoard(input: {
  league: SleeperLeague;
  week: number;
  currentWeek?: number;
  selectedWeek?: number;
  nflSeason?: string;
  users: SleeperLeagueUser[];
  rosters: SleeperRoster[];
  matchups: SleeperMatchup[];
  players: PlayerMap;
  transactions?: SleeperTransaction[];
}): ExplorerBoardView {
  const selectedWeek = input.selectedWeek ?? input.week;
  const currentWeek = input.currentWeek ?? input.week;
  const maxWeek = maxExplorerWeek({
    leagueSeason: input.league.season,
    nflSeason: input.nflSeason ?? input.league.season,
    displayWeek: currentWeek,
    lastScoredWeek: leagueLastScoredWeek(input.league),
  });
  return {
    league: toExplorerLeagueCard(input.league),
    week: selectedWeek,
    currentWeek,
    selectedWeek,
    maxWeek,
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
    transactions: assembleExplorerTransactions(
      input.transactions ?? [],
      input.rosters,
      input.users,
      input.players,
    ),
    settings: assembleLeagueSettings(input.league),
  };
}

export type ExplorerDraftPickView = {
  pickNo: number | null;
  round: number | null;
  draftSlot: number | null;
  player: ExplorerPlayer;
  teamName: string;
};

export type ExplorerDraftView = {
  draftId: string;
  status: string | null;
  type: string | null;
  season: string | null;
  picks: ExplorerDraftPickView[];
};

export type ExplorerTradedPickView = {
  season: string;
  round: number;
  fromTeam: string;
  toTeam: string;
  rosterId: number | null;
};

export type ExplorerBracketGameView = {
  round: number;
  match: number;
  left: string;
  right: string;
  winner: string | null;
};

export function assembleExplorerDraft(
  draft: { draft_id: string; status?: string; type?: string; season?: string },
  picks: Array<{
    player_id?: string | null;
    roster_id?: number | string | null;
    round?: number;
    draft_slot?: number;
    pick_no?: number;
  }>,
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
  players: PlayerMap,
): ExplorerDraftView {
  const teamName = teamNameResolver(rosters, users, "Unknown team");
  return {
    draftId: draft.draft_id,
    status: draft.status ?? null,
    type: draft.type ?? null,
    season: draft.season ?? null,
    picks: picks.map((pick) => ({
      pickNo: pick.pick_no ?? null,
      round: pick.round ?? null,
      draftSlot: pick.draft_slot ?? null,
      player: toExplorerPlayer(pick.player_id || "", players, null, null),
      teamName: teamName(pick.roster_id),
    })),
  };
}

export function assembleExplorerTradedPicks(
  picks: Array<{
    season: string;
    round: number;
    roster_id?: number | string | null;
    previous_owner_id: number | string;
    owner_id: number | string;
  }>,
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
): ExplorerTradedPickView[] {
  const teamName = teamNameResolver(rosters, users, "Unknown team");
  return picks.map((pick) => ({
    season: pick.season,
    round: pick.round,
    fromTeam: teamName(pick.previous_owner_id),
    toTeam: teamName(pick.owner_id),
    rosterId: explorerRosterId(pick.roster_id),
  }));
}

export function assembleExplorerBracket(
  games: Array<{ r: number; m: number; t1: number | null; t2: number | null; w?: number | null }>,
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
): ExplorerBracketGameView[] {
  const teamName = teamNameResolver(rosters, users, "TBD");
  return [...games]
    .sort((left, right) => left.r - right.r || left.m - right.m)
    .map((game) => ({
      round: game.r,
      match: game.m,
      left: teamName(game.t1),
      right: teamName(game.t2),
      winner: game.w == null ? null : teamName(game.w),
    }));
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
