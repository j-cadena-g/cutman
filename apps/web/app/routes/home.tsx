import { Show, SignInButton, SignUpButton } from "@clerk/react-router";
import type { LeagueRow } from "@cutman/db";
import { Link, redirect } from "react-router";
import { computeHomeDestination, resolveHomeAccess } from "~/lib/access.server";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { clerkIsConfigured } from "~/lib/clerk.server";
import { cloudflareEnv } from "~/lib/env";
import type { Route } from "./+types/home";

// `/` is a hub, not a dashboard:
// - signed out -> the existing Clerk sign-in/sign-up landing;
// - signed in without a Sleeper account, or with zero active league memberships -> `/onboarding`;
// - exactly one active league membership -> straight to that league's dashboard;
// - more than one -> league cards linking to each active league.
// `computeHomeDestination` (app/lib/access-rules.ts) makes the redirect/card decision; this
// loader only gathers the inputs and performs the redirect.
export async function loader(args: Route.LoaderArgs) {
  const env = cloudflareEnv(args.context);
  const access = await resolveHomeAccess(args);
  const clerkConfigured = clerkIsConfigured(env);

  // `leagues` is always present (empty when signed out) so the component never has to reason
  // about a field that only exists on some loader return paths.
  if (access.kind === "signed_out") {
    return { access, clerkConfigured, leagues: [] as LeagueRow[] };
  }

  const destination = computeHomeDestination({
    sleeperConnected: access.sleeperConnected,
    activeLeagues: access.activeLeagues,
  });
  if (destination.kind === "needs_onboarding") {
    throw redirect("/onboarding");
  }
  if (destination.kind === "single_league") {
    throw redirect(`/leagues/${destination.league.id}`);
  }
  return { access, clerkConfigured, leagues: destination.leagues };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { access, clerkConfigured, leagues } = loaderData;

  if (access.kind === "signed_out") {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">Cutman</p>
        <h1 className="mt-4 font-display text-5xl leading-[1.05]">The season story for your Sleeper league.</h1>
        <p className="mt-4 text-muted">
          Cutman keeps the book for your Sleeper league. Sign in with Clerk to open the dashboard.
        </p>
        {clerkConfigured ? (
          <Show when="signed-out">
            <div className="mt-10 flex flex-wrap gap-3">
              <SignInButton>
                <Button>Sign in</Button>
              </SignInButton>
              <SignUpButton>
                <Button variant="secondary">Sign up</Button>
              </SignUpButton>
            </div>
          </Show>
        ) : (
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/sign-in">Sign in</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link to="/sign-up">Sign up</Link>
            </Button>
          </div>
        )}
      </main>
    );
  }

  // Only reachable with more than one active league membership (single/zero redirect in the
  // loader) — the commissioner's-scorecard "which book do you want to open" view.
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">Cutman</p>
      <h1 className="mt-4 font-display text-4xl">Your leagues</h1>
      <p className="mt-2 text-muted">Pick a book to open.</p>
      <ol className="mt-8 space-y-4">
        {leagues.map((league, index) => (
          <li key={league.id}>
            <Link to={`/leagues/${league.id}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flag/70 rounded-xl">
              <Card className="transition-colors hover:bg-turf">
                <Badge>League {index + 1}</Badge>
                <CardTitle className="mt-3">{league.name}</CardTitle>
                <CardDescription>Season {league.season}</CardDescription>
              </Card>
            </Link>
          </li>
        ))}
      </ol>
    </main>
  );
}
