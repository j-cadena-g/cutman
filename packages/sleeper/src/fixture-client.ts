import {
  V1_LEAGUE_ID,
  fixturePlayers,
  fixtureTransactions,
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
  rosters?: SleeperRoster[];
  matchups?: SleeperMatchup[];
  transactions?: SleeperTransaction[];
  players?: PlayerMap;
};

export function createFixtureClient(overrides: FixtureOverrides = {}): SleeperClient {
  const state = overrides.state ?? v1FixtureState;
  const user = overrides.user === undefined ? v1FixtureUser : overrides.user;
  const leagues = overrides.leagues ?? [v1FixtureLeague];
  const users = overrides.users ?? v1FixtureUsers;
  const rosters = overrides.rosters ?? v1FixtureRosters;
  const matchups = overrides.matchups ?? v1FixtureMatchups;
  const transactions = overrides.transactions ?? fixtureTransactions;
  const players = overrides.players ?? fixturePlayers;

  return {
    async getNflState() {
      return state;
    },
    async getUser(usernameOrId) {
      if (!user) return null;
      if (usernameOrId === user.username || usernameOrId === user.user_id) return user;
      const teammate = users.find((entry) => entry.username === usernameOrId || entry.user_id === usernameOrId);
      if (!teammate) return null;
      return {
        user_id: teammate.user_id,
        username: teammate.username,
        display_name: teammate.display_name,
        avatar: teammate.avatar,
      };
    },
    async getUserLeagues(userId) {
      if (userId === user?.user_id || users.some((entry) => entry.user_id === userId)) {
        return leagues;
      }
      return [];
    },
    async getLeague(leagueId) {
      return leagues.find((league) => league.league_id === leagueId) ?? null;
    },
    async getLeagueUsers(leagueId) {
      if (leagueId === V1_LEAGUE_ID || leagues.some((league) => league.league_id === leagueId)) {
        return users;
      }
      return [];
    },
    async getRosters(leagueId) {
      if (leagueId === V1_LEAGUE_ID || leagues.some((league) => league.league_id === leagueId)) {
        return rosters;
      }
      return [];
    },
    async getMatchups() {
      return matchups;
    },
    async getTransactions() {
      return transactions;
    },
    async getPlayers() {
      return players;
    },
  };
}
