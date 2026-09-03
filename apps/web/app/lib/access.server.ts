import { getLeague, getLeagueMember, upsertLeagueMember, type LeagueMemberRow, type LeagueRow, type UserRow } from "@cutman/db";
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
  // Commissioner is no longer inferred from insertion order (see @cutman/db). v1 has no
  // verification flow wired up yet, so keep an existing member's role and default new members to
  // "member"; a later onboarding task assigns "commissioner" explicitly via league verification.
  const existingMembership = await getLeagueMember(env.DB, leagueId, user.id);
  const membership = await upsertLeagueMember(env.DB, {
    leagueId,
    userId: user.id,
    role: existingMembership?.role ?? "member",
    now: Date.now(),
  });
  return {
    kind: "member",
    user,
    league,
    membership,
    isOwner: membership.role === "commissioner",
  };
}
