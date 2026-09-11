import { Show, SignOutButton, UserButton } from "@clerk/react-router";
import { setRecapOptIn } from "@cutman/db";
import { isTone, parseTone, toneBlurb, toneLabel, toneOrPlayful, TONES } from "@cutman/story";
import { Form, redirect } from "react-router";
import { resolveLeagueAccess } from "~/lib/access.server";
import { BrandNav } from "~/components/brand-nav";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { getDashboardOrNull } from "~/lib/dashboard";
import { clerkAppearance } from "~/lib/clerk-appearance";
import { cloudflareEnv } from "~/lib/env";
import type { Route } from "./+types/league";

// `/leagues/:leagueId`: requires Clerk and membership in that exact active league. This is the
// living dashboard that used to live at `/` before Cutman supported more than one league — tone,
// recap opt-in, the Sleeper roster link, and Clerk user controls are preserved verbatim, just
// keyed off the `leagueId` route param instead of the single hardcoded v1 league. Reads only that
// league's LeagueBrain snapshot, never Sleeper directly (LeagueBrain polls on its own cron).
export async function loader(args: Route.LoaderArgs) {
  const env = cloudflareEnv(args.context);
  const leagueId = args.params.leagueId;
  const access = await resolveLeagueAccess(args, leagueId);

  if (access.kind === "signed_out") {
    throw redirect("/sign-in");
  }
  if (access.kind === "not_found") {
    // Deliberately the same response whether the league doesn't exist or this user just isn't a
    // member of it — reject cross-league access without confirming which leagues exist.
    throw new Response("Not found", { status: 404 });
  }
  if (access.kind === "not_active") {
    // A real member (often the verifying commissioner) of a league that Task 4 hasn't activated
    // yet. `/onboarding` owns rendering that "setup in progress" state.
    throw redirect("/onboarding");
  }

  const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(access.league.id));
  // A league can flip to "active" in D1 slightly before its LeagueBrain Durable Object has
  // actually been bootstrapped (Task 4 owns provisioning/activation — this should be a short,
  // transient window once it lands). Guard against `getDashboard()`'s "not bootstrapped" throw
  // and render a setting-up/empty-book state below instead of a root 500.
  const dashboard = await getDashboardOrNull(stub);
  return {
    league: {
      id: access.league.id,
      name: access.league.name,
      season: access.league.season,
      sleeperLeagueId: access.league.sleeper_league_id,
      tone: access.league.tone,
    },
    isOwner: access.isOwner,
    userEmail: access.user.email,
    dashboard,
    optIn: Boolean(access.membership.recap_email_opt_in),
  };
}

export async function action(args: Route.ActionArgs) {
  const env = cloudflareEnv(args.context);
  const leagueId = args.params.leagueId;
  const access = await resolveLeagueAccess(args, leagueId);

  // Mirror the loader's own authorization exactly, instead of collapsing every non-member case
  // into one generic error: a signed-out submission should land back on sign-in, a
  // nonexistent/foreign league should 404 the same way a GET would, and a real member of a
  // not-yet-active league should land on `/onboarding` (which owns rendering that state).
  if (access.kind === "signed_out") {
    throw redirect("/sign-in");
  }
  if (access.kind === "not_found") {
    throw new Response("Not found", { status: 404 });
  }
  if (access.kind === "not_active") {
    throw redirect("/onboarding");
  }

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "tone") {
    if (!access.isOwner) return { error: "Only the commissioner can change tone." };
    const toneRaw = String(form.get("tone") ?? "");
    if (!isTone(toneRaw)) return { error: "Pick a real tone." };
    const tone = parseTone(toneRaw);
    const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(access.league.id));
    // LeagueBrain serializes tone mutations for this league so a failed older D1 write
    // cannot roll back a newer success. Dashboard reads stay on getDashboard (not this RPC).
    const saveError = { error: "Cutman couldn't save that tone. Try again." } as const;
    try {
      const result = await stub.persistTone(tone);
      if (result.ok) return { ok: "tone" };
      switch (result.error) {
        case "save":
          return saveError;
        case "desync":
          return {
            error: "Cutman updated the live tone but couldn't save it. Try again so they stay in sync.",
          };
        default: {
          const _exhaustive: never = result.error;
          void _exhaustive;
          return saveError;
        }
      }
    } catch {
      return saveError;
    }
  }

  if (intent === "optin") {
    const on = String(form.get("optin") ?? "") === "1";
    try {
      await setRecapOptIn(env.DB, access.league.id, access.user.id, on);
    } catch {
      return { error: "Cutman couldn't save that preference. Try again." };
    }
    return { ok: "optin" };
  }

  return { error: "Cutman didn't recognize that action." };
}

function SignedInUserControls() {
  return (
    <Show when="signed-in">
      <UserButton
        appearance={{
          ...clerkAppearance,
          elements: {
            avatarBox: "h-10 w-10 ring-2 ring-flag/70",
          },
        }}
      />
    </Show>
  );
}

export default function League({ loaderData, actionData }: Route.ComponentProps) {
  const { league, isOwner, userEmail, dashboard, optIn } = loaderData;
  const tone = toneOrPlayful(league.tone);
  const actionError = actionData && "error" in actionData ? actionData.error : undefined;
  // Falls back to the D1 `leagues` row's own name/week-less state whenever the Durable Object
  // hasn't been bootstrapped yet (`dashboard === null` — see getDashboardOrNull in the loader).
  const leagueName = dashboard?.name ?? league.name;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <BrandNav />
          <h1 className="mt-2 font-display text-4xl md:text-5xl">{leagueName}</h1>
          <p className="mt-2 text-muted">
            Week {dashboard?.week ?? "—"} · living dashboard from the last snapshot
          </p>
          <p className="mt-1 text-sm text-muted">{userEmail}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="secondary">
            <a href={`https://sleeper.com/leagues/${league.sleeperLeagueId}`} target="_blank" rel="noreferrer">
              Rosters on Sleeper
            </a>
          </Button>
          <SignedInUserControls />
          <SignOutButton>
            <Button variant="ghost">Sign out</Button>
          </SignOutButton>
        </div>
      </header>

      {actionError ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {actionError}
        </p>
      ) : null}

      <Card className="mt-8">
        <Badge>{isOwner ? "Commissioner" : "Member"}</Badge>
        <CardTitle className="mt-3">Commish strip</CardTitle>
        <CardDescription>
          {toneLabel(tone)} — {toneBlurb(tone)} Default tone is playful.
        </CardDescription>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="tone" />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Voice</p>
            <div className="flex flex-wrap gap-2">
              {TONES.map((option) => (
                <Button
                  key={option}
                  name="tone"
                  value={option}
                  variant={tone === option ? "default" : "secondary"}
                  aria-pressed={tone === option}
                  disabled={!isOwner || dashboard === null}
                >
                  {toneLabel(option)}
                </Button>
              ))}
            </div>
            {dashboard === null ? (
              <p className="text-sm text-muted">Tone opens once setup finishes.</p>
            ) : null}
          </Form>
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="optin" />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Tuesday recap email</p>
            <Button name="optin" value={optIn ? "0" : "1"} variant={optIn ? "secondary" : "default"}>
              {optIn ? "Opted in — click to stop" : "Email me the Tuesday recap"}
            </Button>
          </Form>
        </div>
      </Card>

      {dashboard ? (
        <>
          <section className="mt-12 grid gap-6 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <h2 className="font-display text-3xl">Timeline</h2>
              {dashboard.timeline.length === 0 ? (
                <Card className="mt-4">
                  <CardTitle>Quiet so far</CardTitle>
                  <CardDescription>
                    Cutman polls Sleeper on the cron, diffs the snapshot, and only writes a beat when something
                    actually changed. This page reads the Durable Object, not Sleeper.
                  </CardDescription>
                </Card>
              ) : (
                <ol className="mt-4 space-y-4">
                  {dashboard.timeline.map((beat) => (
                    <li key={beat.id}>
                      <Card>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-flag">
                          Week {beat.week} · {beat.kind.replaceAll("_", " ")}
                        </p>
                        <p className="mt-2 text-lg leading-relaxed">{beat.copy}</p>
                      </Card>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="lg:col-span-2">
              <h2 className="font-display text-3xl">Bible</h2>
              {dashboard.bible.length === 0 ? (
                <p className="mt-4 text-muted">Running gags land here as the season writes itself.</p>
              ) : (
                <ul className="mt-4 space-y-3 text-sm leading-relaxed text-paper">
                  {dashboard.bible.map((entry) => (
                    <li key={entry.id} className="border-l-2 border-flag/40 pl-3">
                      {entry.entry}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="mt-12 pb-16">
            <h2 className="font-display text-3xl">Recap archive</h2>
            {dashboard.recaps.length === 0 ? (
              <p className="mt-4 text-muted">
                Tuesday 9:00 in America/New_York, once every matchup has a real score. One recap per week. Never a
                blank email. From: Cutman &lt;hello@mail.cutman.io&gt;.
              </p>
            ) : (
              <div className="mt-5 space-y-4">
                {dashboard.recaps.map((recap) => (
                  <Card key={recap.week}>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-flag">Week {recap.week}</p>
                    <CardTitle className="mt-2">{recap.subject}</CardTitle>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-paper">{recap.body}</p>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="mt-12 pb-16">
          <Card>
            <Badge>Verified</Badge>
            <CardTitle className="mt-3">Setting up your season book</CardTitle>
            <CardDescription>
              Cutman is finishing setup for this league. The timeline, bible, and recap archive will fill in
              automatically once it's ready — check back soon.
            </CardDescription>
          </Card>
        </section>
      )}
    </main>
  );
}
