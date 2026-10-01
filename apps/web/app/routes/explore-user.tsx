import { Link } from "react-router";
import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerErrorState, ExplorerPage, ExplorerStaleNotice } from "~/components/explorer-page";
import { PageTitle, SectionHeading } from "~/components/page-shell";
import { Badge } from "~/components/ui/badge";
import { Card, CardDescription, CardTitle, EmptyState } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerUser } from "~/lib/sleeper-explorer.server";
import { formatLeagueStatus, type ExplorerLeagueCard } from "~/lib/sleeper-explorer";
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

function LeagueGrid({ leagues }: { leagues: ExplorerLeagueCard[] }) {
  return (
    <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {leagues.map((league) => (
        <li key={league.sleeperLeagueId}>
          <Link
            to={`/explore/leagues/${encodeURIComponent(league.sleeperLeagueId)}`}
            className="block h-full rounded-2xl focus-ring"
          >
            <Card className="flex h-full items-center gap-4 transition-colors hover:bg-turf">
              <ExplorerAvatar src={league.avatarUrl} name={league.name} size="md" />
              <div className="min-w-0">
                <Badge variant={league.status === "in_season" ? "default" : "neutral"}>
                  {formatLeagueStatus(league.status)}
                </Badge>
                <CardTitle className="mt-2 truncate text-xl">{league.name}</CardTitle>
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
  );
}

export default function ExploreUser({ loaderData }: Route.ComponentProps) {
  const { result } = loaderData;

  if (result.kind !== "ok") {
    return (
      <ExplorerPage>
        <ExplorerErrorState kind={result.kind} heading={result.kind === "not_found" ? `@${result.username}` : undefined} />
      </ExplorerPage>
    );
  }

  return (
    <ExplorerPage>
      <header className="flex items-center gap-4">
        <ExplorerAvatar src={result.user.avatarUrl} name={result.user.displayName} size="lg" />
        <div className="min-w-0">
          <p className="eyebrow-sm text-muted">Sleeper profile</p>
          <PageTitle className="truncate">{result.user.displayName}</PageTitle>
          <p className="mt-1 text-sm text-muted">
            @{result.user.username} · week {result.week}
          </p>
        </div>
      </header>
      {result.stale ? <ExplorerStaleNotice /> : null}

      <section className="mt-8">
        <SectionHeading>
          Season {result.season} · {result.leagues.length} league{result.leagues.length === 1 ? "" : "s"}
        </SectionHeading>
        {result.leagues.length === 0 ? (
          <EmptyState
            className="mt-3 max-w-xl"
            title="No leagues this season"
            detail={`Sleeper didn't return any NFL leagues for this username in ${result.season}.`}
          />
        ) : (
          <LeagueGrid leagues={result.leagues} />
        )}
      </section>

      {result.previousSeason && result.previousLeagues.length > 0 ? (
        <section className="mt-10">
          <SectionHeading>Season {result.previousSeason}</SectionHeading>
          <LeagueGrid leagues={result.previousLeagues} />
        </section>
      ) : null}
    </ExplorerPage>
  );
}
