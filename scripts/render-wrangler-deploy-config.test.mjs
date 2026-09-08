import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/render-wrangler-deploy-config.mjs");

const FAKE_PILOT_ID = "1111111111111111111";
const PLACEHOLDER_PILOT_ID = "0000000000000000000";
const ALL_ZERO_PILOT_ID = "000000";

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

function render(env, outputPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: { ...env, WRANGLER_RENDER_OUTPUT: outputPath },
    encoding: "utf8",
  });
}

describe("render-wrangler-deploy-config", () => {
  it("requires PILOT_SLEEPER_LEAGUE_ID and ignores leftover V1_* keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.deploy.jsonc");
    try {
      const missing = render(
        baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "" }),
        outputPath,
      );
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
      assert.doesNotMatch(missing.stderr, /V1_LEAGUE_ID/);

      const leftover = baseEnv();
      leftover.V1_LEAGUE_ID = "legacy-v1-league-id";
      leftover.V1_LEAGUE_NAME = "Legacy V1 League";
      leftover.V1_SLEEPER_USER_ID = "legacy-v1-user-id";
      leftover.V1_SLEEPER_USERNAME = "legacy_v1_user";
      const ok = render(leftover, outputPath);
      assert.equal(ok.status, 0, ok.stderr);
      const rendered = await readFile(outputPath, "utf8");
      assert.match(rendered, new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${FAKE_PILOT_ID}"`));
      assert.doesNotMatch(rendered, /"V1_LEAGUE_ID"/);
      assert.doesNotMatch(rendered, /"V1_LEAGUE_NAME"/);
      assert.doesNotMatch(rendered, /"V1_SLEEPER_USER_ID"/);
      assert.doesNotMatch(rendered, /"V1_SLEEPER_USERNAME"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when PILOT_SLEEPER_LEAGUE_ID is absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.deploy.jsonc");
    try {
      const env = baseEnv();
      delete env.PILOT_SLEEPER_LEAGUE_ID;
      const missing = render(env, outputPath);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
      assert.doesNotMatch(missing.stderr, /V1_LEAGUE_ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-snowflake PILOT_SLEEPER_LEAGUE_ID", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.deploy.jsonc");
    try {
      const result = render(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "not-a-league" }), outputPath);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects the tracked placeholder PILOT_SLEEPER_LEAGUE_ID on production render", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.deploy.jsonc");
    try {
      const result = render(
        baseEnv({ PILOT_SLEEPER_LEAGUE_ID: PLACEHOLDER_PILOT_ID }),
        outputPath,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
      assert.match(result.stderr, /placeholder/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an all-zero PILOT_SLEEPER_LEAGUE_ID on production render", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.deploy.jsonc");
    try {
      const result = render(
        baseEnv({ PILOT_SLEEPER_LEAGUE_ID: ALL_ZERO_PILOT_ID }),
        outputPath,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-snowflake PILOT_SLEEPER_LEAGUE_ID on local-dev render", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const result = render(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "not-a-league" }), outputPath);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails local-dev render when USE_SLEEPER_FIXTURES is false and PILOT_SLEEPER_LEAGUE_ID is omitted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const result = render(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "" }), outputPath);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails local-dev render when USE_SLEEPER_FIXTURES is false and PILOT_SLEEPER_LEAGUE_ID is absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const env = baseEnv();
      delete env.PILOT_SLEEPER_LEAGUE_ID;
      const result = render(env, outputPath);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails local-dev render when USE_SLEEPER_FIXTURES is false and PILOT_SLEEPER_LEAGUE_ID is the placeholder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const result = render(
        baseEnv({ PILOT_SLEEPER_LEAGUE_ID: PLACEHOLDER_PILOT_ID }),
        outputPath,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
      assert.match(result.stderr, /placeholder/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails local-dev render when USE_SLEEPER_FIXTURES is false and PILOT_SLEEPER_LEAGUE_ID is all zeros", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const result = render(
        baseEnv({ PILOT_SLEEPER_LEAGUE_ID: ALL_ZERO_PILOT_ID }),
        outputPath,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PILOT_SLEEPER_LEAGUE_ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a live-shaped PILOT_SLEEPER_LEAGUE_ID on local-dev render when USE_SLEEPER_FIXTURES is false", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const result = render(baseEnv(), outputPath);
      assert.equal(result.status, 0, result.stderr);
      const rendered = await readFile(outputPath, "utf8");
      assert.match(rendered, new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${FAKE_PILOT_ID}"`));
      assert.match(rendered, /"USE_SLEEPER_FIXTURES"\s*:\s*"false"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the fake placeholder when fixture-mode local-dev render omits PILOT_SLEEPER_LEAGUE_ID", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const result = render(
        baseEnv({ USE_SLEEPER_FIXTURES: "true", PILOT_SLEEPER_LEAGUE_ID: "" }),
        outputPath,
      );
      assert.equal(result.status, 0, result.stderr);
      const rendered = await readFile(outputPath, "utf8");
      assert.match(rendered, new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${PLACEHOLDER_PILOT_ID}"`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the fake placeholder when PILOT_SLEEPER_LEAGUE_ID is absent on fixture-mode local-dev render", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const env = baseEnv({ USE_SLEEPER_FIXTURES: "true" });
      delete env.PILOT_SLEEPER_LEAGUE_ID;
      const result = render(env, outputPath);
      assert.equal(result.status, 0, result.stderr);
      const rendered = await readFile(outputPath, "utf8");
      assert.match(rendered, new RegExp(`"PILOT_SLEEPER_LEAGUE_ID"\\s*:\\s*"${PLACEHOLDER_PILOT_ID}"`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
