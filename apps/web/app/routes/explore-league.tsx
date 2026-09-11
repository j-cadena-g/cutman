import { Link } from "react-router";
import { BrandNav } from "~/components/brand-nav";
import { Badge } from "~/components/ui/badge";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerBoard } from "~/lib/sleeper-explorer.server";
import { describeExplorerError, formatLeagueStatus, type ExplorerPlayer } from "~/lib/sleeper-explorer";
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

function formatPoints(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatRecord(wins: number, losses: number, ties: number): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function PlayerList({ players, empty }: { players: ExplorerPlayer[]; empty: string }) {
  if (players.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-1 text-sm">
      {players.map((player) => (
        <li key={player.playerId} className="flex justify-between gap-3">
          <span>
            {player.position ? <span className="mr-2 text-muted">{player.position}</span> : null}
            {player.name}
            {player.team ? <span className="ml-1 text-muted">{player.team}</span> : null}
          </span>
          <span className="tabular-nums text-muted">{formatPoints(player.points)}</span>
        </li>
      ))}
    </ul>
  );
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

export default function ExploreLeague({ loaderData }: Route.ComponentProps) {
  const { result } = loaderData;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <BrandNav />
      {result.kind === "ok" ? (
        <>
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">Sleeper league</p>
          <h1 className="mt-2 font-display text-4xl md:text-5xl">{result.board.league.name}</h1>
          <p className="mt-2 text-muted">
            Week {result.board.week} · season {result.board.season} · {formatLeagueStatus(result.board.league.status)}
          </p>
          {result.stale ? (
            <p className="mt-2 text-sm text-muted">Showing cached Sleeper data. A fresh pull wasn&apos;t available.</p>
          ) : null}

          <section className="mt-10">
            <h2 className="font-display text-3xl">Standings</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.16em] text-muted">
                  <tr>
                    <th scope="col" className="pb-2 font-semibold">Team</th>
                    <th scope="col" className="pb-2 font-semibold">Manager</th>
                    <th scope="col" className="pb-2 font-semibold">Record</th>
                    <th scope="col" className="pb-2 font-semibold">PF</th>
                  </tr>
                </thead>
                <tbody>
                  {result.board.standings.map((row) => (
                    <tr key={row.rosterId} className="border-t border-cream/10">
                      <td className="py-2 text-cream">{row.teamName}</td>
                      <td className="py-2 text-muted">{row.abandoned ? "Abandoned" : row.displayName}</td>
                      <td className="py-2 tabular-nums">{formatRecord(row.wins, row.losses, row.ties)}</td>
                      <td className="py-2 tabular-nums">{formatPoints(row.pointsFor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-12">
            <h2 className="font-display text-3xl">Week {result.board.week} scoreboard</h2>
            {result.board.matchups.length === 0 ? (
              <Card className="mt-4">
                <CardTitle>No matchups yet</CardTitle>
                <CardDescription>Sleeper didn&apos;t return games for this week.</CardDescription>
              </Card>
            ) : (
              <ul className="mt-4 grid gap-4 md:grid-cols-2">
                {result.board.matchups.map((matchup) => (
                  <li key={matchup.matchupId === null ? `bye-${matchup.sides[0]?.rosterId}` : `m-${matchup.matchupId}`}>
                    <Card>
                      {matchup.matchupId === null ? <Badge>Bye</Badge> : <Badge>Matchup {matchup.matchupId}</Badge>}
                      <div className="mt-4 space-y-4">
                        {matchup.sides.map((side) => (
                          <div key={side.rosterId}>
                            <div className="flex items-baseline justify-between gap-3">
                              <div>
                                <p className="text-cream">{side.teamName}</p>
                                <p className="text-xs text-muted">{side.displayName}</p>
                              </div>
                              <p className="font-display text-2xl tabular-nums">{formatPoints(side.points)}</p>
                            </div>
                            <div className="mt-2">
                              <PlayerList players={side.starters} empty="No starters listed." />
                            </div>
                          </div>
                        ))}
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-12 pb-16">
            <h2 className="font-display text-3xl">Rosters</h2>
            <ul className="mt-4 space-y-3">
              {result.board.rosters.map((roster) => (
                <li key={roster.rosterId}>
                  <details className="rounded-xl border border-cream/12 bg-field/70 p-5">
                    <summary className="cursor-pointer font-display text-xl text-cream">
                      {roster.teamName}
                      <span className="ml-2 text-sm font-sans text-muted">{roster.displayName}</span>
                    </summary>
                    <div className="mt-4 grid gap-4 md:grid-cols-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Starters</p>
                        <div className="mt-2">
                          <PlayerList players={roster.starters} empty="None" />
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Bench</p>
                        <div className="mt-2">
                          <PlayerList players={roster.bench} empty="None" />
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">IR / reserve</p>
                        <div className="mt-2">
                          <PlayerList players={roster.reserve} empty="None" />
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
