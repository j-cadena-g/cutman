export function cloudflareEnv(context: unknown): Env {
  const env = (context as { cloudflare?: { env: Env } }).cloudflare?.env;
  if (!env) {
    throw new Error("Cloudflare env missing from load context");
  }
  return env;
}
