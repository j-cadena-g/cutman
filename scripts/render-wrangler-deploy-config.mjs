#!/usr/bin/env node

import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifestKeys } from "./lib/parse-manifest-keys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const webDir = path.join(repoRoot, "apps/web");
const templatePath = path.join(webDir, "wrangler.jsonc");
const secretsExamplePath = path.join(webDir, ".wrangler.secrets.example");

export const WRANGLER_DEPLOY_OUTPUT_PATH = path.join(webDir, ".wrangler.deploy.jsonc");
export const WRANGLER_DEV_OUTPUT_PATH = path.join(webDir, ".wrangler.dev.jsonc");

/** Tracked wrangler.jsonc placeholder. Live ids are injected at render time. */
export const PLACEHOLDER_PILOT_ID = "0000000000000000000";
/** Distinct local-dev KV placeholders so Miniflare does not share PLAYERS and EXPLORER_CACHE. */
export const PLACEHOLDER_PLAYERS_KV_ID = "00000000000000000000000000000000";
export const PLACEHOLDER_EXPLORER_KV_ID = "00000000000000000000000000000002";

/**
 * Frozen repository destinations used by CLI, `writeRenderedWranglerConfig`,
 * and `run-vite-dev.mjs`. Not injectable from those public entry points.
 *
 * @typedef {{ readonly production: string, readonly dev: string }} WranglerAllowedOutputs
 */
const PRODUCTION_ALLOWED_OUTPUTS = Object.freeze({
  production: path.resolve(WRANGLER_DEPLOY_OUTPUT_PATH),
  dev: path.resolve(WRANGLER_DEV_OUTPUT_PATH),
});

const ALLOWED_OUTPUT_PATHS = Object.freeze([
  PRODUCTION_ALLOWED_OUTPUTS.production,
  PRODUCTION_ALLOWED_OUTPUTS.dev,
]);

const USE_SLEEPER_FIXTURES_ERROR =
  'Invalid USE_SLEEPER_FIXTURES; expected "true" or "false".';
const USE_SLEEPER_FIXTURES_DEPLOY_ERROR =
  'USE_SLEEPER_FIXTURES must be "false" for the deploy config.';

const requiredValues = {
  CLOUDFLARE_ACCOUNT_ID: {
    pattern: /^[a-f0-9]{32}$/i,
    description: "32-character Cloudflare account id",
  },
  CLOUDFLARE_D1_DATABASE_ID: {
    pattern: /^[a-f0-9]{32}$|^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    description: "D1 database id (32 hex chars or UUID)",
  },
  CLOUDFLARE_KV_NAMESPACE_ID: {
    pattern: /^[a-f0-9]{32}$/i,
    description: "32-character PLAYERS KV namespace id",
  },
  CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID: {
    pattern: /^[a-f0-9]{32}$/i,
    description: "32-character EXPLORER_CACHE KV namespace id",
  },
  CLOUDFLARE_CUSTOM_DOMAIN: {
    pattern: /^[^/\s]+(?:\/\*)?$/i,
    description: "custom domain or route pattern without protocol",
  },
  CLERK_PUBLISHABLE_KEY: {
    // Clerk's $ delimiter is inside the base64 payload (decodes to …dev$), not a
    // literal trailing character — see clerk.com/docs/guides/how-clerk-works/overview
    pattern: /^pk_(test|live)_[A-Za-z0-9_-]+={0,2}$/,
    description:
      "Clerk publishable key (pk_test_/pk_live_ + URL-safe base64 FAPI URL)",
  },
  APP_ORIGIN: {
    pattern: /^https?:\/\/[^/\s?#]+$/i,
    description: "application origin including protocol, without path",
  },
  PILOT_SLEEPER_LEAGUE_ID: {
    pattern: /^\d{6,}$/,
    description: "Sleeper league id (numeric snowflake)",
  },
};

const ALL_ZERO_ID = /^0+$/;

const replacements = [
  {
    label: "account_id",
    pattern: /("account_id"\s*:\s*")([^"]*)(")/,
    envName: "CLOUDFLARE_ACCOUNT_ID",
  },
  {
    label: "database_id",
    pattern: /("database_id"\s*:\s*")([^"]*)(")/,
    envName: "CLOUDFLARE_D1_DATABASE_ID",
  },
  {
    label: "PLAYERS kv namespace id",
    pattern: /("binding"\s*:\s*"PLAYERS"\s*,\s*"id"\s*:\s*")([^"]*)(")/,
    envName: "CLOUDFLARE_KV_NAMESPACE_ID",
  },
  {
    label: "EXPLORER_CACHE kv namespace id",
    pattern: /("binding"\s*:\s*"EXPLORER_CACHE"\s*,\s*"id"\s*:\s*")([^"]*)(")/,
    envName: "CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID",
  },
  {
    label: "route pattern",
    pattern: /("pattern"\s*:\s*")([^"]*)(")/,
    envName: "CLOUDFLARE_CUSTOM_DOMAIN",
  },
  {
    label: "APP_ENV",
    pattern: /("APP_ENV"\s*:\s*")([^"]*)(")/,
    envName: "APP_ENV",
  },
  {
    label: "APP_ORIGIN",
    pattern: /("APP_ORIGIN"\s*:\s*")([^"]*)(")/,
    envName: "APP_ORIGIN",
  },
  {
    label: "APP_URL",
    pattern: /("APP_URL"\s*:\s*")([^"]*)(")/,
    envName: "APP_ORIGIN",
  },
  {
    label: "CLERK_PUBLISHABLE_KEY",
    pattern: /("CLERK_PUBLISHABLE_KEY"\s*:\s*")([^"]*)(")/,
    envName: "CLERK_PUBLISHABLE_KEY",
  },
  {
    label: "USE_SLEEPER_FIXTURES",
    pattern: /("USE_SLEEPER_FIXTURES"\s*:\s*")([^"]*)(")/,
    envName: "USE_SLEEPER_FIXTURES",
  },
  {
    label: "PILOT_SLEEPER_LEAGUE_ID",
    pattern: /("PILOT_SLEEPER_LEAGUE_ID"\s*:\s*")([^"]*)(")/,
    envName: "PILOT_SLEEPER_LEAGUE_ID",
  },
];

function formatRepoPath(absolutePath) {
  const relative = path.relative(repoRoot, absolutePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return absolutePath;
}

function allowedOutputDescription(allowedOutputPaths = ALLOWED_OUTPUT_PATHS) {
  return allowedOutputPaths.map((outputPath) => formatRepoPath(outputPath)).join(
    " and ",
  );
}

function freezeAllowedOutputs(allowedOutputs) {
  const production = allowedOutputs?.production;
  const dev = allowedOutputs?.dev;
  if (typeof production !== "string" || typeof dev !== "string") {
    throw new Error(
      "allowedOutputs.production and allowedOutputs.dev are required.",
    );
  }
  return Object.freeze({
    production: path.resolve(production),
    dev: path.resolve(dev),
  });
}

/**
 * lstat every existing path component from `rootPath` through `destinationPath`.
 * The root itself is not checked (the repo directory may be a symlink). Missing
 * tail components are safe — stop at the first ENOENT. Any symlink in the chain
 * (parent or destination) is rejected so writes cannot follow it.
 */
export async function assertPathChainHasNoSymlinks(rootPath, destinationPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedDestination = path.resolve(destinationPath);
  const relative = path.relative(resolvedRoot, resolvedDestination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing to write Wrangler config to ${formatRepoPath(resolvedDestination)}.`,
    );
  }

  const segments = relative === "" ? [] : relative.split(path.sep).filter(Boolean);
  const chain = [];
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    chain.push(current);
  }

  for (const candidate of chain) {
    let stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to write Wrangler config through symlink at ${formatRepoPath(candidate)}.`,
      );
    }
  }
}

/**
 * Resolve a destination against an explicit allowlist keyed by output kind.
 *
 * Test-only. Production callers must use `resolveAndAssertOutputPath`,
 * which always uses the frozen repository destinations. `isDevConfig` is
 * `outputPath === allowedOutputs.dev`, so tests can classify temp files
 * without matching the real `WRANGLER_DEV_OUTPUT_PATH`.
 *
 * @param {string | null | undefined} requested
 * @param {{
 *   allowedOutputs: WranglerAllowedOutputs,
 *   symlinkRoot?: string,
 * }} options
 */
export async function resolveAndAssertOutputPathForAllowedPaths(
  requested,
  { allowedOutputs, symlinkRoot = repoRoot },
) {
  const resolvedAllowed = freezeAllowedOutputs(allowedOutputs);
  const allowedOutputPaths = Object.freeze([
    resolvedAllowed.production,
    resolvedAllowed.dev,
  ]);
  const outputPath = requested
    ? path.resolve(repoRoot, requested)
    : resolvedAllowed.production;

  if (!allowedOutputPaths.includes(outputPath)) {
    throw new Error(
      `Refusing to write Wrangler config to ${formatRepoPath(outputPath)}. Allowed destinations: ${allowedOutputDescription(allowedOutputPaths)}.`,
    );
  }

  await assertPathChainHasNoSymlinks(symlinkRoot, outputPath);

  return {
    outputPath,
    isDevConfig: outputPath === resolvedAllowed.dev,
  };
}

/**
 * Resolve a destination against the frozen repository allowlist.
 * Extra arguments are ignored so callers cannot inject a custom allowlist.
 */
export async function resolveAndAssertOutputPath(
  requested = process.env.WRANGLER_RENDER_OUTPUT,
) {
  return resolveAndAssertOutputPathForAllowedPaths(requested, {
    allowedOutputs: PRODUCTION_ALLOWED_OUTPUTS,
    symlinkRoot: repoRoot,
  });
}

function getOptionalValue(name, env) {
  return env[name]?.trim() || "";
}

function getOptionalValidatedValue(name, env) {
  const value = getOptionalValue(name, env);
  const rule = requiredValues[name];
  if (value && !rule.pattern.test(value)) {
    throw new Error(`Invalid ${name}; expected ${rule.description}.`);
  }
  return value;
}

function getRequiredValue(name, env) {
  const value = env[name]?.trim();
  const rule = requiredValues[name];

  if (!value) {
    throw new Error(`Missing ${name} (${rule.description}).`);
  }

  if (!rule.pattern.test(value)) {
    throw new Error(`Invalid ${name}; expected ${rule.description}.`);
  }

  return value;
}

function resolveUseSleeperFixtures(env) {
  const raw = env.USE_SLEEPER_FIXTURES;
  if (raw == null) {
    return "false";
  }
  if (typeof raw !== "string") {
    throw new Error(USE_SLEEPER_FIXTURES_ERROR);
  }
  const value = raw.trim();
  if (!value) {
    return "false";
  }
  if (value === "true" || value === "false") {
    return value;
  }
  throw new Error(USE_SLEEPER_FIXTURES_ERROR);
}

function resolveUseSleeperFixturesForConfig(isDevConfig, env) {
  const value = resolveUseSleeperFixtures(env);
  if (!isDevConfig && value === "true") {
    throw new Error(USE_SLEEPER_FIXTURES_DEPLOY_ERROR);
  }
  return value;
}

function usesSleeperFixtures(env) {
  return resolveUseSleeperFixtures(env) === "true";
}

function resolvePilotSleeperLeagueId(isDevConfig, env) {
  const allowPlaceholder = isDevConfig && usesSleeperFixtures(env);
  const value = getOptionalValidatedValue("PILOT_SLEEPER_LEAGUE_ID", env);
  if (allowPlaceholder) {
    return value;
  }

  if (!value) {
    throw new Error(
      `Missing PILOT_SLEEPER_LEAGUE_ID (${requiredValues.PILOT_SLEEPER_LEAGUE_ID.description}).`,
    );
  }

  if (ALL_ZERO_ID.test(value)) {
    throw new Error(
      "Invalid PILOT_SLEEPER_LEAGUE_ID; all-zero values (including the tracked placeholder) are not allowed when USE_SLEEPER_FIXTURES is not true.",
    );
  }

  return value;
}

function replaceConfigValue(source, { label, pattern }, value) {
  let replaced = false;

  const nextSource = source.replace(pattern, (_match, prefix, _current, suffix) => {
    replaced = true;
    return `${prefix}${JSON.stringify(value).slice(1, -1)}${suffix}`;
  });

  if (!replaced) {
    throw new Error(`Could not find ${label} in ${path.basename(templatePath)}.`);
  }

  return nextSource;
}

export function renderWranglerConfig(
  template,
  { isDevConfig, env = process.env, secretsExample = "" } = {},
) {
  const deployValues = {
    CLOUDFLARE_ACCOUNT_ID: isDevConfig
      ? "00000000000000000000000000000000"
      : getRequiredValue("CLOUDFLARE_ACCOUNT_ID", env),
    CLOUDFLARE_D1_DATABASE_ID: isDevConfig
      ? "00000000-0000-0000-0000-000000000000"
      : getRequiredValue("CLOUDFLARE_D1_DATABASE_ID", env),
    CLOUDFLARE_KV_NAMESPACE_ID: isDevConfig
      ? PLACEHOLDER_PLAYERS_KV_ID
      : getRequiredValue("CLOUDFLARE_KV_NAMESPACE_ID", env),
    CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID: isDevConfig
      ? PLACEHOLDER_EXPLORER_KV_ID
      : getRequiredValue("CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID", env),
    CLOUDFLARE_CUSTOM_DOMAIN: isDevConfig
      ? "localhost"
      : getRequiredValue("CLOUDFLARE_CUSTOM_DOMAIN", env),
    CLERK_PUBLISHABLE_KEY: getRequiredValue("CLERK_PUBLISHABLE_KEY", env),
    APP_ORIGIN: getRequiredValue("APP_ORIGIN", env),
    APP_ENV:
      env.APP_ENV?.trim() ||
      (isDevConfig ? "development" : "production"),
    USE_SLEEPER_FIXTURES: resolveUseSleeperFixturesForConfig(isDevConfig, env),
    PILOT_SLEEPER_LEAGUE_ID: resolvePilotSleeperLeagueId(isDevConfig, env),
  };
  if (
    deployValues.CLOUDFLARE_KV_NAMESPACE_ID ===
    deployValues.CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID
  ) {
    throw new Error(
      "CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID must differ from CLOUDFLARE_KV_NAMESPACE_ID.",
    );
  }
  let rendered = template;
  for (const replacement of replacements) {
    if (
      isDevConfig &&
      ["account_id", "database_id", "route pattern"].includes(replacement.label)
    ) {
      continue;
    }
    const value = deployValues[replacement.envName];
    if (!value && replacement.envName === "PILOT_SLEEPER_LEAGUE_ID") {
      continue;
    }
    rendered = replaceConfigValue(
      rendered,
      replacement,
      value,
    );
  }

  if (isDevConfig) {
    rendered = rendered.replace(/\n\s*"account_id"\s*:\s*"[^"]*",/, "\n");
    rendered = rendered.replace(/"workers_dev"\s*:\s*false/, '"workers_dev": true');
    rendered = rendered.replace(/"routes"\s*:\s*\[[\s\S]*?\],/, '"routes": [],');
    rendered = rendered.replace(
      /"placement"\s*:\s*\{[\s\S]*?\},/,
      "",
    );

    const requiredSecrets = parseManifestKeys(secretsExample);
    if (requiredSecrets.length === 0) {
      throw new Error(`No secret keys found in ${path.basename(secretsExamplePath)}.`);
    }

    const secretsBlock = [
      '  "secrets": {',
      '    "required": [',
      ...requiredSecrets.map((key) => `      "${key}",`),
      "    ]",
      "  },",
    ].join("\n");

    const varsBlockStart = /\n(\s*"vars"\s*:\s*\{)/;
    if (!varsBlockStart.test(rendered)) {
      throw new Error(`Could not find vars block in ${path.basename(templatePath)}.`);
    }
    rendered = rendered.replace(varsBlockStart, `\n\n${secretsBlock}\n$1`);
  }

  return rendered;
}

/**
 * Write rendered Wrangler config against an explicit allowlist.
 *
 * Test-only. Production callers must use `writeRenderedWranglerConfig`,
 * which always uses the frozen repository destinations. Do not call this
 * from CLI/`main` or `run-vite-dev.mjs`.
 *
 * `allowedOutputs.dev` vs `allowedOutputs.production` is the classification
 * seam: a temp path listed as `dev` gets the local-dev render even when it
 * is not the real `WRANGLER_DEV_OUTPUT_PATH`.
 *
 * @param {{
 *   outputPath?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   allowedOutputs: WranglerAllowedOutputs,
 *   symlinkRoot?: string,
 * }} options
 */
export async function writeRenderedWranglerConfigForAllowedPaths({
  outputPath: requestedOutputPath,
  env = process.env,
  allowedOutputs,
  symlinkRoot = repoRoot,
}) {
  const { outputPath, isDevConfig } = await resolveAndAssertOutputPathForAllowedPaths(
    requestedOutputPath ?? env.WRANGLER_RENDER_OUTPUT ?? null,
    { allowedOutputs, symlinkRoot },
  );
  const template = await readFile(templatePath, "utf8");
  const secretsExample = isDevConfig
    ? await readFile(secretsExamplePath, "utf8")
    : "";
  const rendered = renderWranglerConfig(template, {
    isDevConfig,
    env,
    secretsExample,
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered);

  globalThis.console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}

/**
 * Write rendered Wrangler config to a frozen repository destination.
 * Only `outputPath` and `env` are read; extra fields such as
 * `allowedOutputs` are ignored so CLI/`run-vite-dev` cannot inject paths.
 */
export async function writeRenderedWranglerConfig({
  outputPath: requestedOutputPath,
  env = process.env,
} = {}) {
  await writeRenderedWranglerConfigForAllowedPaths({
    outputPath: requestedOutputPath,
    env,
    allowedOutputs: PRODUCTION_ALLOWED_OUTPUTS,
    symlinkRoot: repoRoot,
  });
}

async function main() {
  await writeRenderedWranglerConfig();
}

export async function isSameRealPath(leftPath, rightPath) {
  try {
    return (await realpath(leftPath)) === (await realpath(rightPath));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Absent argv is a safe non-entrypoint (imports, `node -e`). A present path that
 * cannot be resolved fails loudly instead of skipping `main()`.
 */
export async function isCliEntrypoint(argvPath, modulePath) {
  if (!argvPath) return false;
  await realpath(argvPath);
  return isSameRealPath(argvPath, modulePath);
}

if (await isCliEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) {
  await main();
}
