import { ExplorerAvatar } from "~/components/explorer-avatar";
import { formatExplorerScore, type ExplorerPlayer } from "~/lib/sleeper-explorer";
import { cn } from "~/lib/utils";

// `align="right"` mirrors the row (score on the inner edge) for the right side of a matchup.
export function ExplorerPlayerList({
  players,
  empty,
  align = "left",
}: {
  players: ExplorerPlayer[];
  empty: string;
  align?: "left" | "right";
}) {
  const mirrored = align === "right";
  if (players.length === 0) return <p className={cn("text-sm text-muted", mirrored && "text-right")}>{empty}</p>;
  return (
    <ul className="divide-y divide-cream/10">
      {players.map((player) => (
        <li key={player.playerId} className={cn("flex items-center gap-2 py-2", mirrored && "flex-row-reverse text-right")}>
          <ExplorerAvatar src={player.headshotUrl} name={player.name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-cream">{player.name}</p>
            <p className="truncate text-[11px] text-muted">
              {[player.position, player.team].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
          <span className="shrink-0 text-sm tabular-nums text-cream">{formatExplorerScore(player.points)}</span>
        </li>
      ))}
    </ul>
  );
}
