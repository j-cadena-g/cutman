import { Link } from "react-router";
import { ExplorerLeagueChrome, ExplorerPage } from "~/components/explorer-page";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerBrackets } from "~/lib/sleeper-explorer.server";
import { describeExplorerError, formatLeagueStatus, type ExplorerBracketGameView } from "~/lib/sleeper-explorer";
import { requireUser } from "~/lib/session.server";
import type { Route } from "./+types/explore-league-brackets";

export async function loader(args: Route.LoaderArgs) {
  const user = await requireUser(args);
  const env = cloudflareEnv(args.context);
  const result = await lookupExplorerBrackets(explorerDepsFromEnv(env), {
    sleeperLeagueId: args.params.sleeperLeagueId ?? "",
    clerkUserId: user.id,
  });
  return { result };
}

function BracketList({ title, games }: { title: string; games: ExplorerBracketGameView[] }) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">{title}</h2>
      {games.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No games posted yet.</p>
      ) : (
        <ol className="mt-3 grid gap-2 sm:grid-cols-2">
          {games.map((game) => (
            <li key={`${title}-${game.round}-${game.match}`} className="rounded-2xl border border-cream/12 bg-field/80 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                Round {game.round} · match {game.match}
              </p>
              <p className="mt-1 text-sm text-cream">
                {game.left} vs {game.right}
              </p>
              {game.winner ? <p className="mt-1 text-xs text-live">Winner · {game.winner}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function ExploreLeagueBrackets({ loaderData }: Route.ComponentProps) {
  const { result } = loaderData;
  return (
    <ExplorerPage>
      {result.kind === "ok" ? (
        <>
          <ExplorerLeagueChrome
            avatarUrl={result.league.avatarUrl}
            name={result.league.name}
            eyebrow="Brackets"
            meta={formatLeagueStatus(result.league.status)}
            leagueId={result.league.sleeperLeagueId}
          />
          {result.stale ? (
            <p className="mt-3 text-sm text-muted">Showing cached Sleeper data. A fresh pull wasn&apos;t available.</p>
          ) : null}
          <div className="mt-8 grid items-start gap-8 pb-16 lg:grid-cols-2">
            <BracketList title="Winners" games={result.winners} />
            <BracketList title="Consolation" games={result.losers} />
          </div>
        </>
      ) : (
        <>
          <h1 className="mt-3 font-display text-4xl">Explore Sleeper</h1>
          <Card className="mt-8">
            <CardTitle>{result.kind === "not_found" ? "No Sleeper league" : "Couldn't load brackets"}</CardTitle>
            <CardDescription>{describeExplorerError(result.kind === "not_found" ? "not_found" : result.kind)}</CardDescription>
            <p className="mt-4 text-sm">
              <Link to="/explore" className="text-flag underline-offset-4 hover:underline">
                Look up a username
              </Link>
            </p>
          </Card>
        </>
      )}
    </ExplorerPage>
  );
}
