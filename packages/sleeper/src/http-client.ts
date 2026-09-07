import type { NflState, PlayerMap, SleeperClient, SleeperLeague, SleeperLeagueUser, SleeperMatchup, SleeperRoster, SleeperTransaction, SleeperUser } from "./types.ts";

const DEFAULT_BASE = "https://api.sleeper.app/v1";

function normalizedSleeperPath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "user" && segments[1]) {
    segments[1] = ":id";
    if (segments[2] === "leagues" && segments[3] === "nfl" && segments[4]) {
      segments[4] = ":id";
    }
  } else if (segments[0] === "league" && segments[1]) {
    segments[1] = ":id";
    if ((segments[2] === "matchups" || segments[2] === "transactions") && segments[3]) {
      segments[3] = ":id";
    }
  }
  return `/${segments.join("/")}`;
}

export class SleeperRequestError extends Error {
  declare readonly path: string;
  readonly status: number;

  constructor(path: string, status: number) {
    super(`Sleeper ${normalizedSleeperPath(path)} failed: ${status}`);
    this.name = "SleeperRequestError";
    this.status = status;
    Object.defineProperty(this, "path", {
      value: path,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

// Prefer `instanceof` + `status`. The message regex remains for RPC / structured-clone
// boundaries, where the `SleeperRequestError` prototype and custom fields can be lost while
// `message` survives. Do not "fix" that with `Object.setPrototypeOf`.
export function isSleeperRateLimited(error: unknown): boolean {
  if (error instanceof SleeperRequestError) return error.status === 429;
  return error instanceof Error && / failed: 429$/.test(error.message);
}

export class HttpSleeperClient implements SleeperClient {
  private static readonly REQUEST_TIMEOUT_MS = 10_000;
  private static readonly PLAYERS_TIMEOUT_MS = 30_000;

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
    return this.getJson<PlayerMap>("/players/nfl", HttpSleeperClient.PLAYERS_TIMEOUT_MS);
  }

  private async getJson<T>(path: string, timeoutMs = HttpSleeperClient.REQUEST_TIMEOUT_MS): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await this.fetchPath(path, signal);
    if (!response.ok) {
      throw new SleeperRequestError(path, response.status);
    }
    return (await response.json()) as T;
  }

  private async getJsonOrNull<T>(path: string): Promise<T | null> {
    const signal = AbortSignal.timeout(HttpSleeperClient.REQUEST_TIMEOUT_MS);
    const response = await this.fetchPath(path, signal);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new SleeperRequestError(path, response.status);
    }
    const body: unknown = await response.json();
    return body === null ? null : (body as T);
  }

  // Native `fetch` is this-sensitive. `this.fetchImpl(url)` makes `this` the client and throws
  // Illegal invocation in Workers. Call it as a free function instead.
  private fetchPath(path: string, signal: AbortSignal): Promise<Response> {
    const fetchImpl = this.fetchImpl;
    return fetchImpl(`${this.baseUrl}${path}`, { signal });
  }
}
