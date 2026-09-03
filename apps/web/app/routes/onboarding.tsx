import {
  findPendingVerification,
  getLeagueBySleeperId,
  getLeagueMember,
  getSleeperAccountByUserId,
} from "@cutman/db";
import { Form, Link, redirect } from "react-router";
import {
  connectSleeperAccount,
  createChallengeCode,
  discoverLeagues,
  joinPilotLeague,
  requestCommissionerChallenge,
  verifyCommissionerChallenge,
  type OnboardingDeps,
} from "~/lib/onboarding.server";
import { computePilotLeagueStep, describeOnboardingError, type PilotLeagueStep } from "~/lib/onboarding-view";
import { provisionAndActivateLeague, provisioningDepsFromEnv, retryProvisionAndActivateLeague } from "~/lib/provisioning.server";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cloudflareEnv } from "~/lib/env";
import { requireUser } from "~/lib/session.server";
import { sleeperFromEnv } from "~/lib/sleeper.server";
import { pilotSleeperLeagueId } from "~/lib/v1.server";
import type { Route } from "./+types/onboarding";

// `/onboarding`: connect one Sleeper account, discover current-season leagues, then either the
// pilot league's commissioner challenge or (once active) joining as a member. Every other
// discovered league stays visible but disabled ("Coming soon"). Verify and join stay in
// app/lib/onboarding.server.ts; after a successful verify (and on commissioner retry) this
// route calls app/lib/provisioning.server.ts to bootstrap LeagueBrain and activate the league.
function onboardingDepsFromEnv(env: Env): OnboardingDeps {
  return {
    db: env.DB,
    sleeperClient: sleeperFromEnv(env),
    pilotSleeperLeagueId: pilotSleeperLeagueId(env),
    now: () => Date.now(),
    generateChallenge: createChallengeCode,
    generateId: () => crypto.randomUUID(),
  };
}

export async function loader(args: Route.LoaderArgs) {
  const env = cloudflareEnv(args.context);
  const user = await requireUser(args);
  const deps = onboardingDepsFromEnv(env);

  const sleeperAccount = await getSleeperAccountByUserId(env.DB, user.id);

  let pilotEntry: { name: string; isOwner: boolean } | null = null;
  let comingSoonLeagues: Array<{ sleeperLeagueId: string; name: string; season: string }> = [];
  let discoveryFailed = false;
  if (sleeperAccount) {
    try {
      const discovery = await discoverLeagues(deps, { clerkUserId: user.id });
      if (discovery.ok) {
        const found = discovery.leagues.find((league) => league.classification === "pilot");
        pilotEntry = found ? { name: found.name, isOwner: found.isOwner } : null;
        comingSoonLeagues = discovery.leagues
          .filter((league) => league.classification === "coming_soon")
          .map((league) => ({ sleeperLeagueId: league.sleeperLeagueId, name: league.name, season: league.season }));
      }
    } catch {
      // Sleeper's API (or the network path to it) failed. Never let this reach the root error
      // boundary as an uncaught 500 — render a typed, retryable "could not reach Sleeper" state
      // instead (see computePilotLeagueStep's "discovery_unavailable").
      discoveryFailed = true;
    }
  }

  const league = await getLeagueBySleeperId(env.DB, deps.pilotSleeperLeagueId);
  const membership = league ? await getLeagueMember(env.DB, league.id, user.id) : null;

  if (membership && league && league.status === "active") {
    throw redirect(`/leagues/${league.id}`);
  }

  const verification = await findPendingVerification(env.DB, {
    userId: user.id,
    sleeperLeagueId: deps.pilotSleeperLeagueId,
  });

  const step = computePilotLeagueStep({
    sleeperConnected: Boolean(sleeperAccount),
    discoveryFailed,
    pilotEntry: pilotEntry ? { isOwner: pilotEntry.isOwner } : null,
    league,
    membership,
    pendingVerification: verification
      ? { challenge: verification.challenge, expiresAt: verification.expires_at, attempts: verification.attempts }
      : null,
  });

  // Never send the pilot league's name to the client unless the connected Sleeper account is
  // discovered as a current member of it, or a persisted membership row already confirms it —
  // the same confirmation `computePilotLeagueStep` requires before offering "Join" — so an
  // unconfirmed user's loader payload can't reveal the league's identity even if nothing in the
  // UI happens to render it for their step.
  const pilotLeagueName = pilotEntry?.name ?? (membership && league ? league.name : null);

  return {
    sleeperUsername: sleeperAccount?.username ?? null,
    pilotLeagueName,
    comingSoonLeagues,
    step,
    isCommissioner: membership?.role === "commissioner",
    now: Date.now(),
  };
}

export async function action(args: Route.ActionArgs) {
  const env = cloudflareEnv(args.context);
  const user = await requireUser(args);
  const deps = onboardingDepsFromEnv(env);
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "connect") {
    const usernameInput = String(form.get("username") ?? "");
    const result = await connectSleeperAccount(deps, { clerkUserId: user.id, usernameInput });
    if (!result.ok) return { intent, error: describeOnboardingError(result.error.kind) };
    return { intent, ok: true as const };
  }

  if (intent === "request-challenge") {
    const result = await requestCommissionerChallenge(deps, { clerkUserId: user.id });
    if (!result.ok) return { intent, error: describeOnboardingError(result.error.kind) };
    return { intent, ok: true as const };
  }

  if (intent === "verify-challenge") {
    const result = await verifyCommissionerChallenge(deps, { clerkUserId: user.id });
    if (!result.ok) return { intent, error: describeOnboardingError(result.error.kind) };
    const provisioned = await provisionAndActivateLeague(provisioningDepsFromEnv(env, result.league.id), result.league);
    if (!provisioned.ok) return { intent, error: describeOnboardingError(provisioned.error.kind) };
    return { intent, ok: true as const };
  }

  if (intent === "join") {
    const result = await joinPilotLeague(deps, { clerkUserId: user.id });
    if (!result.ok) return { intent, error: describeOnboardingError(result.error.kind) };
    return { intent, ok: true as const };
  }

  if (intent === "retry-provision") {
    const league = await getLeagueBySleeperId(env.DB, deps.pilotSleeperLeagueId);
    if (!league) return { intent, error: describeOnboardingError("not_commissioner") };
    const membership = await getLeagueMember(env.DB, league.id, user.id);
    const result = await retryProvisionAndActivateLeague(provisioningDepsFromEnv(env, league.id), {
      league,
      membership,
    });
    if (!result.ok) return { intent, error: describeOnboardingError(result.error.kind) };
    return { intent, ok: true as const };
  }

  return { intent, error: "Unknown action." };
}

function SetupRail({ current }: { current: 1 | 2 | 3 }) {
  const steps: Array<{ n: 1 | 2 | 3; label: string }> = [
    { n: 1, label: "Connect Sleeper" },
    { n: 2, label: "Find your leagues" },
    { n: 3, label: "Verify or join" },
  ];
  return (
    <ol aria-label="Setup progress" className="flex flex-wrap gap-3 text-xs font-semibold uppercase tracking-[0.16em]">
      {steps.map((step) => {
        const done = step.n < current;
        const active = step.n === current;
        return (
          <li
            key={step.n}
            aria-current={active ? "step" : undefined}
            className={
              "flex items-center gap-2 rounded-full border px-3 py-1.5 " +
              (active
                ? "border-flag bg-flag/10 text-flag"
                : done
                  ? "border-cream/20 text-cream/70"
                  : "border-cream/10 text-muted")
            }
          >
            <span
              className={
                "flex h-5 w-5 items-center justify-center rounded-full text-[11px] " +
                (active ? "bg-flag text-ink" : done ? "bg-cream/20 text-cream" : "bg-ink/40 text-muted")
              }
            >
              {done ? "✓" : step.n}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function railStepFor(step: PilotLeagueStep): 1 | 2 | 3 {
  if (step.kind === "connect_sleeper_account") return 1;
  if (step.kind === "not_a_pilot_league_member" || step.kind === "discovery_unavailable") return 2;
  return 3;
}

// The signature element: the commissioner challenge rendered like a detachable roster label —
// the code up top (the part you'd "tear off" and paste into Sleeper), a perforated divider, then
// plain instructions underneath.
function ChallengeLabel({
  challenge,
  expiresAt,
  attempts,
  now,
  error,
}: {
  challenge: string;
  expiresAt: number;
  attempts: number;
  now: number;
  error?: string;
}) {
  const minutesLeft = Math.max(0, Math.round((expiresAt - now) / 60000));
  return (
    <Card className="border-2 border-dashed border-flag/50 bg-ink/40">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Roster label · verification code</p>
      <p className="mt-3 font-mono text-3xl font-bold tracking-[0.14em] text-flag">{challenge}</p>
      <div className="my-4 border-t-2 border-dashed border-cream/15" aria-hidden="true" />
      <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-cream/90">
        <li>Open your team on Sleeper.</li>
        <li>
          Rename your team to include <span className="font-mono text-flag">{challenge}</span> (anywhere in the
          name).
        </li>
        <li>Save.</li>
        <li>Come back here and click Verify.</li>
        <li>Restore your usual team name once you're verified.</li>
      </ol>
      <p className="mt-3 text-xs text-muted">
        {minutesLeft > 0
          ? `Expires in about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`
          : "This code just expired — request a new one below."}
        {attempts > 0 ? ` · ${attempts} attempt${attempts === 1 ? "" : "s"} so far.` : null}
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-3">
        <Form method="post">
          <input type="hidden" name="intent" value="verify-challenge" />
          <Button type="submit">I renamed my team — Verify</Button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="request-challenge" />
          <Button type="submit" variant="secondary">
            Request a new code
          </Button>
        </Form>
      </div>
    </Card>
  );
}

export default function Onboarding({ loaderData, actionData }: Route.ComponentProps) {
  const { sleeperUsername, pilotLeagueName, comingSoonLeagues, step, isCommissioner, now } = loaderData;
  const current = railStepFor(step);
  const errorForIntent = (intent: string) =>
    actionData && "error" in actionData && actionData.intent === intent ? actionData.error : undefined;
  const connectError = errorForIntent("connect");

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">
        <Link to="/">Cutman</Link>
      </p>
      <h1 className="mt-3 font-display text-4xl">Set up your league</h1>
      <p className="mt-2 text-muted">Connect your Sleeper account, then verify or join the pilot league.</p>

      <div className="mt-8">
        <SetupRail current={current} />
      </div>

      <div className="mt-8 space-y-6">
        {step.kind === "connect_sleeper_account" ? (
          <Card>
            <CardTitle>Connect your Sleeper account</CardTitle>
            <CardDescription>Enter the Sleeper username you play under. Cutman only reads your public league data.</CardDescription>
            <Form method="post" className="mt-5 space-y-3">
              <input type="hidden" name="intent" value="connect" />
              <Label htmlFor="username">Sleeper username</Label>
              <Input
                id="username"
                name="username"
                placeholder="your_sleeper_handle"
                autoComplete="off"
                required
                aria-invalid={connectError ? true : undefined}
                aria-describedby={connectError ? "username-error" : undefined}
              />
              {connectError ? (
                <p id="username-error" role="alert" className="text-sm text-danger">
                  {connectError}
                </p>
              ) : null}
              <Button type="submit">Connect account</Button>
            </Form>
          </Card>
        ) : null}

        {step.kind !== "connect_sleeper_account" && sleeperUsername ? (
          <p className="text-sm text-muted">
            Connected as <span className="text-cream">{sleeperUsername}</span> on Sleeper.
          </p>
        ) : null}

        {step.kind === "discovery_unavailable" ? (
          <Card>
            <Badge>Connection issue</Badge>
            <CardTitle className="mt-3">Cutman couldn't reach Sleeper</CardTitle>
            <CardDescription>
              Something went wrong reading your leagues from Sleeper just now. This is usually temporary — try
              again in a moment.
            </CardDescription>
            <div className="mt-5">
              <Button asChild variant="secondary">
                <a href="/onboarding">Try again</a>
              </Button>
            </div>
          </Card>
        ) : null}

        {step.kind === "not_a_pilot_league_member" ? (
          <Card>
            <Badge>Not in this league</Badge>
            <CardTitle className="mt-3">That Sleeper account isn't in this league</CardTitle>
            <CardDescription>{describeOnboardingError("not_a_pilot_league_member")}</CardDescription>
          </Card>
        ) : null}

        {step.kind === "request_challenge" ? (
          <Card>
            <Badge>Commissioner</Badge>
            <CardTitle className="mt-3">Verify you own {pilotLeagueName ?? "this league"}</CardTitle>
            <CardDescription>
              Sleeper shows you as the current owner. Request a one-time code, rename your team to include it
              temporarily, then verify.
            </CardDescription>
            {errorForIntent("request-challenge") ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {errorForIntent("request-challenge")}
              </p>
            ) : null}
            <Form method="post" className="mt-5">
              <input type="hidden" name="intent" value="request-challenge" />
              <Button type="submit">Request verification code</Button>
            </Form>
          </Card>
        ) : null}

        {step.kind === "challenge_pending" ? (
          <ChallengeLabel
            challenge={step.challenge}
            expiresAt={step.expiresAt}
            attempts={step.attempts}
            now={now}
            error={errorForIntent("verify-challenge") ?? errorForIntent("request-challenge")}
          />
        ) : null}

        {step.kind === "awaiting_commissioner" ? (
          <Card>
            <CardTitle>Waiting on your commissioner</CardTitle>
            <CardDescription>
              {pilotLeagueName ?? "This league"}'s commissioner hasn't verified it on Cutman yet. Check back after
              they do.
            </CardDescription>
          </Card>
        ) : null}

        {step.kind === "provisioning" ? (
          <Card>
            <Badge>Verified</Badge>
            <CardTitle className="mt-3">Setting up {pilotLeagueName ?? "your league"}</CardTitle>
            <CardDescription>
              Verification is done. Cutman is setting up the season book for this league — check back soon.
            </CardDescription>
          </Card>
        ) : null}

        {step.kind === "setup_error" ? (
          <Card>
            <CardTitle>Setup hit a snag</CardTitle>
            <CardDescription>
              Something went wrong setting up this league. Try again shortly, or reach out if it keeps happening.
            </CardDescription>
            {errorForIntent("retry-provision") ?? errorForIntent("verify-challenge") ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {errorForIntent("retry-provision") ?? errorForIntent("verify-challenge")}
              </p>
            ) : null}
            {isCommissioner ? (
              <Form method="post" className="mt-5">
                <input type="hidden" name="intent" value="retry-provision" />
                <Button type="submit">Retry setup</Button>
              </Form>
            ) : null}
          </Card>
        ) : null}

        {step.kind === "join_available" ? (
          <Card>
            <CardTitle>Join {pilotLeagueName ?? "this league"}</CardTitle>
            <CardDescription>This league is open on Cutman. Join as a member — no verification needed.</CardDescription>
            {errorForIntent("join") ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {errorForIntent("join")}
              </p>
            ) : null}
            <Form method="post" className="mt-5">
              <input type="hidden" name="intent" value="join" />
              <Button type="submit">Join league</Button>
            </Form>
          </Card>
        ) : null}

        {/* "already_member" is intentionally not rendered here: the loader above redirects to
            `/leagues/:id` the moment membership + an active league both exist, so this step can
            never actually reach the component (see computePilotLeagueStep's PilotLeagueStep
            comment and app/routes/onboarding.tsx's loader). */}

        {comingSoonLeagues.length > 0 ? (
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Your other leagues</h2>
            <ul className="mt-3 space-y-2">
              {comingSoonLeagues.map((league) => (
                <li key={league.sleeperLeagueId}>
                  <Card className="flex items-center justify-between gap-4 opacity-70">
                    <div>
                      <p className="text-cream">{league.name}</p>
                      <p className="text-xs text-muted">Season {league.season}</p>
                    </div>
                    <Badge>Coming soon</Badge>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </main>
  );
}
