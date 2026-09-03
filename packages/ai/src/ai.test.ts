import { describe, expect, it } from "vitest";
import { GEMMA_MODEL, generateBeat, generateRecap, type WorkersAi } from "./index.ts";

describe("gemma json dress-up", () => {
  it("parses a beat {copy} payload from the model", async () => {
    const ai: WorkersAi = {
      async run(model) {
        expect(model).toBe(GEMMA_MODEL);
        return { response: '{"copy":"Alex just fleeced the chat for CeeDee."}' };
      },
    };
    const beat = await generateBeat(ai, "sys", "user");
    expect(beat.copy).toContain("CeeDee");
  });

  it("parses a recap {subject,body} payload from the model", async () => {
    const ai: WorkersAi = {
      async run() {
        return {
          response: '{"subject":"Week 3 belongs to Alex","body":"CeeDee changed hands and the chat lost its mind."}',
        };
      },
    };
    const recap = await generateRecap(ai, "sys", "user");
    expect(recap.subject).toContain("Week 3");
    expect(recap.body).toContain("CeeDee");
  });

  it("throws when the model returns unusable output", async () => {
    const ai: WorkersAi = {
      async run() {
        return { response: "nope" };
      },
    };
    await expect(generateRecap(ai, "sys", "user")).rejects.toThrow(/JSON/);
  });
});
