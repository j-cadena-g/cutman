/** Required vs optional secrets for local `pnpm run dev` / `dev:verify`. */

export const REQUIRED_LOCAL_DEV_KEYS = [
  "APP_ENV",
  "APP_ORIGIN",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
];

/** Optional keys for agentic login; Cutman has none. Keep the classifier shape. */
export const AGENTIC_LOCAL_DEV_KEYS = [];

/**
 * @param {string[]} manifestKeys keys from apps/web/.dev.vars.example
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function classifyLocalDevSecrets(manifestKeys, env = process.env) {
  const requiredSet = new Set(REQUIRED_LOCAL_DEV_KEYS);
  const agenticSet = new Set(AGENTIC_LOCAL_DEV_KEYS);
  const unknownRequired = REQUIRED_LOCAL_DEV_KEYS.filter(
    (key) => !manifestKeys.includes(key),
  );
  const optionalKeys = manifestKeys.filter((key) => !requiredSet.has(key));
  const runtimeOptionalKeys = optionalKeys.filter((key) => !agenticSet.has(key));
  const agenticKeys = optionalKeys.filter((key) => agenticSet.has(key));

  const missingRequired = REQUIRED_LOCAL_DEV_KEYS.filter(
    (key) => !env[key]?.trim(),
  );
  const missingOptional = runtimeOptionalKeys.filter((key) => !env[key]?.trim());
  const missingAgentic = agenticKeys.filter((key) => !env[key]?.trim());
  const presentRequired = REQUIRED_LOCAL_DEV_KEYS.filter((key) =>
    env[key]?.trim(),
  );
  const presentOptional = runtimeOptionalKeys.filter((key) => env[key]?.trim());
  const presentAgentic = agenticKeys.filter((key) => env[key]?.trim());

  return {
    requiredKeys: REQUIRED_LOCAL_DEV_KEYS,
    optionalKeys: runtimeOptionalKeys,
    agenticKeys,
    unknownRequired,
    missingRequired,
    missingOptional,
    missingAgentic,
    presentRequired,
    presentOptional,
    presentAgentic,
  };
}

/**
 * @param {string[]} missingAgentic
 * @returns {string | null}
 */
export function formatMissingAgenticNote(missingAgentic) {
  if (missingAgentic.length === 0) {
    return null;
  }

  return `note: agentic login keys not set (${missingAgentic.join(", ")})`;
}

/**
 * Env for the local Vite/Workers child. Forwards injected secrets and tells
 * the Cloudflare Vite plugin to read them from process.env (no .dev.vars).
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function envForLocalViteWorker(env = process.env) {
  const next = { ...env, CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" };
  if (!next.APP_URL?.trim() && next.APP_ORIGIN?.trim()) {
    next.APP_URL = next.APP_ORIGIN;
  }
  return next;
}
