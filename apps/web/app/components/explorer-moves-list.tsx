import { ExplorerAvatar } from "~/components/explorer-avatar";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
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
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{label}</p>
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
      <Card className="mt-3">
        <CardTitle className="text-lg">No moves this week</CardTitle>
        <CardDescription>Sleeper didn&apos;t return waivers, trades, or free-agent claims for this week.</CardDescription>
      </Card>
    );
  }

  return (
    <ul className="mt-3 grid gap-3 xl:grid-cols-2">
      {transactions.map((transaction) => (
        <li key={transaction.transactionId} className="rounded-2xl border border-cream/12 bg-field/80 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-cream">
              {formatExplorerMoveType(transaction.type)}
              <span className="ml-2 text-xs font-medium uppercase tracking-[0.14em] text-muted">
                {transaction.status}
              </span>
            </p>
            <p className="truncate text-xs text-muted">{transaction.teamNames.join(" · ")}</p>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
