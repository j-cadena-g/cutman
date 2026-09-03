import {
  getLeague,
  getLeagueMember,
  getSleeperAccountByUserId,
  listLeaguesForUser,
  type LeagueMemberRow,
  type LeagueRow,
  type UserRow,
} from "@cutman/db";
import { authorizeLeagueAccess, computeHomeDestination } from "~/lib/access-rules";
import { cloudflareEnv } from "~/lib/env";
import { getCurrentUser } from "~/lib/session.server";

export { authorizeLeagueAccess, computeHomeDestination };
export type { HomeDestination, LeagueAuthorization } from "~/lib/access-rules";

type AuthArgs = {
  request: Request;
  context: unknown;
  params?: Record<string, string | undefined>;
};

// ---------------------------------------------------------------------------
// `/` home hub: is this signed-in user connected to Sleeper, and how many *active* league
// memberships do they have? `computeHomeDestination` (app/lib/access-rules.ts) turns this into
// the actual redirect/card decision — this function is only responsible for reading the
// (unfiltered) inputs from Clerk/D1.
// ---------------------------------------------------------------------------

export type HomeAccessState =
  | { kind: "signed_out" }
  | { kind: "signed_in"; user: UserRow; sleeperConnected: boolean; activeLeagues: LeagueRow[] };

export async function resolveHomeAccess(args: AuthArgs): Promise<HomeAccessState> {
  const env = cloudflareEnv(args.context);
  const user = await getCurrentUser(args);
  if (!user) return { kind: "signed_out" };
  const [sleeperAccount, leagues] = await Promise.all([
    getSleeperAccountByUserId(env.DB, user.id),
    listLeaguesForUser(env.DB, user.id),
  ]);
  return {
    kind: "signed_in",
    user,
    sleeperConnected: Boolean(sleeperAccount),
    activeLeagues: leagues.filter((league) => league.status === "active"),
  };
}

// ---------------------------------------------------------------------------
// `/leagues/:leagueId` dashboard: require Clerk and membership in that exact active league.
// `authorizeLeagueAccess` (app/lib/access-rules.ts) makes the actual not_found/not_active/
// authorized decision; this function only reads the league/membership rows to feed it.
// ---------------------------------------------------------------------------

export type LeagueAccessState =
  | { kind: "signed_out" }
  | { kind: "not_found" }
  | { kind: "not_active" }
  | { kind: "member"; user: UserRow; league: LeagueRow; membership: LeagueMemberRow; isOwner: boolean };

export async function resolveLeagueAccess(args: AuthArgs, leagueId: string): Promise<LeagueAccessState> {
  const env = cloudflareEnv(args.context);
  const user = await getCurrentUser(args);
  if (!user) return { kind: "signed_out" };

  const league = await getLeague(env.DB, leagueId);
  const membership = league ? await getLeagueMember(env.DB, league.id, user.id) : null;
  const authorization = authorizeLeagueAccess({ league, membership });

  if (!league || !membership || authorization.kind === "not_found") {
    return { kind: "not_found" };
  }
  if (authorization.kind === "not_active") {
    return { kind: "not_active" };
  }
  return { kind: "member", user, league, membership, isOwner: authorization.isOwner };
}
