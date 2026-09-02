import { describe, expect, it } from "vitest";
import { isValidEmail, normalizeEmail, readSessionId, SESSION_COOKIE, sessionCookieValue } from "./index.ts";

describe("auth cookies", () => {
  it("writes an httpOnly session cookie", () => {
    const cookie = sessionCookieValue("abc123", "http://127.0.0.1:41789/login");
    expect(cookie).toContain(`${SESSION_COOKIE}=abc123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
  });

  it("reads the session id back off a request", () => {
    const request = new Request("http://localhost/", {
      headers: { Cookie: `${SESSION_COOKIE}=abc123; other=1` },
    });
    expect(readSessionId(request)).toBe("abc123");
  });

  it("normalizes emails", () => {
    expect(normalizeEmail(" Manager@Example.test ")).toBe("manager@example.test");
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("manager@example.test")).toBe(true);
  });
});
