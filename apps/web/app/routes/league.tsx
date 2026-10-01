import { Show, SignOutButton, UserButton } from "@clerk/react-router";
import { setRecapOptIn } from "@cutman/db";
import { isTone, parseTone, toneBlurb, toneLabel, toneOrPlayful, TONES } from "@cutman/story";
import { Form, redirect } from "react-router";
import { resolveLeagueAccess } from "~/lib/access.server";
import { PageLead, PageShell, PageTitle, SectionHeading } from "~/components/page-shell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle, EmptyState } from "~/components/ui/card";
import { segmentedItem, segmentedTrack } from "~/components/ui/segmented";
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

// UserButton mounts client-side only; the fixed slot keeps the header from reflowing when it does.
function SignedInUserControls() {
  return (
    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center">
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
    </span>
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
    <PageShell
      width="default"
      actions={
        <>
          <Button asChild variant="secondary" size="sm">
            <a href={`https://sleeper.com/leagues/${league.sleeperLeagueId}`} target="_blank" rel="noreferrer">
              Rosters on Sleeper
            </a>
          </Button>
          <SignOutButton>
            <Button variant="ghost" size="sm">
              Sign out
            </Button>
          </SignOutButton>
          <SignedInUserControls />
        </>
      }
    >
      <PageTitle>{leagueName}</PageTitle>
      <PageLead>
        Week {dashboard?.week ?? "—"} · living dashboard from the last snapshot · {userEmail}
      </PageLead>

      {actionError ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {actionError}
        </p>
      ) : null}

      <Card className="mt-8">
        <Badge>{isOwner ? "Commissioner" : "Member"}</Badge>
        <CardTitle className="mt-3">Commissioner controls</CardTitle>
        <CardDescription>
          {toneLabel(tone)} — {toneBlurb(tone)} Default tone is playful.
        </CardDescription>
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="tone" />
            <p className="eyebrow text-muted">Voice</p>
            <div className={`${segmentedTrack} w-fit flex-wrap`}>
              {TONES.map((option) => (
                <button
                  key={option}
                  type="submit"
                  name="tone"
                  value={option}
                  aria-pressed={tone === option}
                  disabled={!isOwner || dashboard === null}
                  className={segmentedItem(tone === option)}
                >
                  {toneLabel(option)}
                </button>
              ))}
            </div>
            {dashboard === null ? <p className="text-sm text-muted">Tone opens once setup finishes.</p> : null}
          </Form>
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="optin" />
            <p className="eyebrow text-muted">Tuesday recap email</p>
            <Button name="optin" value={optIn ? "0" : "1"} variant={optIn ? "secondary" : "default"}>
              {optIn ? "Opted in — click to stop" : "Email me the Tuesday recap"}
            </Button>
          </Form>
        </div>
      </Card>

      {dashboard ? (
        <>
          <section className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <SectionHeading>Timeline</SectionHeading>
              {dashboard.timeline.length === 0 ? (
                <EmptyState
                  className="mt-3"
                  title="Quiet so far"
                  detail="Cutman polls Sleeper on the cron, diffs the snapshot, and only writes a beat when something actually changed."
                />
              ) : (
                <ol className="mt-3 space-y-4">
                  {dashboard.timeline.map((beat) => (
                    <li key={beat.id}>
                      <Card>
                        <p className="eyebrow-sm text-flag">
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
              <SectionHeading>Bible</SectionHeading>
              {dashboard.bible.length === 0 ? (
                <EmptyState className="mt-3" title="No running gags yet" detail="They land here as the season writes itself." />
              ) : (
                <ul className="mt-3 space-y-3 text-sm leading-relaxed text-paper">
                  {dashboard.bible.map((entry) => (
                    <li key={entry.id} className="border-l-2 border-flag/40 pl-3">
                      {entry.entry}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="mt-12">
            <SectionHeading>Recap archive</SectionHeading>
            {dashboard.recaps.length === 0 ? (
              <EmptyState
                className="mt-3"
                title="No recaps yet"
                detail="Tuesday 9:00 America/New_York, once every matchup has a real score. One recap per week, from Cutman <hello@mail.cutman.io>."
              />
            ) : (
              <div className="mt-3 space-y-4">
                {dashboard.recaps.map((recap) => (
                  <Card key={recap.week}>
                    <p className="eyebrow-sm text-flag">Week {recap.week}</p>
                    <CardTitle className="mt-2">{recap.subject}</CardTitle>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-paper">{recap.body}</p>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <Card className="mt-12">
          <Badge>Verified</Badge>
          <CardTitle className="mt-3">Setting up your season book</CardTitle>
          <CardDescription>
            Cutman is finishing setup for this league. The timeline, bible, and recap archive will fill in
            automatically once it's ready — check back soon.
          </CardDescription>
        </Card>
      )}
    </PageShell>
  );
}
