import type { StoryFact } from "./diff.ts";
import { isBlankRecap, type RecapDraft } from "./json.ts";
import { isWeekFinal } from "./week.ts";
import type { SleeperMatchup } from "@cutman/sleeper";

export type RecapStatus = "skipped_not_final" | "skipped_already" | "published" | "model_error" | "blank";

export type RecapAttemptResult =
  | { status: "skipped_not_final" }
  | { status: "skipped_already" }
  | { status: "model_error"; error: string }
  | { status: "blank" }
  | { status: "published"; recap: RecapDraft };

export type RecapPorts = {
  week: number;
  matchups: SleeperMatchup[];
  existingRecap: RecapDraft | null;
  facts: StoryFact[];
  generate: (facts: StoryFact[]) => Promise<RecapDraft>;
  archive: (recap: RecapDraft) => Promise<void>;
  email: (recap: RecapDraft) => Promise<void>;
};

export async function runRecapAttempt(ports: RecapPorts): Promise<RecapAttemptResult> {
  if (!isWeekFinal(ports.matchups)) {
    return { status: "skipped_not_final" };
  }
  if (ports.existingRecap) {
    return { status: "skipped_already" };
  }

  let draft: RecapDraft;
  try {
    draft = await ports.generate(ports.facts);
  } catch (error) {
    const message = error instanceof Error ? error.message : "model error";
    return { status: "model_error", error: message };
  }

  if (isBlankRecap(draft)) {
    return { status: "blank" };
  }

  await ports.archive(draft);
  await ports.email(draft);
  return { status: "published", recap: draft };
}

export function recapStatusLabel(status: RecapStatus): string {
  switch (status) {
    case "skipped_not_final":
      return "Week is not final";
    case "skipped_already":
      return "Recap already archived";
    case "published":
      return "Archived and emailed";
    case "model_error":
      return "Model failed; nothing published";
    case "blank":
      return "Blank recap; nothing sent";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
