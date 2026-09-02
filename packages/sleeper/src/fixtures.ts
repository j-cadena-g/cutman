import type { NflState, SleeperLeague, SleeperLeagueUser, SleeperMatchup, SleeperRoster, SleeperTransaction, SleeperUser } from "./types.ts";

export const FIXTURE_VERIFY_CODE = "A7K2";
export const FIXTURE_VERIFY_TOKEN = `FF-${FIXTURE_VERIFY_CODE}`;

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
  username: "james",
  user_id: "u-james",
  display_name: "James",
  avatar: "avatar-james",
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
  {
    league_id: "lg-work",
    name: "Work League",
    season: "2025",
    sport: "nfl",
    status: "in_season",
    total_rosters: 4,
  },
];

export const fixtureUsersVerified: SleeperLeagueUser[] = [
  {
    user_id: "u-james",
    username: "james",
    display_name: "James",
    is_owner: true,
    metadata: { team_name: `Purdy Please ${FIXTURE_VERIFY_TOKEN}` },
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

export const fixtureUsersUnverified: SleeperLeagueUser[] = fixtureUsersVerified.map((user) =>
  user.user_id === "u-james"
    ? { ...user, metadata: { team_name: "Purdy Please" } }
    : user,
);

export const fixtureRosters: SleeperRoster[] = [
  {
    roster_id: 1,
    owner_id: "u-james",
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
    creator: "u-james",
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
