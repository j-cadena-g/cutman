export type NflState = {
  week: number;
  season_type: string;
  season: string;
  league_season: string;
  display_week?: number;
  season_start_date?: string;
  previous_season?: string;
  leg?: number;
};

export type SleeperUser = {
  user_id: string;
  username: string;
  display_name: string;
  avatar?: string | null;
};

export type SleeperLeague = {
  league_id: string;
  name: string;
  season: string;
  sport: string;
  status?: string;
  total_rosters?: number;
  avatar?: string | null;
};

export type SleeperLeagueUser = {
  user_id: string;
  username: string;
  display_name: string;
  avatar?: string | null;
  is_owner?: boolean;
  metadata?: {
    team_name?: string;
    [key: string]: unknown;
  } | null;
};

export type SleeperRoster = {
  roster_id: number;
  owner_id: string | null;
  players?: string[] | null;
  starters?: string[] | null;
  reserve?: string[] | null;
  settings?: {
    wins?: number;
    losses?: number;
    ties?: number;
    fpts?: number;
  };
};

export type SleeperMatchup = {
  roster_id: number;
  matchup_id: number | null;
  points: number | null;
  starters?: string[] | null;
  players?: string[] | null;
  players_points?: Record<string, number> | null;
  custom_points?: number | null;
};

export type SleeperDraftPick = {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number;
  owner_id: number;
};

export type SleeperTransaction = {
  type: string;
  transaction_id: string;
  status: string;
  roster_ids: number[];
  creator?: string;
  created?: number;
  leg?: number;
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  draft_picks?: SleeperDraftPick[] | null;
  waiver_budget?: Array<{ sender: number; receiver: number; amount: number }> | null;
};

export type SleeperPlayer = {
  player_id: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  position?: string | null;
  team?: string | null;
};

export type PlayerMap = Record<string, SleeperPlayer>;

export type SleeperClient = {
  getNflState(): Promise<NflState>;
  getUser(usernameOrId: string): Promise<SleeperUser | null>;
  getUserLeagues(userId: string, season: string): Promise<SleeperLeague[]>;
  getLeague(leagueId: string): Promise<SleeperLeague | null>;
  getLeagueUsers(leagueId: string): Promise<SleeperLeagueUser[]>;
  getRosters(leagueId: string): Promise<SleeperRoster[]>;
  getMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]>;
  getTransactions(leagueId: string, week: number): Promise<SleeperTransaction[]>;
  getPlayers(): Promise<PlayerMap>;
};
