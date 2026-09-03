import { clerkClient, getAuth } from "@clerk/react-router/server";
import { upsertUserByClerkId, type UserRow } from "@cutman/db";
import { redirect } from "react-router";
import { bindClerkEnv } from "~/lib/clerk.server";
import { cloudflareEnv } from "~/lib/env";

export type AuthedUser = UserRow;

type AuthArgs = {
  request: Request;
  context: unknown;
};

function clerkUserId(auth: Awaited<ReturnType<typeof getAuth>>): string | null {
  if ("userId" in auth && typeof auth.userId === "string" && auth.userId.length > 0) {
    return auth.userId;
  }
  return null;
}

export async function getCurrentUser(args: AuthArgs): Promise<AuthedUser | null> {
  const env = cloudflareEnv(args.context);
  bindClerkEnv(env);
  const auth = await getAuth(args as Parameters<typeof getAuth>[0]);
  const userId = clerkUserId(auth);
  if (!userId) return null;
  const client = clerkClient(args as Parameters<typeof clerkClient>[0]);
  const clerkUser = await client.users.getUser(userId);
  const email =
    clerkUser.primaryEmailAddress?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    null;
  if (!email) return null;
  return upsertUserByClerkId(env.DB, { id: userId, email, now: Date.now() });
}

export async function requireUser(args: AuthArgs): Promise<AuthedUser> {
  const user = await getCurrentUser(args);
  if (!user) throw redirect("/sign-in");
  return user;
}
