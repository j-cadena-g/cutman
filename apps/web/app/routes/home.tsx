import { Form, Link } from "react-router";
import {
  enableLeague,
  getLeague,
  getVerificationCode,
  listEnabledLeagues,
  putVerificationCode,
  saveSleeperUsername,
  upsertLeagueMember,
  markUserVerified,
} from "@cutman/db";
import { formatVerifyToken, generateVerifyCode, isTone, parseTone, verifySleeperTeamName } from "@cutman/story";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cloudflareEnv } from "~/lib/env";
import { requireUser } from "~/lib/session.server";
import { sleeperFromEnv } from "../../workers/sleeper";
import type { Route } from "./+types/home";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = cloudflareEnv(context);
  const user = await requireUser(request, env);
  const sleeper = sleeperFromEnv(env);
  let error: string | null = null;
  let season = "";
  let leagues: Array<{ league_id: string; name: string; season: string }> = [];
  if (user.sleeper_username) {
    try {
      const state = await sleeper.getNflState();
      season = state.league_season;
      const sleeperUser = await sleeper.getUser(user.sleeper_username);
      if (!sleeperUser) {
        error = "Sleeper did not recognize that username.";
      } else {
        leagues = await sleeper.getUserLeagues(sleeperUser.user_id, state.league_season);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Sleeper is unreachable.";
    }
  }
  const enabled = await listEnabledLeagues(env.DB);
  const enabledIds = new Set(enabled.map((row) => row.sleeper_league_id));
  let verifyToken: string | null = null;
  if (user.sleeper_username && !user.verified_at) {
    const existing = await getVerificationCode(env.DB, user.id);
    const code = existing ?? generateVerifyCode();
    if (!existing) await putVerificationCode(env.DB, user.id, code, Date.now());
    verifyToken = formatVerifyToken(code);
  }
  return {
    user,
    season,
    error,
    verifyToken,
    enabled: enabled.map((row) => ({
      id: row.sleeper_league_id,
      name: row.name,
      tone: row.tone,
    })),
    available: leagues
      .filter((league) => !enabledIds.has(league.league_id))
      .map((league) => ({ id: league.league_id, name: league.name, season: league.season })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = cloudflareEnv(context);
  const user = await requireUser(request, env);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const sleeper = sleeperFromEnv(env);

  switch (intent) {
    case "claim": {
      const username = String(form.get("username") ?? "").trim().replace(/^@/, "");
      if (!username) return { error: "Enter a Sleeper username." };
      const found = await sleeper.getUser(username);
      if (!found) return { error: "No Sleeper user with that username." };
      await saveSleeperUsername(env.DB, user.id, found.username);
      return { ok: "claimed" };
    }
    case "verify": {
      if (!user.sleeper_username) return { error: "Claim a Sleeper username first." };
      const code = await getVerificationCode(env.DB, user.id);
      if (!code) return { error: "No verification code on file." };
      const state = await sleeper.getNflState();
      const sleeperUser = await sleeper.getUser(user.sleeper_username);
      if (!sleeperUser) return { error: "Sleeper username vanished." };
      const leagues = await sleeper.getUserLeagues(sleeperUser.user_id, state.league_season);
      for (const league of leagues) {
        const users = await sleeper.getLeagueUsers(league.league_id);
        const result = verifySleeperTeamName(users, user.sleeper_username, code);
        if (result.ok) {
          await markUserVerified(env.DB, user.id, result.sleeperUserId, Date.now());
          return { ok: "verified" };
        }
      }
      return { error: `We did not find ${formatVerifyToken(code)} on any of your Sleeper team names yet.` };
    }
    case "enable": {
      if (!user.verified_at || !user.sleeper_user_id || !user.sleeper_username) {
        return { error: "Verify your Sleeper team name before enabling a league." };
      }
      const leagueId = String(form.get("leagueId") ?? "");
      const toneRaw = String(form.get("tone") ?? "playful");
      if (!leagueId) return { error: "Missing league." };
      if (!isTone(toneRaw)) return { error: "Pick a real tone." };
      const tone = parseTone(toneRaw);
      const leagueUsers = await sleeper.getLeagueUsers(leagueId);
      const member = leagueUsers.find((entry) => entry.user_id === user.sleeper_user_id);
      if (!member) return { error: "You have to be in that Sleeper league." };
      const isOwner = Boolean(member.is_owner);
      const league = await sleeper.getLeague(leagueId);
      if (!league) return { error: "Sleeper does not know that league." };
      const existing = await getLeague(env.DB, leagueId);
      if (!existing) {
        await enableLeague(env.DB, {
          leagueId,
          name: league.name,
          season: league.season,
          enabledBy: user.id,
          tone,
          toneControl: isOwner ? "commish" : "enabler",
          now: Date.now(),
        });
      }
      await upsertLeagueMember(env.DB, {
        leagueId,
        userId: user.id,
        sleeperUserId: user.sleeper_user_id,
        isOwner,
      });
      const stub = env.LEAGUE_BRAIN.get(env.LEAGUE_BRAIN.idFromName(leagueId));
      await stub.bootstrap({ leagueId, name: league.name, tone: existing?.tone ? parseTone(existing.tone) : tone });
      return { ok: "enabled" };
    }
    default: {
      const _exhaustive: never = intent as never;
      return { error: `Unknown action: ${_exhaustive}` };
    }
  }
}

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const { user, enabled, available, verifyToken, season, error } = loaderData;
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">Cutman</p>
          <h1 className="mt-2 font-display text-4xl md:text-5xl">This week's plot</h1>
          <p className="mt-2 text-sm text-muted">{user.email}</p>
        </div>
        <Form method="post" action="/logout">
          <Button variant="ghost" type="submit">
            Sign out
          </Button>
        </Form>
      </header>

      {actionData?.error ? <p className="mt-6 text-sm text-danger">{actionData.error}</p> : null}
      {error ? <p className="mt-6 text-sm text-danger">{error}</p> : null}

      {!user.sleeper_username ? (
        <Card className="mt-10">
          <CardTitle>Claim your Sleeper username</CardTitle>
          <CardDescription>
            Listing this season's NFL leagues does not require verification. Enabling a league, setting tone, and recap
            email do.
          </CardDescription>
          <Form method="post" className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="intent" value="claim" />
            <div className="flex-1 space-y-2">
              <Label htmlFor="username">Sleeper username</Label>
              <Input id="username" name="username" placeholder="yourname" required />
            </div>
            <Button type="submit">Claim</Button>
          </Form>
        </Card>
      ) : null}

      {verifyToken ? (
        <Card className="mt-8">
          <Badge>One-time verify</Badge>
          <CardTitle className="mt-3">Append {verifyToken} to a Sleeper team name</CardTitle>
          <CardDescription>
            Edit your team name in any of this season's leagues so it includes {verifyToken}. We check{" "}
            <code className="text-cream">metadata.team_name</code> via league users, then bind your Sleeper user id.
          </CardDescription>
          <Form method="post" className="mt-6">
            <input type="hidden" name="intent" value="verify" />
            <Button type="submit">I updated my team name</Button>
          </Form>
        </Card>
      ) : null}

      {user.sleeper_username ? (
        <section className="mt-12">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-3xl">Enabled leagues</h2>
            {season ? <p className="text-xs uppercase tracking-[0.18em] text-muted">{season} NFL</p> : null}
          </div>
          {enabled.length === 0 ? (
            <p className="mt-4 text-muted">None yet. Enable a league below and Cutman starts keeping the book.</p>
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {enabled.map((league) => (
                <Link key={league.id} to={`/leagues/${league.id}`}>
                  <Card className="h-full hover:border-flag/50">
                    <Badge>{league.tone}</Badge>
                    <CardTitle className="mt-3">{league.name}</CardTitle>
                    <CardDescription>Open the living dashboard.</CardDescription>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {user.sleeper_username ? (
        <section className="mt-12 pb-16">
          <h2 className="font-display text-3xl">Available to enable</h2>
          {available.length === 0 ? (
            <p className="mt-4 text-muted">
              {user.sleeper_username
                ? "Every league we found is already enabled, or Sleeper returned none for this season."
                : "Claim a username to list leagues."}
            </p>
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {available.map((league) => (
                <Card key={league.id}>
                  <CardTitle>{league.name}</CardTitle>
                  <CardDescription>Season {league.season}. Must be a member. Commish is Sleeper is_owner.</CardDescription>
                  <Form method="post" className="mt-5 space-y-3">
                    <input type="hidden" name="intent" value="enable" />
                    <input type="hidden" name="leagueId" value={league.id} />
                    <div className="space-y-2">
                      <Label htmlFor={`tone-${league.id}`}>Tone</Label>
                      <select
                        id={`tone-${league.id}`}
                        name="tone"
                        defaultValue="playful"
                        disabled={!user.verified_at}
                        className="flex h-10 w-full rounded-md border border-cream/20 bg-ink/60 px-3 text-sm"
                      >
                        <option value="playful">Playful</option>
                        <option value="savage">Savage</option>
                        <option value="sportscenter">SportsCenter</option>
                      </select>
                    </div>
                    <Button type="submit" disabled={!user.verified_at}>
                      {user.verified_at ? "Enable" : "Verify first"}
                    </Button>
                  </Form>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}
