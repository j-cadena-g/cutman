import { Form, redirect } from "react-router";
import { PageLead, PageShell, PageTitle } from "~/components/page-shell";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { parseExplorerUsernameForm } from "~/lib/sleeper-explorer";
import { requireUser } from "~/lib/session.server";
import type { Route } from "./+types/explore";

export async function loader(args: Route.LoaderArgs) {
  await requireUser(args);
  return {};
}

export async function action(args: Route.ActionArgs) {
  await requireUser(args);
  const form = await args.request.formData();
  const parsed = parseExplorerUsernameForm(String(form.get("username") ?? ""));
  if (!parsed.ok) return { error: parsed.error, submittedUsername: parsed.submittedUsername };
  throw redirect(`/explore/u/${encodeURIComponent(parsed.username)}`);
}

export default function Explore({ actionData }: Route.ComponentProps) {
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  const submittedUsername =
    actionData && "submittedUsername" in actionData ? actionData.submittedUsername : undefined;
  return (
    <PageShell>
      <PageTitle>Explore Sleeper</PageTitle>
      <PageLead>
        Look up any public Sleeper username. This is live league data from Sleeper, not a Cutman season book.
      </PageLead>
      <Card className="mt-8">
        <CardTitle>Find a manager</CardTitle>
        <CardDescription>Cutman only reads what Sleeper already publishes.</CardDescription>
        <Form method="post" className="mt-5 space-y-3">
          <Label htmlFor="username">Sleeper username</Label>
          <Input
            id="username"
            name="username"
            placeholder="sleeper_handle"
            autoComplete="off"
            required
            defaultValue={submittedUsername}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "username-error" : undefined}
          />
          {error ? (
            <p id="username-error" role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit">Look up</Button>
        </Form>
      </Card>
    </PageShell>
  );
}
