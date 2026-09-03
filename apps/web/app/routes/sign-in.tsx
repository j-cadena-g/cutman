import { SignIn } from "@clerk/react-router";
import { Link } from "react-router";
import { clerkIsConfigured } from "~/lib/clerk.server";
import { cloudflareEnv } from "~/lib/env";
import type { Route } from "./+types/sign-in";

export function loader({ context }: Route.LoaderArgs) {
  return { clerkConfigured: clerkIsConfigured(cloudflareEnv(context)) };
}

export default function SignInPage({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">Cutman</p>
      <h1 className="mt-4 font-display text-5xl leading-[1.05]">The season story for your Sleeper league.</h1>
      <p className="mt-4 text-muted">Sign in with Clerk. Access is allowlisted — this is not a public product.</p>
      {loaderData.clerkConfigured ? (
        <div className="mt-10">
          <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl="/" />
        </div>
      ) : (
        <div className="mt-10 space-y-4 text-sm text-muted">
          <p>Clerk keys are not injected in this process. Do not create a `.dev.vars` file.</p>
          <p>
            Export <code className="text-cream">CLERK_PUBLISHABLE_KEY</code> and{" "}
            <code className="text-cream">CLERK_SECRET_KEY</code> via{" "}
            <code className="text-cream">op run --environment &quot;Cutman (dev)&quot;</code>, or set{" "}
            <code className="text-cream">OP_ENVIRONMENT_ID</code> and run <code className="text-cream">pnpm dev</code>.
          </p>
          <Link className="inline-block underline decoration-flag/60" to="/">
            Back to Cutman
          </Link>
        </div>
      )}
    </main>
  );
}
