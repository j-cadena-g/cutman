import { getLeague, getLeagueMember, type LeagueMemberRow, type LeagueRow, type UserRow } from "@cutman/db";
import { cloudflareEnv } from "~/lib/env";
import { v1LeagueId } from "~/lib/v1.server";
import { getCurrentUser } from "~/lib/session.server";

type AuthArgs = {
  request: Request;
  context: unknown;
  params?: Record<string, string | undefined>;
};

export type AccessState =
  | { kind: "signed_out" }
  // Clerk sign-in alone authenticates but does not grant a league membership, and does not
  // create, activate, or bootstrap anything either — this is a pure read. Onboarding (connecting
  // a Sleeper account, then either the commissioner challenge or joining an already active
  // league — see app/lib/onboarding.server.ts) is what actually creates the league row and the
  // membership row. `league` is `null` until a commissioner has completed the challenge for the
  // configured pilot league; Task 3's routes own presenting that "no league yet" state.
  | { kind: "no_membership"; user: UserRow; league: LeagueRow | null }
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

  // No `ensureV1League`/auto-provisioning here: a signed-in request must never create,
  // activate, or bootstrap a league on the read path. This only reads whatever already exists.
  const leagueId = v1LeagueId(env);
  const league = await getLeague(env.DB, leagueId);
  if (!league) {
    return { kind: "no_membership", user, league: null };
  }
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
