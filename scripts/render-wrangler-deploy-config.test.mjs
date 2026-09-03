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

function baseEnv(overrides = {}) {
  const env = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    CLOUDFLARE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
    CLOUDFLARE_KV_NAMESPACE_ID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    CLOUDFLARE_CUSTOM_DOMAIN: "example.test",
    CLERK_PUBLISHABLE_KEY: "pk_test_abcdefghijklmnop",
    APP_ORIGIN: "https://example.test",
    PILOT_SLEEPER_LEAGUE_ID: FAKE_PILOT_ID,
    ...overrides,
  };
  delete env.V1_LEAGUE_ID;
  delete env.V1_LEAGUE_NAME;
  delete env.V1_SLEEPER_USER_ID;
  delete env.V1_SLEEPER_USERNAME;
  return env;
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

      const ok = render(baseEnv(), outputPath);
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

  it("keeps the fake placeholder when local-dev render omits PILOT_SLEEPER_LEAGUE_ID", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cutman-wrangler-render-"));
    const outputPath = path.join(dir, ".wrangler.dev.jsonc");
    try {
      const result = render(baseEnv({ PILOT_SLEEPER_LEAGUE_ID: "" }), outputPath);
      assert.equal(result.status, 0, result.stderr);
      const rendered = await readFile(outputPath, "utf8");
      assert.match(rendered, /"PILOT_SLEEPER_LEAGUE_ID"\s*:\s*"0000000000000000000"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
