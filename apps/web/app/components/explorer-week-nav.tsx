import { Link } from "react-router";
import { explorerLeagueWeekHref } from "~/lib/sleeper-explorer";
import { cn } from "~/lib/utils";

export function ExplorerWeekNav({
  leagueId,
  maxWeek,
  selectedWeek,
}: {
  leagueId: string;
  maxWeek: number;
  selectedWeek: number;
}) {
  const weeks = Array.from({ length: Math.max(1, maxWeek) }, (_, index) => index + 1);
  return (
    <nav aria-label="Select week" className="flex flex-wrap gap-1.5">
      {weeks.map((week) => {
        const selected = week === selectedWeek;
        return (
          <Link
            key={week}
            to={explorerLeagueWeekHref(leagueId, week)}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums",
              selected ? "bg-live text-ink" : "bg-turf text-muted hover:text-cream",
            )}
          >
            {week}
          </Link>
        );
      })}
    </nav>
  );
}
