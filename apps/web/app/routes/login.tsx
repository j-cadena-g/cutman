import { Form, redirect, useNavigation } from "react-router";
import { magicLinkEmail, sendEmail } from "@league-brain/email";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cloudflareEnv } from "~/lib/env";
import { getCurrentUser, startMagicLink } from "~/lib/session.server";
import type { Route } from "./+types/login";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = cloudflareEnv(context);
  const user = await getCurrentUser(request, env);
  if (user) throw redirect("/");
  return { sent: new URL(request.url).searchParams.get("sent") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = cloudflareEnv(context);
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  try {
    const started = await startMagicLink(env, email, request.url);
    const copy = magicLinkEmail({ url: started.url });
    await sendEmail(env.EMAIL, {
      from: env.EMAIL_FROM,
      to: started.email,
      subject: copy.subject,
      text: copy.text,
    });
    return redirect("/login?sent=1");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not send the link." };
  }
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const sending = navigation.state !== "idle";
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">League Brain</p>
      <h1 className="mt-4 font-display text-5xl leading-[1.05]">The league as a story, not a spreadsheet.</h1>
      <p className="mt-4 text-muted">
        Trades, rivalries, weekly shame, running gags. Sign in with a magic link. No passwords.
      </p>
      <Card className="mt-10">
        {loaderData.sent ? (
          <>
            <CardTitle>Check your inbox</CardTitle>
            <CardDescription>
              If that address is real, a 15-minute sign-in link is on the way. Locally, Wrangler logs the email instead of
              sending it until Email Sending is configured.
            </CardDescription>
          </>
        ) : (
          <>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>We email a one-time link. The session cookie is httpOnly.</CardDescription>
            <Form method="post" className="mt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@example.test" />
              </div>
              {actionData?.error ? <p className="text-sm text-danger">{actionData.error}</p> : null}
              <Button type="submit" disabled={sending}>
                {sending ? "Sending…" : "Email me a link"}
              </Button>
            </Form>
          </>
        )}
      </Card>
      <p className="mt-8 text-sm text-muted">
        Built for NFL Sleeper leagues. Rosters stay on{" "}
        <a className="underline decoration-flag/60" href="https://sleeper.com" target="_blank" rel="noreferrer">
          Sleeper
        </a>
        .
      </p>
    </main>
  );
}
