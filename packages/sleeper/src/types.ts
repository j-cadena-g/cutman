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
  roster_positions?: string[] | null;
  scoring_settings?: Record<string, number> | null;
  settings?: {
    playoff_week_start?: number;
    [key: string]: unknown;
  } | null;
  draft_id?: string | null;
  previous_league_id?: string | null;
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
    // Hundredths of a point; Sleeper may send a negative value with a negative `fpts`.
    fpts_decimal?: number;
    fpts_against?: number;
    fpts_against_decimal?: number;
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
  roster_id: number | string;
  previous_owner_id: number | string;
  owner_id: number | string;
};

export type SleeperDraft = {
  draft_id: string;
  league_id?: string;
  status?: string;
  type?: string;
  season?: string;
  start_time?: number | null;
};

export type SleeperDraftPickRow = {
  player_id?: string | null;
  picked_by?: string | null;
  roster_id?: number | string | null;
  round?: number;
  draft_slot?: number;
  pick_no?: number;
};

export type SleeperBracketGame = {
  r: number;
  m: number;
  t1: number | null;
  t2: number | null;
  w?: number | null;
  l?: number | null;
  p?: number | null;
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
  getLeagueDrafts(leagueId: string): Promise<SleeperDraft[]>;
  getDraftPicks(draftId: string): Promise<SleeperDraftPickRow[]>;
  getTradedPicks(leagueId: string): Promise<SleeperDraftPick[]>;
  getWinnersBracket(leagueId: string): Promise<SleeperBracketGame[]>;
  getLosersBracket(leagueId: string): Promise<SleeperBracketGame[]>;
};
