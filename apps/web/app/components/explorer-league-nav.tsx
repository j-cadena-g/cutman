import { Link, useLocation } from "react-router";
import { segmentedItem, segmentedTrack } from "~/components/ui/segmented";
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
    <nav aria-label="League sections" className={cn(segmentedTrack, "w-full lg:w-auto")}>
      {items.map((item) => (
        <Link
          key={item.href}
          to={item.href}
          aria-current={item.active ? "page" : undefined}
          className={segmentedItem(item.active, "flex-1 lg:flex-none")}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
