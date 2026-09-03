import { SignIn } from "@clerk/react-router";

export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-flag">Cutman</p>
      <h1 className="mt-4 font-display text-5xl leading-[1.05]">The season story for 519 Keeper.</h1>
      <p className="mt-4 text-muted">Sign in with Clerk. Access is allowlisted — this is not a public product.</p>
      <div className="mt-10">
        <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl="/" />
      </div>
    </main>
  );
}
