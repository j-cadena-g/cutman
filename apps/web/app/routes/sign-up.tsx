import { SignUp } from "@clerk/react-router";

export default function SignUpPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">Cutman</p>
      <h1 className="mt-4 font-display text-5xl leading-[1.05]">Create a Clerk account.</h1>
      <p className="mt-4 text-muted">
        Signing up does not put you on 519 Keeper. James allowlists Clerk emails to Sleeper user ids.
      </p>
      <div className="mt-10">
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" forceRedirectUrl="/" />
      </div>
    </main>
  );
}
