import { clerkMiddleware, rootAuthLoader } from "@clerk/react-router/server";
import type { LoaderFunctionArgs } from "react-router";
import { cloudflareEnv } from "~/lib/env";

type ProcessEnv = { env?: Record<string, string | undefined> };

export function clerkKeys(env: Env): { publishableKey: string; secretKey: string } {
  return {
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
  };
}

export function bindClerkEnv(env: Env): void {
  const processEnv = (globalThis as { process?: ProcessEnv }).process?.env;
  if (!processEnv) return;
  processEnv.CLERK_PUBLISHABLE_KEY = env.CLERK_PUBLISHABLE_KEY;
  processEnv.CLERK_SECRET_KEY = env.CLERK_SECRET_KEY;
  processEnv.VITE_CLERK_PUBLISHABLE_KEY = env.CLERK_PUBLISHABLE_KEY;
}

export function clerkRequestMiddleware(
  args: { context: unknown; request: Request },
  next: () => Promise<Response>,
): Response | Promise<Response> {
  const env = cloudflareEnv(args.context);
  bindClerkEnv(env);
  return clerkMiddleware({
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
    signInUrl: "/sign-in",
    signUpUrl: "/sign-up",
  })(args as never, next) as Response | Promise<Response>;
}

export function loadRootAuth(args: { request: Request; context: unknown }) {
  bindClerkEnv(cloudflareEnv(args.context));
  return rootAuthLoader(args as LoaderFunctionArgs);
}
