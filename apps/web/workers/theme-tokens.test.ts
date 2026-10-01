/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import appCss from "../app/app.css?raw";
import { clerkAppearance } from "../app/lib/clerk-appearance.ts";

// Clerk's appearance API needs literal colors, so clerk-appearance.ts repeats the @theme hex
// values. This keeps the two from drifting apart.
function themeColor(name: string): string {
  const match = appCss.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  if (!match) throw new Error(`--color-${name} missing from app.css`);
  return match[1].toLowerCase();
}

describe("theme tokens", () => {
  it("keeps Clerk's colors in sync with app.css", () => {
    const { variables } = clerkAppearance;
    expect(variables.colorPrimary).toBe(themeColor("flag"));
    expect(variables.colorBackground).toBe(themeColor("field"));
    expect(variables.colorNeutral).toBe(themeColor("muted"));
    expect(variables.colorText).toBe(themeColor("cream"));
    expect(variables.colorTextSecondary).toBe(themeColor("muted"));
    expect(variables.colorInputBackground).toBe(themeColor("ink"));
    expect(variables.colorInputText).toBe(themeColor("cream"));
    expect(variables.colorDanger).toBe(themeColor("danger"));
  });

  it("keeps Clerk's corner radius in sync with app.css", () => {
    expect(appCss).toContain(`--radius-md: ${clerkAppearance.variables.borderRadius};`);
  });
});
