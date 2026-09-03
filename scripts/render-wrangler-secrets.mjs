#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifestKeys } from "./lib/parse-manifest-keys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(repoRoot, "apps/web/.wrangler.secrets.example");

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error("usage: render-wrangler-secrets.mjs <output.json>");
    process.exit(1);
  }

  const manifest = await readFile(manifestPath, "utf8");
  const keys = parseManifestKeys(manifest);
  if (keys.length === 0) {
    throw new Error(`No secret keys found in ${path.basename(manifestPath)}.`);
  }

  const secrets = {};
  const missing = [];

  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (!value) {
      missing.push(key);
      continue;
    }
    secrets[key] = value;
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing Worker secrets (set in 1Password Environment): ${missing.join(", ")}.`,
    );
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600,
  });
}

await main();
