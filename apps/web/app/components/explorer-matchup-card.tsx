import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerPlayerList } from "~/components/explorer-player-list";
import {
  formatExplorerRecord,
  formatExplorerScore,
  isRealPlayerId,
  matchupLeader,
  zipMatchupStarters,
  type ExplorerMatchupView,
  type ExplorerPlayer,
  type ExplorerMatchupSide,
} from "~/lib/sleeper-explorer";
import { cn } from "~/lib/utils";

function slotLabel(slot: string | null): string {
  if (!slot) return "—";
  if (slot === "SUPER_FLEX") return "SF";
  if (slot === "IDP_FLEX") return "IDP";
  if (slot === "REC_FLEX") return "REC";
  return slot;
}

function slotClass(slot: string | null): string {
  const key = (slot ?? "").split("/")[0] ?? "";
  switch (key) {
    case "QB":
    case "SUPER_FLEX":
      return "text-amber-300";
    case "RB":
      return "text-emerald-300";
    case "WR":
      return "text-sky-300";
    case "TE":
      return "text-rose-300";
    case "K":
      return "text-violet-300";
    case "DEF":
      return "text-orange-200";
    case "FLEX":
    case "REC_FLEX":
    case "WRRBTE":
      return "text-lime-300";
    default:
      return "text-muted";
  }
}

const MATCHUP_COLS = "grid grid-cols-[minmax(0,1fr)_2.25rem_minmax(0,1fr)] items-center gap-2";
const MATCHUP_PAD = "px-4 sm:px-5";

function TeamPane({
  side,
  align,
  leading,
}: {
  side: ExplorerMatchupSide;
  align: "left" | "right";
  leading: boolean;
}) {
  const record = formatExplorerRecord(side.wins, side.losses, side.ties);
  const mirrored = align === "right";
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", mirrored && "items-end text-right")}>
      <div className={cn("flex min-w-0 items-center gap-2", mirrored && "flex-row-reverse")}>
        <ExplorerAvatar src={side.avatarUrl} name={side.teamName} size="md" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-cream">{side.teamName}</p>
          <p className="truncate text-xs text-muted">
            {side.abandoned ? "Abandoned" : side.displayName} · {record}
          </p>
        </div>
      </div>
      <p
        className={cn(
          "font-sans text-2xl font-bold leading-none tabular-nums tracking-tight sm:text-3xl",
          leading ? "text-live" : "text-cream",
        )}
      >
        {formatExplorerScore(side.points)}
      </p>
    </div>
  );
}

function StarterFace({
  player,
  align,
  winning,
}: {
  player: ExplorerPlayer | null;
  align: "left" | "right";
  winning: boolean;
}) {
  const empty = !player || !isRealPlayerId(player.playerId);
  const name = empty ? "Empty" : player.name;
  const meta = empty ? "—" : [player.team, player.position].filter(Boolean).join(" · ");
  return (
    <div className={cn("flex min-w-0 items-center gap-2", align === "right" && "flex-row-reverse text-right")}>
      <ExplorerAvatar src={empty ? null : player.headshotUrl} name={name} size="sm" />
      <div className="min-w-0">
        <p className={cn("truncate text-sm", empty ? "text-muted" : "text-cream")}>{name}</p>
        <p className="truncate text-[11px] text-muted">{meta}</p>
      </div>
      <p
        className={cn(
          "shrink-0 text-sm font-semibold tabular-nums",
          winning ? "text-live" : "text-cream",
          empty && "text-muted",
        )}
      >
        {formatExplorerScore(empty ? null : player.points)}
      </p>
    </div>
  );
}

export function ExplorerMatchupCard({ matchup }: { matchup: ExplorerMatchupView }) {
  const left = matchup.sides[0];
  const right = matchup.sides[1];
  const leaderId = matchupLeader(matchup.sides);
  const bye = matchup.matchupId === null || !right || !left;
  const lines = zipMatchupStarters(left?.starters ?? [], right?.starters ?? []);
  const label = bye
    ? `${left?.teamName ?? "Bye"} bye`
    : `${left?.teamName ?? "Team"} vs ${right?.teamName ?? "Team"}`;

  return (
    <article className="overflow-hidden rounded-2xl border border-cream/12 bg-field/80 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
      <div className="px-4 py-4 sm:px-5">
        {bye ? (
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-live">Bye</p>
        ) : null}
        {bye || !left || !right ? (
          left ? (
            <TeamPane side={left} align="left" leading={false} />
          ) : (
            <p className="text-sm text-muted">No team on this bye.</p>
          )
        ) : (
          <div className={cn(MATCHUP_COLS, "items-start")}>
            <TeamPane side={left} align="left" leading={leaderId === left.rosterId} />
            <p className="pt-4 text-center text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">vs</p>
            <TeamPane side={right} align="right" leading={leaderId === right.rosterId} />
          </div>
        )}
        <h3 className="sr-only">{label}</h3>
      </div>

      {bye ? (
        <div className="border-t border-cream/10 px-4 py-1 sm:px-5">
          <ExplorerPlayerList players={(left?.starters ?? []).filter((player) => isRealPlayerId(player.playerId))} empty="No starters listed." />
        </div>
      ) : lines.length > 0 ? (
        <div>
          <div className={cn(MATCHUP_COLS, MATCHUP_PAD, "border-t border-cream/10 py-2 text-xs font-semibold text-cream")}>
            <p className="truncate">{left.teamName}</p>
            <p aria-hidden="true" />
            <p className="truncate text-right">{right.teamName}</p>
          </div>
          <ol className="divide-y divide-cream/10 border-t border-cream/10">
          {lines.map((line, index) => {
            const leftWins =
              line.left?.points != null && line.right?.points != null && line.left.points > line.right.points;
            const rightWins =
              line.left?.points != null && line.right?.points != null && line.right.points > line.left.points;
            return (
              <li
                key={`${line.slot ?? "slot"}-${line.left?.playerId ?? "empty"}-${line.right?.playerId ?? "empty"}-${index}`}
                className={cn(MATCHUP_COLS, MATCHUP_PAD, "py-2.5")}
              >
                <StarterFace player={line.left} align="left" winning={leftWins} />
                <p className={cn("text-center text-[11px] font-bold tracking-wide", slotClass(line.slot))}>
                  {slotLabel(line.slot)}
                </p>
                <StarterFace player={line.right} align="right" winning={rightWins} />
              </li>
            );
          })}
          </ol>
        </div>
      ) : (
        <p className="border-t border-cream/10 px-4 py-3 text-sm text-muted sm:px-5">No starters listed.</p>
      )}
    </article>
  );
}
