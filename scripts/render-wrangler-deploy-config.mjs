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

const ALLOWED_OUTPUT_PATHS = Object.freeze([
  path.resolve(WRANGLER_DEPLOY_OUTPUT_PATH),
  path.resolve(WRANGLER_DEV_OUTPUT_PATH),
]);

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

function allowedOutputDescription() {
  return ALLOWED_OUTPUT_PATHS.map((outputPath) => formatRepoPath(outputPath)).join(
    " and ",
  );
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

export async function resolveAndAssertOutputPath(
  requested = process.env.WRANGLER_RENDER_OUTPUT,
) {
  const outputPath = requested
    ? path.resolve(repoRoot, requested)
    : path.resolve(WRANGLER_DEPLOY_OUTPUT_PATH);

  if (!ALLOWED_OUTPUT_PATHS.includes(outputPath)) {
    throw new Error(
      `Refusing to write Wrangler config to ${formatRepoPath(outputPath)}. Allowed destinations: ${allowedOutputDescription()}.`,
    );
  }

  await assertPathChainHasNoSymlinks(repoRoot, outputPath);

  return {
    outputPath,
    isDevConfig: outputPath === path.resolve(WRANGLER_DEV_OUTPUT_PATH),
  };
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
  return getOptionalValue("USE_SLEEPER_FIXTURES", env) || "false";
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
    USE_SLEEPER_FIXTURES: resolveUseSleeperFixtures(env),
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

export async function writeRenderedWranglerConfig({
  outputPath: requestedOutputPath,
  env = process.env,
} = {}) {
  const { outputPath, isDevConfig } = await resolveAndAssertOutputPath(
    requestedOutputPath ?? env.WRANGLER_RENDER_OUTPUT ?? null,
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

const isCliEntrypoint =
  Boolean(process.argv[1]) &&
  (await isSameRealPath(process.argv[1], fileURLToPath(import.meta.url)));

if (isCliEntrypoint) await main();
