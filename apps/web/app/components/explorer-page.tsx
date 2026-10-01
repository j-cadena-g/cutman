import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExplorerAvatar } from "~/components/explorer-avatar";
import { ExplorerLeagueNav } from "~/components/explorer-league-nav";
import { PageShell, PageTitle } from "~/components/page-shell";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { describeExplorerError, type ExplorerErrorKind } from "~/lib/sleeper-explorer";

export function ExplorerPage({ children }: { children: ReactNode }) {
  return <PageShell width="wide">{children}</PageShell>;
}

export function ExplorerLeagueChrome({
  avatarUrl,
  name,
  meta,
  leagueId,
}: {
  avatarUrl: string | null;
  name: string;
  meta: string;
  leagueId: string;
}) {
  return (
    <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex min-w-0 items-center gap-4">
        <ExplorerAvatar src={avatarUrl} name={name} size="lg" />
        <div className="min-w-0">
          <p className="eyebrow-sm text-muted">Sleeper league</p>
          <PageTitle className="truncate">{name}</PageTitle>
          <p className="mt-1 text-sm text-muted">{meta}</p>
        </div>
      </div>
      <ExplorerLeagueNav leagueId={leagueId} />
    </header>
  );
}

const ERROR_TITLES = {
  invalid_username: "Need a username",
  not_found: "Not on Sleeper",
  rate_limited: "Sleeper is throttling",
  quota_exceeded: "Lookup limit reached",
  unavailable: "Couldn't reach Sleeper",
} as const satisfies Record<ExplorerErrorKind, string>;

// Every explorer failure (bad username, missing league, throttled, quota, outage) renders the
// same heading + card + way back, so the pages don't each invent their own.
export function ExplorerErrorState({ kind, heading = "Explore Sleeper" }: { kind: ExplorerErrorKind; heading?: string }) {
  return (
    <>
      <PageTitle>{heading}</PageTitle>
      <Card className="mt-6 max-w-xl">
        <CardTitle>{ERROR_TITLES[kind]}</CardTitle>
        <CardDescription>{describeExplorerError(kind)}</CardDescription>
        <p className="mt-4 text-sm">
          <Link to="/explore" className="text-link">
            Look up another username
          </Link>
        </p>
      </Card>
    </>
  );
}

export function ExplorerStaleNotice() {
  return <p className="mt-3 text-sm text-muted">Showing cached Sleeper data. A fresh pull wasn&apos;t available.</p>;
}
