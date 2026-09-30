import { Link, useLocation } from "react-router";
import { explorerLeaguePath } from "~/lib/sleeper-explorer";
import { cn } from "~/lib/utils";

export function ExplorerLeagueNav({ leagueId }: { leagueId: string }) {
  const { pathname } = useLocation();
  const scoreboard = explorerLeaguePath(leagueId);
  const draft = explorerLeaguePath(leagueId, "draft");
  const brackets = explorerLeaguePath(leagueId, "brackets");
  const items = [
    { href: scoreboard, label: "Scoreboard", active: pathname === scoreboard },
    { href: draft, label: "Draft", active: pathname === draft },
    { href: brackets, label: "Brackets", active: pathname === brackets },
  ];
  return (
    <nav aria-label="League sections" className="flex w-full gap-1 rounded-full bg-turf/80 p-1 lg:w-auto">
      {items.map((item) => (
        <Link
          key={item.href}
          to={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "flex-1 rounded-full px-3 py-1.5 text-center text-xs font-semibold uppercase tracking-[0.14em] lg:flex-none lg:px-4",
            item.active ? "bg-live text-ink" : "text-muted hover:text-cream",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
