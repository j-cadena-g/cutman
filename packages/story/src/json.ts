export type BeatDraft = {
  copy: string;
};

export type RecapDraft = {
  subject: string;
  body: string;
};

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response was not JSON");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

export function parseBeatDraft(raw: string): BeatDraft {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || !("copy" in parsed)) {
    throw new Error("Beat JSON missing copy");
  }
  const copy = (parsed as { copy: unknown }).copy;
  if (typeof copy !== "string" || copy.trim().length === 0) {
    throw new Error("Beat copy was blank");
  }
  return { copy: copy.trim() };
}

export function parseRecapDraft(raw: string): RecapDraft {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Recap JSON missing object");
  }
  const record = parsed as { subject?: unknown; body?: unknown };
  if (typeof record.subject !== "string" || typeof record.body !== "string") {
    throw new Error("Recap JSON missing subject/body");
  }
  return { subject: record.subject.trim(), body: record.body.trim() };
}

export function isBlankRecap(draft: RecapDraft | null | undefined): boolean {
  if (!draft) return true;
  return draft.subject.trim().length === 0 || draft.body.trim().length === 0;
}

export function isBlankBeat(draft: BeatDraft | null | undefined): boolean {
  if (!draft) return true;
  return draft.copy.trim().length === 0;
}
