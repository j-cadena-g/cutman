import { fixtureLeagues, fixtureMatchupsFinal, fixturePlayers, fixtureRosters, fixtureState, fixtureTransactions, fixtureUser, fixtureUsersVerified } from "./fixtures.ts";
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
  const state = overrides.state ?? fixtureState;
  const user = overrides.user === undefined ? fixtureUser : overrides.user;
  const leagues = overrides.leagues ?? fixtureLeagues;
  const users = overrides.users ?? fixtureUsersVerified;
  const rosters = overrides.rosters ?? fixtureRosters;
  const matchups = overrides.matchups ?? fixtureMatchupsFinal;
  const transactions = overrides.transactions ?? fixtureTransactions;
  const players = overrides.players ?? fixturePlayers;

  return {
    async getNflState() {
      return state;
    },
    async getUser(usernameOrId) {
      if (!user) return null;
      if (usernameOrId === user.username || usernameOrId === user.user_id) return user;
      return null;
    },
    async getUserLeagues() {
      return leagues;
    },
    async getLeague(leagueId) {
      return leagues.find((league) => league.league_id === leagueId) ?? null;
    },
    async getLeagueUsers() {
      return users;
    },
    async getRosters() {
      return rosters;
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
