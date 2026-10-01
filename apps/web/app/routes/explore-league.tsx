import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerManagerMeta, ExplorerRosterLink, EXPLORER_OPEN_ROSTER_EVENT } from "~/components/explorer-manager-link";
import { ExplorerMatchupCard } from "~/components/explorer-matchup-card";
import { ExplorerMovesList } from "~/components/explorer-moves-list";
import { ExplorerErrorState, ExplorerLeagueChrome, ExplorerPage, ExplorerStaleNotice } from "~/components/explorer-page";
import { SectionHeading } from "~/components/page-shell";
import { ExplorerPlayerList } from "~/components/explorer-player-list";
import { ExplorerWeekNav } from "~/components/explorer-week-nav";
import { EmptyState, surface } from "~/components/ui/card";
import { cn } from "~/lib/utils";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerBoard } from "~/lib/sleeper-explorer.server";
import {
  formatExplorerRecord,
  formatExplorerSlot,
  formatExplorerScore,
  formatLeagueStatus,
  parseExplorerWeekParam,
  type ExplorerLeagueSettings,
  type ExplorerRosterView,
  type ExplorerStandingRow,
} from "~/lib/sleeper-explorer";
import { requireUser } from "~/lib/session.server";
import type { Route } from "./+types/explore-league";

export async function loader(args: Route.LoaderArgs) {
  const user = await requireUser(args);
  const env = cloudflareEnv(args.context);
  const sleeperLeagueId = args.params.sleeperLeagueId ?? "";
  const week = parseExplorerWeekParam(new URL(args.request.url).searchParams.get("week"));
  const result = await lookupExplorerBoard(explorerDepsFromEnv(env), {
    sleeperLeagueId,
    clerkUserId: user.id,
    week,
  });
  return { result };
}

function scoringLabel(key: string): string {
  return key.replaceAll("_", " ");
}

function LeagueSettingsStrip({ settings }: { settings: ExplorerLeagueSettings }) {
  if (settings.rosterSlots.length === 0 && settings.playoffWeekStart == null && settings.scoringLines.length === 0) {
    return null;
  }
  return (
    <section className={cn(surface, "mt-6 flex flex-wrap gap-x-8 gap-y-2 px-4 py-3 text-sm text-muted")}>
      {settings.rosterSlots.length > 0 ? (
        <p>
          <span className="font-semibold text-cream">Slots</span> · {settings.rosterSlots.map(formatExplorerSlot).join(" · ")}
        </p>
      ) : null}
      {settings.playoffWeekStart != null ? (
        <p>
          <span className="font-semibold text-cream">Playoffs</span> · week {settings.playoffWeekStart}
        </p>
      ) : null}
      {settings.scoringLines.length > 0 ? (
        <p>
          <span className="font-semibold text-cream">Scoring</span> ·{" "}
          {settings.scoringLines.map((line) => `${scoringLabel(line.key)} ${line.value}`).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function ExplorerRosterPanel({ roster }: { roster: ExplorerRosterView }) {
  const { hash, key } = useLocation();
  const targeted = hash === `#roster-${roster.rosterId}`;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (targeted) setOpen(true);
  }, [targeted, key]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<number>).detail === roster.rosterId) setOpen(true);
    };
    window.addEventListener(EXPLORER_OPEN_ROSTER_EVENT, onOpen);
    return () => window.removeEventListener(EXPLORER_OPEN_ROSTER_EVENT, onOpen);
  }, [roster.rosterId]);

  return (
    <details
      id={`roster-${roster.rosterId}`}
      name="explorer-rosters"
      className={cn(surface, "group @container p-4")}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg focus-ring [&::-webkit-details-marker]:hidden">
        <ExplorerAvatar src={roster.avatarUrl} name={roster.teamName} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-cream">{roster.teamName}</span>
          <span className="block truncate text-xs text-muted">
            {formatExplorerRecord(roster.wins, roster.losses, roster.ties)}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-3 text-xs text-muted">
        <ExplorerManagerMeta
          displayName={roster.displayName}
          username={roster.username}
          isOwner={roster.isOwner}
          abandoned={roster.abandoned}
        />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-5 @xl:grid-cols-3">
        <div>
          <p className="eyebrow-sm text-muted">Starters</p>
          <div className="mt-1">
            <ExplorerPlayerList players={roster.starters} empty="None" />
          </div>
        </div>
        <div>
          <p className="eyebrow-sm text-muted">Bench</p>
          <div className="mt-1">
            <ExplorerPlayerList players={roster.bench} empty="None" />
          </div>
        </div>
        <div>
          <p className="eyebrow-sm text-muted">IR / reserve</p>
          <div className="mt-1">
            <ExplorerPlayerList players={roster.reserve} empty="None" />
          </div>
        </div>
      </div>
    </details>
  );
}

function StandingsList({ rows }: { rows: ExplorerStandingRow[] }) {
  return (
    <ol className={cn(surface, "divide-y divide-cream/10 overflow-hidden")}>
      {rows.map((row, index) => (
        <li key={row.rosterId} className="flex items-center gap-3 px-4 py-3">
          <span className="w-5 text-center text-xs font-semibold tabular-nums text-muted">{index + 1}</span>
          <ExplorerAvatar src={row.avatarUrl} name={row.teamName} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-cream">
              <ExplorerRosterLink rosterId={row.rosterId} className="rounded-sm transition-colors hover:text-flag focus-ring">
                {row.teamName}
              </ExplorerRosterLink>
            </p>
            <p className="truncate text-[11px] text-muted">
              <ExplorerManagerMeta
                displayName={row.displayName}
                username={row.username}
                isOwner={row.isOwner}
                abandoned={row.abandoned}
              />
            </p>
          </div>
          <p className="text-sm tabular-nums text-cream">{formatExplorerRecord(row.wins, row.losses, row.ties)}</p>
          <div className="w-16 text-right text-[11px] tabular-nums text-muted">
            <p className="text-sm text-cream">{formatExplorerScore(row.pointsFor)}</p>
            <p>PA {formatExplorerScore(row.pointsAgainst)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function ExploreLeague({ loaderData }: Route.ComponentProps) {
  const { result } = loaderData;

  if (result.kind !== "ok") {
    return (
      <ExplorerPage>
        <ExplorerErrorState kind={result.kind} heading={result.kind === "not_found" ? "League not found" : undefined} />
      </ExplorerPage>
    );
  }

  const { board } = result;
  return (
    <ExplorerPage>
      <ExplorerLeagueChrome
        avatarUrl={board.league.avatarUrl}
        name={board.league.name}
        meta={`Week ${board.selectedWeek} · ${board.season} · ${formatLeagueStatus(board.league.status)}`}
        leagueId={board.league.sleeperLeagueId}
      />
      <div className="mt-4">
        <ExplorerWeekNav leagueId={board.league.sleeperLeagueId} maxWeek={board.maxWeek} selectedWeek={board.selectedWeek} />
      </div>
      {result.stale ? <ExplorerStaleNotice /> : null}
      <LeagueSettingsStrip settings={board.settings} />

      <div className="mt-8 grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <SectionHeading>Standings</SectionHeading>
          <div className="mt-3">
            <StandingsList rows={board.standings} />
          </div>
        </aside>

        <div className="min-w-0 space-y-10">
          <section>
            <SectionHeading>Week {board.selectedWeek} matchups</SectionHeading>
            {board.matchups.length === 0 ? (
              <EmptyState className="mt-3" title="No matchups yet" detail="Sleeper didn't return games for this week." />
            ) : (
              <ul className="mt-3 grid grid-cols-1 gap-4 2xl:grid-cols-2">
                {board.matchups.map((matchup) => (
                  <li key={matchup.matchupId === null ? `bye-${matchup.sides[0]?.rosterId}` : `m-${matchup.matchupId}`}>
                    <ExplorerMatchupCard matchup={matchup} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionHeading>Week {board.selectedWeek} moves</SectionHeading>
            <ExplorerMovesList transactions={board.transactions} />
          </section>

          <section>
            <SectionHeading>Rosters</SectionHeading>
            <ul className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {board.rosters.map((roster) => (
                <li key={roster.rosterId} className="lg:has-open:col-span-2">
                  <ExplorerRosterPanel roster={roster} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </ExplorerPage>
  );
}
