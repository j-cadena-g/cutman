import { Link } from "react-router";
import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerLeagueChrome, ExplorerPage } from "~/components/explorer-page";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerDrafts } from "~/lib/sleeper-explorer.server";
import { describeExplorerError, formatExplorerDraftPick, formatLeagueStatus } from "~/lib/sleeper-explorer";
import { requireUser } from "~/lib/session.server";
import type { Route } from "./+types/explore-league-draft";

export async function loader(args: Route.LoaderArgs) {
  const user = await requireUser(args);
  const env = cloudflareEnv(args.context);
  const result = await lookupExplorerDrafts(explorerDepsFromEnv(env), {
    sleeperLeagueId: args.params.sleeperLeagueId ?? "",
    clerkUserId: user.id,
  });
  return { result };
}

export default function ExploreLeagueDraft({ loaderData }: Route.ComponentProps) {
  const { result } = loaderData;
  return (
    <ExplorerPage>
      {result.kind === "ok" ? (
        <>
          <ExplorerLeagueChrome
            avatarUrl={result.league.avatarUrl}
            name={result.league.name}
            eyebrow="Draft"
            meta={formatLeagueStatus(result.league.status)}
            leagueId={result.league.sleeperLeagueId}
          />
          {result.stale ? (
            <p className="mt-3 text-sm text-muted">Some Sleeper data could not be refreshed and may be incomplete.</p>
          ) : null}

          <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
            <div className="min-w-0">
              {result.drafts.length === 0 ? (
                <Card>
                  <CardTitle>No drafts yet</CardTitle>
                  <CardDescription>Sleeper didn&apos;t return a draft board for this league.</CardDescription>
                </Card>
              ) : (
                result.drafts.map((draft) => (
                  <section key={draft.draftId}>
                    <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                      {draft.type ?? "Draft"} {draft.season ? `· ${draft.season}` : ""} {draft.status ? `· ${draft.status}` : ""}
                    </h2>
                    {draft.picks.length === 0 ? (
                      <p className="mt-3 text-sm text-muted">No picks listed for this draft.</p>
                    ) : (
                      <ol className="mt-3 grid gap-px overflow-hidden rounded-2xl border border-cream/12 bg-field/80 sm:grid-cols-2 xl:grid-cols-3">
                        {draft.picks.map((pick, index) => (
                          <li
                            key={`${draft.draftId}-${pick.pickNo ?? "empty"}-${pick.player.playerId}-${index}`}
                            className="flex items-center gap-3 bg-field px-4 py-2.5"
                          >
                            <span className="w-10 text-xs tabular-nums text-muted">
                              {formatExplorerDraftPick(pick.round, pick.pickInRound)}
                            </span>
                            <ExplorerAvatar src={pick.player.headshotUrl} name={pick.player.name} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm text-cream">{pick.player.name || "Empty pick"}</p>
                              <p className="truncate text-[11px] text-muted">{pick.teamName}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                ))
              )}
            </div>

            <aside className="pb-16 lg:sticky lg:top-4">
              <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Traded picks</h2>
              {result.tradedPicks.length === 0 ? (
                <p className="mt-3 text-sm text-muted">No traded picks on file.</p>
              ) : (
                <ul className="mt-3 divide-y divide-cream/10 overflow-hidden rounded-2xl border border-cream/12 bg-field/80">
                  {result.tradedPicks.map((pick) => (
                    <li key={`${pick.season}-${pick.round}-${pick.rosterId ?? "none"}-${pick.fromTeam}-${pick.toTeam}`} className="px-4 py-3 text-sm text-cream">
                      {pick.season} round {pick.round} · {pick.fromTeam} → {pick.toTeam}
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>
        </>
      ) : (
        <>
          <h1 className="mt-3 font-display text-4xl">Explore Sleeper</h1>
          <Card className="mt-8">
            <CardTitle>{result.kind === "not_found" ? "No Sleeper league" : "Couldn't load drafts"}</CardTitle>
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
