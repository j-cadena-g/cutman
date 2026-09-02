import type { NflState, PlayerMap, SleeperClient, SleeperLeague, SleeperLeagueUser, SleeperMatchup, SleeperRoster, SleeperTransaction, SleeperUser } from "./types.ts";

const DEFAULT_BASE = "https://api.sleeper.app/v1";

export class HttpSleeperClient implements SleeperClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = DEFAULT_BASE,
  ) {}

  async getNflState(): Promise<NflState> {
    return this.getJson<NflState>("/state/nfl");
  }

  async getUser(usernameOrId: string): Promise<SleeperUser | null> {
    return this.getJsonOrNull<SleeperUser>(`/user/${encodeURIComponent(usernameOrId)}`);
  }

  async getUserLeagues(userId: string, season: string): Promise<SleeperLeague[]> {
    return this.getJson<SleeperLeague[]>(`/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`);
  }

  async getLeague(leagueId: string): Promise<SleeperLeague | null> {
    return this.getJsonOrNull<SleeperLeague>(`/league/${encodeURIComponent(leagueId)}`);
  }

  async getLeagueUsers(leagueId: string): Promise<SleeperLeagueUser[]> {
    return this.getJson<SleeperLeagueUser[]>(`/league/${encodeURIComponent(leagueId)}/users`);
  }

  async getRosters(leagueId: string): Promise<SleeperRoster[]> {
    return this.getJson<SleeperRoster[]>(`/league/${encodeURIComponent(leagueId)}/rosters`);
  }

  async getMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]> {
    return this.getJson<SleeperMatchup[]>(`/league/${encodeURIComponent(leagueId)}/matchups/${week}`);
  }

  async getTransactions(leagueId: string, week: number): Promise<SleeperTransaction[]> {
    return this.getJson<SleeperTransaction[]>(`/league/${encodeURIComponent(leagueId)}/transactions/${week}`);
  }

  async getPlayers(): Promise<PlayerMap> {
    return this.getJson<PlayerMap>("/players/nfl");
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`);
    if (!response.ok) {
      throw new Error(`Sleeper ${path} failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async getJsonOrNull<T>(path: string): Promise<T | null> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Sleeper ${path} failed: ${response.status}`);
    }
    const body: unknown = await response.json();
    return body === null ? null : (body as T);
  }
}
