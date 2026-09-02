export const TONES = ["savage", "playful", "sportscenter"] as const;

export type Tone = (typeof TONES)[number];

export function isTone(value: string): value is Tone {
  return (TONES as readonly string[]).includes(value);
}

export function parseTone(value: string): Tone {
  if (isTone(value)) return value;
  throw new Error(`Unknown tone: ${value}`);
}

export function toneLabel(tone: Tone): string {
  switch (tone) {
    case "savage":
      return "Savage";
    case "playful":
      return "Playful";
    case "sportscenter":
      return "SportsCenter";
    default: {
      const _exhaustive: never = tone;
      return _exhaustive;
    }
  }
}

export function toneBlurb(tone: Tone): string {
  switch (tone) {
    case "savage":
      return "The group chat after a bad beat. No mercy, still funny.";
    case "playful":
      return "Running gags, nicknames, and light roasting. The league's sitcom.";
    case "sportscenter":
      return "Cold opens, top plays, and the music swell. Broadcast energy.";
    default: {
      const _exhaustive: never = tone;
      return _exhaustive;
    }
  }
}
