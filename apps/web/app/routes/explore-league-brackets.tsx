import { ExplorerErrorState, ExplorerLeagueChrome, ExplorerPage, ExplorerStaleNotice } from "~/components/explorer-page";
import { SectionHeading } from "~/components/page-shell";
import { EmptyState, surface } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerBrackets } from "~/lib/sleeper-explorer.server";
import { formatLeagueStatus, type ExplorerBracketGameView } from "~/lib/sleeper-explorer";
import { requireUser } from "~/lib/session.server";
import { cn } from "~/lib/utils";
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
      <SectionHeading>{title}</SectionHeading>
      {games.length === 0 ? (
        <EmptyState className="mt-3" title="No games yet" detail="Sleeper posts this bracket once the playoffs are set." />
      ) : (
        <ol className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {games.map((game) => (
            <li key={`${title}-${game.round}-${game.match}`} className={cn(surface, "px-4 py-3")}>
              <p className="eyebrow-sm text-muted">
                Round {game.round} · match {game.match}
              </p>
              <p className="mt-1 text-sm text-cream">
                {game.left} vs {game.right}
              </p>
              {game.winner ? <p className="mt-1 text-xs text-flag">Winner · {game.winner}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function ExploreLeagueBrackets({ loaderData }: Route.ComponentProps) {
  const { result } = loaderData;

  if (result.kind !== "ok") {
    return (
      <ExplorerPage>
        <ExplorerErrorState kind={result.kind} heading={result.kind === "not_found" ? "League not found" : undefined} />
      </ExplorerPage>
    );
  }

  return (
    <ExplorerPage>
      <ExplorerLeagueChrome
        avatarUrl={result.league.avatarUrl}
        name={result.league.name}
        meta={`Playoffs · ${result.league.season} · ${formatLeagueStatus(result.league.status)}`}
        leagueId={result.league.sleeperLeagueId}
      />
      {result.stale ? <ExplorerStaleNotice /> : null}
      <div className="mt-8 grid grid-cols-1 items-start gap-8 lg:grid-cols-2">
        <BracketList title="Winners" games={result.winners} />
        <BracketList title="Consolation" games={result.losers} />
      </div>
    </ExplorerPage>
  );
}
