import { clerkMiddleware, rootAuthLoader } from "@clerk/react-router/server";
import type { LoaderFunctionArgs } from "react-router";
import { cloudflareEnv } from "~/lib/env";

type ProcessEnv = { env?: Record<string, string | undefined> };

const PLACEHOLDER_PUBLISHABLE = new Set([
  "pk_test_replace_me",
  "pk_test_not_configured",
  "pk_test_Y2xlcmsuZXhhbXBsZS5kZXYk",
]);

const PLACEHOLDER_SECRET = new Set(["sk_test_not_configured", "sk_test_x", "sk_test_..."]);

export function clerkKeys(env: Env): { publishableKey: string; secretKey: string } {
  return {
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
  };
}

export function clerkIsConfigured(env: Env): boolean {
  const publishable = env.CLERK_PUBLISHABLE_KEY?.trim() ?? "";
  const secret = env.CLERK_SECRET_KEY?.trim() ?? "";
  if (!publishable || !secret) return false;
  if (PLACEHOLDER_PUBLISHABLE.has(publishable) || PLACEHOLDER_SECRET.has(secret)) {
    return false;
  }
  const match = publishable.match(/^pk_(test|live)_([A-Za-z0-9_-]+={0,2})$/);
  if (!match || !/^sk_(test|live)_/.test(secret)) return false;
  try {
    const decoded = atob(match[2].replaceAll("-", "+").replaceAll("_", "/"));
    if (decoded.includes("example.") || decoded.includes("replace")) return false;
  } catch {
    return false;
  }
  return true;
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
  if (!clerkIsConfigured(env)) {
    return next();
  }
  bindClerkEnv(env);
  return clerkMiddleware({
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
    signInUrl: "/sign-in",
    signUpUrl: "/sign-up",
  })(args as never, next) as Response | Promise<Response>;
}

export function loadRootAuth(args: { request: Request; context: unknown }) {
  const env = cloudflareEnv(args.context);
  if (!clerkIsConfigured(env)) {
    return { clerkConfigured: false as const };
  }
  bindClerkEnv(env);
  return rootAuthLoader(args as LoaderFunctionArgs);
}
