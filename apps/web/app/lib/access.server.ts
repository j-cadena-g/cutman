import { getLeague, getLeagueMember, type LeagueMemberRow, type LeagueRow, type UserRow } from "@cutman/db";
import { cloudflareEnv } from "~/lib/env";
import { ensureV1League, v1LeagueId } from "~/lib/v1.server";
import { getCurrentUser } from "~/lib/session.server";

type AuthArgs = {
  request: Request;
  context: unknown;
  params?: Record<string, string | undefined>;
};

export type AccessState =
  | { kind: "signed_out" }
  // Clerk sign-in alone authenticates but does not grant a league membership. Onboarding
  // (connecting a Sleeper account, then either the commissioner challenge or joining an already
  // active league — see app/lib/onboarding.server.ts) is what actually creates the membership row.
  | { kind: "no_membership"; user: UserRow; league: LeagueRow }
  | {
      kind: "member";
      user: UserRow;
      league: LeagueRow;
      membership: LeagueMemberRow;
      isOwner: boolean;
    };

export async function resolveAccess(args: AuthArgs): Promise<AccessState> {
  const env = cloudflareEnv(args.context);
  const user = await getCurrentUser(args);
  if (!user) return { kind: "signed_out" };

  await ensureV1League(env);
  const leagueId = v1LeagueId(env);
  const league = await getLeague(env.DB, leagueId);
  if (!league) {
    throw new Error("V1 league failed to initialize.");
  }
  // No automatic membership grant here: a signed-in Clerk user with no `league_members` row is
  // "no_membership" until they complete onboarding (see app/lib/onboarding.server.ts), which
  // writes an explicit "member" or "commissioner" role.
  const membership = await getLeagueMember(env.DB, leagueId, user.id);
  if (!membership) {
    return { kind: "no_membership", user, league };
  }
  return {
    kind: "member",
    user,
    league,
    membership,
    isOwner: membership.role === "commissioner",
  };
}
