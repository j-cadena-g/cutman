import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerManagerMeta, ExplorerRosterLink, EXPLORER_OPEN_ROSTER_EVENT } from "~/components/explorer-manager-link";
import { ExplorerMatchupCard } from "~/components/explorer-matchup-card";
import { ExplorerMovesList } from "~/components/explorer-moves-list";
import { ExplorerLeagueChrome, ExplorerPage } from "~/components/explorer-page";
import { ExplorerPlayerList } from "~/components/explorer-player-list";
import { ExplorerWeekNav } from "~/components/explorer-week-nav";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerBoard } from "~/lib/sleeper-explorer.server";
import {
  describeExplorerError,
  formatExplorerRecord,
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

function ExplorerMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <Card className="mt-8">
      <CardTitle>{title}</CardTitle>
      <CardDescription>{detail}</CardDescription>
      <p className="mt-4 text-sm">
        <Link to="/explore" className="text-flag underline-offset-4 hover:underline">
          Look up a username
        </Link>
      </p>
    </Card>
  );
}

function scoringLabel(key: string): string {
  return key.replaceAll("_", " ");
}

function LeagueSettingsStrip({ settings }: { settings: ExplorerLeagueSettings }) {
  if (settings.rosterSlots.length === 0 && settings.playoffWeekStart == null && settings.scoringLines.length === 0) {
    return null;
  }
  return (
    <section className="mt-6 flex flex-wrap gap-x-8 gap-y-2 rounded-2xl border border-cream/12 bg-field/80 px-4 py-3 text-sm text-muted">
      {settings.rosterSlots.length > 0 ? (
        <p>
          <span className="font-semibold text-cream">Slots</span> · {settings.rosterSlots.join(" · ")}
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
      className="rounded-2xl border border-cream/12 bg-field/80 p-4"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <ExplorerAvatar src={roster.avatarUrl} name={roster.teamName} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-cream">{roster.teamName}</span>
          <span className="block truncate text-xs text-muted">
            {formatExplorerRecord(roster.wins, roster.losses, roster.ties)}
          </span>
        </span>
      </summary>
      <div className="mt-3 text-xs text-muted">
        <ExplorerManagerMeta
          displayName={roster.displayName}
          username={roster.username}
          isOwner={roster.isOwner}
          abandoned={roster.abandoned}
        />
      </div>
      <div className="mt-4 grid gap-5 sm:grid-cols-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Starters</p>
          <div className="mt-1">
            <ExplorerPlayerList players={roster.starters} empty="None" />
          </div>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Bench</p>
          <div className="mt-1">
            <ExplorerPlayerList players={roster.bench} empty="None" />
          </div>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">IR / reserve</p>
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
    <ol className="divide-y divide-cream/10 overflow-hidden rounded-2xl border border-cream/12 bg-field/80">
      {rows.map((row, index) => (
        <li key={row.rosterId} className="flex items-center gap-3 px-4 py-3">
          <span className="w-5 text-center text-xs font-semibold tabular-nums text-muted">{index + 1}</span>
          <ExplorerAvatar src={row.avatarUrl} name={row.teamName} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-cream">
              <ExplorerRosterLink rosterId={row.rosterId} className="hover:text-live">
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

  return (
    <ExplorerPage>
      {result.kind === "ok" ? (
        <>
          <ExplorerLeagueChrome
            avatarUrl={result.board.league.avatarUrl}
            name={result.board.league.name}
            eyebrow="Sleeper league"
            meta={`Week ${result.board.selectedWeek} · ${result.board.season} · ${formatLeagueStatus(result.board.league.status)}`}
            leagueId={result.board.league.sleeperLeagueId}
          />
          <div className="mt-4">
            <ExplorerWeekNav
              leagueId={result.board.league.sleeperLeagueId}
              maxWeek={result.board.maxWeek}
              selectedWeek={result.board.selectedWeek}
            />
          </div>
          {result.stale ? (
            <p className="mt-3 text-sm text-muted">Showing cached Sleeper data. A fresh pull wasn&apos;t available.</p>
          ) : null}
          <LeagueSettingsStrip settings={result.board.settings} />

          <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
            <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
              <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Standings</h2>
              <div className="mt-3">
                <StandingsList rows={result.board.standings} />
              </div>
            </aside>

            <div className="min-w-0 space-y-10">
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                  Week {result.board.selectedWeek} matchups
                </h2>
                {result.board.matchups.length === 0 ? (
                  <Card className="mt-3">
                    <CardTitle>No matchups yet</CardTitle>
                    <CardDescription>Sleeper didn&apos;t return games for this week.</CardDescription>
                  </Card>
                ) : (
                  <ul className="mt-3 grid gap-4 2xl:grid-cols-2">
                    {result.board.matchups.map((matchup) => (
                      <li
                        key={matchup.matchupId === null ? `bye-${matchup.sides[0]?.rosterId}` : `m-${matchup.matchupId}`}
                      >
                        <ExplorerMatchupCard matchup={matchup} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                  Week {result.board.selectedWeek} moves
                </h2>
                <ExplorerMovesList transactions={result.board.transactions} />
              </section>

              <section className="pb-16">
                <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Rosters</h2>
                <ul className="mt-3 grid gap-3 lg:grid-cols-2">
                  {result.board.rosters.map((roster) => (
                    <li key={roster.rosterId}>
                      <ExplorerRosterPanel roster={roster} />
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        </>
      ) : result.kind === "not_found" ? (
        <>
          <h1 className="mt-3 font-display text-4xl">League not found</h1>
          <ExplorerMessage title="No Sleeper league" detail={describeExplorerError(result.kind)} />
        </>
      ) : result.kind === "rate_limited" ? (
        <>
          <h1 className="mt-3 font-display text-4xl">Explore Sleeper</h1>
          <ExplorerMessage title="Sleeper is throttling" detail={describeExplorerError(result.kind)} />
        </>
      ) : result.kind === "quota_exceeded" ? (
        <>
          <h1 className="mt-3 font-display text-4xl">Explore Sleeper</h1>
          <ExplorerMessage title="Lookup limit reached" detail={describeExplorerError(result.kind)} />
        </>
      ) : result.kind === "unavailable" ? (
        <>
          <h1 className="mt-3 font-display text-4xl">Explore Sleeper</h1>
          <ExplorerMessage title="Couldn't reach Sleeper" detail={describeExplorerError(result.kind)} />
        </>
      ) : (
        (() => {
          const exhaustive: never = result;
          return exhaustive;
        })()
      )}
    </ExplorerPage>
  );
}
