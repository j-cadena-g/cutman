import { Form, Link } from "react-router";
import { getLeague, getLeagueMember, setLeagueTone, setRecapOptIn, upsertLeagueMember } from "@cutman/db";
import { isTone, parseTone, toneBlurb, toneLabel, type Tone } from "@cutman/story";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { cloudflareEnv } from "~/lib/env";
import { requireUser } from "~/lib/session.server";
import { sleeperFromEnv } from "../../workers/sleeper";
import type { Route } from "./+types/leagues.$leagueId";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const env = cloudflareEnv(context);
  const user = await requireUser(request, env);
  const leagueId = params.leagueId;
  const league = await getLeague(env.DB, leagueId);
  if (!league) {
    throw new Response("League is not enabled", { status: 404 });
  }
  const sleeper = sleeperFromEnv(env);
  let isOwner = false;
  if (user.sleeper_user_id) {
    const users = await sleeper.getLeagueUsers(leagueId);
    const member = users.find((entry) => entry.user_id === user.sleeper_user_id);
    if (!member) {
      throw new Response("You are not in this league", { status: 403 });
    }
    isOwner = Boolean(member.is_owner);
    await upsertLeagueMember(env.DB, {
      leagueId,
      userId: user.id,
      sleeperUserId: user.sleeper_user_id,
      isOwner,
    });
  }
  const membership = await getLeagueMember(env.DB, leagueId, user.id);
  const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(leagueId));
  try {
    await stub.poll();
  } catch (error) {
    console.error("poll failed", error);
  }
  const dashboard = await stub.getDashboard();
  const canSetTone = isOwner || league.tone_control === "enabler";
  return {
    user,
    league,
    isOwner,
    canSetTone,
    optIn: Boolean(membership?.recap_email_opt_in),
    dashboard,
    sleeperUrl: `https://sleeper.com/leagues/${leagueId}`,
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const env = cloudflareEnv(context);
  const user = await requireUser(request, env);
  if (!user.verified_at || !user.sleeper_user_id) {
    return { error: "Verify your Sleeper team name first." };
  }
  const leagueId = params.leagueId;
  const league = await getLeague(env.DB, leagueId);
  if (!league) return { error: "League is not enabled." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const sleeper = sleeperFromEnv(env);
  const users = await sleeper.getLeagueUsers(leagueId);
  const member = users.find((entry) => entry.user_id === user.sleeper_user_id);
  if (!member) return { error: "You are not in this league." };
  const isOwner = Boolean(member.is_owner);

  switch (intent) {
    case "tone": {
      const toneRaw = String(form.get("tone") ?? "");
      if (!isTone(toneRaw)) return { error: "Pick a real tone." };
      const tone = parseTone(toneRaw);
      if (!isOwner && league.tone_control === "commish") {
        return { error: "A commissioner already locked tone." };
      }
      await setLeagueTone(env.DB, leagueId, tone, isOwner ? "commish" : league.tone_control);
      const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(leagueId));
      await stub.setTone(tone);
      return { ok: "tone" };
    }
    case "optin": {
      const on = String(form.get("optin") ?? "") === "1";
      await upsertLeagueMember(env.DB, {
        leagueId,
        userId: user.id,
        sleeperUserId: user.sleeper_user_id,
        isOwner,
      });
      await setRecapOptIn(env.DB, leagueId, user.id, on);
      return { ok: "optin" };
    }
    default: {
      const _exhaustive: never = intent as never;
      return { error: `Unknown action: ${_exhaustive}` };
    }
  }
}

export default function LeaguePage({ loaderData, actionData }: Route.ComponentProps) {
  const { league, dashboard, isOwner, canSetTone, optIn, sleeperUrl } = loaderData;
  const tones: Tone[] = ["playful", "savage", "sportscenter"];
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">
        <Link to="/" className="hover:text-cream">
          Cutman
        </Link>
      </p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl md:text-5xl">{dashboard.name}</h1>
          <p className="mt-2 text-muted">Week {dashboard.week ?? "—"} · living dashboard, all week</p>
        </div>
        <Button asChild variant="secondary">
          <a href={sleeperUrl} target="_blank" rel="noreferrer">
            Rosters on Sleeper
          </a>
        </Button>
      </div>

      {actionData?.error ? <p className="mt-4 text-sm text-danger">{actionData.error}</p> : null}

      <Card className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge>{isOwner ? "Commissioner" : "Member"}</Badge>
            <CardTitle className="mt-3">Commish strip</CardTitle>
            <CardDescription>
              {toneLabel(parseTone(league.tone))} — {toneBlurb(parseTone(league.tone))} First enabler may set tone until a
              commish appears.
            </CardDescription>
          </div>
        </div>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="tone" />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Voice</p>
            <div className="flex flex-wrap gap-2">
              {tones.map((tone) => (
                <Button key={tone} name="tone" value={tone} variant={league.tone === tone ? "default" : "secondary"} disabled={!canSetTone}>
                  {toneLabel(tone)}
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
                Cutman polls Sleeper, diffs the snapshot, and only writes a beat when something actually changed. Same
                payload twice is silence.
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
            Tuesday morning in America/New_York, once every matchup has a real score. One recap per week. Never a blank
            email.
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
