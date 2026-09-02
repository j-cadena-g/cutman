const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type EasternParts = {
  hour: number;
  weekday: number;
  weekdayLabel: string;
};

export function easternParts(now: Date): EasternParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(now);
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hourRaw = parts.find((part) => part.type === "hour")?.value ?? "0";
  const hour = Number.parseInt(hourRaw, 10) % 24;
  const weekday = WEEKDAY_INDEX[weekdayLabel] ?? 0;
  return { hour, weekday, weekdayLabel };
}

export function shouldPoll(parts: EasternParts): boolean {
  return parts.hour % 3 === 0;
}

export function shouldAttemptTuesdayRecap(parts: EasternParts): boolean {
  return parts.weekday === 2 && (parts.hour === 9 || parts.hour === 13 || parts.hour === 19);
}
