import { ExplorerAvatar } from "~/components/explorer-avatar";
import { EmptyState, surface } from "~/components/ui/card";
import { cn } from "~/lib/utils";
import { formatExplorerMoveType, type ExplorerTransactionView } from "~/lib/sleeper-explorer";

function MovePlayers({
  label,
  moves,
}: {
  label: string;
  moves: ExplorerTransactionView["adds"];
}) {
  if (moves.length === 0) return null;
  return (
    <div>
      <p className="eyebrow-sm text-muted">{label}</p>
      <ul className="mt-1 space-y-1">
        {moves.map((move) => (
          <li key={`${label}-${move.player.playerId}-${move.rosterId}`} className="flex min-w-0 items-center gap-2">
            <ExplorerAvatar src={move.player.headshotUrl} name={move.player.name} size="sm" />
            <span className="min-w-0 truncate text-sm text-cream">{move.player.name}</span>
            <span className="truncate text-[11px] text-muted">{move.teamName}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ExplorerMovesList({ transactions }: { transactions: ExplorerTransactionView[] }) {
  if (transactions.length === 0) {
    return (
      <EmptyState
        className="mt-3"
        title="No moves this week"
        detail="Sleeper didn't return waivers, trades, or free-agent claims for this week."
      />
    );
  }

  return (
    <ul className="mt-3 space-y-3">
      {transactions.map((transaction) => (
        <li key={transaction.transactionId} className={cn(surface, "@container p-4")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-cream">
              {formatExplorerMoveType(transaction.type)}
              <span className="eyebrow-sm ml-2 text-muted">
                {transaction.status}
              </span>
            </p>
            <p className="truncate text-xs text-muted">{transaction.teamNames.join(" · ")}</p>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 @md:grid-cols-2">
            <MovePlayers label="Adds" moves={transaction.adds} />
            <MovePlayers label="Drops" moves={transaction.drops} />
          </div>
          {transaction.waiverBudget.length > 0 ? (
            <ul className="mt-3 text-xs text-muted">
              {transaction.waiverBudget.map((transfer) => (
                <li key={`${transfer.senderName}-${transfer.receiverName}-${transfer.amount}`}>
                  ${transfer.amount} FAAB · {transfer.senderName} → {transfer.receiverName}
                </li>
              ))}
            </ul>
          ) : null}
          {transaction.draftPicks.length > 0 ? (
            <ul className="mt-2 text-xs text-muted">
              {transaction.draftPicks.map((pick) => (
                <li key={`${pick.season}-${pick.round}-${pick.rosterId ?? "none"}-${pick.fromTeam}-${pick.toTeam}`}>
                  {pick.season} round {pick.round} · {pick.fromTeam} → {pick.toTeam}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
