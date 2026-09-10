#!/usr/bin/env node
/**
 * Wipes Cutman's LOCAL-ONLY D1 state so `pnpm run db:migrate:local` can rebuild it clean.
 *
 * Scope, on purpose:
 * - Deletes only `apps/web/.wrangler/state/v3/d1` — Miniflare's local D1 SQLite files for this
 *   project. It never touches `.wrangler/state/v3/{do,kv,cache,observability}` (Durable Object,
 *   KV, cache, or trace state), and never touches any other project's `.wrangler` directory.
 * - Never touches remote D1: there is no `--remote` flag here, and this script never reads
 *   `.wrangler.deploy.jsonc` or any live Cloudflare/D1 id. See AGENTS.md invariants.
 *
 * Use this when local D1 predates a schema change (e.g. Task 1's clean rebuild of `leagues`,
 * `league_members`, `league_verifications`, `sleeper_accounts`) and `ensureSchema`'s
 * purely-additive `CREATE TABLE IF NOT EXISTS` can't reconcile the old shape on its own.
 */
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const webDir = path.join(repoRoot, "apps/web");
const localD1Dir = path.join(webDir, ".wrangler", "state", "v3", "d1");

export const LOCAL_D1_SEGMENTS = Object.freeze([".wrangler", "state", "v3", "d1"]);

// Defensive guard: only ever delete this exact, hardcoded local D1 state directory — never a
// path built from arguments, env vars, or anything else that could point somewhere unexpected.
export const EXPECTED_LOCAL_D1_SUFFIX = path.join("apps", "web", ...LOCAL_D1_SEGMENTS);

export function assertExpectedLocalD1Path(targetDir) {
  if (!targetDir.endsWith(EXPECTED_LOCAL_D1_SUFFIX)) {
    throw new Error(`Refusing to delete unexpected path: ${targetDir}`);
  }
}

/**
 * lstat every existing component from `webDir` through `.wrangler/state/v3/d1`.
 * Missing tail components are safe — stop descending at the first ENOENT.
 * Any symbolic link in the chain is rejected so recursive rm cannot follow it.
 */
export async function assertLocalD1PathHasNoSymlinks(targetWebDir) {
  const chain = [targetWebDir];
  let current = targetWebDir;
  for (const segment of LOCAL_D1_SEGMENTS) {
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
      throw new Error(`Refusing to delete path with symbolic link: ${candidate}`);
    }
  }
}

export async function resetLocalD1(targetDir) {
  assertExpectedLocalD1Path(targetDir);
  const targetWebDir = path.resolve(targetDir, "..", "..", "..", "..");
  await assertLocalD1PathHasNoSymlinks(targetWebDir);
  await rm(targetDir, { recursive: true, force: true });
}

async function main() {
  await resetLocalD1(localD1Dir);
  console.log(`Removed local D1 state: ${path.relative(repoRoot, localD1Dir)}`);
  console.log("Next: migrations reapply automatically if you ran `pnpm run db:reset:local`.");
}

const isCliEntrypoint =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliEntrypoint) {
  await main();
}
