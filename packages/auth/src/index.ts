export const SESSION_COOKIE = "lb_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAGIC_TTL_MS = 1000 * 60 * 15;

export function randomId(bytes = 18): string {
  const array = crypto.getRandomValues(new Uint8Array(bytes));
  return [...array].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sessionCookieValue(sessionId: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  const expires = new Date(Date.now() + SESSION_TTL_MS).toUTCString();
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}${secure}`;
}

export function clearSessionCookie(requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function readSessionId(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const parts = header.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.startsWith(`${SESSION_COOKIE}=`)) {
      const value = part.slice(SESSION_COOKIE.length + 1);
      return value || null;
    }
  }
  return null;
}

export function magicLinkExpiry(now = Date.now()): number {
  return now + MAGIC_TTL_MS;
}

export function sessionExpiry(now = Date.now()): number {
  return now + SESSION_TTL_MS;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
