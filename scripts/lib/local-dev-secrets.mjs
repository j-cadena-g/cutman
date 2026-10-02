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

/** Opt-in switch for calling real Workers AI from local dev. */
export const REMOTE_AI_FLAG = "CUTMAN_REMOTE_AI";

/** Wrangler reads these instead of opening the Cloudflare OAuth login. */
export const REMOTE_AI_KEYS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

/**
 * Local Workers AI is off unless CUTMAN_REMOTE_AI=true. When it is on, an API token and
 * account id are required so `pnpm run dev` never falls back to the OAuth browser login.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {{ enabled: boolean, missing: string[], error: string | null }}
 */
export function remoteAiStatus(env = process.env) {
  const raw = env[REMOTE_AI_FLAG]?.trim() ?? "";
  if (raw !== "" && raw !== "true" && raw !== "false") {
    return {
      enabled: false,
      missing: [],
      error: `Invalid ${REMOTE_AI_FLAG}; expected "true" or "false".`,
    };
  }
  if (raw !== "true") return { enabled: false, missing: [], error: null };
  const missing = REMOTE_AI_KEYS.filter((key) => !env[key]?.trim());
  return {
    enabled: true,
    missing,
    error:
      missing.length > 0
        ? `${REMOTE_AI_FLAG}=true needs ${missing.join(" and ")} so Wrangler skips the OAuth login. Set them in your local-dev Environment, or unset ${REMOTE_AI_FLAG}.`
        : null,
  };
}
