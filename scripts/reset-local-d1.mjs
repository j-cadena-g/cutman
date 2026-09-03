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
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const webDir = path.join(repoRoot, "apps/web");
const localD1Dir = path.join(webDir, ".wrangler", "state", "v3", "d1");

// Defensive guard: only ever delete this exact, hardcoded local D1 state directory — never a
// path built from arguments, env vars, or anything else that could point somewhere unexpected.
const expectedSuffix = path.join("apps", "web", ".wrangler", "state", "v3", "d1");
if (!localD1Dir.endsWith(expectedSuffix)) {
  throw new Error(`Refusing to delete unexpected path: ${localD1Dir}`);
}

await rm(localD1Dir, { recursive: true, force: true });
console.log(`Removed local D1 state: ${path.relative(repoRoot, localD1Dir)}`);
console.log("Next: migrations reapply automatically if you ran `pnpm run db:reset:local`.");
