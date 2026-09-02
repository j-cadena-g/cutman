import { parseBeatDraft, parseRecapDraft, type BeatDraft, type RecapDraft } from "@cutman/story";

export const GEMMA_MODEL = "@cf/google/gemma-4-26b-a4b-it" as const;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type WorkersAi = {
  run: (
    model: typeof GEMMA_MODEL,
    inputs: {
      messages: ChatMessage[];
      chat_template_kwargs?: { enable_thinking: boolean };
    },
  ) => Promise<unknown>;
};

function responseText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") {
    throw new Error("Empty model response");
  }
  const record = raw as {
    response?: unknown;
    result?: { response?: unknown };
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof record.response === "string") return record.response;
  if (typeof record.result?.response === "string") return record.result.response;
  const content = record.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  throw new Error("Unrecognized model response");
}

export async function runGemma(ai: WorkersAi, system: string, user: string): Promise<string> {
  const raw = await ai.run(GEMMA_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    chat_template_kwargs: { enable_thinking: false },
  });
  return responseText(raw);
}

export async function generateBeat(ai: WorkersAi, system: string, user: string): Promise<BeatDraft> {
  return parseBeatDraft(await runGemma(ai, system, user));
}

export async function generateRecap(ai: WorkersAi, system: string, user: string): Promise<RecapDraft> {
  return parseRecapDraft(await runGemma(ai, system, user));
}
