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
 * Forward additive migrations (`0003_recap_attempt_backlog.sql`, `0004_explorer_origin_quota.sql`)
 * reapply with `pnpm run db:migrate:local`; a reset is only required when the local shape
 * predates those CREATE IF NOT EXISTS statements or a rewritten earlier migration.
 *
 * Residual symlink-replacement race (accepted): this script is local-only and never remote.
 * Before rm, the walk lstats the derived repo root, `apps`, `apps/web`, then each
 * LOCAL_D1_SEGMENTS component, and refuses any symbolic link in that chain. After that
 * check, `fs.rm` still follows a path. A symlink swapped in between check and rm is a
 * residual TOCTOU race. It is accepted because this is a developer-local wipe of the
 * hardcoded Miniflare D1 directory and Node has no portable nofollow recursive rm.
 * The exact production path guard and CLI entrypoint behavior are unchanged.
 */
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const webDir = path.join(repoRoot, "apps/web");
const localD1Dir = path.join(webDir, ".wrangler", "state", "v3", "d1");

export const LOCAL_D1_SEGMENTS = Object.freeze([".wrangler", "state", "v3", "d1"]);

/**
 * Walk from `.wrangler/state/v3/d1` back to `apps/web` using the suffix length, not a
 * hardcoded `..` count, so the symlink walk stays aligned if LOCAL_D1_SEGMENTS changes.
 */
export function resolveLocalD1WebDir(targetDir) {
  return path.resolve(
    targetDir,
    ...Array.from({ length: LOCAL_D1_SEGMENTS.length }, () => ".."),
  );
}

/**
 * Pure path-equality guard. Tests pass an explicit expected temp path; production pins
 * expectedDir to the hardcoded localD1Dir constant via assertExpectedLocalD1Path.
 */
export function assertCanonicalResolvedPath(targetDir, expectedDir) {
  if (path.resolve(targetDir) !== path.resolve(expectedDir)) {
    throw new Error(`Refusing to delete unexpected path: ${targetDir}`);
  }
}

// Defensive guard: only ever delete this exact, hardcoded local D1 state directory — never a
// path built from arguments, env vars, or anything else that could point somewhere unexpected.
export function assertExpectedLocalD1Path(targetDir) {
  assertCanonicalResolvedPath(targetDir, localD1Dir);
}

/**
 * lstat every existing component from the derived repo root through
 * `apps/web/.wrangler/state/v3/d1`. Missing tail components are safe — stop
 * descending at the first ENOENT. Any symbolic link in the chain is rejected
 * so recursive rm cannot follow it, including a symlink at `apps` itself.
 *
 * Repo root is `dirname(dirname(webDir))` (the parent of `apps`). A checkout
 * whose own root path is a symlink is refused rather than followed: that is
 * intentional for a destructive wipe. Ancestor symlinks above the repo root
 * are outside this chain (e.g. `~/dev` as a volume symlink is fine).
 */
export async function assertLocalD1PathHasNoSymlinks(targetWebDir) {
  const targetAppsDir = path.dirname(targetWebDir);
  const targetRepoRoot = path.dirname(targetAppsDir);
  const chain = [targetRepoRoot, targetAppsDir, targetWebDir];
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

// Residual TOCTOU: the walk lstats the chain, then rm follows the path. A symlink
// swapped in between those calls is accepted for this local-only wipe of the
// hardcoded Miniflare D1 directory; Node fs.rm cannot take a nofollow handle.
async function removeLocalD1Dir(targetDir) {
  const targetWebDir = resolveLocalD1WebDir(targetDir);
  await assertLocalD1PathHasNoSymlinks(targetWebDir);
  await rm(targetDir, { recursive: true, force: true });
}

/**
 * Test-only deletion: removes targetDir only when it canonically matches expectedDir.
 * expectedDir is required and has no production default, so this cannot fall through to
 * the real local D1 directory.
 */
export async function resetLocalD1MatchingExpected(targetDir, expectedDir) {
  assertCanonicalResolvedPath(targetDir, expectedDir);
  await removeLocalD1Dir(targetDir);
}

export async function resetLocalD1(targetDir) {
  assertExpectedLocalD1Path(targetDir);
  await removeLocalD1Dir(targetDir);
}

async function main() {
  await resetLocalD1(localD1Dir);
  console.log(`Removed local D1 state: ${path.relative(repoRoot, localD1Dir)}`);
  console.log("Next: migrations reapply automatically if you ran `pnpm run db:reset:local`.");
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
  const resolvedArgvPath = await realpath(argvPath);
  return isSameRealPath(resolvedArgvPath, modulePath);
}

if (await isCliEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) {
  await main();
}
