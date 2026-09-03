import { SignUp } from "@clerk/react-router";
import { Link } from "react-router";
import { clerkIsConfigured } from "~/lib/clerk.server";
import { cloudflareEnv } from "~/lib/env";
import type { Route } from "./+types/sign-up";

export function loader({ context }: Route.LoaderArgs) {
  return { clerkConfigured: clerkIsConfigured(cloudflareEnv(context)) };
}

export default function SignUpPage({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">Cutman</p>
      <h1 className="mt-4 font-display text-5xl leading-[1.05]">Create a Clerk account.</h1>
      <p className="mt-4 text-muted">
        Signing up does not put you on the league. Access is an allowlist of Clerk emails to Sleeper user ids.
      </p>
      {loaderData.clerkConfigured ? (
        <div className="mt-10">
          <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" forceRedirectUrl="/" />
        </div>
      ) : (
        <div className="mt-10 space-y-4 text-sm text-muted">
          <p>Clerk keys are not injected in this process. Do not create a `.dev.vars` file.</p>
          <Link className="inline-block underline decoration-flag/60" to="/sign-in">
            Back to sign in
          </Link>
        </div>
      )}
    </main>
  );
}
