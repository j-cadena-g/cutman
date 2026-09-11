import { Link } from "react-router";
import { BrandNav } from "~/components/brand-nav";
import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerMatchupCard } from "~/components/explorer-matchup-card";
import { ExplorerPlayerList } from "~/components/explorer-player-list";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerBoard } from "~/lib/sleeper-explorer.server";
import {
  describeExplorerError,
  formatExplorerRecord,
  formatExplorerScore,
  formatLeagueStatus,
  type ExplorerStandingRow,
} from "~/lib/sleeper-explorer";
import { requireUser } from "~/lib/session.server";
import type { Route } from "./+types/explore-league";

export async function loader(args: Route.LoaderArgs) {
  const user = await requireUser(args);
  const env = cloudflareEnv(args.context);
  const sleeperLeagueId = args.params.sleeperLeagueId ?? "";
  const result = await lookupExplorerBoard(explorerDepsFromEnv(env), {
    sleeperLeagueId,
    clerkUserId: user.id,
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

function StandingsList({ rows }: { rows: ExplorerStandingRow[] }) {
  return (
    <ol className="divide-y divide-cream/10 overflow-hidden rounded-2xl border border-cream/12 bg-field/80">
      {rows.map((row, index) => (
        <li key={row.rosterId} className="flex items-center gap-3 px-4 py-3">
          <span className="w-5 text-center text-xs font-semibold tabular-nums text-muted">{index + 1}</span>
          <ExplorerAvatar src={row.avatarUrl} name={row.teamName} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-cream">{row.teamName}</p>
            <p className="truncate text-[11px] text-muted">{row.abandoned ? "Abandoned" : row.displayName}</p>
          </div>
          <p className="text-sm tabular-nums text-cream">{formatExplorerRecord(row.wins, row.losses, row.ties)}</p>
          <p className="w-16 text-right text-sm tabular-nums text-muted">{formatExplorerScore(row.pointsFor)}</p>
        </li>
      ))}
    </ol>
  );
}

export default function ExploreLeague({ loaderData }: Route.ComponentProps) {
  const { result } = loaderData;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <BrandNav />
      {result.kind === "ok" ? (
        <>
          <div className="mt-5 flex items-center gap-4">
            <ExplorerAvatar src={result.board.league.avatarUrl} name={result.board.league.name} size="lg" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Sleeper league</p>
              <h1 className="truncate font-display text-3xl leading-tight md:text-4xl">{result.board.league.name}</h1>
              <p className="mt-1 text-sm text-muted">
                Week {result.board.week} · {result.board.season} · {formatLeagueStatus(result.board.league.status)}
              </p>
            </div>
          </div>
          {result.stale ? (
            <p className="mt-3 text-sm text-muted">Showing cached Sleeper data. A fresh pull wasn&apos;t available.</p>
          ) : null}

          <section className="mt-10">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Standings</h2>
            <div className="mt-3">
              <StandingsList rows={result.board.standings} />
            </div>
          </section>

          <section className="mt-10">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              Week {result.board.week} matchups
            </h2>
            {result.board.matchups.length === 0 ? (
              <Card className="mt-3">
                <CardTitle>No matchups yet</CardTitle>
                <CardDescription>Sleeper didn&apos;t return games for this week.</CardDescription>
              </Card>
            ) : (
              <ul className="mt-3 space-y-4">
                {result.board.matchups.map((matchup) => (
                  <li key={matchup.matchupId === null ? `bye-${matchup.sides[0]?.rosterId}` : `m-${matchup.matchupId}`}>
                    <ExplorerMatchupCard matchup={matchup} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-10 pb-16">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Rosters</h2>
            <ul className="mt-3 space-y-3">
              {result.board.rosters.map((roster) => (
                <li key={roster.rosterId}>
                  <details className="rounded-2xl border border-cream/12 bg-field/80 p-4">
                    <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
                      <ExplorerAvatar src={roster.avatarUrl} name={roster.teamName} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-cream">{roster.teamName}</span>
                        <span className="block truncate text-xs text-muted">
                          {roster.abandoned ? "Abandoned" : roster.displayName} ·{" "}
                          {formatExplorerRecord(roster.wins, roster.losses, roster.ties)}
                        </span>
                      </span>
                    </summary>
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
                </li>
              ))}
            </ul>
          </section>
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
    </main>
  );
}
