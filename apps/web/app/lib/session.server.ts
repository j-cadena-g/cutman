import {
  consumeMagicLink,
  createSession,
  deleteSession,
  findSession,
  findUserById,
  putMagicLink,
  type UserRow,
  upsertUserByEmail,
} from "@league-brain/db";
import {
  clearSessionCookie,
  isValidEmail,
  magicLinkExpiry,
  normalizeEmail,
  randomId,
  readSessionId,
  sessionCookieValue,
  sessionExpiry,
  sha256Hex,
} from "@league-brain/auth";

export type AuthedUser = UserRow;

export async function getCurrentUser(request: Request, env: Env): Promise<AuthedUser | null> {
  const sessionId = readSessionId(request);
  if (!sessionId) return null;
  const session = await findSession(env.DB, sessionId, Date.now());
  if (!session) return null;
  return findUserById(env.DB, session.user_id);
}

export async function requireUser(request: Request, env: Env): Promise<AuthedUser> {
  const user = await getCurrentUser(request, env);
  if (!user) {
    throw Response.redirect(new URL("/login", request.url), 302);
  }
  return user;
}

export async function startMagicLink(
  env: Env,
  rawEmail: string,
  requestUrl: string,
): Promise<{ email: string; url: string }> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    throw new Error("Enter a real email address.");
  }
  const now = Date.now();
  await upsertUserByEmail(env.DB, { id: randomId(), email, now });
  const token = randomId(24);
  await putMagicLink(env.DB, {
    tokenHash: await sha256Hex(token),
    email,
    expiresAt: magicLinkExpiry(now),
    now,
  });
  const url = new URL("/auth/callback", env.APP_URL || requestUrl);
  url.searchParams.set("token", token);
  return { email, url: url.toString() };
}

export async function completeMagicLink(env: Env, token: string, requestUrl: string): Promise<string> {
  const now = Date.now();
  const email = await consumeMagicLink(env.DB, await sha256Hex(token), now);
  if (!email) {
    throw new Error("That link is expired or already used.");
  }
  const user = await upsertUserByEmail(env.DB, { id: randomId(), email, now });
  const sessionId = randomId(24);
  await createSession(env.DB, {
    id: sessionId,
    userId: user.id,
    expiresAt: sessionExpiry(now),
    now,
  });
  return sessionCookieValue(sessionId, requestUrl);
}

export async function destroySession(request: Request, env: Env): Promise<string> {
  const sessionId = readSessionId(request);
  if (sessionId) await deleteSession(env.DB, sessionId);
  return clearSessionCookie(request.url);
}
