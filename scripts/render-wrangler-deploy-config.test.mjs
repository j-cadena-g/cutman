import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderWranglerConfig,
  resolveAndAssertOutputPath,
  WRANGLER_DEPLOY_OUTPUT_PATH,
  WRANGLER_DEV_OUTPUT_PATH,
} from "./render-wrangler-deploy-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/render-wrangler-deploy-config.mjs");
const templatePath = path.join(repoRoot, "apps/web/wrangler.jsonc");
const secretsExamplePath = path.join(repoRoot, "apps/web/.wrangler.secrets.example");

const FAKE_PILOT_ID = "1111111111111111111";
const PLACEHOLDER_PILOT_ID = "0000000000000000000";
const ALL_ZERO_PILOT_ID = "000000";

const template = await readFile(templatePath, "utf8");
const secretsExample = await readFile(secretsExamplePath, "utf8");

function baseEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("V1_")) delete env[key];
  }
  return {
    ...env,
    CLOUDFLARE_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    CLOUDFLARE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
    CLOUDFLARE_KV_NAMESPACE_ID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    CLOUDFLARE_CUSTOM_DOMAIN: "example.test",
    CLERK_PUBLISHABLE_KEY: "pk_test_abcdefghijklmnop",
    APP_ORIGIN: "https://example.test",
    USE_SLEEPER_FIXTURES: "false",
    PILOT_SLEEPER_LEAGUE_ID: FAKE_PILOT_ID,
    ...overrides,
  };
}

function renderProduction(env) {
  return renderWranglerConfig(template, { isDevConfig: false, env });
}

function renderDev(env) {
  return renderWranglerConfig(template, {
    isDevConfig: true,
    env,
    secretsExample,
  });
}

function spawnRenderer(envOverrides = {}, outputPath) {
  const env = { ...process.env, ...envOverrides };
  if (outputPath !== undefined) {
    env.WRANGLER_RENDER_OUTPUT = outputPath;
  }
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

describe("render-wrangler-deploy-config output path", () => {
  it("defaults to the gitignored production config path", async () => {
    const resolved = await resolveAndAssertOutputPath(null);
    assert.equal(resolved.outputPath, path.resolve(WRANGLER_DEPLOY_OUTPUT_PATH));
    assert.equal(resolved.isDevConfig, false);
  });

  it("allows the exact production and local-dev repository paths", async () => {
    const deploy = await resolveAndAssertOutputPath("apps/web/.wrangler.deploy.jsonc");
    assert.equal(deploy.outputPath, path.resolve(WRANGLER_DEPLOY_OUTPUT_PATH));
    assert.equal(deploy.isDevConfig, false);

    const dev = await resolveAndAssertOutputPath(WRANGLER_DEV_OUTPUT_PATH);
    assert.equal(dev.outputPath, path.resolve(WRANGLER_DEV_OUTPUT_PATH));
    assert.equal(dev.isDevConfig, true);
  });

  it("allows a path that canonicalizes to an exact allowed destination", async () => {
    const resolved = await resolveAndAssertOutputPath(
      "apps/web/foo/../.wrangler.deploy.jsonc",
    );
    assert.equal(resolved.outputPath, path.resolve(WRANGLER_DEPLOY_OUTPUT_PATH));
  });

  it("rejects an arbitrary path, including a matching basename outside apps/web", async () => {
    const arbitrary = path.join(os.tmpdir(), ".wrangler.deploy.jsonc");
    await assert.rejects(
      () => resolveAndAssertOutputPath(arbitrary),
      /Refusing to write Wrangler config/,
    );
    await assert.rejects(
      () => resolveAndAssertOutputPath("apps/.wrangler.deploy.jsonc"),
      /Refusing to write Wrangler config/,
    );
  });

  it("rejects a traversal-equivalent path that leaves apps/web", async () => {
    await assert.rejects(
      () => resolveAndAssertOutputPath("apps/web/../../.wrangler.deploy.jsonc"),
      /Refusing to write Wrangler config/,
    );
  });

  it("rejects an arbitrary CLI output path before rendering secrets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.deploy.jsonc");
    try {
      const result = spawnRenderer({}, outputPath);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to write Wrangler config/);
      assert.doesNotMatch(result.stderr, /CLOUDFLARE_ACCOUNT_ID/);
      assert.doesNotMatch(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
      await assert.rejects(() => readFile(outputPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a traversal-equivalent CLI output path before rendering secrets", async () => {
    const result = spawnRenderer(baseEnv(), "apps/web/../../.wrangler.deploy.jsonc");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to write Wrangler config/);
    assert.doesNotMatch(result.stderr, /Missing CLOUDFLARE_ACCOUNT_ID/);
  });
});

describe("render-wrangler-deploy-config", () => {
  it("requires PILOT_SLEEPER_LEAGUE_ID and ignores leftover V1_* keys", () => {
    assert.throws(
      () => renderProduction(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "" })),
      /PILOT_SLEEPER_LEAGUE_ID/,
    );

    const leftover = baseEnv();
    leftover.V1_LEAGUE_ID = "legacy-v1-league-id";
    leftover.V1_LEAGUE_NAME = "Legacy V1 League";
    leftover.V1_SLEEPER_USER_ID = "legacy-v1-user-id";
    leftover.V1_SLEEPER_USERNAME = "legacy_v1_user";
    const rendered = renderProduction(leftover);
    assert.match(rendered, new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${FAKE_PILOT_ID}"`));
    assert.doesNotMatch(rendered, /"V1_LEAGUE_ID"/);
    assert.doesNotMatch(rendered, /"V1_LEAGUE_NAME"/);
    assert.doesNotMatch(rendered, /"V1_SLEEPER_USER_ID"/);
    assert.doesNotMatch(rendered, /"V1_SLEEPER_USERNAME"/);
  });

  it("fails when PILOT_SLEEPER_LEAGUE_ID is absent", () => {
    const env = baseEnv();
    delete env.PILOT_SLEEPER_LEAGUE_ID;
    assert.throws(
      () => renderProduction(env),
      (error) => {
        assert.match(error.message, /PILOT_SLEEPER_LEAGUE_ID/);
        assert.doesNotMatch(error.message, /V1_LEAGUE_ID/);
        return true;
      },
    );
  });

  it("rejects a non-snowflake PILOT_SLEEPER_LEAGUE_ID", () => {
    assert.throws(
      () => renderProduction(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "not-a-league" })),
      /PILOT_SLEEPER_LEAGUE_ID/,
    );
  });

  it("rejects the tracked placeholder PILOT_SLEEPER_LEAGUE_ID on production render", () => {
    assert.throws(
      () => renderProduction(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: PLACEHOLDER_PILOT_ID })),
      /PILOT_SLEEPER_LEAGUE_ID.*placeholder/s,
    );
  });

  it("rejects an all-zero PILOT_SLEEPER_LEAGUE_ID on production render", () => {
    assert.throws(
      () => renderProduction(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: ALL_ZERO_PILOT_ID })),
      /PILOT_SLEEPER_LEAGUE_ID/,
    );
  });

  it("rejects a non-snowflake PILOT_SLEEPER_LEAGUE_ID on local-dev render", () => {
    assert.throws(
      () => renderDev(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "not-a-league" })),
      /PILOT_SLEEPER_LEAGUE_ID/,
    );
  });

  it("fails local-dev render when USE_SLEEPER_FIXTURES is false and PILOT_SLEEPER_LEAGUE_ID is omitted", () => {
    assert.throws(
      () => renderDev(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "" })),
      /PILOT_SLEEPER_LEAGUE_ID/,
    );
  });

  it("fails local-dev render when USE_SLEEPER_FIXTURES is false and PILOT_SLEEPER_LEAGUE_ID is absent", () => {
    const env = baseEnv();
    delete env.PILOT_SLEEPER_LEAGUE_ID;
    assert.throws(() => renderDev(env), /PILOT_SLEEPER_LEAGUE_ID/);
  });

  it("fails local-dev render when USE_SLEEPER_FIXTURES is false and PILOT_SLEEPER_LEAGUE_ID is the placeholder", () => {
    assert.throws(
      () => renderDev(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: PLACEHOLDER_PILOT_ID })),
      /PILOT_SLEEPER_LEAGUE_ID.*placeholder/s,
    );
  });

  it("fails local-dev render when USE_SLEEPER_FIXTURES is false and PILOT_SLEEPER_LEAGUE_ID is all zeros", () => {
    assert.throws(
      () => renderDev(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: ALL_ZERO_PILOT_ID })),
      /PILOT_SLEEPER_LEAGUE_ID/,
    );
  });

  it("writes a live-shaped PILOT_SLEEPER_LEAGUE_ID on local-dev render when USE_SLEEPER_FIXTURES is false", () => {
    const rendered = renderDev(baseEnv());
    assert.match(rendered, new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${FAKE_PILOT_ID}"`));
    assert.match(rendered, /"USE_SLEEPER_FIXTURES"\s*:\s*"false"/);
  });

  it("keeps the fake placeholder when fixture-mode local-dev render omits PILOT_SLEEPER_LEAGUE_ID", () => {
    const rendered = renderDev(
      baseEnv({ USE_SLEEPER_FIXTURES: "true", PILOT_SLEEPER_LEAGUE_ID: "" }),
    );
    assert.match(
      rendered,
      new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${PLACEHOLDER_PILOT_ID}"`),
    );
  });

  it("keeps the fake placeholder when PILOT_SLEEPER_LEAGUE_ID is absent on fixture-mode local-dev render", () => {
    const env = baseEnv({ USE_SLEEPER_FIXTURES: "true" });
    delete env.PILOT_SLEEPER_LEAGUE_ID;
    const rendered = renderDev(env);
    assert.match(
      rendered,
      new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${PLACEHOLDER_PILOT_ID}"`),
    );
  });
});
