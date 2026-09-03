#!/usr/bin/env node
/**
 * Starts Vite + Cloudflare local dev under op run. Expects secrets in
 * process.env (injected by op run). CLOUDFLARE_INCLUDE_PROCESS_ENV lets the
 * Cloudflare Vite plugin read declared secrets from the process environment
 * instead of a .dev.vars file.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyLocalDevSecrets,
  envForLocalViteWorker,
  formatMissingAgenticNote,
} from "./lib/local-dev-secrets.mjs";
import { parseManifestKeys } from "./lib/parse-manifest-keys.mjs";

const CUTMAN_DEV_PORT = 41789;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const webDir = path.join(repoRoot, "apps/web");
const examplePath = path.join(webDir, ".dev.vars.example");

function assertRequiredKeys() {
  const manifest = readFileSync(examplePath, "utf8");
  const manifestKeys = parseManifestKeys(manifest);
  const { missingRequired, missingOptional, missingAgentic, unknownRequired } =
    classifyLocalDevSecrets(manifestKeys);

  if (unknownRequired.length > 0) {
    console.error(
      `error: required local keys missing from apps/web/.dev.vars.example: ${unknownRequired.join(", ")}`,
    );
    process.exit(1);
  }

  if (missingRequired.length > 0) {
    console.error(
      `error: missing required local secrets: ${missingRequired.join(", ")}. Set APP_ENV, APP_ORIGIN, and your Clerk keys (via OP_ENVIRONMENT_ID + op run, or export them in the shell).`,
    );
    process.exit(1);
  }

  if (missingOptional.length > 0) {
    console.log(
      `note: optional secrets not set: ${missingOptional.join(", ")}`,
    );
  }

  const agenticNote = formatMissingAgenticNote(missingAgentic);
  if (agenticNote) {
    console.log(agenticNote);
  }
}

async function assertDevPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use (likely a stale "pnpm run dev"). Stop it with: lsof -ti :${port} -sTCP:LISTEN | xargs kill`,
          ),
        );
        return;
      }

      reject(error);
    });

    probe.once("listening", () => {
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve();
      });
    });

    probe.listen(port, "127.0.0.1");
  });
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("usage: run-vite-dev.mjs <command> [args...]");
  process.exit(1);
}

assertRequiredKeys();

if (command === "vite") {
  try {
    await assertDevPortAvailable(CUTMAN_DEV_PORT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const devWranglerConfig = path.join(webDir, ".wrangler.dev.jsonc");
process.env.WRANGLER_RENDER_OUTPUT = devWranglerConfig;
await import("./render-wrangler-deploy-config.mjs");
process.env.CUTMAN_WRANGLER_CONFIG = devWranglerConfig;

const viteBin = path.join(repoRoot, "node_modules/vite/bin/vite.js");
const useVite =
  command === "vite" && existsSync(viteBin)
    ? [viteBin, ...args]
    : [command, ...args];
const executable = useVite[0] === viteBin ? process.execPath : command;
const spawnArgs = useVite[0] === viteBin ? useVite : args;

const child = spawn(executable, spawnArgs, {
  cwd: webDir,
  env: envForLocalViteWorker(process.env),
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
