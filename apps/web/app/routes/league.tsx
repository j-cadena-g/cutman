import { Show, SignOutButton, UserButton } from "@clerk/react-router";
import { setLeagueTone, setRecapOptIn } from "@cutman/db";
import { isTone, parseTone, toneBlurb, toneLabel, toneOrPlayful, type Tone } from "@cutman/story";
import { Form, Link, redirect } from "react-router";
import { resolveLeagueAccess } from "~/lib/access.server";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
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

  const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(access.league.sleeper_league_id));
  const dashboard = await stub.getDashboard();
  return {
    access,
    dashboard,
    optIn: Boolean(access.membership.recap_email_opt_in),
  };
}

export async function action(args: Route.ActionArgs) {
  const env = cloudflareEnv(args.context);
  const leagueId = args.params.leagueId;
  const access = await resolveLeagueAccess(args, leagueId);
  if (access.kind !== "member") {
    return { error: "Sign in to change this book." };
  }

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "tone") {
    if (!access.isOwner) return { error: "Only the commissioner can change tone." };
    const toneRaw = String(form.get("tone") ?? "");
    if (!isTone(toneRaw)) return { error: "Pick a real tone." };
    const tone = parseTone(toneRaw);
    await setLeagueTone(env.DB, access.league.id, tone);
    const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(access.league.sleeper_league_id));
    await stub.setTone(tone);
    return { ok: "tone" };
  }

  if (intent === "optin") {
    const on = String(form.get("optin") ?? "") === "1";
    await setRecapOptIn(env.DB, access.league.id, access.user.id, on);
    return { ok: "optin" };
  }

  return { error: `Unknown action: ${intent}` };
}

function SignedInUserControls() {
  return (
    <Show when="signed-in">
      <UserButton
        appearance={{
          elements: {
            avatarBox: "h-10 w-10 ring-2 ring-flag/70",
          },
        }}
      />
    </Show>
  );
}

export default function League({ loaderData, actionData }: Route.ComponentProps) {
  const { access, dashboard, optIn } = loaderData;
  const tones: Tone[] = ["playful", "savage", "sportscenter"];
  const tone = toneOrPlayful(access.league.tone);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">
            <Link to="/">Cutman</Link>
          </p>
          <h1 className="mt-2 font-display text-4xl md:text-5xl">{dashboard.name}</h1>
          <p className="mt-2 text-muted">
            Week {dashboard.week ?? "—"} · living dashboard from the last snapshot
          </p>
          <p className="mt-1 text-sm text-muted">{access.user.email}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="secondary">
            <a href={`https://sleeper.com/leagues/${access.league.sleeper_league_id}`} target="_blank" rel="noreferrer">
              Rosters on Sleeper
            </a>
          </Button>
          <SignedInUserControls />
          <SignOutButton>
            <Button variant="ghost">Sign out</Button>
          </SignOutButton>
        </div>
      </header>

      {actionData?.error ? <p className="mt-4 text-sm text-danger">{actionData.error}</p> : null}

      <Card className="mt-8">
        <Badge>{access.isOwner ? "Commissioner" : "Member"}</Badge>
        <CardTitle className="mt-3">Commish strip</CardTitle>
        <CardDescription>
          {toneLabel(tone)} — {toneBlurb(tone)} Default tone is playful.
        </CardDescription>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="tone" />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Voice</p>
            <div className="flex flex-wrap gap-2">
              {tones.map((option) => (
                <Button
                  key={option}
                  name="tone"
                  value={option}
                  variant={tone === option ? "default" : "secondary"}
                  disabled={!access.isOwner}
                >
                  {toneLabel(option)}
                </Button>
              ))}
            </div>
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

      <section className="mt-12 grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <h2 className="font-display text-3xl">Timeline</h2>
          {dashboard.timeline.length === 0 ? (
            <Card className="mt-4">
              <CardTitle>Quiet so far</CardTitle>
              <CardDescription>
                Cutman polls Sleeper on the cron, diffs the snapshot, and only writes a beat when something actually
                changed. This page reads the Durable Object, not Sleeper.
              </CardDescription>
            </Card>
          ) : (
            <ol className="mt-4 space-y-4">
              {dashboard.timeline.map((beat) => (
                <li key={beat.id}>
                  <Card>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-flag">
                      Week {beat.week} · {beat.kind.replace("_", " ")}
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
            Tuesday 9:00 in America/New_York, once every matchup has a real score. One recap per week. Never a blank
            email. From: Cutman &lt;hello@mail.cutman.io&gt;.
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
    </main>
  );
}
