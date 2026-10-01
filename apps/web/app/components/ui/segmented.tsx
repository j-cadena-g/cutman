import { cn } from "~/lib/utils";

// Pill track shared by the explorer section tabs and the dashboard tone picker. The items are
// links in one place and submit buttons in the other, so this exports classes, not elements.
export const segmentedTrack = "flex gap-1 rounded-full bg-turf/80 p-1";

export function segmentedItem(active: boolean, className?: string): string {
  return cn(
    "eyebrow-sm rounded-full px-2.5 py-1.5 text-center sm:px-4 transition-colors focus-ring disabled:cursor-not-allowed disabled:opacity-50",
    active ? "bg-flag text-ink" : "text-muted hover:text-cream disabled:hover:text-muted",
    className,
  );
}
