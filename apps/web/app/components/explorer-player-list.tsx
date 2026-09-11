import { ExplorerAvatar } from "~/components/explorer-avatar";
import { formatExplorerScore, type ExplorerPlayer } from "~/lib/sleeper-explorer";

export function ExplorerPlayerList({ players, empty }: { players: ExplorerPlayer[]; empty: string }) {
  if (players.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-cream/10">
      {players.map((player) => (
        <li key={player.playerId} className="flex items-center gap-2 py-2">
          <ExplorerAvatar src={player.headshotUrl} name={player.name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-cream">{player.name}</p>
            <p className="truncate text-[11px] text-muted">
              {[player.position, player.team].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
          <span className="text-sm tabular-nums text-cream">{formatExplorerScore(player.points)}</span>
        </li>
      ))}
    </ul>
  );
}
