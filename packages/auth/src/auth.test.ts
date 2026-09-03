import { describe, expect, it } from "vitest";
import { isValidEmail, normalizeEmail } from "./index.ts";

describe("email helpers", () => {
  it("normalizes emails", () => {
    expect(normalizeEmail(" Manager@Example.test ")).toBe("manager@example.test");
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("manager@example.test")).toBe(true);
  });
});
