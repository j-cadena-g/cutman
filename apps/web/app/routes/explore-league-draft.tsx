import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerErrorState, ExplorerLeagueChrome, ExplorerPage, ExplorerStaleNotice } from "~/components/explorer-page";
import { SectionHeading } from "~/components/page-shell";
import { EmptyState, surface } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { explorerDepsFromEnv, lookupExplorerDrafts } from "~/lib/sleeper-explorer.server";
import { formatExplorerDraftPick, formatLeagueStatus } from "~/lib/sleeper-explorer";
import { requireUser } from "~/lib/session.server";
import { cn } from "~/lib/utils";
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
        meta={`Draft · ${result.league.season} · ${formatLeagueStatus(result.league.status)}`}
        leagueId={result.league.sleeperLeagueId}
      />
      {result.stale ? <ExplorerStaleNotice /> : null}

      <div className="mt-8 grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <div className="min-w-0 space-y-10">
          {result.drafts.length === 0 ? (
            <EmptyState title="No drafts yet" detail="Sleeper didn't return a draft board for this league." />
          ) : (
            result.drafts.map((draft) => (
              <section key={draft.draftId}>
                <SectionHeading>
                  {[draft.type ?? "Draft", draft.season, draft.status].filter(Boolean).join(" · ")}
                </SectionHeading>
                {draft.picks.length === 0 ? (
                  <EmptyState className="mt-3" title="No picks yet" detail="Sleeper didn't list any picks for this draft." />
                ) : (
                  // `gap-px` over a cream/10 track draws the same hairlines as `divide-cream/10` elsewhere.
                  <ol
                    className={cn(
                      surface,
                      "mt-3 grid grid-cols-1 gap-px overflow-hidden bg-cream/10 sm:grid-cols-2 xl:grid-cols-3",
                    )}
                  >
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

        <aside className="min-w-0 lg:sticky lg:top-4">
          <SectionHeading>Traded picks</SectionHeading>
          {result.tradedPicks.length === 0 ? (
            <EmptyState className="mt-3" title="No traded picks" detail="Every team still owns its own picks." />
          ) : (
            <ul className={cn(surface, "mt-3 divide-y divide-cream/10 overflow-hidden")}>
              {result.tradedPicks.map((pick) => (
                <li
                  key={`${pick.season}-${pick.round}-${pick.rosterId ?? "none"}-${pick.fromTeam}-${pick.toTeam}`}
                  className="px-4 py-3 text-sm text-cream"
                >
                  {pick.season} round {pick.round} · {pick.fromTeam} → {pick.toTeam}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </ExplorerPage>
  );
}
