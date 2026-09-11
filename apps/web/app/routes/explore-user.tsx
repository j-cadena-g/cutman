import { Link } from "react-router";
import { BrandNav } from "~/components/brand-nav";
import { ExplorerAvatar } from "~/components/explorer-avatar";
import { Badge } from "~/components/ui/badge";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerUser } from "~/lib/sleeper-explorer.server";
import { describeExplorerError, formatLeagueStatus } from "~/lib/sleeper-explorer";
import { requireUser } from "~/lib/session.server";
import type { Route } from "./+types/explore-user";

export async function loader(args: Route.LoaderArgs) {
  const user = await requireUser(args);
  const env = cloudflareEnv(args.context);
  const username = args.params.username ?? "";
  const result = await lookupExplorerUser(explorerDepsFromEnv(env), {
    username,
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
          Try another username
        </Link>
      </p>
    </Card>
  );
}

export default function ExploreUser({ loaderData }: Route.ComponentProps) {
  const { result } = loaderData;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <BrandNav />
      {result.kind === "ok" ? (
        <>
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">Sleeper profile</p>
          <div className="mt-3 flex items-center gap-4">
            <ExplorerAvatar src={result.user.avatarUrl} name={result.user.displayName} size="lg" />
            <div>
              <h1 className="font-display text-4xl">{result.user.displayName}</h1>
              <p className="mt-1 text-muted">@{result.user.username}</p>
            </div>
          </div>
          {result.stale ? (
            <p className="mt-4 text-sm text-muted">Showing cached Sleeper data. A fresh pull wasn&apos;t available.</p>
          ) : null}
          <p className="mt-6 text-sm text-muted">
            Season {result.season} · week {result.week} · {result.leagues.length} league
            {result.leagues.length === 1 ? "" : "s"}
          </p>
          {result.leagues.length === 0 ? (
            <Card className="mt-6">
              <CardTitle>No leagues this season</CardTitle>
              <CardDescription>Sleeper didn&apos;t return any NFL leagues for this username in {result.season}.</CardDescription>
            </Card>
          ) : (
            <ul className="mt-6 space-y-3">
              {result.leagues.map((league) => (
                <li key={league.sleeperLeagueId}>
                  <Link
                    to={`/explore/leagues/${encodeURIComponent(league.sleeperLeagueId)}`}
                    className="block rounded-xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-flag/70"
                  >
                    <Card className="flex items-center gap-4 transition-colors hover:bg-turf">
                      <ExplorerAvatar src={league.avatarUrl} name={league.name} size="md" />
                      <div className="min-w-0">
                        <Badge>{formatLeagueStatus(league.status)}</Badge>
                        <CardTitle className="mt-2 truncate">{league.name}</CardTitle>
                        <CardDescription>
                          Season {league.season}
                          {league.totalRosters ? ` · ${league.totalRosters} teams` : ""}
                        </CardDescription>
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : result.kind === "not_found" ? (
        <>
          <h1 className="mt-3 font-display text-4xl">@{result.username}</h1>
          <ExplorerMessage title="No Sleeper user" detail={describeExplorerError(result.kind)} />
        </>
      ) : result.kind === "invalid_username" ? (
        <>
          <h1 className="mt-3 font-display text-4xl">Explore Sleeper</h1>
          <ExplorerMessage title="Need a username" detail={describeExplorerError(result.kind)} />
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
