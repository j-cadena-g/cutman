import type { StoryFact } from "./diff.ts";
import type { Tone } from "./tone.ts";

function toneSystem(tone: Tone): string {
  switch (tone) {
    case "savage":
      return "You are the league's meanest, funniest historian. Roast with specifics. Never invent stats, scores, trades, or injuries. Dress the facts only.";
    case "playful":
      return "You write the league sitcom recap. Warm, jokey, obsessed with running gags. Never invent stats, scores, trades, or injuries. Dress the facts only.";
    case "sportscenter":
      return "You are a SportsCenter anchor cold-opening this league. Punchy, broadcast, a little dramatic. Never invent stats, scores, trades, or injuries. Dress the facts only.";
    default: {
      const _exhaustive: never = tone;
      return _exhaustive;
    }
  }
}

export function beatPrompt(input: {
  tone: Tone;
  leagueName: string;
  week: number;
  bible: string[];
  facts: StoryFact[];
}): { system: string; user: string } {
  return {
    system: `${toneSystem(input.tone)} Reply with JSON only: {"copy":"..."}. One short beat (2-5 sentences).`,
    user: [
      `League: ${input.leagueName}`,
      `Week: ${input.week}`,
      `Bible / running memory:`,
      input.bible.length ? input.bible.map((line) => `- ${line}`).join("\n") : "- (empty)",
      `Facts you must dress, not invent:`,
      input.facts.map((fact) => `- [${fact.kind}] ${fact.copy}`).join("\n"),
    ].join("\n"),
  };
}

export function recapPrompt(input: {
  tone: Tone;
  leagueName: string;
  week: number;
  bible: string[];
  facts: StoryFact[];
}): { system: string; user: string } {
  return {
    system: `${toneSystem(input.tone)} Reply with JSON only: {"subject":"...","body":"..."}. Subject is an email subject line. Body is a Tuesday-morning recap in plain text, multiple short paragraphs. Never send a blank subject or body.`,
    user: [
      `League: ${input.leagueName}`,
      `Week ${input.week} is final.`,
      `Bible / running memory:`,
      input.bible.length ? input.bible.map((line) => `- ${line}`).join("\n") : "- (empty)",
      `Facts you must dress, not invent:`,
      input.facts.length ? input.facts.map((fact) => `- [${fact.kind}] ${fact.copy}`).join("\n") : "- Final scores and completed transactions only as provided.",
    ].join("\n"),
  };
}
