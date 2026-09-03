import type { NflState, SleeperLeague, SleeperLeagueUser, SleeperMatchup, SleeperRoster, SleeperTransaction, SleeperUser } from "./types.ts";

// Fixture data for `createFixtureClient` only — not Worker env. Runtime league identity
// is `PILOT_SLEEPER_LEAGUE_ID`.
export const V1_LEAGUE_ID = "0000000000000000000";
export const V1_LEAGUE_NAME = "Example League";
export const EXAMPLE_SLEEPER_USER_ID = "0000000000000000001";
export const EXAMPLE_SLEEPER_USERNAME = "example_user";

export const fixtureState: NflState = {
  week: 3,
  season_type: "regular",
  season: "2025",
  league_season: "2025",
  display_week: 3,
  season_start_date: "2025-09-04",
  previous_season: "2024",
  leg: 3,
};

export const fixtureUser: SleeperUser = {
  username: "alex",
  user_id: "u-alex",
  display_name: "Alex",
  avatar: "avatar-alex",
};

export const fixtureLeagues: SleeperLeague[] = [
  {
    league_id: "lg-group-chat",
    name: "The Group Chat",
    season: "2025",
    sport: "nfl",
    status: "in_season",
    total_rosters: 4,
  },
];

export const fixtureUsersVerified: SleeperLeagueUser[] = [
  {
    user_id: "u-alex",
    username: "alex",
    display_name: "Alex",
    is_owner: true,
    metadata: { team_name: "Purdy Please" },
  },
  {
    user_id: "u-mina",
    username: "mina",
    display_name: "Mina",
    is_owner: false,
    metadata: { team_name: "Zero RB Forever" },
  },
  {
    user_id: "u-dev",
    username: "devin",
    display_name: "Devin",
    is_owner: false,
    metadata: { team_name: "Start Your QBs" },
  },
  {
    user_id: "u-ash",
    username: "ash",
    display_name: "Ash",
    is_owner: false,
    metadata: { team_name: "The Waiver Wire" },
  },
];

export const fixtureRosters: SleeperRoster[] = [
  {
    roster_id: 1,
    owner_id: "u-alex",
    players: ["4046", "6794", "8134", "4984", "PHI"],
    starters: ["4046", "6794", "8134", "PHI"],
  },
  {
    roster_id: 2,
    owner_id: "u-mina",
    players: ["4881", "4035", "7564", "9226", "SF"],
    starters: ["4881", "4035", "7564", "SF"],
  },
  {
    roster_id: 3,
    owner_id: "u-dev",
    players: ["5849", "3198", "8146", "KC"],
    starters: ["5849", "3198", "KC"],
  },
  {
    roster_id: 4,
    owner_id: "u-ash",
    players: ["4988", "6786", "8112", "DAL"],
    starters: ["4988", "6786", "DAL"],
  },
];

export const fixtureMatchupsFinal: SleeperMatchup[] = [
  {
    roster_id: 1,
    matchup_id: 1,
    points: 128.4,
    starters: ["4046", "6794", "8134", "PHI"],
    players: ["4046", "6794", "8134", "4984", "PHI"],
    players_points: { "4046": 24.1, "6794": 18.4, "8134": 22.2, "4984": 31.6, PHI: 12.0 },
  },
  {
    roster_id: 2,
    matchup_id: 1,
    points: 111.2,
    starters: ["4881", "4035", "7564", "SF"],
    players: ["4881", "4035", "7564", "9226", "SF"],
    players_points: { "4881": 19.0, "4035": 14.2, "7564": 11.8, "9226": 3.1, SF: 8.0 },
  },
  {
    roster_id: 3,
    matchup_id: 2,
    points: 96.7,
    starters: ["5849", "3198", "KC"],
    players: ["5849", "3198", "8146", "KC"],
    players_points: { "5849": 28.4, "3198": 9.1, "8146": 21.0, KC: 7.0 },
  },
  {
    roster_id: 4,
    matchup_id: 2,
    points: 101.3,
    starters: ["4988", "6786", "DAL"],
    players: ["4988", "6786", "8112", "DAL"],
    players_points: { "4988": 16.2, "6786": 12.4, "8112": 4.0, DAL: 11.0 },
  },
];

export const fixtureMatchupsInProgress: SleeperMatchup[] = fixtureMatchupsFinal.map((m, index) =>
  index === 3 ? { ...m, points: null } : m,
);

export const fixtureMatchupsNoPlayerPoints: SleeperMatchup[] = fixtureMatchupsFinal.map((m) => ({
  ...m,
  players_points: null,
}));

export const fixtureTransactions: SleeperTransaction[] = [
  {
    type: "trade",
    transaction_id: "tx-trade-1",
    status: "complete",
    roster_ids: [1, 2],
    creator: "u-alex",
    created: 1_725_000_000_000,
    leg: 3,
    adds: { "4984": 1, "9226": 2 },
    drops: { "4984": 2, "9226": 1 },
    draft_picks: [],
    waiver_budget: [],
  },
];

export const fixturePlayers = {
  "4046": { player_id: "4046", full_name: "Patrick Mahomes", position: "QB", team: "KC" },
  "6794": { player_id: "6794", full_name: "Justin Jefferson", position: "WR", team: "MIN" },
  "8134": { player_id: "8134", full_name: "Bijan Robinson", position: "RB", team: "ATL" },
  "4984": { player_id: "4984", full_name: "CeeDee Lamb", position: "WR", team: "DAL" },
  "4881": { player_id: "4881", full_name: "Lamar Jackson", position: "QB", team: "BAL" },
  "4035": { player_id: "4035", full_name: "Saquon Barkley", position: "RB", team: "PHI" },
  "7564": { player_id: "7564", full_name: "Puka Nacua", position: "WR", team: "LAR" },
  "9226": { player_id: "9226", full_name: "A.J. Brown", position: "WR", team: "PHI" },
  "5849": { player_id: "5849", full_name: "Jalen Hurts", position: "QB", team: "PHI" },
  "3198": { player_id: "3198", full_name: "Travis Kelce", position: "TE", team: "KC" },
  "8146": { player_id: "8146", full_name: "Jahmyr Gibbs", position: "RB", team: "DET" },
  "4988": { player_id: "4988", full_name: "Josh Allen", position: "QB", team: "BUF" },
  "6786": { player_id: "6786", full_name: "Amon-Ra St. Brown", position: "WR", team: "DET" },
  "8112": { player_id: "8112", full_name: "De'Von Achane", position: "RB", team: "MIA" },
};

export const v1FixtureState: NflState = {
  week: 1,
  season_type: "regular",
  season: "2026",
  league_season: "2026",
  display_week: 1,
  season_start_date: "2026-09-10",
  previous_season: "2025",
  leg: 1,
};

export const v1FixtureUser: SleeperUser = {
  username: EXAMPLE_SLEEPER_USERNAME,
  user_id: EXAMPLE_SLEEPER_USER_ID,
  display_name: EXAMPLE_SLEEPER_USERNAME,
  avatar: null,
};

export const v1FixtureLeague: SleeperLeague = {
  league_id: V1_LEAGUE_ID,
  name: V1_LEAGUE_NAME,
  season: "2026",
  sport: "nfl",
  status: "in_season",
  total_rosters: 10,
};

const v1Teammates: Array<{ username: string; user_id: string; team: string }> = [
  { username: "mina", user_id: "u-mina", team: "Zero RB Forever" },
  { username: "devin", user_id: "u-devin", team: "Start Your QBs" },
  { username: "ash", user_id: "u-ash", team: "The Waiver Wire" },
  { username: "rio", user_id: "u-rio", team: "Fourth Down Faith" },
  { username: "nate", user_id: "u-nate", team: "Red Zone Committee" },
  { username: "cole", user_id: "u-cole", team: "Stacked Slot" },
  { username: "tess", user_id: "u-tess", team: "Tuesday Tape" },
  { username: "wren", user_id: "u-wren", team: "Bye Week Bargain" },
  { username: "quad", user_id: "u-quad", team: "Two Tight Ends" },
];

export const v1FixtureUsers: SleeperLeagueUser[] = [
  {
    user_id: EXAMPLE_SLEEPER_USER_ID,
    username: EXAMPLE_SLEEPER_USERNAME,
    display_name: EXAMPLE_SLEEPER_USERNAME,
    is_owner: false,
    metadata: { team_name: "Example Squad" },
  },
  ...v1Teammates.map((teammate) => ({
    user_id: teammate.user_id,
    username: teammate.username,
    display_name: teammate.username,
    is_owner: false,
    metadata: { team_name: teammate.team },
  })),
];

export const v1FixtureRosters: SleeperRoster[] = [
  { roster_id: 1, owner_id: EXAMPLE_SLEEPER_USER_ID, players: ["4046", "6794", "8134", "PHI"], starters: ["4046", "6794", "8134", "PHI"] },
  { roster_id: 2, owner_id: "u-mina", players: ["4881", "4035", "7564", "SF"], starters: ["4881", "4035", "7564", "SF"] },
  { roster_id: 3, owner_id: "u-devin", players: ["5849", "3198", "8146", "KC"], starters: ["5849", "3198", "KC"] },
  { roster_id: 4, owner_id: "u-ash", players: ["4988", "6786", "8112", "DAL"], starters: ["4988", "6786", "DAL"] },
  { roster_id: 5, owner_id: "u-rio", players: ["4046", "9226", "SF"], starters: ["4046", "9226", "SF"] },
  { roster_id: 6, owner_id: "u-nate", players: ["4881", "4984", "PHI"], starters: ["4881", "4984", "PHI"] },
  { roster_id: 7, owner_id: "u-cole", players: ["5849", "7564", "KC"], starters: ["5849", "7564", "KC"] },
  { roster_id: 8, owner_id: "u-tess", players: ["4988", "8134", "DAL"], starters: ["4988", "8134", "DAL"] },
  { roster_id: 9, owner_id: "u-wren", players: ["6794", "4035", "SF"], starters: ["6794", "4035", "SF"] },
  { roster_id: 10, owner_id: "u-quad", players: ["3198", "8146", "PHI"], starters: ["3198", "8146", "PHI"] },
];

export const v1FixtureMatchups: SleeperMatchup[] = [
  { roster_id: 1, matchup_id: 1, points: 118.2, starters: ["4046", "6794", "8134", "PHI"], players: ["4046", "6794", "8134", "PHI"], players_points: { "4046": 22.0, "6794": 16.4, "8134": 18.1, PHI: 8.0 } },
  { roster_id: 2, matchup_id: 1, points: 104.6, starters: ["4881", "4035", "7564", "SF"], players: ["4881", "4035", "7564", "SF"], players_points: { "4881": 20.1, "4035": 14.0, "7564": 12.5, SF: 7.0 } },
  { roster_id: 3, matchup_id: 2, points: 97.4, starters: ["5849", "3198", "KC"], players: ["5849", "3198", "KC"], players_points: { "5849": 24.2, "3198": 9.2, KC: 6.0 } },
  { roster_id: 4, matchup_id: 2, points: 101.0, starters: ["4988", "6786", "DAL"], players: ["4988", "6786", "DAL"], players_points: { "4988": 18.4, "6786": 13.1, DAL: 9.0 } },
  { roster_id: 5, matchup_id: 3, points: 88.0, starters: ["4046", "9226", "SF"], players: ["4046", "9226", "SF"], players_points: { "4046": 15.0, "9226": 11.0, SF: 6.0 } },
  { roster_id: 6, matchup_id: 3, points: 92.5, starters: ["4881", "4984", "PHI"], players: ["4881", "4984", "PHI"], players_points: { "4881": 17.5, "4984": 14.0, PHI: 7.0 } },
  { roster_id: 7, matchup_id: 4, points: 86.3, starters: ["5849", "7564", "KC"], players: ["5849", "7564", "KC"], players_points: { "5849": 16.0, "7564": 10.3, KC: 5.0 } },
  { roster_id: 8, matchup_id: 4, points: 90.1, starters: ["4988", "8134", "DAL"], players: ["4988", "8134", "DAL"], players_points: { "4988": 15.1, "8134": 13.0, DAL: 8.0 } },
  { roster_id: 9, matchup_id: 5, points: 79.8, starters: ["6794", "4035", "SF"], players: ["6794", "4035", "SF"], players_points: { "6794": 12.8, "4035": 11.0, SF: 6.0 } },
  { roster_id: 10, matchup_id: 5, points: 83.4, starters: ["3198", "8146", "PHI"], players: ["3198", "8146", "PHI"], players_points: { "3198": 10.4, "8146": 14.0, PHI: 7.0 } },
];
