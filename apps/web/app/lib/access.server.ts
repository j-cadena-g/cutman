import {
  findAllowlistByEmail,
  getLeague,
  getLeagueMember,
  upsertLeagueMember,
  type AllowlistRow,
  type LeagueMemberRow,
  type LeagueRow,
  type UserRow,
} from "@cutman/db";
import { cloudflareEnv } from "~/lib/env";
import { ensureV1League, v1LeagueId } from "~/lib/v1.server";
import { getCurrentUser } from "~/lib/session.server";
import { sleeperFromEnv } from "../../workers/sleeper";

type AuthArgs = {
  request: Request;
  context: unknown;
  params?: Record<string, string | undefined>;
};

export type AccessState =
  | { kind: "signed_out" }
  | {
      kind: "signed_in";
      user: UserRow;
      reason: "not_allowlisted" | "not_in_league";
    }
  | {
      kind: "member";
      user: UserRow;
      allowlist: AllowlistRow;
      league: LeagueRow;
      membership: LeagueMemberRow;
      isOwner: boolean;
    };

export async function resolveAccess(args: AuthArgs): Promise<AccessState> {
  const env = cloudflareEnv(args.context);
  const user = await getCurrentUser(args);
  if (!user) return { kind: "signed_out" };

  const allowlist = await findAllowlistByEmail(env.DB, user.email);
  if (!allowlist) {
    return { kind: "signed_in", user, reason: "not_allowlisted" };
  }

  const leagueId = v1LeagueId(env);
  const sleeper = sleeperFromEnv(env);
  const members = await sleeper.getLeagueUsers(leagueId);
  const sleeperMember = members.find((entry) => entry.user_id === allowlist.sleeper_user_id);
  if (!sleeperMember) {
    return { kind: "signed_in", user, reason: "not_in_league" };
  }

  await ensureV1League(env);
  await upsertLeagueMember(env.DB, {
    leagueId,
    userId: user.id,
    sleeperUserId: allowlist.sleeper_user_id,
    isOwner: Boolean(sleeperMember.is_owner),
  });
  const league = await getLeague(env.DB, leagueId);
  const membership = await getLeagueMember(env.DB, leagueId, user.id);
  if (!league || !membership) {
    return { kind: "signed_in", user, reason: "not_in_league" };
  }
  return {
    kind: "member",
    user,
    allowlist,
    league,
    membership,
    isOwner: Boolean(membership.is_owner),
  };
}
