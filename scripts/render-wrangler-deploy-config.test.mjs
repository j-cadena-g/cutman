import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertPathChainHasNoSymlinks,
  isCliEntrypoint,
  isSameRealPath,
  PLACEHOLDER_EXPLORER_KV_ID,
  PLACEHOLDER_PILOT_ID,
  PLACEHOLDER_PLAYERS_KV_ID,
  renderWranglerConfig,
  resolveAndAssertOutputPath,
  resolveAndAssertOutputPathForAllowedPaths,
  WRANGLER_DEPLOY_OUTPUT_PATH,
  WRANGLER_DEV_OUTPUT_PATH,
  writeRenderedWranglerConfig,
  writeRenderedWranglerConfigForAllowedPaths,
} from "./render-wrangler-deploy-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/render-wrangler-deploy-config.mjs");
const templatePath = path.join(repoRoot, "apps/web/wrangler.jsonc");
const secretsExamplePath = path.join(repoRoot, "apps/web/.wrangler.secrets.example");

const FAKE_PILOT_ID = "1111111111111111111";
const ALL_ZERO_PILOT_ID = "000000";
const FAKE_PLAYERS_KV_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FAKE_EXPLORER_KV_ID = "cccccccccccccccccccccccccccccccc";
const INVALID_EXPLORER_KV_ID = "not-a-kv-namespace-id";

const template = await readFile(templatePath, "utf8");
const secretsExample = await readFile(secretsExamplePath, "utf8");

function trackedTemplateString(name) {
  const match = template.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  assert.ok(match, `tracked wrangler.jsonc is missing ${name}`);
  return match[1];
}

function trackedTemplateKvId(binding) {
  const match = template.match(
    new RegExp(`"binding"\\s*:\\s*"${binding}"\\s*,\\s*"id"\\s*:\\s*"([^"]*)"`),
  );
  assert.ok(match, `tracked wrangler.jsonc is missing ${binding} kv id`);
  return match[1];
}

const trackedPilotId = trackedTemplateString("PILOT_SLEEPER_LEAGUE_ID");
const trackedUseSleeperFixtures = trackedTemplateString("USE_SLEEPER_FIXTURES");
const trackedPlayersKvId = trackedTemplateKvId("PLAYERS");
const trackedExplorerKvId = trackedTemplateKvId("EXPLORER_CACHE");

function kvBindingIdPattern(binding, id) {
  return new RegExp(`"binding"\\s*:\\s*"${binding}"\\s*,\\s*"id"\\s*:\\s*"${id}"`);
}

function useSleeperFixturesPattern(value) {
  return new RegExp(`"USE_SLEEPER_FIXTURES"\\s*:\\s*"${value}"`);
}

function baseEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("V1_")) delete env[key];
  }
  return {
    ...env,
    CLOUDFLARE_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    CLOUDFLARE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
    CLOUDFLARE_KV_NAMESPACE_ID: FAKE_PLAYERS_KV_ID,
    CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID: FAKE_EXPLORER_KV_ID,
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

async function snapshotFile(filePath) {
  try {
    const info = await stat(filePath);
    return {
      exists: true,
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

async function snapshotAllowedOutputs() {
  return {
    deploy: await snapshotFile(WRANGLER_DEPLOY_OUTPUT_PATH),
    dev: await snapshotFile(WRANGLER_DEV_OUTPUT_PATH),
  };
}

async function withTempAllowedOutputs(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-allowed-"));
  const allowedOutputs = Object.freeze({
    production: path.join(dir, ".wrangler.deploy.jsonc"),
    dev: path.join(dir, ".wrangler.dev.jsonc"),
  });
  try {
    return await fn({ dir, allowedOutputs });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const USE_SLEEPER_FIXTURES_DEPLOY_ERROR =
  'USE_SLEEPER_FIXTURES must be "false" for the deploy config.';

function assertInvalidUseSleeperFixtures(envValue) {
  assert.throws(
    () => renderProduction(baseEnv({ USE_SLEEPER_FIXTURES: envValue })),
    (error) => {
      assert.equal(
        error.message,
        'Invalid USE_SLEEPER_FIXTURES; expected "true" or "false".',
      );
      return true;
    },
  );
}

function assertRejectedDeployFixtures(env) {
  assert.throws(
    () => renderProduction(env),
    (error) => {
      assert.equal(error.message, USE_SLEEPER_FIXTURES_DEPLOY_ERROR);
      assert.doesNotMatch(error.message, new RegExp(FAKE_PILOT_ID));
      assert.doesNotMatch(error.message, new RegExp(FAKE_PLAYERS_KV_ID));
      assert.doesNotMatch(error.message, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
      return true;
    },
  );
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

  it("rejects a symbolic link at an allowed production destination without touching repo files", async () => {
    await withTempAllowedOutputs(async ({ dir, allowedOutputs }) => {
      const target = path.join(dir, "target.jsonc");
      await writeFile(target, "should-not-be-overwritten");
      await symlink(target, allowedOutputs.production);
      const before = await snapshotAllowedOutputs();

      await assert.rejects(
        () =>
          resolveAndAssertOutputPathForAllowedPaths(allowedOutputs.production, {
            allowedOutputs,
            symlinkRoot: dir,
          }),
        /symlink/,
      );
      await assert.rejects(
        () =>
          writeRenderedWranglerConfigForAllowedPaths({
            outputPath: allowedOutputs.production,
            env: baseEnv(),
            allowedOutputs,
            symlinkRoot: dir,
          }),
        /symlink/,
      );
      assert.equal((await lstat(allowedOutputs.production)).isSymbolicLink(), true);
      assert.equal(await readFile(target, "utf8"), "should-not-be-overwritten");
      await assert.rejects(
        () => resolveAndAssertOutputPath(allowedOutputs.production),
        /Refusing to write Wrangler config/,
      );
      assert.deepEqual(await snapshotAllowedOutputs(), before);
    });
  });

  it("returns at the first missing path component without throwing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-missing-"));
    try {
      await assertPathChainHasNoSymlinks(root, path.join(root, "missing", "out.jsonc"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a parent directory symlink without mutating real repo directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-parent-link-"));
    try {
      const realDir = path.join(root, "real");
      await mkdir(realDir);
      const target = path.join(realDir, "secret.jsonc");
      await writeFile(target, "should-not-be-overwritten");
      const parentLink = path.join(root, "linked-parent");
      await symlink(realDir, parentLink);
      const destination = path.join(parentLink, ".wrangler.deploy.jsonc");

      await assert.rejects(
        () => assertPathChainHasNoSymlinks(root, destination),
        /symlink/,
      );
      assert.equal((await lstat(parentLink)).isSymbolicLink(), true);
      assert.equal(await readFile(target, "utf8"), "should-not-be-overwritten");
      await assert.rejects(
        () => resolveAndAssertOutputPath(destination),
        /Refusing to write Wrangler config/,
      );
      await assert.rejects(
        () =>
          resolveAndAssertOutputPathForAllowedPaths(destination, {
            allowedOutputs: {
              production: destination,
              dev: path.join(parentLink, ".wrangler.dev.jsonc"),
            },
            symlinkRoot: root,
          }),
        /symlink/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not write files on a normal non-test import", async () => {
    const before = await snapshotAllowedOutputs();
    const env = {
      ...process.env,
      ...baseEnv(),
      WRANGLER_RENDER_OUTPUT: WRANGLER_DEV_OUTPUT_PATH,
    };
    delete env.NODE_TEST_CONTEXT;

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import "./scripts/render-wrangler-deploy-config.mjs";',
      ],
      {
        cwd: repoRoot,
        env,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(await snapshotAllowedOutputs(), before);
  });

  it("runs as CLI when invoked through a symlink to the script", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-cli-link-"));
    const linkPath = path.join(dir, "render-wrangler-deploy-config.mjs");
    await symlink(scriptPath, linkPath);
    try {
      const result = spawnSync(process.execPath, [linkPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          WRANGLER_RENDER_OUTPUT: path.join(dir, ".wrangler.deploy.jsonc"),
        },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to write Wrangler config/);
      assert.doesNotMatch(result.stderr, /CLOUDFLARE_ACCOUNT_ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing argv path as not this module", async () => {
    assert.equal(
      await isSameRealPath("/this/path/does/not/exist.mjs", scriptPath),
      false,
    );
  });

  it("treats an absent argv path as a safe non-entrypoint", async () => {
    assert.equal(await isCliEntrypoint("", scriptPath), false);
    assert.equal(await isCliEntrypoint(undefined, scriptPath), false);
  });

  it("fails loudly when argv is present but unresolvable", async () => {
    await assert.rejects(
      () => isCliEntrypoint("/this/path/does/not/exist.mjs", scriptPath),
      { code: "ENOENT" },
    );

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'process.argv[1] = "/this/path/does/not/exist.mjs"; await import("./scripts/render-wrangler-deploy-config.mjs");',
      ],
      {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT/);
  });

  it("treats a symlink to this module as the CLI entrypoint", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-entrypoint-link-"));
    const linkPath = path.join(dir, "render-wrangler-deploy-config.mjs");
    try {
      await symlink(scriptPath, linkPath);
      assert.equal(await isCliEntrypoint(linkPath, scriptPath), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("selects the production default when injected env omits output even if process.env points elsewhere", async () => {
    await withTempAllowedOutputs(async ({ dir, allowedOutputs }) => {
      const previousOutput = process.env.WRANGLER_RENDER_OUTPUT;
      process.env.WRANGLER_RENDER_OUTPUT = WRANGLER_DEV_OUTPUT_PATH;
      const env = baseEnv();
      delete env.WRANGLER_RENDER_OUTPUT;
      const before = await snapshotAllowedOutputs();

      try {
        await writeRenderedWranglerConfigForAllowedPaths({
          env,
          allowedOutputs,
          symlinkRoot: dir,
        });
        const written = await readFile(allowedOutputs.production, "utf8");
        assert.match(
          written,
          new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${FAKE_PILOT_ID}"`),
        );
        assert.match(written, useSleeperFixturesPattern("false"));
        assert.doesNotMatch(written, /"secrets"\s*:\s*\{/);
        await assert.rejects(() => readFile(allowedOutputs.dev));
        assert.deepEqual(await snapshotAllowedOutputs(), before);
      } finally {
        if (previousOutput === undefined) {
          delete process.env.WRANGLER_RENDER_OUTPUT;
        } else {
          process.env.WRANGLER_RENDER_OUTPUT = previousOutput;
        }
      }
    });
  });

  it("classifies an injected temp path as local-dev without writing repository files", async () => {
    await withTempAllowedOutputs(async ({ dir, allowedOutputs }) => {
      const before = await snapshotAllowedOutputs();
      await writeRenderedWranglerConfigForAllowedPaths({
        outputPath: allowedOutputs.dev,
        env: baseEnv(),
        allowedOutputs,
        symlinkRoot: dir,
      });

      const written = await readFile(allowedOutputs.dev, "utf8");
      assert.match(written, /"secrets"\s*:\s*\{/);
      assert.match(
        written,
        new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${FAKE_PILOT_ID}"`),
      );
      assert.match(written, useSleeperFixturesPattern("false"));
      await assert.rejects(() => readFile(allowedOutputs.production));
      await assert.rejects(
        () =>
          writeRenderedWranglerConfigForAllowedPaths({
            outputPath: path.join(os.tmpdir(), ".wrangler.dev.jsonc"),
            env: baseEnv(),
            allowedOutputs,
            symlinkRoot: dir,
          }),
        /Refusing to write Wrangler config/,
      );
      await assert.rejects(
        () =>
          writeRenderedWranglerConfig({
            outputPath: allowedOutputs.dev,
            env: baseEnv(),
          }),
        /Refusing to write Wrangler config/,
      );
      assert.deepEqual(await snapshotAllowedOutputs(), before);
    });
  });

  it("classifies by allowedOutputs kind rather than the real repository path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-kind-"));
    const allowedOutputs = Object.freeze({
      production: path.join(dir, "kind-production.jsonc"),
      dev: path.join(dir, "kind-dev.jsonc"),
    });
    const before = await snapshotAllowedOutputs();
    try {
      const production = await resolveAndAssertOutputPathForAllowedPaths(
        allowedOutputs.production,
        { allowedOutputs, symlinkRoot: dir },
      );
      assert.equal(production.isDevConfig, false);
      assert.notEqual(
        production.outputPath,
        path.resolve(WRANGLER_DEPLOY_OUTPUT_PATH),
      );

      const dev = await resolveAndAssertOutputPathForAllowedPaths(
        allowedOutputs.dev,
        { allowedOutputs, symlinkRoot: dir },
      );
      assert.equal(dev.isDevConfig, true);
      assert.notEqual(dev.outputPath, path.resolve(WRANGLER_DEV_OUTPUT_PATH));

      await writeRenderedWranglerConfigForAllowedPaths({
        outputPath: allowedOutputs.dev,
        env: baseEnv(),
        allowedOutputs,
        symlinkRoot: dir,
      });
      assert.match(await readFile(allowedOutputs.dev, "utf8"), /"secrets"\s*:\s*\{/);
      assert.doesNotMatch(
        await readFile(allowedOutputs.dev, "utf8"),
        /"account_id"/,
      );
      await assert.rejects(() => readFile(allowedOutputs.production));
      assert.deepEqual(await snapshotAllowedOutputs(), before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores injected allowlists on the public writer and resolver", async () => {
    await withTempAllowedOutputs(async ({ dir, allowedOutputs }) => {
      const before = await snapshotAllowedOutputs();
      await assert.rejects(
        () =>
          writeRenderedWranglerConfig({
            outputPath: allowedOutputs.production,
            env: baseEnv(),
            allowedOutputs,
            symlinkRoot: dir,
          }),
        /Refusing to write Wrangler config/,
      );
      await assert.rejects(
        () =>
          resolveAndAssertOutputPath(allowedOutputs.production, {
            allowedOutputs,
            symlinkRoot: dir,
          }),
        /Refusing to write Wrangler config/,
      );
      await assert.rejects(() => readFile(allowedOutputs.production));
      assert.deepEqual(await snapshotAllowedOutputs(), before);
    });
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
    assert.match(rendered, useSleeperFixturesPattern("false"));
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

  it("rejects USE_SLEEPER_FIXTURES=true on production render without echoing secrets", () => {
    assertRejectedDeployFixtures(baseEnv({ USE_SLEEPER_FIXTURES: "true" }));
    assertRejectedDeployFixtures(
      baseEnv({ USE_SLEEPER_FIXTURES: " true ", PILOT_SLEEPER_LEAGUE_ID: "" }),
    );
    assertRejectedDeployFixtures(
      baseEnv({
        USE_SLEEPER_FIXTURES: "true",
        PILOT_SLEEPER_LEAGUE_ID: PLACEHOLDER_PILOT_ID,
      }),
    );
  });

  it("rejects USE_SLEEPER_FIXTURES=true for deploy output before writing", async () => {
    await withTempAllowedOutputs(async ({ dir, allowedOutputs }) => {
      const before = await snapshotAllowedOutputs();
      await assert.rejects(
        () =>
          writeRenderedWranglerConfigForAllowedPaths({
            outputPath: allowedOutputs.production,
            env: baseEnv({ USE_SLEEPER_FIXTURES: "true" }),
            allowedOutputs,
            symlinkRoot: dir,
          }),
        (error) => {
          assert.equal(error.message, USE_SLEEPER_FIXTURES_DEPLOY_ERROR);
          assert.doesNotMatch(error.message, new RegExp(FAKE_PILOT_ID));
          return true;
        },
      );
      await assert.rejects(() => readFile(allowedOutputs.production));
      await assert.rejects(() => readFile(allowedOutputs.dev));
      assert.deepEqual(await snapshotAllowedOutputs(), before);
    });
  });

  it("rejects USE_SLEEPER_FIXTURES=true on the deploy CLI path before writing", async () => {
    const before = await snapshotAllowedOutputs();
    const result = spawnRenderer(
      baseEnv({ USE_SLEEPER_FIXTURES: "true" }),
      WRANGLER_DEPLOY_OUTPUT_PATH,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /USE_SLEEPER_FIXTURES must be "false" for the deploy config/);
    assert.doesNotMatch(result.stderr, /CLOUDFLARE_ACCOUNT_ID/);
    assert.doesNotMatch(result.stderr, new RegExp(FAKE_PILOT_ID));
    assert.deepEqual(await snapshotAllowedOutputs(), before);
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
    assert.match(rendered, useSleeperFixturesPattern("false"));
  });

  it("keeps the fake placeholder when fixture-mode local-dev render omits PILOT_SLEEPER_LEAGUE_ID", () => {
    const rendered = renderDev(
      baseEnv({ USE_SLEEPER_FIXTURES: "true", PILOT_SLEEPER_LEAGUE_ID: "" }),
    );
    assert.equal(trackedPilotId, PLACEHOLDER_PILOT_ID);
    assert.equal(trackedUseSleeperFixtures, "false");
    assert.match(
      rendered,
      new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${PLACEHOLDER_PILOT_ID}"`),
    );
    assert.match(rendered, useSleeperFixturesPattern("true"));
  });

  it("keeps the fake placeholder when PILOT_SLEEPER_LEAGUE_ID is absent on fixture-mode local-dev render", () => {
    const env = baseEnv({ USE_SLEEPER_FIXTURES: "true" });
    delete env.PILOT_SLEEPER_LEAGUE_ID;
    const rendered = renderDev(env);
    assert.match(
      rendered,
      new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${PLACEHOLDER_PILOT_ID}"`),
    );
    assert.match(rendered, useSleeperFixturesPattern("true"));
  });

  it("exports PLACEHOLDER_PILOT_ID matching the tracked wrangler template", () => {
    assert.equal(trackedPilotId, PLACEHOLDER_PILOT_ID);
  });

  it("defaults USE_SLEEPER_FIXTURES to false when unset, empty, or whitespace", () => {
    const omitted = baseEnv();
    delete omitted.USE_SLEEPER_FIXTURES;
    assert.match(renderProduction(omitted), useSleeperFixturesPattern("false"));
    assert.match(
      renderProduction(baseEnv({ USE_SLEEPER_FIXTURES: "" })),
      useSleeperFixturesPattern("false"),
    );
    assert.match(
      renderProduction(baseEnv({ USE_SLEEPER_FIXTURES: "   " })),
      useSleeperFixturesPattern("false"),
    );
  });

  it("trims surrounding whitespace on explicit true and false", () => {
    assert.match(
      renderDev(baseEnv({ USE_SLEEPER_FIXTURES: " true " })),
      useSleeperFixturesPattern("true"),
    );
    assert.match(
      renderProduction(baseEnv({ USE_SLEEPER_FIXTURES: " false " })),
      useSleeperFixturesPattern("false"),
    );
    assert.match(
      renderDev(baseEnv({ USE_SLEEPER_FIXTURES: "\tfalse\n" })),
      useSleeperFixturesPattern("false"),
    );
  });

  it("rejects coerced or object-like USE_SLEEPER_FIXTURES values without echoing them", () => {
    assertInvalidUseSleeperFixtures("TRUE");
    assertInvalidUseSleeperFixtures("True");
    assertInvalidUseSleeperFixtures("1");
    assertInvalidUseSleeperFixtures("yes");
    assertInvalidUseSleeperFixtures("0");
    assertInvalidUseSleeperFixtures("falsey");
    assertInvalidUseSleeperFixtures(true);
    assertInvalidUseSleeperFixtures(1);
    assertInvalidUseSleeperFixtures({ toString: () => "true" });
  });

  it("renders both production KV ids onto the matching bindings", () => {
    const rendered = renderProduction(baseEnv());
    assert.match(rendered, kvBindingIdPattern("PLAYERS", FAKE_PLAYERS_KV_ID));
    assert.match(rendered, kvBindingIdPattern("EXPLORER_CACHE", FAKE_EXPLORER_KV_ID));
    assert.doesNotMatch(rendered, kvBindingIdPattern("PLAYERS", FAKE_EXPLORER_KV_ID));
    assert.doesNotMatch(rendered, kvBindingIdPattern("EXPLORER_CACHE", FAKE_PLAYERS_KV_ID));
  });

  it("renders distinct local-dev KV placeholders without requiring env ids", () => {
    assert.equal(trackedPlayersKvId, PLACEHOLDER_PLAYERS_KV_ID);
    assert.equal(trackedExplorerKvId, PLACEHOLDER_EXPLORER_KV_ID);
    assert.notEqual(PLACEHOLDER_PLAYERS_KV_ID, PLACEHOLDER_EXPLORER_KV_ID);

    const env = baseEnv();
    delete env.CLOUDFLARE_KV_NAMESPACE_ID;
    delete env.CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID;
    const rendered = renderDev(env);
    assert.match(rendered, kvBindingIdPattern("PLAYERS", PLACEHOLDER_PLAYERS_KV_ID));
    assert.match(rendered, kvBindingIdPattern("EXPLORER_CACHE", PLACEHOLDER_EXPLORER_KV_ID));
  });

  it("rejects a missing CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID without exposing values", () => {
    const env = baseEnv();
    delete env.CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID;
    assert.throws(
      () => renderProduction(env),
      (error) => {
        assert.match(error.message, /Missing CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID/);
        assert.doesNotMatch(error.message, new RegExp(FAKE_PLAYERS_KV_ID));
        assert.doesNotMatch(error.message, new RegExp(FAKE_EXPLORER_KV_ID));
        assert.doesNotMatch(error.message, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
        return true;
      },
    );
  });

  it("rejects an invalid CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID without exposing the value", () => {
    assert.throws(
      () =>
        renderProduction(
          baseEnv({ CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID: INVALID_EXPLORER_KV_ID }),
        ),
      (error) => {
        assert.match(error.message, /Invalid CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID/);
        assert.doesNotMatch(error.message, new RegExp(INVALID_EXPLORER_KV_ID));
        assert.doesNotMatch(error.message, new RegExp(FAKE_PLAYERS_KV_ID));
        return true;
      },
    );
  });

  it("rejects identical PLAYERS and EXPLORER_CACHE KV ids without exposing values", () => {
    assert.throws(
      () =>
        renderProduction(
          baseEnv({ CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID: FAKE_PLAYERS_KV_ID }),
        ),
      (error) => {
        assert.match(error.message, /CLOUDFLARE_EXPLORER_KV_NAMESPACE_ID must differ/);
        assert.doesNotMatch(error.message, new RegExp(FAKE_PLAYERS_KV_ID));
        return true;
      },
    );
  });
});
