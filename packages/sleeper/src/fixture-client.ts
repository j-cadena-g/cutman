import {
  COMING_SOON_LEAGUE_ID,
  MUTABLE_SLEEPER_PREVIOUS_USERNAME,
  V1_LEAGUE_ID,
  comingSoonFixtureLeague,
  comingSoonFixtureUsers,
  fixturePlayers,
  fixtureTransactions,
  mutableFixtureUser,
  v1FixtureLeague,
  v1FixtureMatchups,
  v1FixtureRosters,
  v1FixtureState,
  v1FixtureUser,
  v1FixtureUsers,
} from "./fixtures.ts";
import type { NflState, PlayerMap, SleeperClient, SleeperLeague, SleeperLeagueUser, SleeperMatchup, SleeperRoster, SleeperTransaction, SleeperUser } from "./types.ts";

export type FixtureOverrides = {
  state?: NflState;
  user?: SleeperUser | null;
  leagues?: SleeperLeague[];
  users?: SleeperLeagueUser[];
  usersByLeagueId?: Record<string, SleeperLeagueUser[]>;
  rosters?: SleeperRoster[];
  matchups?: SleeperMatchup[];
  transactions?: SleeperTransaction[];
  players?: PlayerMap;
};

function defaultUsersByLeagueId(): Record<string, SleeperLeagueUser[]> {
  return {
    [V1_LEAGUE_ID]: v1FixtureUsers,
    [COMING_SOON_LEAGUE_ID]: comingSoonFixtureUsers,
  };
}

function toSleeperUser(entry: SleeperLeagueUser): SleeperUser {
  return {
    user_id: entry.user_id,
    username: entry.username,
    display_name: entry.display_name,
    avatar: entry.avatar,
  };
}

export function createFixtureClient(overrides: FixtureOverrides = {}): SleeperClient {
  const state = overrides.state ?? v1FixtureState;
  const user = overrides.user === undefined ? v1FixtureUser : overrides.user;
  const leagues = overrides.leagues ?? [v1FixtureLeague, comingSoonFixtureLeague];
  const usersByLeagueId =
    overrides.usersByLeagueId ??
    (overrides.users
      ? Object.fromEntries(leagues.map((league) => [league.league_id, overrides.users!]))
      : defaultUsersByLeagueId());
  const directory = new Map<string, SleeperUser>();
  for (const entry of Object.values(usersByLeagueId).flat()) {
    const resolved = toSleeperUser(entry);
    directory.set(resolved.username, resolved);
    directory.set(resolved.user_id, resolved);
  }
  if (user) {
    directory.set(user.username, user);
    directory.set(user.user_id, user);
  }
  if (!overrides.usersByLeagueId && !overrides.users) {
    directory.set(mutableFixtureUser.username, mutableFixtureUser);
    directory.set(mutableFixtureUser.user_id, mutableFixtureUser);
    directory.set(MUTABLE_SLEEPER_PREVIOUS_USERNAME, mutableFixtureUser);
  }
  const rosters = overrides.rosters ?? v1FixtureRosters;
  const matchups = overrides.matchups ?? v1FixtureMatchups;
  const transactions = overrides.transactions ?? fixtureTransactions;
  const players = overrides.players ?? fixturePlayers;

  function usersForLeague(leagueId: string): SleeperLeagueUser[] {
    return usersByLeagueId[leagueId] ?? [];
  }

  function rowsForLeague<T>(leagueId: string, rows: T[], overrideSet: boolean): T[] {
    if (leagueId === V1_LEAGUE_ID) return rows;
    if (overrideSet && leagues.some((league) => league.league_id === leagueId)) return rows;
    return [];
  }

  return {
    async getNflState() {
      return state;
    },
    async getUser(usernameOrId) {
      return directory.get(usernameOrId) ?? null;
    },
    async getUserLeagues(userId) {
      return leagues.filter((league) => usersForLeague(league.league_id).some((entry) => entry.user_id === userId));
    },
    async getLeague(leagueId) {
      return leagues.find((league) => league.league_id === leagueId) ?? null;
    },
    async getLeagueUsers(leagueId) {
      return usersForLeague(leagueId);
    },
    async getRosters(leagueId) {
      return rowsForLeague(leagueId, rosters, Boolean(overrides.rosters));
    },
    async getMatchups(leagueId) {
      return rowsForLeague(leagueId, matchups, Boolean(overrides.matchups));
    },
    async getTransactions(leagueId) {
      return rowsForLeague(leagueId, transactions, Boolean(overrides.transactions));
    },
    async getPlayers() {
      return players;
    },
  };
}
